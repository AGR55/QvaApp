import type { Store } from "./store.js";
import type { P2pOffer } from "./types.js";
import type { ApplyTiming } from "./qvapay.js";
import type { NotificationInput } from "./notification-dispatcher.js";

interface Evaluation {
  receivedAt: number;
  sentAt: string;
  finishedAt: number;
  reason: string;
}

/** Observability only: never sends a financial request or holds the decision queue. */
export class OfferRaceMonitor {
  constructor(private readonly store: Store,
    private readonly publish: (input: NotificationInput) => Promise<void>,
    private readonly watchedMarket: (coin: string) => string | undefined,
    private readonly ownOffer: (offer: P2pOffer) => boolean,
    private readonly now = Date.now) {}

  async evaluated(offer: P2pOffer, receivedAt: number, sentAt: string, reason: string): Promise<void> {
    if (!this.watchedMarket(offer.coin) || this.ownOffer(offer)) return;
    this.store.audit("offer_evaluation", JSON.stringify({ receivedAt, sentAt, finishedAt: this.now(), reason: reason.slice(0,500) }),offer.uuid);
    if (!nonVip(offer.only_vip) || /VIP|KYC/i.test(reason)) return;
    if (/QvaPay rechazó|Sin cupo de aplicación/.test(reason)) {
      await this.publish({message:`🧾 Intento no realizado o rechazado · ${this.watchedMarket(offer.coin)}\n${offer.amount} QUSD · tasa ${(offer.receive/offer.amount).toFixed(6)}\n${reason}\nEsto por sí solo no confirma que otro usuario la tomara.\nOferta: ${offer.uuid}`,
        event:{kind:"offer-rejected",uuid:offer.uuid,eventVersion:offer.updated_at ?? sentAt}});
    }
    const latest=this.store.latestMarketFeedState(offer.uuid);
    if(latest?.event==="p2p.applied" && latest.receivedAt>=receivedAt)
      await this.taken({...offer,status:"processing"},latest.receivedAt,new Date(latest.sentAt).toISOString());
  }

  async taken(offer: P2pOffer, receivedAt: number, sentAt: string): Promise<void> {
    const market=this.watchedMarket(offer.coin);
    if (!market || !nonVip(offer.only_vip) || this.ownOffer(offer) || this.store.getOperation(offer.uuid)) return;
    if (this.store.get(`cooperative_owner_fiat:${offer.uuid}`)) return;
    const intent=this.store.latestOfferMutation(offer.uuid);
    // An in-flight, confirmed or uncertain own application may be the source
    // of the very same applied event. Never label that as a lost race.
    if(intent && intent.state!=="rejected") return;
    const recorded=this.read<Evaluation>(offer.uuid,"offer_evaluation");
    const evaluation=recorded && recorded.receivedAt<=receivedAt && receivedAt-recorded.receivedAt<=60_000 ? recorded : undefined;
    if (evaluation && /VIP|KYC/i.test(evaluation.reason)) return;
    const timing=this.read<ApplyTiming>(offer.uuid,"offer_apply_timing");
    const relevant=timing && timing.queuedAt >= (evaluation?.receivedAt ?? receivedAt-60_000) ? timing : undefined;
    const lines=[`🏁 Oferta ocupada · ${market} · no VIP`,
      `${offer.type==="sell" ? "Compra" : "Venta"} de ${offer.amount} QUSD · tasa ${(offer.receive/offer.amount).toFixed(6)}`,
      relevant?.dispatchedAt ? "Nuestro intento no obtuvo la oferta." : "No consta una aplicación nuestra enviada para esta oferta.",
      `Decisión: ${evaluation?.reason ?? "Sin evaluación local previa registrada"}.`];
    if(evaluation) {
      const published=Date.parse(evaluation.sentAt);
      if(Number.isFinite(published)) lines.push(`Entrega del evento: ${Math.max(0,evaluation.receivedAt-published)} ms.`);
      if(relevant?.dispatchedAt) lines.push(`Recepción → envío: ${Math.max(0,relevant.dispatchedAt-evaluation.receivedAt)} ms; cola de envío: ${relevant.dispatchedAt-relevant.queuedAt} ms; respuesta QvaPay: ${relevant.finishedAt-relevant.dispatchedAt} ms.`);
    }
    lines.push("Confirmado por p2p.applied; el evento no identifica si fue una persona o un bot.",`Oferta: ${offer.uuid}`);
    const message=lines.join("\n");
    this.store.audit("offer_taken_trace",message,offer.uuid);
    await this.publish({message,event:{kind:"offer-taken",uuid:offer.uuid,eventVersion:sentAt}});
  }

  private read<T>(uuid: string, action: string): T | undefined {
    const row=this.store.latestOfferAudit(uuid,action);
    if(!row) return;
    try { return JSON.parse(row.detail) as T; } catch { return; }
  }
}

function nonVip(value: unknown): boolean { return value===false || value===0 || value==="0" || value==="false"; }
