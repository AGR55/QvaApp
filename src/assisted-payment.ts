import { createHash } from "node:crypto";
import { ChatCatalog } from "./chat-catalog.js";
import type { Store } from "./store.js";
import type { QvaPayClient } from "./qvapay.js";

export class AssistedPaymentError extends Error {
  constructor(public readonly status: 400 | 404 | 409, message: string) { super(message); }
}
export const assistedPaymentMarkets: Readonly<Record<string, { currency: string; kind: "card" | "phone" }>> = {
  BANK_CUP: { currency: "CUP", kind: "card" }, CLASICA: { currency: "USD", kind: "card" },
  ETECSA: { currency: "CUP", kind: "phone" },
};
const fail = (message: string): never => { throw new AssistedPaymentError(409, message); };
const fieldName = (name: string) => name.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/[_-]/g, " ");

/** Strict structured fields only. Never choose a number out of an arbitrary message. */
export function paymentDestination(details: unknown, kind: "card" | "phone") {
  if (!details || typeof details !== "object" || Array.isArray(details)) return fail("La oferta no tiene datos de pago verificables.");
  const cards = new Set<string>(), phones = new Set<string>();
  for (const [name, raw] of Object.entries(details)) {
    const label = fieldName(name);
    if (/\b(origen|emisor|pagador|sender)\b/.test(label)) continue;
    const cardField = /\b(cuenta|tarjeta|account|card)\b/.test(label);
    const phoneField = /\b(telefono|movil|celular|phone|telephone)\b/.test(label);
    if (!cardField && !phoneField) continue;
    if (typeof raw !== "string" || raw.length > 120 || !raw.trim()) return fail("Hay un campo de pago vacío o inválido en la oferta.");
    if (cardField && phoneField) return fail("La oferta mezcla tarjeta y teléfono en un mismo campo; revisa los datos.");
    const value = raw.trim();
    if (cardField) {
      if (!/^[0-9 -]+$/.test(value)) return fail("La tarjeta publicada no es un número completo y único.");
      const normalized = value.replace(/[ -]/g, "");
      if (!/^[0-9]{16}$/.test(normalized) || /^([0-9])\1+$/.test(normalized)) return fail("Se necesita una tarjeta completa de 16 dígitos; esta cuenta requiere revisión manual.");
      cards.add(normalized);
    } else {
      if (!/^\+?[0-9 ()-]+$/.test(value)) return fail("El teléfono publicado contiene datos no válidos.");
      let normalized = value.replace(/[ ()-]/g, "");
      if (normalized.startsWith("+53")) normalized = normalized.slice(3);
      else if (normalized.startsWith("53") && normalized.length === 10) normalized = normalized.slice(2);
      if (!/^5[0-9]{7}$/.test(normalized)) return fail("Se necesita un único móvil cubano de 8 dígitos.");
      phones.add(normalized);
    }
  }
  if (cards.size > 1 || phones.size > 1) return fail("La oferta contiene más de un destino de pago; no se elegirá uno automáticamente.");
  if (kind === "card" && cards.size !== 1) return fail("No se encontró una tarjeta única en los campos de la oferta.");
  if (kind === "phone" && phones.size !== 1) return fail("No se encontró un móvil destinatario único en la oferta.");
  return { destination: (kind === "card" ? [...cards][0] : [...phones][0])!, confirmationPhone: kind === "card" ? [...phones][0] ?? null : null };
}

/** Explicit operator read. This service has no payment, SMS or QvaPay mutation gateway. */
export class AssistedPaymentService {
  constructor(private readonly store: Store, private readonly qva: Pick<QvaPayClient, "profile" | "getOffer">,
    private readonly market: (code: string) => { currency: string } | undefined, private readonly now = Date.now) {}

  async prepare(uuid: string, order?: string) {
    const catalog = new ChatCatalog(this.store);
    const before = catalog.get(uuid, order);
    if (!before || before.orderUuid !== order) throw new AssistedPaymentError(404, "No existe una operación propia con esa oferta y orden exactas.");
    if (!["applied", "acknowledged", "processing"].includes(before.state)) return fail("La operación ya no admite preparar un pago.");
    if (this.store.hasUnresolvedMutationForOffer(uuid)) return fail("La operación tiene una acción pendiente de conciliación.");
    const support = assistedPaymentMarkets[before.coin];
    if (!support || this.market(before.coin)?.currency !== support.currency) return fail("Este mercado o moneda no admite pago asistido.");
    // Do not rely on cached role/Peer for an outgoing payment destination.
    const profile = await this.qva.profile();
    const offer = await this.qva.getOffer(uuid, { priority: true });
    if (offer.uuid !== uuid || offer.coin !== before.coin) return fail("La oferta consultada no coincide con la operación.");
    if (Boolean(order) !== (offer.offer_kind === "flexible")) return fail("La oferta requiere identificar su orden de rango.");
    const child = order ? offer.Orders?.find(item => item.uuid === order) : undefined;
    if (order && !child) return fail("QvaPay no devolvió la orden exacta; no se usará el importe del padre.");
    const creator = offer.User?.uuid ?? offer.owner_uuid;
    if (offer.User?.uuid && offer.owner_uuid && offer.User.uuid !== offer.owner_uuid) return fail("QvaPay devolvió propietarios incompatibles.");
    const taker = child ? child.Taker?.uuid : offer.Peer?.uuid;
    const pays = before.role === "creator" ? creator === profile.uuid && offer.type === "buy"
      : taker === profile.uuid && offer.type === "sell";
    const counterparty = before.role === "creator" ? taker : creator;
    if (!profile.uuid || !pays || !counterparty || counterparty === profile.uuid || counterparty !== before.counterpartyId)
      return fail("No se pudo verificar que seas el pagador de esta contraparte.");
    const status = child?.status ?? offer.status;
    const amount = child?.amount ?? offer.amount, receive = child?.receive ?? offer.receive;
    if (status !== "processing" || amount !== before.amount || receive !== before.receive)
      return fail("El estado o los importes cambiaron. Actualiza y revisa la operación.");
    if (!Number.isFinite(receive) || receive <= 0 || receive > 1e9 || Math.abs(receive * 100 - Math.round(receive * 100)) > 1e-6)
      return fail("El importe fiat no se puede representar exactamente con dos decimales.");
    const current = catalog.get(uuid, order);
    if (!current || current.orderUuid !== order || current.state !== before.state || current.counterpartyId !== before.counterpartyId ||
      current.amount !== before.amount || current.receive !== before.receive || this.store.hasUnresolvedMutationForOffer(uuid))
      return fail("La operación cambió durante la comprobación. Vuelve a revisarla.");
    // In a creator-buy offer, parent.details may describe the creator's own
    // account. Until per-order destination provenance exists, never pay it.
    if (before.role === "creator") return fail("Las compras creadas por ti necesitan datos de pago propios de la orden; no se usará la tarjeta del creador.");
    const destination = paymentDestination(offer.details, support.kind);
    const checkedAt = this.now();
    const data = { uuid, orderUuid: order ?? null, market: before.coin, currency: support.currency,
      amount: receive.toFixed(2), kind: support.kind, ...destination, counterpartyId: counterparty };
    return { ...data, fingerprint: createHash("sha256").update(JSON.stringify(data)).digest("hex"),
      checkedAt, expiresAt: checkedAt + 120_000, execution: "form_review" as const };
  }
}
