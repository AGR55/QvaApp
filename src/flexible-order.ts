import type { P2pOffer, P2pOrder } from "./types.js";

/** Constant-time sizing; never rounds above the available capital. */
export function sizeFlexibleOffer(offer: P2pOffer, capacity: number, limit = Infinity): P2pOffer | undefined {
  if (offer.offer_kind !== "flexible") return offer;
  const available = Number(offer.available_amount), min = Number(offer.order_min), max = Number(offer.order_max);
  const quote = offer.receive / offer.amount;
  if (![available, min, max, quote, capacity].every(Number.isFinite) ||
    min <= 0 || max < min || available <= 0 || quote <= 0 || capacity <= 0) return;
  const amount = Math.floor(Math.min(available, max, capacity, limit) * 100) / 100;
  if (amount < min || amount <= 0) return;
  return { ...offer, amount, receive: amount * quote };
}

export function orderForOperation(offer: P2pOffer, orderUuid?: string): P2pOffer {
  if (!orderUuid) {
    if (offer.offer_kind === "flexible") throw new Error("La operación flexible requiere identificar su orden.");
    return offer;
  }
  const order = offer.Orders?.find(item => item.uuid === orderUuid);
  if (!order) throw new Error("QvaPay no devolvió la orden de esta operación; se conserva el estado local.");
  return { ...offer, amount: order.amount, receive: order.receive, status: order.status,
    ...(order.updated_at ? { updated_at: order.updated_at } : {}),
  };
}

export function matchingRecoveryOrder(offer: P2pOffer, amount: number, since: number, account?: string): P2pOrder | undefined {
  if (!account || !Number.isFinite(amount)) return;
  const matches = offer.Orders?.filter(order => order.Taker?.uuid === account && order.amount === amount &&
    Number.isFinite(Date.parse(order.created_at ?? "")) && Date.parse(order.created_at!) >= since - 5_000 &&
    Date.parse(order.created_at!) <= since + 120_000);
  return matches?.length === 1 ? matches[0] : undefined;
}
