import type { MarketListingGateway } from "./core/ports.js";
import { createHash } from "node:crypto";
import type { MarketAccountService } from "./market-accounts.js";
import { QvaApiError } from "./qvapay.js";
import type {
  MarketReaderHealth,
  Store,
} from "./store.js";
import type { FiatMarket, ListTiming, P2pListPage, P2pType } from "./types.js";

export interface MarketPollJob {
  coin: FiatMarket;
  side: P2pType;
}

export interface MarketPageUpdate extends MarketPollJob {
  page: P2pListPage;
  scannedAt: number;
  sourceAccountId: string;
  dispatchSequence?: number;
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
  lastEventLatencyMs?: number | null;
  lastDeliveryLagMs?: number | null;
  lastEventOutcome?: string;
  lastDecisionLatencyMs?: number | null;
  lastApplyQueueMs?: number | null;
  lastApplyBudgetWaitMs?: number | null;
  lastApplyResponseMs?: number | null;
}

export interface MarketDataSource {
  pollNext(): Promise<MarketPageUpdate | undefined>;
  status(): MarketSourceStatus;
}

interface RuntimeAccount extends MarketSourceAccountStatus {
  reader: MarketListingGateway;
  tokenFingerprint?: string;
  owner: string | undefined;
  seeded: boolean;
}

export interface PollingMarketSourceRuntime {
  primaryOwner?: () => string | undefined;
  now?: () => number;
  monotonicNow?: () => number;
  onPollTiming?: (timing: MarketPollTiming) => void;
}

export interface MarketPollTiming extends MarketPollJob {
  sourceAccountId: string;
  startedAt: number;
  finishedAt: number;
  requestMs: number;
  outcome: "success" | "failed" | "discarded";
  discardReason?: "credential_changed" | "superseded";
  /** Time between successful responses for this market/side, across readers. Not origin freshness. */
  coverageGapMs?: number;
  offerCount?: number;
  totalOffers?: number;
  cacheStatus?: "HIT" | "MISS";
  transport?: ListTiming;
}

export class PollingMarketSource implements MarketDataSource {
  private readonly primaryOwnerProvider: (() => string | undefined) | undefined;
  private readonly now: () => number;
  private readonly monotonicNow: () => number;
  private readonly onPollTiming: PollingMarketSourceRuntime["onPollTiming"];
  private readonly lastMarketResponse = new Map<string, number>();
  private readonly accounts = new Map<string, RuntimeAccount>();
  private rosterSignature = "";
  private jobCursor = 0;
  private readonly claims = new Map<string, string | undefined>();
  private sequence = 0;
  private readonly acceptedSequence = new Map<string, number>();

  constructor(
    private readonly store: Store,
    private readonly accountService: MarketAccountService,
    private readonly primaryReader: MarketListingGateway,
    private readonly primaryIntervalSeconds: () => number,
    private readonly jobs: () => MarketPollJob[],
    runtime: PollingMarketSourceRuntime = {},
  ) {
    this.now = runtime.now ?? Date.now;
    this.primaryOwnerProvider = runtime.primaryOwner;
    this.monotonicNow = runtime.monotonicNow ?? (() => performance.now());
    this.onPollTiming = runtime.onPollTiming;
  }

  async pollNext(): Promise<MarketPageUpdate | undefined> {
    if (this.claims.size >= 4) return undefined;
    this.refreshAccounts();
    const jobs = this.jobs();
    if (!jobs.length) return undefined;
    const now = this.now();
    const due = [...this.accounts.values()]
      .filter(
        (candidate) =>
          candidate.enabled &&
          candidate.health !== "requires_attention" &&
          candidate.nextEligibleAt <= now &&
          !this.claims.has(candidate.id) &&
          (!candidate.owner || this.ownerReadyAt(candidate.owner) <= now),
      )
      .sort(
        (left, right) =>
          left.nextEligibleAt - right.nextEligibleAt ||
          left.lastAttemptAt! - right.lastAttemptAt! ||
          left.id.localeCompare(right.id),
      );
    let account: RuntimeAccount | undefined;
    for (const candidate of due) {
      if (!candidate.owner && this.claims.size) break;
      if (candidate.owner && [...this.claims.values()].some(owner => !owner || owner === candidate.owner)) continue;
      account = candidate;
      break;
    }
    if (!account) return undefined;

    const job = jobs[this.jobCursor % jobs.length]!;
    const sequence = ++this.sequence;
    const owner = account.owner;
    const fingerprint = account.tokenFingerprint;
    const accountGeneration = account.role === "reader" ? this.accountService.generation(account.id) : 0;
    const activeKeys = new Set(jobs.map(item => `${item.coin}:${item.side}`));
    for (const key of this.lastMarketResponse.keys()) if (!activeKeys.has(key)) this.lastMarketResponse.delete(key);
    for (const key of this.acceptedSequence.keys()) if (!activeKeys.has(key)) this.acceptedSequence.delete(key);
    this.jobCursor = (this.jobCursor + 1) % jobs.length;
    const startedAt = now;
    const started = this.monotonicNow();
    const timing: MarketPollTiming = { ...job, sourceAccountId: account.id, startedAt,
      finishedAt: startedAt, requestMs: 0, outcome: "failed" };
    account.lastAttemptAt = startedAt;
    account.nextEligibleAt =
      startedAt + account.intervalSeconds * 1_000;
    this.claims.set(account.id, owner);
    try {
      if (owner) {
        const interval = Math.max(account.intervalSeconds, ...[...this.accounts.values()]
          .filter(item => item.owner === owner && item.enabled && item.health !== "requires_attention")
          .map(item => item.intervalSeconds));
        this.saveOwnerReadyAt(owner, startedAt + interval * 1000);
      }
      const page = await account.reader.listOffersPage({
        take: 100,
        page: 1,
        type: job.side,
        coin: job.coin,
        status: "open",
        orderBy: "best_rate",
        orderType: "desc",
      });
      timing.offerCount = page.offers.length;
      timing.totalOffers = page.total;
      if (page.cacheStatus) timing.cacheStatus = page.cacheStatus;
      if (page.timing) timing.transport = page.timing;
      this.refreshAccounts();
      const current = this.accounts.get(account.id);
      if (!current || !current.enabled || current.tokenFingerprint !== fingerprint || current.owner !== owner ||
          (account.role === "reader" && this.accountService.generation(account.id) !== accountGeneration)) {
        timing.outcome = "discarded"; timing.discardReason = "credential_changed"; return undefined;
      }
      const key = `${job.coin}:${job.side}`;
      if ((this.acceptedSequence.get(key) ?? 0) > sequence) {
        timing.outcome = "discarded"; timing.discardReason = "superseded"; return undefined;
      }
      this.acceptedSequence.set(key, sequence);
      const live = current;
      live.health = "healthy";
      live.lastAttemptAt = account.lastAttemptAt;
      live.nextEligibleAt = account.nextEligibleAt;
      live.lastSuccessAt = this.now();
      const previous = this.lastMarketResponse.get(key);
      if (previous !== undefined) timing.coverageGapMs = Math.max(0, this.monotonicNow() - previous);
      this.lastMarketResponse.set(key, this.monotonicNow());
      timing.outcome = "success";
      live.consecutiveErrors = 0;
      delete live.lastError;
      this.persistHealth(live, true);
      return {
        ...job,
        page,
        scannedAt: live.lastSuccessAt,
        sourceAccountId: account.id,
        dispatchSequence: sequence,
      };
    } catch (error) {
      timing.outcome = "failed";
      if (owner && error instanceof QvaApiError && error.status === 429)
        this.saveOwnerReadyAt(owner, this.now() + (error.retryAfterMs ?? backoffMilliseconds(account.consecutiveErrors + 1)));
      this.refreshAccounts();
      const current = this.accounts.get(account.id);
      if (current?.enabled && current.tokenFingerprint === fingerprint && current.owner === owner &&
          (account.role !== "reader" || this.accountService.generation(account.id) === accountGeneration)) {
        current.lastAttemptAt = account.lastAttemptAt;
        this.recordFailure(current, error);
      }
      return undefined;
    } finally {
      this.claims.delete(account.id);
      timing.finishedAt = this.now();
      timing.requestMs = Math.max(0, this.monotonicNow() - started);
      try { this.onPollTiming?.(timing); } catch { /* Metrics never change the polling result. */ }
    }
  }

  status(): MarketSourceStatus {
    this.refreshAccounts();
    const runtimeAccounts = [...this.accounts.values()];
    const accounts = runtimeAccounts.map(publicStatus);
    const healthy = runtimeAccounts.filter(
      (account) => account.enabled && account.health === "healthy",
    );
    const ownerIntervals = new Map<string, number>();
    let requestsPerSecond = 0;
    for (const account of healthy) {
      if (!account.owner) requestsPerSecond += 1 / account.intervalSeconds;
      else ownerIntervals.set(account.owner, Math.max(ownerIntervals.get(account.owner) ?? 0, account.intervalSeconds));
    }
    for (const interval of ownerIntervals.values()) requestsPerSecond += 1 / interval;
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
      ["primary", primaryInterval, this.primaryOwner()],
      ...secondary.map((account) => [
        account.id,
        account.tokenFingerprint,
        account.intervalSeconds,
        account.enabled,
        account.health,
        account.qvaPayUuid,
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
      owner: this.primaryOwner(),
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
        owner: normalizeOwner(account.qvaPayUuid),
        seeded: reusable ? previous.seeded : false,
      });
    }
    this.accounts.clear();
    for (const [id, account] of next) this.accounts.set(id, account);
    this.seedSchedule();
  }

  private primaryOwner(): string | undefined {
    return normalizeOwner(this.primaryOwnerProvider ? this.primaryOwnerProvider() : this.store.get("analytics_account_uuid"));
  }

  private ownerKey(owner: string): string { return `market_reader_owner_ready:${createHash("sha256").update(owner).digest("hex")}`; }
  private ownerReadyAt(owner: string): number {
    const value = this.store.get(this.ownerKey(owner));
    if (value === undefined) return 0;
    const parsed = Number(value);
    return value.trim() && Number.isFinite(parsed) && parsed >= 0 ? parsed : Number.MAX_SAFE_INTEGER;
  }
  private saveOwnerReadyAt(owner: string, readyAt: number): void {
    this.store.set(this.ownerKey(owner), String(Math.max(this.ownerReadyAt(owner), readyAt)));
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
      account.nextEligibleAt = Math.max(
        account.nextEligibleAt,
        now + (baseInterval * index) / active.length,
      );
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

function normalizeOwner(value: string | undefined): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim().toLowerCase() : undefined;
}

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/\b\d+\|[A-Za-z0-9._~-]+\b/g, "[redacted]")
    .slice(0, 300);
}
