import type { Store } from "./store.js";
import { QvaApiError, type QvaPayClient } from "./qvapay.js";
import type { HuntingSyncCoordinator, CooperativeReservation } from "./hunting-sync.js";
import type { P2pOffer, P2pFeedEvent } from "./types.js";
import { cooperativeNotificationText } from "./telegram-operation.js";

export interface CooperativeExecution {
  offer: P2pOffer; createdAt: number; updatedAt: number;
  phase: "reserving" | "reserved" | "applying" | "applied" | "committed" | "completed" | "settled" | "released" | "cancelled" | "uncertain" | "commit_pending" | "release_pending";
  reservation?: CooperativeReservation; error?: string; credited?: boolean;
}

type HunterRuntime = {
  ownBusy(): boolean;
  safetyReason(offer: P2pOffer): string | undefined;
  canReserveOwn(coin: string, fiat: number): boolean;
  ownerCost(coin: string, fiat: number): number;
  projectState?(event: "p2p.paid" | "p2p.completed", offer: P2pOffer): Promise<void>;
  notify(message: string, uuid: string): Promise<void>;
};
const RESOURCE = "cooperative-executions";
const MAX_AGE_MS = 5_000;

export class CooperativeHunter {
  private readonly queue = new Map<string, { offer: P2pOffer; receivedAt: number }>();
  private readonly jobs = new Map<string, CooperativeExecution>();
  private running = false;
  private stopped = false;
  private huntingEnabled: boolean;
  private retryTimer: NodeJS.Timeout | undefined;
  private drainPromise: Promise<void> | undefined;

  constructor(private readonly store: Store, private readonly sync: Pick<HuntingSyncCoordinator, "isEnabled" | "aggregate" | "reserve" | "settle">,
    private readonly qva: Pick<QvaPayClient, "secondaryApplyAvailable" | "applySecondary" | "getOffer">,
    private readonly runtime: HunterRuntime, private readonly now = Date.now) {
    this.huntingEnabled = store.get("cooperative_hunting_enabled") !== "false";
    for (const job of store.loadRemoteResource<CooperativeExecution[]>(RESOURCE)?.data ?? []) this.jobs.set(job.offer.uuid, job);
  }

  executions(): CooperativeExecution[] { return [...this.jobs.values()].filter(job => !["released", "settled"].includes(job.phase)).map(job => structuredClone(job)); }
  enabled(): boolean { return this.sync.isEnabled() && this.huntingEnabled; }
  setEnabled(enabled: boolean): void {
    this.store.set("cooperative_hunting_enabled", String(enabled));
    this.huntingEnabled = enabled;
    if (!enabled) this.queue.clear();
    this.store.audit("cooperative_hunting_changed", enabled ? "Cacería de segunda prioridad activada." : "Cacería cooperativa detenida.");
  }

  enqueue(offer: P2pOffer, receivedAt: number): void {
    if (!this.eligible(offer, receivedAt) || this.jobs.has(offer.uuid)) return;
    const snapshot: P2pOffer = { uuid: offer.uuid, type: offer.type, coin: offer.coin, amount: offer.amount, receive: offer.receive, status: offer.status,
      ...(offer.owner_uuid ? {owner_uuid:offer.owner_uuid}:{}), ...(offer.User?.uuid ? {User:{uuid:offer.User.uuid}}:{}),
      ...(offer.only_vip === undefined ? {} : {only_vip:offer.only_vip}),
      ...(offer.requirements === undefined ? {} : {requirements:offer.requirements}),
      ...(offer.requirements_met === undefined ? {} : {requirements_met:offer.requirements_met}),
      ...(offer.offer_kind ? {offer_kind:offer.offer_kind}:{}), ...(offer.updated_at ? {updated_at:offer.updated_at}:{}), };
    this.queue.set(offer.uuid, { offer: snapshot, receivedAt });
    if (this.queue.size > 100) this.queue.delete(this.queue.keys().next().value!);
    this.kick();
  }

  private kick(): void { this.drainPromise ??= this.drain().finally(() => { this.drainPromise=undefined; }); }

  private eligible(offer: P2pOffer, receivedAt: number): boolean {
    if (this.stopped || !this.enabled() || this.now() - receivedAt > MAX_AGE_MS || receivedAt > this.now() ||
      !Number.isFinite(offer.amount) || !Number.isFinite(offer.receive) || offer.amount <= 0 || offer.receive <= 0 ||
      this.runtime.safetyReason(offer)) return false;
    const aggregate = this.sync.aggregate(offer.coin, this.now());
    if (aggregate?.capacities) {
      const eligible = aggregate.capacities.filter(level => level.price >= offer.receive/offer.amount && level.minimal <= offer.receive);
      return eligible.length > 1 && eligible.reduce((sum,level) => sum + level.fiat,0) + .001 >= offer.receive;
    }
    return Boolean(aggregate && aggregate.offersCount > 1 && aggregate.price > 0 &&
      offer.receive / offer.amount <= aggregate.price && offer.receive >= aggregate.minimal && offer.receive <= aggregate.fiat);
  }

  private async drain(): Promise<void> {
    if (this.running || this.stopped) return;
    this.running = true;
    try {
      // Yield this turn so an already received primary opportunity runs first.
      await new Promise<void>(resolve => setImmediate(resolve));
      while (this.queue.size && !this.stopped) {
        for (const [key,value] of this.queue) if (this.now()-value.receivedAt>MAX_AGE_MS) this.queue.delete(key);
        if (!this.queue.size) break;
        if (this.runtime.ownBusy()) {
          this.retryTimer ??= setTimeout(() => { this.retryTimer=undefined; this.kick(); },100);
          break;
        }
        const [uuid, candidate] = this.queue.entries().next().value!;
        this.queue.delete(uuid);
        if (!this.eligible(candidate.offer, candidate.receivedAt) || this.runtime.ownBusy() || !this.qva.secondaryApplyAvailable()) continue;
        await this.take(candidate.offer, candidate.receivedAt);
      }
    } catch (error) {
      this.store.audit("cooperative_hunting_error", error instanceof Error ? error.message.slice(0,300) : "Error cooperativo");
    } finally { this.running = false; }
  }

  private save(job: CooperativeExecution, phase = job.phase, error?: string): void {
    job.phase = phase; job.updatedAt = this.now();
    if (error) job.error = error; else delete job.error;
    this.jobs.set(job.offer.uuid, job);
    const all = [...this.jobs.values()];
    for (const coin of new Set(all.map(item => item.offer.coin))) {
      const reserved = all.filter(item => item.offer.coin === coin && item.reservation &&
        !this.store.getOperation(item.offer.uuid) && !["released", "settled"].includes(item.phase))
        .reduce((sum,item) => sum + this.runtime.ownerCost(coin, item.reservation!.ownerFiat), 0);
      this.store.set(`cooperative_fiat_reserved:${coin}`, String(reserved));
    }
    const terminal = all.filter(item => ["released", "settled"].includes(item.phase)).slice(-500);
    const retained = new Set(terminal.map(item => item.offer.uuid));
    for (const item of all) if (["released", "settled"].includes(item.phase) && !retained.has(item.offer.uuid)) this.jobs.delete(item.offer.uuid);
    this.store.saveRemoteResource(RESOURCE, [...all.filter(item => !["released", "settled"].includes(item.phase)), ...terminal]);
  }

  private async take(offer: P2pOffer, receivedAt: number): Promise<void> {
    const job: CooperativeExecution = { offer, createdAt: this.now(), updatedAt: this.now(), phase: "reserving" };
    this.save(job);
    try {
      job.reservation = await this.sync.reserve(offer);
      if (job.reservation.state !== "reserved") { this.save(job, "uncertain", "La reserva ya tenía un estado terminal; no se reaplicó."); return; }
      this.save(job, "reserved");
      if (!this.enabled() || this.runtime.safetyReason(offer) || this.now() - receivedAt > MAX_AGE_MS ||
        this.runtime.ownBusy() || !this.qva.secondaryApplyAvailable() ||
        !this.runtime.canReserveOwn(offer.coin, job.reservation.ownerFiat)) {
        await this.release(job); return;
      }
      this.store.set(`cooperative_owner_fiat:${offer.uuid}`, String(job.reservation.ownerFiat));
      this.save(job, "applying");
      try {
        await this.qva.applySecondary(offer.uuid, () => !this.runtime.ownBusy() &&
          !this.runtime.safetyReason(offer) && this.now() - receivedAt <= MAX_AGE_MS && this.enabled() &&
          this.runtime.canReserveOwn(offer.coin, job.reservation!.ownerFiat));
      } catch (error) {
        if (error instanceof QvaApiError && error.status >= 400 && error.status < 500) { await this.release(job); return; }
        throw error;
      }
      this.save(job, "applied");
      await this.projectOperation(job);
      await this.commit(job);
      void this.runtime.notify(cooperativeNotificationText({ uuid: offer.uuid, amount: offer.amount,
        receive: offer.receive, coin: offer.coin, ownerFiat: job.reservation.ownerFiat,
        owedQusd: job.reservation.contributions.reduce((sum,row) => sum + row.qusd,0) }), offer.uuid);
    } catch (error) {
      const definitiveReservationRejection = job.phase === "reserving" && error instanceof Error && "status" in error &&
        typeof error.status === "number" && error.status >= 400 && error.status < 500;
      this.save(job, definitiveReservationRejection ? "released" : "uncertain", error instanceof Error ? error.message.slice(0,300) : "Resultado incierto");
      if (!definitiveReservationRejection) void this.runtime.notify(`⚠️ Cacería cooperativa pendiente de comprobar: ${offer.uuid}. Se retuvo la reserva para evitar gastar el mismo fiat. Revisa Cacerías conjuntas.`, offer.uuid);
    }
  }

  private async projectOperation(job: CooperativeExecution): Promise<void> {
    if (!job.reservation) return;
    this.store.set(`cooperative_owner_fiat:${job.offer.uuid}`, String(job.reservation.ownerFiat));
    if (!this.store.getOperation(job.offer.uuid)) this.store.createOperation({ uuid: job.offer.uuid, offerType: "sell",
      coin: job.offer.coin, amount: job.offer.amount, receive: job.offer.receive, rate: job.offer.receive/job.offer.amount,
      state: "acknowledged", autoApplied: true, cancelAt: null, createdAt: job.createdAt,
      ...(job.offer.User?.uuid ?? job.offer.owner_uuid ? { counterpartyId: (job.offer.User?.uuid ?? job.offer.owner_uuid)! } : {}) });
    // A feed event can beat the HTTP apply acknowledgement. Replay its durable
    // evidence only after this account's successful application is established.
    const latest = this.store.latestMarketFeedState(job.offer.uuid);
    if (latest && latest.receivedAt >= job.createdAt && (latest.event === "p2p.completed" || latest.event === "p2p.paid")) {
      const offer = { ...job.offer, status: latest.event === "p2p.completed" ? "completed" as const : "paid" as const };
      await this.runtime.projectState?.(latest.event, offer);
      if (latest.event === "p2p.completed") {
        job.credited = true;
        this.save(job);
        this.updateOwed();
      }
    }
  }

  private async commit(job: CooperativeExecution): Promise<void> {
    this.save(job, "commit_pending");
    try { await this.sync.settle(job.offer.uuid, "commit"); this.save(job, job.credited ? "completed" : "committed"); }
    catch (error) { this.save(job, "commit_pending", error instanceof Error ? error.message : "Confirmación pendiente"); }
  }
  private async release(job: CooperativeExecution): Promise<void> {
    this.save(job, "release_pending");
    try { await this.sync.settle(job.offer.uuid, "release"); this.store.set(`cooperative_owner_fiat:${job.offer.uuid}`, ""); this.save(job, "released"); }
    catch (error) { this.save(job, "release_pending", error instanceof Error ? error.message : "Liberación pendiente"); }
  }

  onState(event: P2pFeedEvent, offer: P2pOffer): void {
    const job = this.jobs.get(offer.uuid);
    const operation = this.store.getOperation(offer.uuid);
    if (job?.reservation && operation?.state === "cancelled" && event === "p2p.cancelled" && !job.credited) {
      this.save(job,"cancelled","Cacería cancelada: revisa las transferencias antes de volver a declarar el fiat del grupo.");
      return;
    }
    if (!job?.reservation || event !== "p2p.completed" || !operation || operation.state === "cancelled" ||
      !["applied", "committed", "commit_pending"].includes(job.phase)) return;
    job.credited = true;
    this.save(job, job.phase === "committed" ? "completed" : job.phase);
    this.updateOwed();
  }

  markDistributed(uuid: string): void {
    const job = this.jobs.get(uuid);
    if (!job || job.phase !== "completed") throw new Error("Solo puedes declarar repartida una cacería completada.");
    this.save(job, "settled"); this.updateOwed();
    this.store.audit("cooperative_distribution_declared", "El operador declaró transferidos los QUSD de todos los participantes.", uuid);
  }
  private updateOwed(): void {
    const total = [...this.jobs.values()].filter(job => job.credited && !["settled", "released"].includes(job.phase))
      .reduce((sum,job) => sum + (job.reservation?.contributions.reduce((value,row) => value + row.qusd,0) ?? 0),0);
    this.store.set("cooperative_qusd_owed", String(total));
  }

  async reconcile(): Promise<void> {
    if (this.running) return;
    for (const job of this.jobs.values()) {
      if (job.phase === "completed") continue;
      if (job.phase === "commit_pending") await this.commit(job);
      else if (job.phase === "release_pending" || job.phase === "reserved") await this.release(job);
      else if (["uncertain", "applying", "reserving", "committed"].includes(job.phase)) {
        if (!job.reservation) {
          // No apply can have been sent before the reservation was persisted.
          try { job.reservation = await this.sync.reserve(job.offer); await this.release(job); }
          catch (error) {
            if (error instanceof Error && "status" in error && typeof error.status === "number" && error.status >= 400 && error.status < 500)
              this.save(job, "released");
          }
          continue;
        }
        let offer: P2pOffer;
        try { offer = await this.qva.getOffer(job.offer.uuid); } catch { continue; }
        if (offer.status === "cancelled" && this.store.getOperation(offer.uuid)?.state === "cancelled") {
          this.onState("p2p.cancelled",offer); continue;
        }
        const account = this.store.get("analytics_account_uuid");
        if (!account || offer.Peer?.uuid !== account || !["processing", "paid", "completed"].includes(offer.status)) continue;
        if (!job.reservation) { try { job.reservation = await this.sync.reserve(job.offer); } catch { continue; } }
        await this.projectOperation(job);
        if (job.phase !== "committed") await this.commit(job);
        if (offer.status === "completed") this.onState("p2p.completed", offer);
      }
    }
    this.updateOwed();
  }
  async stop(): Promise<void> { this.stopped = true; this.queue.clear(); if (this.retryTimer) clearTimeout(this.retryTimer); await this.drainPromise; }
}
