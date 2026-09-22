import { createHash, randomUUID } from "node:crypto";
import type { MarketListingGateway } from "./core/ports.js";
import { QvaPayClient } from "./qvapay.js";
import type {
  MarketReaderAccount,
  MarketReaderHealth,
  Store,
} from "./store.js";
import type { Vault } from "./vault.js";

export interface PublicMarketReaderAccount {
  id: string;
  label: string;
  qvaPayUuid?: string;
  intervalSeconds: number;
  enabled: boolean;
  health: MarketReaderHealth;
  lastSuccessAt: number | null;
  lastAttemptAt: number | null;
  nextEligibleAt: number;
  consecutiveErrors: number;
  lastError?: string;
  tokenConfigured: true;
  createdAt: number;
  updatedAt: number;
}

type ReaderFactory = (token: string) => MarketListingGateway;

export class MarketAccountService {
  constructor(
    private readonly store: Store,
    private readonly vault: Vault,
    private readonly readerFactory: ReaderFactory = (token) =>
      new QvaPayClient(() => token),
  ) {}

  list(): PublicMarketReaderAccount[] {
    return this.store.marketReaderAccounts().map(publicAccount);
  }

  internalAccounts(): MarketReaderAccount[] {
    return this.store.marketReaderAccounts();
  }

  reader(account: MarketReaderAccount): MarketListingGateway {
    return this.readerFactory(this.vault.decrypt(account.encryptedToken));
  }

  async add(input: {
    label: string;
    token: string;
    intervalSeconds: number;
  }): Promise<PublicMarketReaderAccount> {
    const normalized = validateInput(input);
    await validateReader(this.readerFactory(normalized.token));
    let account: MarketReaderAccount;
    try {
      account = this.store.createMarketReaderAccount({
        id: randomUUID(),
        label: normalized.label,
        encryptedToken: this.vault.encrypt(normalized.token),
        tokenFingerprint: fingerprint(normalized.token),
        intervalSeconds: normalized.intervalSeconds,
      });
    } catch (error) {
      if (error instanceof Error && /token_fingerprint|UNIQUE/i.test(error.message))
        throw new Error("Esta cuenta lectora ya está vinculada.");
      throw error;
    }
    this.store.audit(
      "market_reader_added",
      `Cuenta lectora añadida: ${account.label}.`,
    );
    return publicAccount(account);
  }

  update(
    id: string,
    input: Partial<{
      label: string;
      intervalSeconds: number;
      enabled: boolean;
    }>,
  ): PublicMarketReaderAccount {
    const current = required(this.store.marketReaderAccount(id));
    const label = input.label === undefined
      ? current.label
      : validateLabel(input.label);
    const intervalSeconds = input.intervalSeconds === undefined
      ? current.intervalSeconds
      : validateInterval(input.intervalSeconds);
    const updated = required(
      this.store.updateMarketReaderAccount(id, {
        label,
        intervalSeconds,
        ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
      }),
    );
    this.store.audit(
      "market_reader_updated",
      `Cuenta lectora actualizada: ${updated.label}.`,
    );
    return publicAccount(updated);
  }

  async rotate(id: string, token: string): Promise<PublicMarketReaderAccount> {
    const current = required(this.store.marketReaderAccount(id));
    const normalized = validateToken(token);
    await validateReader(this.readerFactory(normalized));
    const updated = required(
      this.store.updateMarketReaderAccount(id, {
        encryptedToken: this.vault.encrypt(normalized),
        tokenFingerprint: fingerprint(normalized),
        qvaPayUuid: null,
      }),
    );
    this.store.audit(
      "market_reader_token_rotated",
      `Token rotado para la cuenta lectora ${current.label}.`,
    );
    return publicAccount(updated);
  }

  remove(id: string): void {
    const current = required(this.store.marketReaderAccount(id));
    if (!this.store.deleteMarketReaderAccount(id))
      throw new Error("La cuenta lectora no existe.");
    this.store.audit(
      "market_reader_removed",
      `Cuenta lectora eliminada: ${current.label}.`,
    );
  }
}

function publicAccount(account: MarketReaderAccount): PublicMarketReaderAccount {
  return {
    id: account.id,
    label: account.label,
    ...(account.qvaPayUuid ? { qvaPayUuid: account.qvaPayUuid } : {}),
    intervalSeconds: account.intervalSeconds,
    enabled: account.enabled,
    health: account.health,
    lastSuccessAt: account.lastSuccessAt,
    lastAttemptAt: account.lastAttemptAt,
    nextEligibleAt: account.nextEligibleAt,
    consecutiveErrors: account.consecutiveErrors,
    ...(account.lastError ? { lastError: account.lastError } : {}),
    tokenConfigured: true,
    createdAt: account.createdAt,
    updatedAt: account.updatedAt,
  };
}

async function validateReader(reader: MarketListingGateway): Promise<void> {
  try {
    await reader.listOffersPage({ take: 1, page: 1, status: "open" });
  } catch (error) {
    throw new Error(`QvaPay no validó el token p2p:read: ${safeError(error)}`);
  }
}

function validateInput(input: {
  label: string;
  token: string;
  intervalSeconds: number;
}) {
  return {
    label: validateLabel(input.label),
    token: validateToken(input.token),
    intervalSeconds: validateInterval(input.intervalSeconds),
  };
}

function validateLabel(value: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 60)
    throw new Error("La etiqueta debe tener entre 1 y 60 caracteres.");
  return normalized;
}

function validateToken(value: string): string {
  const normalized = value.trim();
  if (normalized.length < 12 || normalized.length > 2_048)
    throw new Error("El token de lectura no tiene un formato válido.");
  return normalized;
}

function validateInterval(value: number): number {
  if (!Number.isFinite(value) || value < 3 || value > 3_600)
    throw new Error("El intervalo debe estar entre 3 y 3600 segundos.");
  return value;
}

function fingerprint(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function required<T>(value: T | undefined): T {
  if (!value) throw new Error("La cuenta lectora no existe.");
  return value;
}

function safeError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/\b\d+\|[A-Za-z0-9._~-]+\b/g, "[redacted]")
    .slice(0, 240);
}
