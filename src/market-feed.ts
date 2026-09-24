import { createHmac, timingSafeEqual } from "node:crypto";
import type { PollingMarketSource } from "./market-source.js";
import type { MarketDataSource, MarketPageUpdate, MarketSourceStatus } from "./market-source.js";
import type { Store } from "./store.js";
import type { P2pOffer } from "./types.js";
import type { Vault } from "./vault.js";

export type MarketSourceMode = "polling" | "webhook";

export interface MarketFeedHeaders {
  signature?: string;
  timestamp?: string;
}

export class MarketFeedRequestError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export class MarketSourceCoordinator implements MarketDataSource {
  private processing = false;

  constructor(
    private readonly store: Store,
    private readonly vault: Vault,
    private readonly polling: PollingMarketSource,
    private readonly webhookUrl: string,
    private readonly ingest: (offer: P2pOffer, receivedAt: number) => Promise<unknown>,
    private readonly canProcess: () => boolean = () => true,
    private readonly now: () => number = Date.now,
  ) {}

  mode(): MarketSourceMode {
    return this.store.get("market_source_mode") === "webhook"
      ? "webhook"
      : "polling";
  }

  setMode(mode: MarketSourceMode): void {
    if (mode !== "polling" && mode !== "webhook")
      throw new Error("Modo de fuente de mercado inválido.");
    if (mode === "webhook" && !this.hasSecret())
      throw new Error("Guarda primero el secreto del webhook de QvaPay.");
    this.store.set("market_source_mode", mode);
    if (mode === "polling") this.store.ignorePendingMarketFeedEvents();
    this.store.audit(
      "market_source_changed",
      `Fuente de mercado cambiada a ${mode}.`,
    );
    if (mode === "webhook") queueMicrotask(() => void this.processNext());
  }

  saveWebhookSecret(secret: string): void {
    const normalized = secret.trim();
    if (normalized.length < 16 || normalized.length > 512)
      throw new Error("El secreto del webhook debe tener entre 16 y 512 caracteres.");
    this.store.set("market_feed_secret", this.vault.encrypt(normalized));
    this.store.audit("market_feed_secret_rotated", "Se guardó un nuevo secreto cifrado para el feed P2P.");
  }

  hasSecret(): boolean {
    return Boolean(this.store.get("market_feed_secret"));
  }

  async pollNext(): Promise<MarketPageUpdate | undefined> {
    if (this.mode() !== "polling") return undefined;
    return this.polling.pollNext();
  }

  status(): MarketSourceStatus {
    const polling = this.polling.status();
    const counts = this.store.marketFeedEventCounts();
    return {
      ...polling,
      mode: this.mode(),
      webhookUrl: this.webhookUrl,
      webhookSecretConfigured: this.hasSecret(),
      lastWebhookReceivedAt: optionalStoredNumber(this.store, "market_feed_last_received_at"),
      lastWebhookProcessedAt: optionalStoredNumber(this.store, "market_feed_last_processed_at"),
      pendingWebhookEvents: counts.pending,
      failedWebhookEvents: counts.failed,
      ...(this.store.get("market_feed_last_error")
        ? { lastWebhookError: this.store.get("market_feed_last_error")! }
        : {}),
    };
  }

  acceptWebhook(rawBody: Buffer, headers: MarketFeedHeaders): {
    duplicate: boolean;
    queued: boolean;
  } {
    if (!rawBody.length || rawBody.length > 10_000)
      throw new MarketFeedRequestError(400, "Payload del feed inválido.");
    const secret = this.secret();
    const timestamp = parseTimestamp(headers.timestamp);
    if (Math.abs(this.now() - timestamp) > 5 * 60_000)
      throw new MarketFeedRequestError(401, "Timestamp del feed vencido.");
    verifySignature(rawBody, headers.signature, secret);
    const payload = parseFeedPayload(rawBody);
    const key = `${payload.event}:${payload.data.uuid}`;
    const queued = this.mode() === "webhook" && payload.event === "p2p.created";
    const inserted = this.store.enqueueMarketFeedEvent({
      key,
      event: payload.event,
      payload,
      state: queued ? "pending" : "ignored",
      receivedAt: this.now(),
    });
    this.store.set("market_feed_last_received_at", String(this.now()));
    this.store.set("market_feed_last_error", "");
    if (inserted)
      this.store.audit(
        queued ? "market_feed_received" : "market_feed_ignored",
        queued
          ? `Oferta ${payload.data.uuid} recibida por webhook.`
          : `Evento ${payload.event} recibido con la fuente ${this.mode()}.`,
        payload.data.uuid,
      );
    if (queued && inserted) queueMicrotask(() => void this.processNext());
    return { duplicate: !inserted, queued: queued && inserted };
  }

  async processNext(): Promise<boolean> {
    if (this.processing || this.mode() !== "webhook" || !this.canProcess()) return false;
    const event = this.store.nextMarketFeedEvent(this.now());
    if (!event) return false;
    this.processing = true;
    try {
      const payload = normalizeStoredPayload(event.payload);
      if (payload.event !== "p2p.created" || payload.data.status !== "open") {
        this.store.completeMarketFeedEvent(event.key, "ignored");
        return true;
      }
      await this.ingest(payload.data, event.receivedAt);
      this.store.completeMarketFeedEvent(event.key, "processed");
      this.store.set("market_feed_last_processed_at", String(this.now()));
      this.store.set("market_feed_last_error", "");
      this.store.audit(
        "market_feed_processed",
        `Oferta ${payload.data.uuid} procesada desde el webhook.`,
        payload.data.uuid,
      );
      return true;
    } catch (error) {
      const message = safeError(error);
      this.store.failMarketFeedEvent(event.key, message, this.now());
      this.store.set("market_feed_last_error", message);
      this.store.audit("market_feed_processing_error", message);
      return false;
    } finally {
      this.processing = false;
    }
  }

  private secret(): string {
    const encrypted = this.store.get("market_feed_secret");
    if (!encrypted)
      throw new MarketFeedRequestError(503, "El webhook todavía no está configurado.");
    try {
      return this.vault.decrypt(encrypted);
    } catch {
      throw new MarketFeedRequestError(503, "No se pudo abrir el secreto del webhook.");
    }
  }
}

interface FeedPayload {
  event: string;
  sent_at: string;
  data: P2pOffer;
}

function parseFeedPayload(rawBody: Buffer): FeedPayload {
  let value: unknown;
  try {
    value = JSON.parse(rawBody.toString("utf8"));
  } catch {
    throw new MarketFeedRequestError(400, "El payload del feed no es JSON válido.");
  }
  return normalizeStoredPayload(value);
}

function normalizeStoredPayload(value: unknown): FeedPayload {
  if (!isRecord(value) || typeof value.event !== "string" || typeof value.sent_at !== "string" || !isRecord(value.data))
    throw new MarketFeedRequestError(400, "Payload del feed incompleto.");
  const data = value.data;
  if (
    typeof data.uuid !== "string" || !/^[A-Za-z0-9-]{8,100}$/.test(data.uuid) ||
    (data.type !== "buy" && data.type !== "sell") ||
    typeof data.coin !== "string" || !/^[A-Z0-9_]{2,40}$/.test(data.coin) ||
    !positiveNumber(data.amount) || !positiveNumber(data.receive) ||
    typeof data.status !== "string"
  ) throw new MarketFeedRequestError(400, "Oferta del feed inválida.");
  return {
    event: value.event,
    sent_at: value.sent_at,
    data: {
      ...(data as unknown as P2pOffer),
      uuid: data.uuid,
      type: data.type,
      coin: data.coin,
      amount: Number(data.amount),
      receive: Number(data.receive),
      status: data.status,
    },
  };
}

function verifySignature(rawBody: Buffer, header: string | undefined, secret: string): void {
  const received = (header ?? "").replace(/^sha256=/i, "").trim().toLowerCase();
  const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
  const receivedBuffer = Buffer.from(received, "hex");
  const expectedBuffer = Buffer.from(expected, "hex");
  if (
    !/^[a-f0-9]{64}$/.test(received) ||
    receivedBuffer.length !== expectedBuffer.length ||
    !timingSafeEqual(receivedBuffer, expectedBuffer)
  ) throw new MarketFeedRequestError(401, "Firma del feed inválida.");
}

function parseTimestamp(value: string | undefined): number {
  if (!value) throw new MarketFeedRequestError(401, "Falta el timestamp del feed.");
  const numeric = Number(value);
  const timestamp = Number.isFinite(numeric)
    ? numeric < 10_000_000_000 ? numeric * 1_000 : numeric
    : Date.parse(value);
  if (!Number.isFinite(timestamp))
    throw new MarketFeedRequestError(401, "Timestamp del feed inválido.");
  return timestamp;
}

function positiveNumber(value: unknown): boolean {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalStoredNumber(store: Store, key: string): number | null {
  const value = Number(store.get(key));
  return Number.isFinite(value) && value > 0 ? value : null;
}

function safeError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .slice(0, 500);
}
