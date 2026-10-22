import { createHmac, timingSafeEqual } from "node:crypto";
import type { PollingMarketSource } from "./market-source.js";
import type { MarketDataSource, MarketPageUpdate, MarketSourceStatus } from "./market-source.js";
import type { MarketFeedEvent, Store } from "./store.js";
import type { P2pFeedEvent, P2pOffer } from "./types.js";
import type { Vault } from "./vault.js";
import {
  QvaPayFeedStream,
  type QvaPayStreamRuntime,
  type QvaPayStreamState,
} from "./qvapay-feed-stream.js";

export type MarketSourceMode = "polling" | "hybrid";

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
  private wakeOpportunities?: () => void;
  private processingState = false;
  private recoveryRequested = false;
  private lastRecoveryPollAt = 0;
  private readonly stream: QvaPayFeedStream;
  private streamState: QvaPayStreamState = { phase: "idle" };

  constructor(
    private readonly store: Store,
    private readonly vault: Vault,
    private readonly polling: PollingMarketSource,
    private readonly webhookUrl: string,
    private readonly ingest: (
      offer: P2pOffer,
      receivedAt: number,
      event: "p2p.created" | "p2p.reopened" | "p2p.range_created" | "p2p.range_updated",
      sentAt: string,
    ) => Promise<unknown>,
    private readonly canProcess: () => boolean = () => true,
    private readonly now: () => number = Date.now,
    streamRuntime: QvaPayStreamRuntime = {},
    private readonly ingestState: (
      event: Exclude<P2pFeedEvent, "p2p.created" | "p2p.reopened" | "p2p.range_created" | "p2p.range_updated">,
      offer: P2pOffer,
      receivedAt: number,
      sentAt: string,
    ) => Promise<unknown> = async () => undefined,
  ) {
    this.stream = new QvaPayFeedStream(
      (payload) => this.acceptStreamPayload(payload),
      (state) => this.updateStreamState(state),
      streamRuntime,
    );
  }

  mode(): MarketSourceMode {
    const stored = this.store.get("market_source_mode");
    return stored === "hybrid" || stored === "webhook"
      ? "hybrid"
      : "polling";
  }

  setMode(mode: MarketSourceMode): void {
    if (mode !== "polling" && mode !== "hybrid")
      throw new Error("Modo de fuente de mercado inválido.");
    if (mode === "hybrid" && !this.hasWebhookSecret())
      throw new Error("Guarda primero el secreto del webhook de QvaPay.");
    const streamCredentials = mode === "hybrid"
      ? this.streamCredentials()
      : undefined;
    this.store.set("market_source_mode", mode);
    if (mode === "polling") {
      this.store.ignorePendingMarketFeedEvents();
      this.stream.stop();
    }
    this.store.audit(
      "market_source_changed",
      `Fuente de mercado cambiada a ${mode}.`,
    );
    if (mode === "hybrid") {
      this.stream.start(streamCredentials!);
      queueMicrotask(() => void this.processNext());
    }
  }

  saveWebhookSecret(secret: string): void {
    const normalized = secret.trim();
    if (normalized.length < 16 || normalized.length > 512)
      throw new Error("El secreto del webhook debe tener entre 16 y 512 caracteres.");
    this.store.set("market_feed_secret", this.vault.encrypt(normalized));
    this.store.audit("market_feed_secret_rotated", "Se guardó un nuevo secreto cifrado para el feed P2P.");
  }

  saveStreamCredentials(appId: string, appSecret: string): void {
    const normalizedId = appId.trim();
    const normalizedSecret = appSecret.trim();
    if (normalizedId.length < 4 || normalizedId.length > 256)
      throw new Error("El app-id debe tener entre 4 y 256 caracteres.");
    if (normalizedSecret.length < 16 || normalizedSecret.length > 512)
      throw new Error("El app-secret debe tener entre 16 y 512 caracteres.");
    this.store.set("market_feed_app_id", this.vault.encrypt(normalizedId));
    this.store.set("market_feed_app_secret", this.vault.encrypt(normalizedSecret));
    this.store.audit("market_stream_credentials_rotated", "Se guardaron credenciales cifradas para el stream P2P.");
    if (this.mode() === "hybrid") this.startStream();
  }

  start(): void {
    if (this.mode() === "hybrid" && this.hasStreamCredentials()) this.startStream();
  }

  stop(): void {
    this.stream.stop();
  }

  hasWebhookSecret(): boolean {
    return Boolean(this.store.get("market_feed_secret"));
  }

  hasStreamCredentials(): boolean {
    return Boolean(this.store.get("market_feed_app_id") && this.store.get("market_feed_app_secret"));
  }

  async pollNext(): Promise<MarketPageUpdate | undefined> {
    if (this.mode() === "polling") return this.polling.pollNext();
    const disconnected = this.streamState.phase !== "connected";
    if (!disconnected && !this.recoveryRequested) return undefined;
    const now = this.now();
    if (now - this.lastRecoveryPollAt < 3_000) return undefined;
    this.lastRecoveryPollAt = now;
    const update = await this.polling.pollNext();
    if (update && !disconnected) this.recoveryRequested = false;
    return update;
  }

  status(): MarketSourceStatus {
    const polling = this.polling.status();
    const counts = this.store.marketFeedEventCounts();
    return {
      ...polling,
      mode: this.mode(),
      webhookUrl: this.webhookUrl,
      webhookSecretConfigured: this.hasWebhookSecret(),
      streamCredentialsConfigured: this.hasStreamCredentials(),
      streamPhase: this.streamState.phase,
      ...(this.streamState.expiresAt ? { streamExpiresAt: this.streamState.expiresAt } : {}),
      lastStreamReceivedAt: optionalStoredNumber(this.store, "market_stream_last_received_at"),
      ...((this.streamState.error ?? this.store.get("market_stream_last_error"))
        ? { lastStreamError: this.streamState.error ?? this.store.get("market_stream_last_error")! }
        : {}),
      lastWebhookReceivedAt: optionalStoredNumber(this.store, "market_feed_last_received_at"),
      lastWebhookProcessedAt: optionalStoredNumber(this.store, "market_feed_last_processed_at"),
      pendingWebhookEvents: counts.pending,
      failedWebhookEvents: counts.failed,
      ...(this.store.get("market_feed_last_error")
        ? { lastWebhookError: this.store.get("market_feed_last_error")! }
        : {}),
      lastEventLatencyMs: optionalStoredNonNegativeNumber(this.store, "market_feed_last_latency_ms"),
      lastDeliveryLagMs: optionalStoredNonNegativeNumber(this.store, "market_feed_last_delivery_lag_ms"),
      lastDecisionLatencyMs: optionalStoredNonNegativeNumber(this.store, "market_feed_last_decision_ms"),
      lastApplyQueueMs: optionalStoredNonNegativeNumber(this.store, "qva_apply_last_queue_ms"),
      lastApplyBudgetWaitMs: optionalStoredNonNegativeNumber(this.store, "qva_apply_last_budget_wait_ms"),
      lastApplyResponseMs: optionalStoredNonNegativeNumber(this.store, "qva_apply_last_response_ms"),
      ...(this.store.get("market_feed_last_outcome")
        ? { lastEventOutcome: this.store.get("market_feed_last_outcome")! }
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
    const result = this.acceptPayload(payload, "webhook");
    this.store.set("market_feed_last_received_at", String(this.now()));
    this.store.set("market_feed_last_error", "");
    return result;
  }

  async processNext(): Promise<boolean> {
    if (this.mode() !== "hybrid" || !this.canProcess()) return false;
    // State reconciliation may need remote reads. Its queue must not hold fresh
    // opportunities; pending invalidations are checked directly in SQLite.
    const stateWork = this.processStateEvents();
    if (this.processing) return stateWork;
    this.processing = true;
    let processed = false;
    const active = new Map<string, { type: "buy" | "sell"; uuid: string; work: Promise<void> }>();
    try {
      while (this.mode() === "hybrid" && this.canProcess()) {
        while (active.size < 3) {
          const blocked: Array<"buy" | "sell"> = [];
          const jobs = [...active.values()];
          if (jobs.some(job => job.type === "buy")) blocked.push("buy");
          if (jobs.filter(job => job.type === "sell").length >= 2) blocked.push("sell");
          const event = this.store.nextMarketFeedEvent(this.now(), "opportunity", [...active.keys()], blocked, jobs.map(job => job.uuid));
          if (!event) break;
          processed = true;
          const payload = event.payload as { data?: { type?: string; uuid?: string } };
          const type = payload?.data?.type === "sell" ? "sell" : "buy";
          const work = this.processEvent(event).finally(() => {
            active.delete(event.key);
            this.wakeOpportunities?.();
          });
          active.set(event.key, { type, uuid: payload.data?.uuid ?? "", work });
        }
        if (!active.size) break;
        // New arrivals may use an idle lane while another HTTP request is
        // outstanding. Keep the existing per-side and total concurrency limits.
        await new Promise<void>(resolve => {
          const wake = () => {
            if (this.wakeOpportunities === wake) delete this.wakeOpportunities;
            resolve();
          };
          this.wakeOpportunities = wake;
        });
      }
    } finally {
      await Promise.allSettled([...active.values()].map(job => job.work));
      this.processing = false;
    }
    return (await stateWork) || processed;
  }

  private async processStateEvents(): Promise<boolean> {
    if (this.processingState) return false;
    this.processingState = true;
    let processed = false;
    try {
      while (this.mode() === "hybrid" && this.canProcess()) {
        const event = this.store.nextMarketFeedEvent(this.now(), "state");
        if (!event) break;
        processed = true;
        await this.processEvent(event);
      }
      return processed;
    } finally {
      this.processingState = false;
    }
  }

  private async processEvent(event: MarketFeedEvent): Promise<void> {
    try {
      const payload = normalizeStoredPayload(event.payload);
      if (!isMarketFeedEvent(payload.event)) {
        this.store.completeMarketFeedEvent(event.key, "ignored");
        return;
      }
      let outcome: string = payload.event;
      if (isOpportunityEvent(payload.event) && payload.data.status === "open") {
        if (this.store.hasPendingMarketFeedInvalidation(payload.data.uuid, Date.parse(payload.sent_at))) {
          outcome = "invalidada antes de evaluar";
        } else {
          const result = await this.ingest(payload.data, event.receivedAt, payload.event, payload.sent_at);
          if (isRecord(result) && typeof result.action === "string") outcome = result.action;
        }
      } else if (!isOpportunityEvent(payload.event)) {
        await this.ingestState(payload.event, payload.data, event.receivedAt, payload.sent_at);
      }
      this.store.completeMarketFeedEvent(event.key, "processed");
      this.store.set("market_feed_last_processed_at", String(this.now()));
      this.store.set("market_feed_last_latency_ms", String(Math.max(0, this.now() - event.receivedAt)));
      this.store.set("market_feed_last_outcome", outcome.slice(0, 200));
      this.store.set("market_feed_last_error", "");
      this.store.audit("market_feed_processed",
        `Evento ${payload.event} de oferta ${payload.data.uuid} (${payload.data.coin}) procesado desde el feed: ${outcome.slice(0, 200)}.`,
        payload.data.uuid);
    } catch (error) {
      const message = safeError(error);
      this.store.failMarketFeedEvent(event.key, message, this.now());
      this.store.set("market_feed_last_error", message);
      const metadata = eventMetadata(event.payload);
      this.store.audit("market_feed_processing_error", `${metadata.text}. Error: ${message}`, metadata.uuid);
    }
  }

  private acceptStreamPayload(value: unknown): void {
    try {
      const payload = normalizeStoredPayload(value);
      this.store.set("market_stream_last_received_at", String(this.now()));
      this.acceptPayload(payload, "stream");
    } catch (error) {
      const message = safeError(error);
      this.updateStreamState({ phase: "backoff", error: message });
      this.store.audit("market_stream_payload_error", message);
    }
  }

  private acceptPayload(payload: FeedPayload, source: "webhook" | "stream"): {
    duplicate: boolean;
    queued: boolean;
  } {
    const version = typeof payload.data.updated_at === "string" && payload.data.updated_at
      ? payload.data.updated_at
      : payload.sent_at;
    const key = payload.event.startsWith("p2p.range_")
      ? `${payload.event}:${payload.data.uuid}:${version}:${payload.sent_at}:${payload.data.available_amount ?? ""}`
      : `${payload.event}:${payload.data.uuid}:${version}`;
    const queued = this.mode() === "hybrid" && isMarketFeedEvent(payload.event);
    const inserted = this.store.enqueueMarketFeedEvent({
      key,
      event: payload.event,
      payload,
      state: queued ? "pending" : "ignored",
      receivedAt: this.now(),
    });
    const sentAt = Date.parse(payload.sent_at);
    if (inserted && Number.isFinite(sentAt))
      this.store.set(
        "market_feed_last_delivery_lag_ms",
        String(Math.max(0, this.now() - sentAt)),
      );
    if (inserted)
      this.store.audit(
        queued ? "market_feed_received" : "market_feed_ignored",
        queued
          ? `Evento ${payload.event} de oferta ${payload.data.uuid} (${payload.data.coin}) recibido por ${source}.`
          : `Evento ${payload.event} de oferta ${payload.data.uuid} (${payload.data.coin}) recibido por ${source} con la fuente ${this.mode()}.`,
        payload.data.uuid,
      );
    if (queued && inserted) {
      if (isOpportunityEvent(payload.event)) this.wakeOpportunities?.();
      queueMicrotask(() => void this.processNext());
    }
    return { duplicate: !inserted, queued: queued && inserted };
  }

  private startStream(): void {
    const credentials = this.streamCredentials();
    this.stream.start(credentials);
  }

  private streamCredentials(): { appId: string; appSecret: string } {
    const encryptedId = this.store.get("market_feed_app_id");
    const encryptedSecret = this.store.get("market_feed_app_secret");
    if (!encryptedId || !encryptedSecret)
      throw new Error("Faltan las credenciales de app para el stream de QvaPay.");
    try {
      return {
        appId: this.vault.decrypt(encryptedId),
        appSecret: this.vault.decrypt(encryptedSecret),
      };
    } catch {
      throw new Error("No se pudieron abrir las credenciales del stream.");
    }
  }

  private updateStreamState(state: QvaPayStreamState): void {
    const previous = this.streamState.phase;
    this.streamState = state;
    if (state.phase === "connected" && previous !== "connected")
      this.recoveryRequested = true;
    if (state.error) this.store.set("market_stream_last_error", safeError(state.error));
    else if (state.phase === "connected") this.store.set("market_stream_last_error", "");
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

function isOpportunityEvent(event: string): event is "p2p.created" | "p2p.reopened" | "p2p.range_created" | "p2p.range_updated" {
  return event === "p2p.created" || event === "p2p.reopened" || event === "p2p.range_created" || event === "p2p.range_updated";
}

function isMarketFeedEvent(event: string): event is P2pFeedEvent {
  return isOpportunityEvent(event) ||
    event === "p2p.applied" ||
    event === "p2p.paid" ||
    event === "p2p.completed" ||
    event === "p2p.cancelled" || event === "p2p.range_closed";
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

function optionalStoredNonNegativeNumber(store: Store, key: string): number | null {
  const raw = store.get(key);
  if (raw === undefined || raw === "") return null;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

function safeError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .slice(0, 500);
}

function eventMetadata(value: unknown): { text: string; uuid?: string } {
  if (!isRecord(value)) return { text: "Evento de feed inválido" };
  const event = typeof value.event === "string" && isMarketFeedEvent(value.event)
    ? value.event
    : "evento desconocido";
  const data = isRecord(value.data) ? value.data : undefined;
  const uuid = typeof data?.uuid === "string" && /^[A-Za-z0-9-]{8,100}$/.test(data.uuid)
    ? data.uuid
    : undefined;
  const coin = typeof data?.coin === "string" && /^[A-Z0-9_]{2,40}$/.test(data.coin)
    ? data.coin
    : "mercado desconocido";
  return {
    text: `Evento ${event}${uuid ? ` de oferta ${uuid}` : ""} (${coin})`,
    ...(uuid ? { uuid } : {}),
  };
}
