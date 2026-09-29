import type { MarketListingGateway } from "./core/ports.js";
import type { MarketAccountService } from "./market-accounts.js";
import { QvaApiError } from "./qvapay.js";
import type {
  MarketReaderHealth,
  Store,
} from "./store.js";
import type { FiatMarket, P2pListPage, P2pType } from "./types.js";

export interface MarketPollJob {
  coin: FiatMarket;
  side: P2pType;
}

export interface MarketPageUpdate extends MarketPollJob {
  page: P2pListPage;
  scannedAt: number;
  sourceAccountId: string;
}

interface MarketSourceAccountStatus {
  id: string;
  label: string;
  role: "primary" | "reader";
  intervalSeconds: number;
  enabled: boolean;
  health: MarketReaderHealth;
  lastSuccessAt: number | null;
  lastAttemptAt: number | null;
  nextEligibleAt: number;
  consecutiveErrors: number;
  lastError?: string;
}

export interface MarketSourceStatus {
  mode: "polling" | "hybrid";
  accounts: MarketSourceAccountStatus[];
  healthyAccounts: number;
  effectiveCadenceSeconds: number | null;
  estimatedRequestsPerMinute: number;
  webhookUrl?: string;
  webhookSecretConfigured?: boolean;
  streamCredentialsConfigured?: boolean;
  streamPhase?: "idle" | "connecting" | "connected" | "backoff" | "unauthorized" | "subscription_required" | "expired";
  streamExpiresAt?: string;
  lastStreamReceivedAt?: number | null;
  lastStreamError?: string;
  lastWebhookReceivedAt?: number | null;
  lastWebhookProcessedAt?: number | null;
  pendingWebhookEvents?: number;
  failedWebhookEvents?: number;
  lastWebhookError?: string;
}

export interface MarketDataSource {
  pollNext(): Promise<MarketPageUpdate | undefined>;
  status(): MarketSourceStatus;
}

interface RuntimeAccount extends MarketSourceAccountStatus {
  reader: MarketListingGateway;
  tokenFingerprint?: string;
  seeded: boolean;
}

export interface PollingMarketSourceRuntime {
  now?: () => number;
}

export class PollingMarketSource implements MarketDataSource {
  private readonly now: () => number;
  private readonly accounts = new Map<string, RuntimeAccount>();
  private rosterSignature = "";
  private jobCursor = 0;
  private polling = false;

  constructor(
    private readonly store: Store,
    private readonly accountService: MarketAccountService,
    private readonly primaryReader: MarketListingGateway,
    private readonly primaryIntervalSeconds: () => number,
    private readonly jobs: () => MarketPollJob[],
    runtime: PollingMarketSourceRuntime = {},
  ) {
    this.now = runtime.now ?? Date.now;
  }

  async pollNext(): Promise<MarketPageUpdate | undefined> {
    if (this.polling) return undefined;
    this.refreshAccounts();
    const jobs = this.jobs();
    if (!jobs.length) return undefined;
    const now = this.now();
    const account = [...this.accounts.values()]
      .filter(
        (candidate) =>
          candidate.enabled &&
          candidate.health !== "requires_attention" &&
          candidate.nextEligibleAt <= now,
      )
      .sort(
        (left, right) =>
          left.nextEligibleAt - right.nextEligibleAt ||
          left.lastAttemptAt! - right.lastAttemptAt! ||
          left.id.localeCompare(right.id),
      )[0];
    if (!account) return undefined;

    const job = jobs[this.jobCursor % jobs.length]!;
    this.jobCursor = (this.jobCursor + 1) % jobs.length;
    const startedAt = now;
    account.lastAttemptAt = startedAt;
    account.nextEligibleAt =
      startedAt + account.intervalSeconds * 1_000;
    this.polling = true;
    try {
      const page = await account.reader.listOffersPage({
        take: 100,
        page: 1,
        type: job.side,
        coin: job.coin,
        status: "open",
        orderBy: "best_rate",
        orderType: "desc",
      });
      account.health = "healthy";
      account.lastSuccessAt = this.now();
      account.consecutiveErrors = 0;
      delete account.lastError;
      this.persistHealth(account, true);
      return {
        ...job,
        page,
        scannedAt: account.lastSuccessAt,
        sourceAccountId: account.id,
      };
    } catch (error) {
      this.recordFailure(account, error);
      return undefined;
    } finally {
      this.polling = false;
    }
  }

  status(): MarketSourceStatus {
    this.refreshAccounts();
    const accounts = [...this.accounts.values()].map(publicStatus);
    const healthy = accounts.filter(
      (account) => account.enabled && account.health === "healthy",
    );
    const requestsPerSecond = healthy.reduce(
      (total, account) => total + 1 / account.intervalSeconds,
      0,
    );
    return {
      mode: "polling",
      accounts,
      healthyAccounts: healthy.length,
      effectiveCadenceSeconds:
        requestsPerSecond > 0 ? 1 / requestsPerSecond : null,
      estimatedRequestsPerMinute: requestsPerSecond * 60,
    };
  }

  private refreshAccounts(): void {
    const secondary = this.accountService.internalAccounts();
    const primaryInterval = Math.max(3, this.primaryIntervalSeconds());
    const signature = JSON.stringify([
      ["primary", primaryInterval],
      ...secondary.map((account) => [
        account.id,
        account.tokenFingerprint,
        account.intervalSeconds,
        account.enabled,
        account.health,
      ]),
    ]);
    if (signature === this.rosterSignature) return;
    this.rosterSignature = signature;

    const previousPrimary = this.accounts.get("primary");
    const next = new Map<string, RuntimeAccount>();
    next.set("primary", {
      id: "primary",
      label: "Cuenta principal",
      role: "primary",
      intervalSeconds: primaryInterval,
      enabled: true,
      health: previousPrimary?.health ?? "healthy",
      lastSuccessAt: previousPrimary?.lastSuccessAt ?? null,
      lastAttemptAt: previousPrimary?.lastAttemptAt ?? null,
      nextEligibleAt: previousPrimary?.nextEligibleAt ?? 0,
      consecutiveErrors: previousPrimary?.consecutiveErrors ?? 0,
      ...(previousPrimary?.lastError
        ? { lastError: previousPrimary.lastError }
        : {}),
      reader: this.primaryReader,
      seeded: previousPrimary?.seeded ?? false,
    });
    for (const account of secondary) {
      const previous = this.accounts.get(account.id);
      const reusable = previous?.tokenFingerprint === account.tokenFingerprint;
      next.set(account.id, {
        id: account.id,
        label: account.label,
        role: "reader",
        intervalSeconds: account.intervalSeconds,
        enabled: account.enabled,
        health: account.health,
        lastSuccessAt: account.lastSuccessAt,
        lastAttemptAt: account.lastAttemptAt,
        nextEligibleAt: reusable
          ? previous.nextEligibleAt
          : account.nextEligibleAt,
        consecutiveErrors: account.consecutiveErrors,
        ...(account.lastError ? { lastError: account.lastError } : {}),
        reader: reusable
          ? previous.reader
          : this.accountService.reader(account),
        tokenFingerprint: account.tokenFingerprint,
        seeded: reusable ? previous.seeded : false,
      });
    }
    this.accounts.clear();
    for (const [id, account] of next) this.accounts.set(id, account);
    this.seedSchedule();
  }

  private seedSchedule(): void {
    const active = [...this.accounts.values()].filter(
      (account) => account.enabled && account.health !== "requires_attention",
    );
    if (!active.length) return;
    const now = this.now();
    const baseInterval = Math.min(
      ...active.map((account) => account.intervalSeconds * 1_000),
    );
    active.forEach((account, index) => {
      if (account.seeded) return;
      account.nextEligibleAt = now + (baseInterval * index) / active.length;
      account.seeded = true;
    });
  }

  private recordFailure(account: RuntimeAccount, error: unknown): void {
    const now = this.now();
    account.consecutiveErrors += 1;
    account.lastError = safeError(error);
    if (error instanceof QvaApiError && [401, 403].includes(error.status)) {
      account.health = "requires_attention";
      account.nextEligibleAt = Number.MAX_SAFE_INTEGER;
    } else if (error instanceof QvaApiError && error.status === 429) {
      account.health = "cooldown";
      account.nextEligibleAt =
        now +
        (error.retryAfterMs ?? backoffMilliseconds(account.consecutiveErrors));
    } else {
      account.health = "error";
      account.nextEligibleAt =
        now + backoffMilliseconds(account.consecutiveErrors);
    }
    this.persistHealth(account, false);
  }

  private persistHealth(account: RuntimeAccount, success: boolean): void {
    if (account.role !== "reader") return;
    this.store.updateMarketReaderHealth(account.id, {
      health: account.health,
      lastAttemptAt: account.lastAttemptAt ?? this.now(),
      nextEligibleAt: account.nextEligibleAt,
      success,
      ...(account.lastError ? { error: account.lastError } : {}),
    });
  }
}

export function weightedMarketJobs(input: {
  markets: Array<{
    code: FiatMarket;
    buyEnabled: boolean;
    sellEnabled: boolean;
  }>;
}): MarketPollJob[] {
  const buyQusd = input.markets
    .filter((market) => market.buyEnabled)
    .map((market) => ({ coin: market.code, side: "sell" as const }));
  const sellQusd = input.markets
    .filter((market) => market.sellEnabled)
    .map((market) => ({ coin: market.code, side: "buy" as const }));
  return [...buyQusd, ...sellQusd, ...buyQusd];
}

function publicStatus(account: RuntimeAccount): MarketSourceAccountStatus {
  return {
    id: account.id,
    label: account.label,
    role: account.role,
    intervalSeconds: account.intervalSeconds,
    enabled: account.enabled,
    health: account.health,
    lastSuccessAt: account.lastSuccessAt,
    lastAttemptAt: account.lastAttemptAt,
    nextEligibleAt: account.nextEligibleAt,
    consecutiveErrors: account.consecutiveErrors,
    ...(account.lastError ? { lastError: account.lastError } : {}),
  };
}

function backoffMilliseconds(errors: number): number {
  return Math.min(60_000, 3_000 * 2 ** Math.max(0, errors - 1));
}

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/\b\d+\|[A-Za-z0-9._~-]+\b/g, "[redacted]")
    .slice(0, 300);
}
