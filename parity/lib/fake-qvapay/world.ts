/**
 * Mundo determinista del fake QvaPay.
 *
 * Estado en memoria que hace que los escenarios con cassette sean stateful sin
 * reloj real ni azar: ofertas, usuario, transacciones, chat, IDs deterministas
 * y dedupe de webhooks (K5/K13). El cassette decide las respuestas; `effects`
 * declara los cambios de estado para que un `GET` posterior pueda leerlos.
 */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";

import type { WorldEffect, WorldSeed } from "./types.js";
import type { VirtualClock } from "./clock.js";

/** 32+ caracteres, fijo: el cassette calcula la firma con este secreto. */
export const DEFAULT_WEBHOOK_SECRET = "whsec_fake_qvapay_0123456789abcdef";

export const MARKET_FEED_EVENTS = new Set([
  "p2p.created",
  "p2p.reopened",
  "p2p.resumed",
  "p2p.paused",
  "p2p.applied",
  "p2p.paid",
  "p2p.completed",
  "p2p.cancelled",
  "p2p.range_created",
  "p2p.range_updated",
  "p2p.range_closed",
]);

export interface WebhookPayload {
  event: string;
  sent_at: string;
  data: Record<string, unknown>;
}

export interface WebhookRecord {
  key: string;
  event: string;
  uuid: string;
  receivedAt: number;
  payload: WebhookPayload;
}

export interface AppliedOrderRecord {
  uuid: string;
  order: string;
  at: number;
}

/** Error de validación del webhook entrante (mapea a status HTTP). */
export class WebhookValidationError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "WebhookValidationError";
  }
}

export class FakeWorld {
  user: Record<string, unknown>;
  offers: Record<string, unknown>[];
  transactions: unknown[];
  chats: Record<string, unknown[]>;
  appliedOrders: AppliedOrderRecord[];
  idCounter: number;
  readonly webhookSecret: string;
  readonly webhookEvents: Map<string, WebhookRecord>;
  webhookDuplicates: number;

  constructor(
    private readonly seed: WorldSeed,
    readonly clock: VirtualClock,
    webhookSecret: string = DEFAULT_WEBHOOK_SECRET,
  ) {
    this.webhookSecret = webhookSecret;
    this.user = {};
    this.offers = [];
    this.transactions = [];
    this.chats = {};
    this.appliedOrders = [];
    this.idCounter = 0;
    this.webhookEvents = new Map();
    this.webhookDuplicates = 0;
    this.reset();
  }

  reset(): void {
    const clone = structuredClone(this.seed);
    this.user = clone.user ?? {};
    this.offers = clone.offers ?? [];
    this.transactions = clone.transactions ?? [];
    this.chats = clone.chats ?? {};
    this.appliedOrders = [];
    this.idCounter = 0;
    this.webhookEvents.clear();
    this.webhookDuplicates = 0;
  }

  /** IDs deterministas por ejecución: `order-0001`, `offer-0002`, … */
  nextId(prefix: string): string {
    this.idCounter += 1;
    return `${prefix}-${String(this.idCounter).padStart(4, "0")}`;
  }

  findOffer(uuid: string): Record<string, unknown> | undefined {
    return this.offers.find((offer) => offer.uuid === uuid);
  }

  applyEffects(effects: readonly WorldEffect[], at: number): void {
    for (const effect of effects) {
      switch (effect.op) {
        case "status": {
          const offer = this.requireOffer(effect.uuid, "status");
          offer.status = effect.status;
          offer.updated_at = new Date(at).toISOString();
          break;
        }
        case "patch": {
          const offer = this.requireOffer(effect.uuid, "patch");
          Object.assign(offer, effect.patch);
          offer.updated_at = new Date(at).toISOString();
          break;
        }
        case "apply": {
          const offer = this.requireOffer(effect.uuid, "apply");
          const order = effect.order ?? this.nextId("order");
          offer.status = "applied";
          offer.updated_at = new Date(at).toISOString();
          const orders = Array.isArray(offer.Orders) ? (offer.Orders as Record<string, unknown>[]) : [];
          orders.push({
            uuid: order,
            status: "applied",
            amount: offer.amount,
            receive: offer.receive,
            created_at: new Date(at).toISOString(),
          });
          offer.Orders = orders;
          this.appliedOrders.push({ uuid: effect.uuid, order, at });
          break;
        }
        case "cancel": {
          const offer = this.requireOffer(effect.uuid, "cancel");
          offer.status = effect.status ?? "cancelled";
          offer.updated_at = new Date(at).toISOString();
          break;
        }
        case "create": {
          const offer = { ...effect.offer };
          if (typeof offer.uuid !== "string" || !offer.uuid) offer.uuid = this.nextId("offer");
          if (typeof offer.status !== "string") offer.status = "open";
          this.offers.push(offer);
          break;
        }
        case "chat": {
          const messages = this.chats[effect.uuid] ?? [];
          messages.push(effect.message);
          this.chats[effect.uuid] = messages;
          break;
        }
        case "transaction": {
          this.transactions.push(effect.transaction);
          break;
        }
        default: {
          const exhaustive: never = effect;
          throw new Error(`Efecto de mundo desconocido: ${JSON.stringify(exhaustive)}`);
        }
      }
    }
  }

  private requireOffer(uuid: string, operation: string): Record<string, unknown> {
    const offer = this.findOffer(uuid);
    if (!offer) throw new Error(`effects.${operation}: oferta ${uuid} no existe en world.offers`);
    return offer;
  }

  snapshot(): Record<string, unknown> {
    return {
      virtualNow: this.clock.now(),
      user: structuredClone(this.user),
      offers: structuredClone(this.offers),
      transactions: structuredClone(this.transactions),
      chats: structuredClone(this.chats),
      appliedOrders: structuredClone(this.appliedOrders),
      idCounter: this.idCounter,
      webhook: {
        duplicates: this.webhookDuplicates,
        events: [...this.webhookEvents.values()].map((record) => structuredClone(record)),
      },
    };
  }

  /**
   * Calcula la dedupe key exactamente como `src/market-feed.ts:348-359` (K13):
   *  - `range_*`: event:uuid:version:sent_at:available_amount
   *  - `paused`/`resumed`: event:uuid:version:sent_at
   *  - resto: event:uuid:version
   * donde version = `data.updated_at` si existe, si no `sent_at`.
   */
  dedupeKey(payload: WebhookPayload): string {
    const updatedAt = payload.data.updated_at;
    const version = typeof updatedAt === "string" && updatedAt ? updatedAt : payload.sent_at;
    return payload.event.startsWith("p2p.range_")
      ? `${payload.event}:${payload.data.uuid}:${version}:${payload.sent_at}:${String(payload.data.available_amount ?? "")}`
      : payload.event === "p2p.paused" || payload.event === "p2p.resumed"
        ? `${payload.event}:${payload.data.uuid}:${version}:${payload.sent_at}`
        : `${payload.event}:${payload.data.uuid}:${version}`;
  }

  /** Persiste el evento (202 solo tras persistir) y decide `duplicate` (K5). */
  receiveWebhook(payload: WebhookPayload, at: number): { key: string; duplicate: boolean } {
    const key = this.dedupeKey(payload);
    if (this.webhookEvents.has(key)) {
      this.webhookDuplicates += 1;
      return { key, duplicate: true };
    }
    this.webhookEvents.set(key, {
      key,
      event: payload.event,
      uuid: String(payload.data.uuid),
      receivedAt: at,
      payload: structuredClone(payload),
    });
    return { key, duplicate: false };
  }
}

/* ------------------------------------------------------------------ */
/* Validación y firma del webhook entrante (K5)                        */
/* ------------------------------------------------------------------ */

export function verifyWebhookSignature(rawBody: Buffer, header: string | undefined, secret: string): void {
  const received = (header ?? "").replace(/^sha256=/i, "").trim().toLowerCase();
  const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
  const receivedBuffer = Buffer.from(received, "hex");
  const expectedBuffer = Buffer.from(expected, "hex");
  if (
    !/^[a-f0-9]{64}$/.test(received) ||
    receivedBuffer.length !== expectedBuffer.length ||
    !timingSafeEqual(receivedBuffer, expectedBuffer)
  ) {
    throw new WebhookValidationError(401, "Firma del feed inválida.");
  }
}

/** Mismo parseo de timestamp que `src/market-feed.ts:505-514`. */
export function parseWebhookTimestamp(value: string | undefined): number {
  if (!value) throw new WebhookValidationError(401, "Falta el timestamp del feed.");
  const numeric = Number(value);
  const timestamp = Number.isFinite(numeric)
    ? numeric < 10_000_000_000
      ? numeric * 1_000
      : numeric
    : Date.parse(value);
  if (!Number.isFinite(timestamp)) throw new WebhookValidationError(401, "Timestamp del feed inválido.");
  return timestamp;
}

/** Mismo parseo/validación de payload que `src/market-feed.ts:457-491`. */
export function parseFeedPayload(rawBody: Buffer): WebhookPayload {
  let value: unknown;
  try {
    value = JSON.parse(rawBody.toString("utf8"));
  } catch {
    throw new WebhookValidationError(400, "El payload del feed no es JSON válido.");
  }
  if (
    !isRecord(value) ||
    typeof value.event !== "string" ||
    typeof value.sent_at !== "string" ||
    !isRecord(value.data)
  ) {
    throw new WebhookValidationError(400, "Payload del feed incompleto.");
  }
  const data = value.data;
  if (
    typeof data.uuid !== "string" ||
    !/^[A-Za-z0-9-]{8,100}$/.test(data.uuid) ||
    (data.type !== "buy" && data.type !== "sell") ||
    typeof data.coin !== "string" ||
    !/^[A-Z0-9_]{2,40}$/.test(data.coin) ||
    !positiveNumber(data.amount) ||
    !positiveNumber(data.receive) ||
    typeof data.status !== "string"
  ) {
    throw new WebhookValidationError(400, "Oferta del feed inválida.");
  }
  return {
    event: value.event,
    sent_at: value.sent_at,
    data: {
      ...data,
      uuid: data.uuid,
      type: data.type,
      coin: data.coin,
      amount: Number(data.amount),
      receive: Number(data.receive),
      status: data.status,
    },
  };
}

/** Firma HMAC-SHA256 del body crudo, con el formato de cabecera de QvaPay. */
export function signWebhookBody(rawBody: Buffer | string, secret: string): string {
  return `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;
}

export function sha256Hex(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function positiveNumber(value: unknown): boolean {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
