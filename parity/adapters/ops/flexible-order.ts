/**
 * Operaciones de conformidad para `src/flexible-order.ts`.
 *
 * Ops puras (sin red, sin store, sin reloj de sistema):
 *  - `flexible.size`: dimensiona una oferta flexible por saldo/disponible/máximo.
 *  - `flexible.orderForOperation`: proyecta el estado de la orden hija sobre el
 *    padre y calcula su fecha financiera.
 *  - `flexible.matchingRecoveryOrder`: elige la orden de recuperación inequívoca.
 *
 * Salidas canónicas: importes QUSD, importes fiat (receive crudo) y tasas como
 * string decimal de escala fija 8.
 */
import {
  matchingRecoveryOrder,
  orderForOperation,
  sizeFlexibleOffer,
} from "../../../src/flexible-order.js";
import type { P2pOffer, P2pOrder } from "../../../src/types.js";

type Input = Record<string, unknown>;

function text(input: Input, key: string): string {
  const value = input[key];
  if (typeof value !== "string") throw new Error(`El campo ${key} debe ser texto.`);
  return value;
}

function optionalText(input: Input, key: string): string | undefined {
  return input[key] === undefined ? undefined : text(input, key);
}

function num(input: Input, key: string): number {
  const value = input[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`El campo ${key} debe ser un número finito.`);
  }
  return value;
}

function obj(input: Input, key: string): Input {
  const value = input[key];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`El campo ${key} debe ser un objeto.`);
  }
  return value as Input;
}

/** Fixed-scale decimal string without going through a locale float formatter. */
function dec(value: number, scale = 8): string {
  if (!Number.isFinite(value)) return String(value);
  if (scale < 0 || scale > 12) throw new Error("Escala no soportada.");
  return Number(value.toFixed(scale)).toFixed(scale);
}

function orderOf(raw: Input): P2pOrder {
  const order: P2pOrder = {
    uuid: text(raw, "uuid"),
    amount: num(raw, "amount"),
    receive: num(raw, "receive"),
    status: text(raw, "status"),
  };
  const optional = ["created_at", "updated_at", "paid_at", "released_at", "cancelled_at"] as const;
  for (const key of optional) {
    if (raw[key] !== undefined) (order as Record<string, unknown>)[key] = raw[key];
  }
  if (raw.Taker !== undefined) order.Taker = raw.Taker as P2pOrder["Taker"];
  return order;
}

function offerOf(raw: Input): P2pOffer {
  const offer: P2pOffer = {
    uuid: text(raw, "uuid"),
    type: text(raw, "type") as P2pOffer["type"],
    coin: text(raw, "coin"),
    amount: num(raw, "amount"),
    receive: num(raw, "receive"),
    status: text(raw, "status") as P2pOffer["status"],
  };
  const optional = [
    "offer_kind",
    "available_amount",
    "order_min",
    "order_max",
    "only_kyc",
    "only_vip",
    "private",
    "created_at",
    "updated_at",
  ] as const;
  for (const key of optional) {
    if (raw[key] !== undefined) (offer as Record<string, unknown>)[key] = raw[key];
  }
  if (raw.details !== undefined) offer.details = raw.details as Record<string, string>;
  if (raw.tags !== undefined) offer.tags = raw.tags as string[];
  if (raw.Orders !== undefined) offer.Orders = (raw.Orders as Input[]).map(orderOf);
  return offer;
}

function rateOf(amount: number, receive: number): number {
  return amount === 0 ? 0 : receive / amount;
}

/** Subconjunto estable y suficiente para verificar la orden hija. */
function orderProjection(offer: P2pOffer) {
  return {
    uuid: offer.uuid,
    type: offer.type,
    coin: offer.coin,
    amount: dec(offer.amount),
    receive: dec(offer.receive),
    rate: dec(rateOf(offer.amount, offer.receive)),
    status: offer.status,
    updated_at: offer.updated_at ?? null,
  };
}

export const ops = {
  "flexible.size": (input: Input) => {
    const offer = offerOf(obj(input, "offer"));
    const limit = input.limit === undefined ? Number.POSITIVE_INFINITY : num(input, "limit");
    const sized = sizeFlexibleOffer(offer, num(input, "capacity"), limit);
    if (!sized) return null;
    return {
      uuid: sized.uuid,
      type: sized.type,
      coin: sized.coin,
      amount: dec(sized.amount),
      receive: dec(sized.receive),
      rate: dec(rateOf(sized.amount, sized.receive)),
      status: sized.status,
      offer_kind: sized.offer_kind ?? null,
    };
  },

  "flexible.orderForOperation": (input: Input) => {
    const offer = offerOf(obj(input, "offer"));
    const orderUuid = optionalText(input, "orderUuid");
    return orderProjection(orderForOperation(offer, orderUuid));
  },

  "flexible.matchingRecoveryOrder": (input: Input) => {
    const offer = offerOf(obj(input, "offer"));
    const account = optionalText(input, "account");
    const match = matchingRecoveryOrder(offer, num(input, "amount"), num(input, "since"), account);
    if (!match) return null;
    return {
      uuid: match.uuid,
      status: match.status,
      amount: dec(match.amount),
      receive: dec(match.receive),
      created_at: match.created_at ?? null,
    };
  },
};
