import type { config as Config } from "./config.js";
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MarketConfigService,
  type MarketConfig,
  type TradingConfig,
} from "./market-config.js";
import {
  QvaApiError,
  QvaConnectionError,
  QvaMutationUncertainError,
} from "./qvapay.js";
import type { Store } from "./store.js";
import type { FiatMarket, OperationState, P2pAverage, P2pFeedEvent, P2pListPage, P2pOffer } from "./types.js";
import type { QvaPayGateway, TradingRepository } from "./core/ports.js";
import type { MarketPageUpdate } from "./market-source.js";
import { OpportunityOrchestrator } from "./application/opportunity-orchestrator.js";
import {
  isMutationUncertain,
  MonetaryIntents,
} from "./application/monetary-intents.js";
import { evaluateRisk, type RiskDecision } from "./core/risk-policy.js";
import {
  MIN_OFFER_QUSD,
  median,
  outgoingFiatCost,
  ownOfferFiatTotal,
} from "./market-math.js";
import { planLiquidity } from "./core/liquidity-plan.js";

type RuntimeConfig = typeof Config;
interface BlockedOfferNotification {
  kind: "blocked-offer";
  alert: {
    uuid: string;
    coin: FiatMarket;
    offerType: "buy" | "sell";
    amount: number;
    receive: number;
    rate: number;
    reason: string;
    referenceRate?: number;
    updatedAt: number;
  };
}
interface OperationNotification {
  kind: "operation-applied" | "reconciliation-required";
  uuid: string;
  coin: FiatMarket;
  amount: number;
}
type Notify = (
  message: string,
  operationUuid?: string,
  event?: BlockedOfferNotification | OperationNotification,
) => Promise<void>;

type MarketDecision = "auto_buy" | "manual_sell" | "blocked" | "ignored";
export interface MarketItem {
  offer: P2pOffer;
  rate: number;
  decision: MarketDecision;
  reason: string;
}
export interface MarketSnapshot {
  items: MarketItem[];
  total: number;
  scannedAt: number;
  average?: P2pAverage;
}

export class TradingEngine {
  private averagesCache?: {
    value: Record<string, P2pAverage>;
    expiresAt: number;
  };
  private refreshRoundInFlight = false;
  private qusdBalanceCache?: { value: number; updatedAt: number };
  private scanInFlight: Promise<{
    inspected: number;
    candidates: number;
    action?: string;
  }> | undefined;
  private readonly marketSnapshotCache = new Map<
    string,
    MarketSnapshot & { coin: FiatMarket; side: "buy" | "sell" }
  >();
  constructor(
    private readonly store: TradingRepository,
    private readonly qva: QvaPayGateway,
    private readonly cfg: RuntimeConfig,
    marketConfigOrNotify: MarketConfigService | Notify,
    notify?: Notify,
  ) {
    this.marketConfig =
      typeof marketConfigOrNotify === "function"
        ? new MarketConfigService(
            this.cfg.dataDir ??
              mkdtempSync(join(tmpdir(), "qvaapply-test-config-")),
            this.cfg,
            this.store as Store,
          )
        : marketConfigOrNotify;
    this.notify =
      typeof marketConfigOrNotify === "function"
        ? marketConfigOrNotify
        : notify!;
    this.monetaryIntents = new MonetaryIntents(this.store);
    this.opportunityOrchestrator = new OpportunityOrchestrator(
      this.store as Store,
      this.qva,
      this.marketConfig,
      { notify: (message, event) => this.notify(message, undefined, event) },
    );
    for (const market of this.marketConfig.markets()) {
      if (this.store.get(`fiat_balance:${market.code}`) === undefined) {
        this.store.set(
          `fiat_balance:${market.code}`,
          String(market.fiatBalance),
        );
        this.store.audit(
          "fiat_balance",
          `Saldo inicial declarado: ${market.fiatBalance} ${market.currency} (${market.code})`,
        );
      }
    }
  }

  private readonly marketConfig: MarketConfigService;
  private readonly notify: Notify;
  private readonly monetaryIntents: MonetaryIntents;
  private readonly opportunityOrchestrator: OpportunityOrchestrator;

  markets(): MarketConfig[] {
    return this.marketConfig.markets();
  }
  activeMarkets(): MarketConfig[] {
    return this.marketConfig.activeMarkets();
  }
  automationConfig(): TradingConfig["automation"] {
    return this.marketConfig.current().automation;
  }
  market(code: FiatMarket): MarketConfig | undefined {
    return this.marketConfig.find(code);
  }
  isMarket(code: string): code is FiatMarket {
    return Boolean(this.market(code));
  }
  marketLabel(code: FiatMarket): string {
    return this.market(code)?.label ?? code;
  }
  marketCurrency(code: FiatMarket): string {
    return this.market(code)?.currency ?? "";
  }
  saveConfig(
    next: TradingConfig,
    source = "panel",
    reason = "Configuración actualizada desde el panel local",
  ): void {
    const saved = this.marketConfig.save(
      next,
      source,
      reason,
    );
    for (const market of saved.markets) {
      this.store.set(`fiat_balance:${market.code}`, String(market.fiatBalance));
    }
    this.store.audit(
      "config",
      "Configuración de mercados actualizada desde el panel local",
    );
  }

  updateHunting(values: {
    buyRunning?: boolean;
    sellRunning?: boolean;
    market?: {
      code: FiatMarket;
      huntBuyEnabled?: boolean;
      huntSellEnabled?: boolean;
      buyMaxRate?: number;
      sellMinRate?: number;
    };
  }): void {
    const next = this.marketConfig.current();
    if (values.buyRunning !== undefined) next.hunting.buyRunning = values.buyRunning;
    if (values.sellRunning !== undefined) next.hunting.sellRunning = values.sellRunning;
    if (values.market) {
      const market = next.markets.find((item) => item.code === values.market!.code);
      if (!market) throw new Error("Mercado de cacería inválido.");
      if (values.market.huntBuyEnabled !== undefined)
        market.huntBuyEnabled = values.market.huntBuyEnabled;
      if (values.market.huntSellEnabled !== undefined)
        market.huntSellEnabled = values.market.huntSellEnabled;
      if (values.market.buyMaxRate !== undefined)
        market.buyMaxRate = values.market.buyMaxRate;
      if (values.market.sellMinRate !== undefined)
        market.sellMinRate = values.market.sellMinRate;
    }
    this.saveConfig(next, "panel", "Controles de cacería actualizados");
    this.store.audit("hunting_control", huntingChangeDetail(values));
  }

  huntEnabled(code: FiatMarket, side: "buy" | "sell"): boolean {
    const config = this.marketConfig.current();
    const market = config.markets.find((item) => item.code === code);
    if (!market?.active) return false;
    return side === "buy"
      ? config.hunting.buyRunning && market.huntBuyEnabled
      : config.hunting.sellRunning && market.huntSellEnabled;
  }

  isPaused(): boolean {
    return this.store.get("paused") !== "false";
  }
  mode(): "simulation" | "real" {
    return this.store.get("mode") === "real" ? "real" : "simulation";
  }
  refreshEnabled(): boolean {
    return this.store.get("refresh_enabled") === "true";
  }
  fiatBalance(coin: FiatMarket = "BANK_CUP"): number {
    return Number(this.store.get(`fiat_balance:${coin}`) ?? 0);
  }

  setPaused(paused: boolean, source = "Telegram"): void {
    if (!paused && this.store.get("emergency_stop") === "true")
      throw new Error(
        "Desactiva primero la parada de emergencia; la reanudación permanece bloqueada.",
      );
    this.store.set("paused", String(paused));
    this.store.audit(
      paused ? "paused" : "resumed",
      `Automatización modificada desde ${source}`,
    );
  }
  setFiatBalance(coin: FiatMarket, amount: number): void {
    if (!this.isMarket(coin)) throw new Error("Mercado no configurado.");
    this.store.set(`fiat_balance:${coin}`, String(amount));
    this.marketConfig.updateBalance(coin, amount);
    this.store.audit(
      "fiat_balance",
      `Saldo fiat declarado: ${amount} ${this.marketCurrency(coin)} (${coin})`,
    );
  }
  strategy() {
    const config = this.marketConfig.current();
    return {
      buyMax: Object.fromEntries(
        config.markets.map((market) => [market.code, market.buyMaxRate]),
      ),
      sellMin: Object.fromEntries(
        config.markets.map((market) => [market.code, market.sellMinRate]),
      ),
      reserve: config.qusdReserve,
      maxOpenOffers: config.maxOpenOffers,
    };
  }
  updateStrategy(
    values: Partial<{
      buyMaxCup: number;
      buyMaxUsd: number;
      sellMinCup: number;
      sellMinUsd: number;
      reserve: number;
      cupLimit: number;
    }>,
  ): void {
    for (const raw of Object.values(values)) {
      if (!Number.isFinite(raw) || raw < 0)
        throw new Error("Los límites deben ser números positivos.");
    }
    const next = this.marketConfig.current();
    const cup = next.markets.find((market) => market.code === "BANK_CUP");
    const usd = next.markets.find((market) => market.code === "BANDECPREPAGO");
    if (values.buyMaxCup !== undefined && cup)
      cup.buyMaxRate = values.buyMaxCup;
    if (values.sellMinCup !== undefined && cup)
      cup.sellMinRate = values.sellMinCup;
    if (values.cupLimit !== undefined && cup)
      cup.purchaseMaxQusd = values.cupLimit;
    if (values.buyMaxUsd !== undefined && usd)
      usd.buyMaxRate = values.buyMaxUsd;
    if (values.sellMinUsd !== undefined && usd)
      usd.sellMinRate = values.sellMinUsd;
    if (values.reserve !== undefined) {
      next.qusdReserve = values.reserve;
      next.risk.minQusdReserve = values.reserve;
    }
    this.saveConfig(next);
    this.store.audit("strategy", "Estrategia actualizada desde el panel local");
  }
  setRefresh(enabled: boolean): void {
    this.store.set("refresh_enabled", String(enabled));
    this.store.audit(
      "refresh",
      enabled ? "Refresco activado" : "Refresco desactivado",
    );
  }

  setMode(mode: "simulation" | "real"): void {
    if (mode === "real" && !this.cfg.realTradingAllowed)
      throw new Error(
        "Para usar modo real, cambia CONFIRM_REAL_TRADING=true en .env y reinicia el bot.",
      );
    this.store.set("mode", mode);
    this.store.audit("mode", `Modo ${mode} seleccionado`);
  }

  initializeProductionState(): void {
    // El modo queda fijado internamente; no forma parte del estado operativo
    // que puede seleccionar o consultar el usuario.
    this.store.set("mode", "real");
    this.setPaused(
      this.store.get("emergency_stop") === "true",
      "arranque del servicio",
    );
  }

  setEmergencyStop(enabled: boolean, source = "panel"): void {
    this.store.set("emergency_stop", String(enabled));
    if (enabled) this.store.set("paused", "true");
    this.store.audit(
      enabled ? "emergency_stop" : "emergency_stop_cleared",
      enabled
        ? `Parada de emergencia activada desde ${source}; no se iniciarán operaciones.`
        : `Parada de emergencia desactivada desde ${source}; la automatización permanece pausada.`,
    );
  }

  async activate(): Promise<void> {
    // Verifica una sesión real antes de reanudar; saldo 0 sigue siendo una sesión válida.
    await this.qva.qusdBalance();
    this.setPaused(false);
    this.store.audit(
      "automation_activated",
      "Automatización activada",
    );
  }

  reconcilePendingWorkflows() {
    return this.opportunityOrchestrator.reconcilePending();
  }

  async reconcilePendingStandaloneMutations(): Promise<number> {
    let reconciled = 0;
    const pending = this.store
      .recoverableMutationIntents()
      .filter((intent) => !intent.workflowId);
    const ownOfferKinds = new Set([
      "create_offer",
      "edit_offer",
      "cancel_offer",
    ]);
    const operationKinds = new Set(["paid", "received", "cancel"]);
    const pendingOwnOffers = pending.filter((intent) =>
      ownOfferKinds.has(intent.kind)
    );
    let ownOffers: P2pOffer[] | undefined;
    if (pendingOwnOffers.length) {
      try {
        ownOffers = await this.listOwnOffers();
      } catch (error) {
        this.store.audit(
          "standalone_offer_reconciliation_pending",
          qvaPayFailureDetail("consultar las ofertas propias", error),
        );
      }
    }
    for (const intent of pending) {
      if (operationKinds.has(intent.kind) && intent.operationUuid) {
        const operation = this.store.getOperation(intent.operationUuid);
        if (!operation) continue;
        try {
          const remote = await this.qva.getOffer(intent.operationUuid);
          const next = reconciledOperationMutationState(
            intent.kind,
            operation.state,
            remote.status,
          );
          if (!next) continue;
          if (next !== operation.state)
            this.store.updateOperation(intent.operationUuid, next);
          this.store.updateMutationIntent(intent.intentId, "reconciled", {
            remoteStatus: remote.status,
            operationState: next,
          });
          this.store.audit(
            "operation_mutation_reconciled",
            `QvaPay confirmó ${intent.kind} mediante el estado ${remote.status}; la Operación quedó ${next}.`,
            intent.operationUuid,
          );
          reconciled += 1;
        } catch (error) {
          this.store.audit(
            "operation_mutation_reconciliation_pending",
            qvaPayFailureDetail(`conciliar ${intent.kind}`, error),
            intent.operationUuid,
          );
        }
        continue;
      }
      if (ownOfferKinds.has(intent.kind)) {
        if (!ownOffers) continue;
        const remote = reconcileOwnOfferMutation(intent, ownOffers);
        if (!remote) continue;
        this.store.updateMutationIntent(intent.intentId, "reconciled", remote);
        this.store.audit(
          "standalone_offer_mutation_reconciled",
          `QvaPay confirmó el resultado de ${intent.kind}; la mutación incierta ya no bloquea el motor.`,
          intent.operationUuid,
        );
        reconciled += 1;
        continue;
      }
      if (intent.kind !== "apply" || !intent.operationUuid) continue;
      const uuid = intent.operationUuid!;
      try {
        const remote = await this.qva.getOffer(uuid);
        const remoteStatus = remote.status.toLowerCase();
        if (
          [
            "open",
            "processing",
            "paid",
            "revision",
            "cancelled",
            "canceled",
            "completed",
          ].includes(remoteStatus)
        ) {
          const next = operationStateFromRemote("applied", remoteStatus);
          const existing = this.store.getOperation(uuid);
          if (!existing && operationStatusShowsApplication(remoteStatus)) {
            if (!isRecoverableOperationOffer(remote)) continue;
            const request = isRecord(intent.request) ? intent.request : {};
            this.store.createOperation({
              uuid,
              offerType: remote.type,
              coin: remote.coin,
              amount: remote.amount,
              receive: remote.receive,
              rate: rate(remote),
              state: next,
              autoApplied: request.automatic === true,
              cancelAt: null,
              createdAt: intent.createdAt,
              ...(remote.User?.uuid
                ? { counterpartyId: remote.User.uuid }
                : remote.Peer?.uuid
                  ? { counterpartyId: remote.Peer.uuid }
                  : {}),
            });
          } else if (existing && next !== existing.state) {
            this.store.updateOperation(uuid, next);
          }
          this.store.updateMutationIntent(intent.intentId, "reconciled", {
            remoteStatus: remote.status,
            operationState: existing || operationStatusShowsApplication(remoteStatus)
              ? next
              : undefined,
          });
          this.store.audit(
            "standalone_apply_reconciled",
            `QvaPay confirmó el estado ${remote.status}; la mutación incierta ya no bloquea el motor.`,
            uuid,
          );
          reconciled += 1;
        }
      } catch (error) {
        if (!isDefinitiveAccountRestriction(error)) {
          this.store.audit(
            "standalone_apply_reconciliation_pending",
            qvaPayFailureDetail("conciliar la aplicación", error),
            uuid,
          );
          continue;
        }
        this.store.updateMutationIntent(intent.intentId, "reconciled", {
          rejectedByQvaPay: true,
          reason: error.message,
        });
        this.store.audit(
          "standalone_apply_reconciled",
          `QvaPay confirmó que la cuenta no cumple la restricción de la oferta: ${error.message}`,
          uuid,
        );
        reconciled += 1;
      }
    }
    return reconciled;
  }

  reconcileWorkflow(workflowId: string) {
    return this.opportunityOrchestrator.reconcile(workflowId);
  }

  async inspectMarket(coin: FiatMarket): Promise<MarketSnapshot> {
    if (!this.isMarket(coin)) throw new Error("Mercado no configurado.");
    const sell = await this.inspectMarketSide(coin, "sell");
    const buy = await this.inspectMarketSide(coin, "buy");
    return {
      items: [...sell.items, ...buy.items],
      total: sell.total + buy.total,
      scannedAt: Math.max(sell.scannedAt, buy.scannedAt),
      ...(sell.average || buy.average
        ? { average: { ...sell.average, ...buy.average } }
        : {}),
    };
  }

  async inspectMarketSide(
    coin: FiatMarket,
    type: "buy" | "sell",
  ): Promise<MarketSnapshot> {
    if (!this.isMarket(coin)) throw new Error("Mercado no configurado.");
    const page = await this.qva.listOffersPage({
      take: 100,
      page: 1,
      type,
      coin,
      status: "open",
      orderBy: "best_rate",
      orderType: "desc",
    });
    return this.marketSnapshotFromPage(coin, type, page, Date.now());
  }

  private async marketSnapshotFromPage(
    coin: FiatMarket,
    type: "buy" | "sell",
    page: P2pListPage,
    scannedAt: number,
    preferCachedAverages = false,
  ): Promise<MarketSnapshot> {
    const averages = preferCachedAverages
      ? this.store.loadRemoteResource<Record<string, P2pAverage>>("averages")?.data
      : await this.getAverages();
    const matchingOffers = page.offers.filter(
      (offer) => offer.type === type && offer.coin === coin,
    );
    const marketMedian = median(matchingOffers.map(rate));
    const reference: P2pAverage = {
      ...averages?.[coin],
      ...(marketMedian === undefined
        ? {}
        : type === "buy"
          ? { median_buy: marketMedian }
          : { median_sell: marketMedian }),
    };
    return {
      items: matchingOffers.map((offer) =>
        this.classifyOffer(offer, reference),
      ),
      total:
        matchingOffers.length === page.offers.length
          ? page.total
          : matchingOffers.length,
      scannedAt,
      ...(Object.keys(reference).length ? { average: reference } : {}),
    };
  }

  async ingestMarketUpdate(update: MarketPageUpdate): Promise<{
    inspected: number;
    candidates: number;
    action?: string;
  }> {
    if (this.scanInFlight) return this.scanInFlight;
    const run = this.ingestMarketUpdateOnce(update);
    this.scanInFlight = run;
    try {
      return await run;
    } finally {
      if (this.scanInFlight === run) this.scanInFlight = undefined;
    }
  }

  async ingestMarketOffer(
    offer: P2pOffer,
    receivedAt = Date.now(),
    event: "p2p.created" | "p2p.reopened" = "p2p.created",
    sentAt?: string,
  ): Promise<{ inspected: number; candidates: number; action?: string }> {
    if (this.scanInFlight) await this.scanInFlight;
    const run = this.ingestPreparedMarketOffer(offer, receivedAt, event, sentAt);
    this.scanInFlight = run;
    try {
      return await run;
    } finally {
      if (this.scanInFlight === run) this.scanInFlight = undefined;
    }
  }

  private async ingestPreparedMarketOffer(
    offer: P2pOffer,
    receivedAt: number,
    event: "p2p.created" | "p2p.reopened",
    sentAt?: string,
  ): Promise<{ inspected: number; candidates: number; action?: string }> {
    let candidate = offer;
    const publishedAt = sentAt ? Date.parse(sentAt) : Number.NaN;
    if (Number.isFinite(publishedAt) && Date.now() - publishedAt > 5_000) {
      try {
        candidate = await this.qva.getOffer(offer.uuid);
      } catch (error) {
        if (error instanceof QvaApiError && error.status === 404)
          return { inspected: 1, candidates: 0, action: "ya no disponible" };
        throw error;
      }
      if (candidate.status !== "open")
        return { inspected: 1, candidates: 0, action: `ya no disponible (${candidate.status})` };
    }
    return candidate.type === "sell"
      ? this.ingestFastFiatFundedOffer(candidate, receivedAt, event)
      : this.ingestFastQusdFundedOffer(candidate, receivedAt, event);
  }

  private async ingestFastFiatFundedOffer(
    offer: P2pOffer,
    receivedAt: number,
    event: "p2p.created" | "p2p.reopened",
  ): Promise<{ inspected: number; candidates: number; action?: string }> {
    if (this.isPaused()) return { inspected: 0, candidates: 0, action: "pausado" };
    if (offer.status !== "open" || !this.isMarket(offer.coin) || offer.amount <= 0 || offer.receive <= 0)
      return { inspected: 1, candidates: 0, action: "ignorada" };
    const coin = this.offerMarket(offer);
    const market = this.market(coin)!;
    const quotedRate = rate(offer);
    const transfer = outgoingFiatCost(offer.amount, quotedRate, market.outgoingTransferFee);
    let decision: MarketItem["decision"] = "auto_buy";
    let reason = "Compra inmediata elegible por precio y capital";
    if (Boolean(offer.only_vip)) {
      decision = "ignored";
      reason = "Oferta exclusiva para usuarios VIP";
    } else if (!this.huntEnabled(coin, "buy")) {
      decision = "ignored";
      reason = "Cacería de compra detenida";
    } else if (transfer.effectiveRate > market.buyMaxRate) {
      decision = "ignored";
      reason = `La tasa efectiva ${transfer.effectiveRate.toFixed(2)} supera el máximo ${market.buyMaxRate.toFixed(2)}`;
    } else if (!this.canFund(offer)) {
      decision = "ignored";
      reason = "Saldo fiat declarado insuficiente";
    } else if (this.store.isSeen(offer.uuid) && event !== "p2p.reopened") {
      decision = "ignored";
      reason = "Oferta ya evaluada";
    }
    this.persistIncrementalMarketOffer(
      { coin, side: offer.type, items: [], total: 1, scannedAt: receivedAt },
      [{ offer, rate: quotedRate, decision, reason }],
    );
    if (decision !== "auto_buy")
      return { inspected: 1, candidates: 0, action: reason };
    if (this.mode() !== "real") {
      this.store.markSeen(offer.uuid);
      return { inspected: 1, candidates: 1, action: `simulada ${offer.uuid}` };
    }
    if (this.store.get("emergency_stop") === "true")
      return { inspected: 1, candidates: 1, action: "interruptor de emergencia" };
    if (this.store.hasUnresolvedMutation())
      throw new Error("Existe una mutación incierta pendiente de conciliación.");

    const warnings = this.fastLaneWarnings(offer, transfer.total);
    if (warnings.length) this.store.audit(
      "market_fast_lane_warnings",
      warnings.join(" · "),
      offer.uuid,
    );
    if (!this.huntEnabled(coin, "buy") || !this.canFund(offer))
      return { inspected: 1, candidates: 1, action: "capital o cacería cambió antes de aplicar" };
    try {
      await this.applyBuyQusd(offer, true, undefined, true);
    } catch (error) {
      if (!isDefinitiveQvaApplyRejection(error)) throw error;
      const detail = qvaPayFailureDetail("aplicar a la oferta", error);
      this.store.markSeen(offer.uuid);
      this.store.audit("qvapay_apply_rejected", detail, offer.uuid);
      return { inspected: 1, candidates: 1, action: `rechazada ${offer.uuid}` };
    }
    this.store.markSeen(offer.uuid);
    this.store.audit(
      "market_fast_lane_applied",
      `Aplicada en ${Math.max(0, Date.now() - receivedAt)} ms desde la recepción.`,
      offer.uuid,
    );
    return { inspected: 1, candidates: 1, action: `aplicada ${offer.uuid}` };
  }

  private fastLaneWarnings(offer: P2pOffer, requiredFiat: number): string[] {
    const config = this.marketConfig.current();
    const store = this.store as Store;
    const warnings: string[] = [];
    if (config.risk.reviewedAt === null) warnings.push("límites sin revisión manual");
    if (offer.amount > config.risk.maxQusdPerOperation) warnings.push("importe sobre límite conservador");
    if (store.activeOperations().length >= config.risk.maxConcurrentOperations)
      warnings.push("operaciones simultáneas sobre límite conservador");
    if (store.dailyAppliedQusd(dayStart(Date.now())) + offer.amount > config.risk.maxDailyAppliedQusd)
      warnings.push("volumen diario sobre límite conservador");
    if (Number(store.get("consecutive_errors") ?? 0) >= config.risk.maxConsecutiveErrors)
      warnings.push("contador de errores sobre umbral conservador");
    if (requiredFiat > this.fiatBalance(offer.coin)) warnings.push("capital bruto insuficiente");
    return warnings;
  }

  private async ingestFastQusdFundedOffer(
    offer: P2pOffer,
    receivedAt: number,
    event: "p2p.created" | "p2p.reopened",
  ): Promise<{ inspected: number; candidates: number; action?: string }> {
    if (this.isPaused()) return { inspected: 0, candidates: 0, action: "pausado" };
    if (offer.status !== "open" || !this.isMarket(offer.coin) || offer.amount <= 0 || offer.receive <= 0)
      return { inspected: 1, candidates: 0, action: "ignorada" };
    const coin = this.offerMarket(offer);
    const market = this.market(coin)!;
    const quotedRate = rate(offer);
    let decision: MarketItem["decision"] = "manual_sell";
    let reason = "Venta inmediata elegible por precio y capital";
    if (Boolean(offer.only_vip)) {
      decision = "ignored";
      reason = "Oferta exclusiva para usuarios VIP";
    } else if (offer.offer_kind === "flexible") {
      decision = "ignored";
      reason = "La aplicación parcial de ofertas flexibles todavía no está configurada";
    } else if (!this.huntEnabled(coin, "sell")) {
      decision = "ignored";
      reason = "Cacería de venta detenida";
    } else if (quotedRate < market.sellMinRate) {
      decision = "ignored";
      reason = `La tasa ${quotedRate.toFixed(2)} no alcanza el mínimo ${market.sellMinRate.toFixed(2)}`;
    } else if (this.store.isSeen(offer.uuid) && event !== "p2p.reopened") {
      decision = "ignored";
      reason = "Oferta ya evaluada";
    }
    this.persistIncrementalMarketOffer(
      { coin, side: offer.type, items: [], total: 1, scannedAt: receivedAt },
      [{ offer, rate: quotedRate, decision, reason }],
    );
    if (decision !== "manual_sell")
      return { inspected: 1, candidates: 0, action: reason };
    if (this.mode() !== "real") {
      this.store.markSeen(offer.uuid);
      return { inspected: 1, candidates: 1, action: `simulada ${offer.uuid}` };
    }
    if (this.store.get("emergency_stop") === "true")
      return { inspected: 1, candidates: 1, action: "interruptor de emergencia" };
    if (this.store.hasUnresolvedMutation())
      throw new Error("Existe una mutación incierta pendiente de conciliación.");
    const warnings = this.fastLaneWarnings(offer, 0);
    if (warnings.length) this.store.audit(
      "market_fast_lane_warnings",
      warnings.join(" · "),
      offer.uuid,
    );
    const availableQusd = await this.fastLaneQusdBalance();
    if (availableQusd < offer.amount)
      return { inspected: 1, candidates: 0, action: "Saldo QUSD libre insuficiente" };
    if (!this.huntEnabled(coin, "sell"))
      return { inspected: 1, candidates: 1, action: "cacería cambió antes de aplicar" };
    try {
      await this.monetaryIntents.execute({
        kind: "apply",
        operationUuid: offer.uuid,
        request: { uuid: offer.uuid, automatic: true, fastLane: true },
        action: () => this.qva.apply(offer.uuid),
      });
    } catch (error) {
      if (!isDefinitiveQvaApplyRejection(error)) throw error;
      const detail = qvaPayFailureDetail("aplicar a la oferta", error);
      this.store.markSeen(offer.uuid);
      this.store.audit("qvapay_apply_rejected", detail, offer.uuid);
      return { inspected: 1, candidates: 1, action: `rechazada ${offer.uuid}` };
    }
    this.qusdBalanceCache = { value: Math.max(0, availableQusd - offer.amount), updatedAt: Date.now() };
    this.store.createOperation({
      uuid: offer.uuid,
      offerType: "buy",
      coin,
      amount: offer.amount,
      receive: offer.receive,
      rate: quotedRate,
      state: "applied",
      autoApplied: true,
      cancelAt: null,
      createdAt: Date.now(),
      ...(offer.User?.uuid ? { counterpartyId: offer.User.uuid } : {}),
    });
    this.store.markSeen(offer.uuid);
    this.store.recordDecisionEvent({
      uuid: offer.uuid,
      coin,
      offerType: offer.type,
      amount: offer.amount,
      receive: offer.receive,
      rate: quotedRate,
      decision: "applied",
      reason: "Venta automática confirmada por la vía rápida de precio y capital.",
    });
    this.store.audit(
      "market_fast_lane_applied",
      `Venta aplicada en ${Math.max(0, Date.now() - receivedAt)} ms desde la recepción.`,
      offer.uuid,
    );
    queueMicrotask(() => void (async () => {
      try {
        await this.sendChatBestEffort(offer.uuid);
        await this.notify(
          `Aplicaste a vender ${offer.amount} QUSD por ${offer.receive} ${this.marketCurrency(coin)} en ${this.marketLabel(coin)}.`,
          offer.uuid,
          { kind: "operation-applied", uuid: offer.uuid, coin, amount: offer.amount },
        );
      } catch (error) {
        this.store.audit(
          "notification_warning",
          error instanceof Error ? error.message : String(error),
          offer.uuid,
        );
      }
    })());
    return { inspected: 1, candidates: 1, action: `venta aplicada ${offer.uuid}` };
  }

  private async fastLaneQusdBalance(): Promise<number> {
    if (this.qusdBalanceCache && Date.now() - this.qusdBalanceCache.updatedAt <= 15_000)
      return this.qusdBalanceCache.value;
    return this.qusdBalance();
  }

  async ingestMarketStateEvent(
    event: Exclude<P2pFeedEvent, "p2p.created" | "p2p.reopened">,
    offer: P2pOffer,
    receivedAt = Date.now(),
  ): Promise<void> {
    if (!this.isMarket(offer.coin)) return;
    const cached = this.store.loadRemoteResource<{
      total?: number;
      offers?: Array<P2pOffer & { rate?: number; decision?: string; reason?: string }>;
    }>(`market:${offer.coin}`);
    if (cached) {
      const offers = (cached.data.offers ?? []).filter((candidate) => candidate.uuid !== offer.uuid);
      this.store.saveRemoteResource(
        `market:${offer.coin}`,
        { ...cached.data, total: Math.min(cached.data.total ?? offers.length, offers.length), offers },
        receivedAt,
      );
    }

    const operation = this.store.getOperation(offer.uuid);
    this.store.resolveTradingAlert(
      offer.uuid,
      event === "p2p.applied" && operation ? "applied" : "expired",
    );
    if (operation) {
      const next = operationStateFromFeed(operation.state, event);
      if (next !== operation.state) this.store.updateOperation(offer.uuid, next);
      if (
        (event === "p2p.paid" || event === "p2p.completed") &&
        operation.offerType === "sell"
      ) this.store.recordFiatMovement(
        operation.uuid,
        operation.coin,
        "debit",
        operation.receive + (this.market(operation.coin)?.outgoingTransferFee ?? 0),
        "Feed QvaPay",
      );
      if (event === "p2p.completed" && operation.offerType === "buy")
        this.store.recordFiatMovement(
          operation.uuid,
          operation.coin,
          "credit",
          operation.receive,
          "Feed QvaPay",
        );
    }
    this.store.audit(
      "market_feed_state_applied",
      `${event} proyectado en ${Math.max(0, Date.now() - receivedAt)} ms${operation ? " y Operación sincronizada" : ""}.`,
      offer.uuid,
    );
  }

  private async ingestMarketUpdateOnce(update: MarketPageUpdate): Promise<{
    inspected: number;
    candidates: number;
    action?: string;
  }> {
    if (this.isPaused())
      return { inspected: 0, candidates: 0, action: "pausado" };
    try {
      const snapshot = {
        ...(await this.marketSnapshotFromPage(
          update.coin,
          update.side,
          update.page,
          update.scannedAt,
        )),
        coin: update.coin,
        side: update.side,
      };
      this.marketSnapshotCache.set(snapshotKey(update.coin, update.side), snapshot);
      const now = Date.now();
      const maxAgeMs = this.marketConfig.current().risk.maxQuoteAgeSeconds * 1_000;
      const snapshots = [...this.marketSnapshotCache.values()].filter(
        (candidate) =>
          now - candidate.scannedAt <= maxAgeMs &&
          this.huntEnabled(
            candidate.coin,
            candidate.side === "sell" ? "buy" : "sell",
          ),
      );
      const required = this.activeMarkets().flatMap((market) => [
        ...(this.huntEnabled(market.code, "buy")
          ? [snapshotKey(market.code, "sell")]
          : []),
        ...(this.huntEnabled(market.code, "sell")
          ? [snapshotKey(market.code, "buy")]
          : []),
      ]);
      const available = new Set(
        snapshots.map((candidate) => snapshotKey(candidate.coin, candidate.side)),
      );
      if (required.some((key) => !available.has(key)))
        return {
          inspected: snapshots.reduce((sum, item) => sum + item.items.length, 0),
          candidates: 0,
          action: "calentando mercado",
        };
      return this.processSnapshots(
        snapshots,
        snapshots.some((candidate) => candidate.side === "buy"),
        !required.some((key) => key.endsWith(":buy")),
      );
    } catch (error) {
      await this.handleError("scan", error);
      return { inspected: 0, candidates: 0, action: "error" };
    }
  }

  async scan(): Promise<{
    inspected: number;
    candidates: number;
    action?: string;
  }> {
    if (this.scanInFlight) return this.scanInFlight;
    const run = this.scanOnce();
    this.scanInFlight = run;
    try {
      return await run;
    } finally {
      if (this.scanInFlight === run) this.scanInFlight = undefined;
    }
  }

  private async scanOnce(): Promise<{
    inspected: number;
    candidates: number;
    action?: string;
  }> {
    if (this.isPaused())
      return { inspected: 0, candidates: 0, action: "pausado" };
    try {
      const round = Number(this.store.get("market_scan_round") ?? 0);
      const includeBuySide = round % 2 === 0 && this.marketConfig.current().hunting.sellRunning;
      this.store.set("market_scan_round", String(round + 1));
      const snapshots: Array<MarketSnapshot & { coin: FiatMarket; side: "buy" | "sell" }> = [];
      const activeMarkets = this.activeMarkets();
      const buyHuntMarkets = activeMarkets.filter((market) => this.huntEnabled(market.code, "buy"));
      const sellHuntMarkets = activeMarkets.filter((market) => this.huntEnabled(market.code, "sell"));
      for (const market of buyHuntMarkets) {
        snapshots.push({
          ...(await this.inspectMarketSide(market.code, "sell")),
          coin: market.code,
          side: "sell",
        });
      }
      if (includeBuySide) {
        for (const market of sellHuntMarkets) {
          snapshots.push({
            ...(await this.inspectMarketSide(market.code, "buy")),
            coin: market.code,
            side: "buy",
          });
        }
      }
      return await this.processSnapshots(
        snapshots,
        includeBuySide,
        sellHuntMarkets.length === 0,
      );
    } catch (error) {
      await this.handleError("scan", error);
      return { inspected: 0, candidates: 0, action: "error" };
    }
  }

  private async processSnapshots(
    snapshots: Array<
      MarketSnapshot & { coin: FiatMarket; side: "buy" | "sell" }
    >,
    includeBuySide: boolean,
    noSellHuntMarkets: boolean,
    options: {
      synchronizedOfferTypes?: Array<"buy" | "sell">;
      incremental?: boolean;
    } = {},
  ): Promise<{
    inspected: number;
    candidates: number;
    action?: string;
  }> {
      const items = snapshots.flatMap((market) => market.items);
      const offers = items.map((item) => item.offer);
      const candidates = items
        .filter(
          (item) =>
            item.decision === "auto_buy" || item.decision === "manual_sell",
        )
        .map((item) => item.offer);
      const sellCandidates = items
        .filter(
          (item) =>
            item.decision === "auto_buy" && !this.store.isSeen(item.offer.uuid),
        )
        .map((item) => item.offer);
      const buyCandidates = items
        .filter(
          (item) =>
            item.decision === "manual_sell" &&
            !this.store.isSeen(item.offer.uuid),
        )
        .map((item) => item.offer);

      const synchronizedOfferTypes: Array<"buy" | "sell"> =
        options.synchronizedOfferTypes?.slice() ?? ["sell"];
      if (!options.synchronizedOfferTypes && (includeBuySide || noSellHuntMarkets))
        synchronizedOfferTypes.push("buy");
      this.syncWebAlerts(items, synchronizedOfferTypes, snapshots);
      if (options.incremental) this.persistIncrementalMarketOffer(snapshots[0]!, items);
      else this.persistScanCoverage(snapshots, items, includeBuySide);

      for (const item of items.filter(
        (candidate) => candidate.decision === "blocked",
      )) {
        const snapshot = snapshots.find(
          (entry) => entry.coin === item.offer.coin && entry.side === item.offer.type,
        );
        const referenceRate = numeric(
          item.offer.type === "sell"
            ? snapshot?.average?.median_sell
            : snapshot?.average?.median_buy,
        );
        this.store.recordDecisionEvent({
          uuid: item.offer.uuid,
          coin: this.offerMarket(item.offer),
          offerType: item.offer.type,
          amount: item.offer.amount,
          receive: item.offer.receive,
          rate: item.rate,
          decision: "blocked",
          reason: item.reason,
          ...(referenceRate ? { referenceRate } : {}),
        });
        if (this.store.isSeen(item.offer.uuid)) continue;
        this.store.markSeen(item.offer.uuid);
        this.store.audit("price_guard_block", item.reason, item.offer.uuid);
        await this.notify(
          `🛡️ Oferta bloqueada por cortafuegos (${this.marketLabel(this.offerMarket(item.offer))})\n${item.offer.amount} QUSD · ${item.rate.toFixed(2)} ${this.marketCurrency(this.offerMarket(item.offer))}/QUSD\n${item.reason}\nOferta: ${item.offer.uuid}`,
          undefined,
          {
            kind: "blocked-offer",
            alert: {
              uuid: item.offer.uuid,
              coin: this.offerMarket(item.offer),
              offerType: item.offer.type,
              amount: item.offer.amount,
              receive: item.offer.receive,
              rate: item.rate,
              reason: item.reason,
              ...(referenceRate ? { referenceRate } : {}),
              updatedAt: Date.now(),
            },
          },
        );
      }

      // Una sola mutación por ronda. Se comparan márgenes porcentuales para no
      // mezclar directamente tasas de mercados con monedas distintas.
      const rankedSells = sellCandidates
        .filter((offer) => this.canFund(offer))
        .sort((left, right) => this.opportunityScore(right) - this.opportunityScore(left));
      let blockedUuid: string | undefined;
      for (const best of rankedSells) {
        const bestCoin = this.offerMarket(best);
        if (!this.huntEnabled(bestCoin, "buy")) continue;
        if (this.mode() === "real") {
          const reference = median(
            items
              .filter(
                (item) =>
                  item.offer.coin === best.coin && item.offer.type === "sell",
              )
              .map((item) => item.rate),
          );
          const risk = await this.evaluateAutomaticBuy(best, reference);
          if (risk.kind !== "apply") {
            blockedUuid ??= best.uuid;
            const reason = risk.reasons.join(" · ");
            this.store.audit("risk_block", reason, best.uuid);
            this.store.recordDecisionEvent({
              uuid: best.uuid,
              coin: bestCoin,
              offerType: best.type,
              amount: best.amount,
              receive: best.receive,
              rate: rate(best),
              decision: "blocked",
              reason,
              checks: risk.checks,
              ...(reference ? { referenceRate: reference } : {}),
            });
            this.store.upsertTradingAlert({
              uuid: best.uuid, coin: bestCoin, offerType: best.type,
              amount: best.amount, receive: best.receive, rate: rate(best),
              decision: "blocked", reason,
              ...(reference ? { referenceRate: reference } : {}),
            });
            await this.notifyRiskBlock(best, reason, reference);
            continue;
          }
          try {
            await this.applyBuyQusd(best, true, reference);
          } catch (error) {
            if (!isDefinitiveQvaApplyRejection(error)) throw error;
            const reason = qvaPayFailureDetail("aplicar a la oferta", error);
            this.store.audit("qvapay_apply_rejected", reason, best.uuid);
            this.store.recordDecisionEvent({
              uuid: best.uuid,
              coin: bestCoin,
              offerType: best.type,
              amount: best.amount,
              receive: best.receive,
              rate: rate(best),
              decision: "blocked",
              reason,
              ...(reference ? { referenceRate: reference } : {}),
            });
            this.store.upsertTradingAlert({
              uuid: best.uuid,
              coin: bestCoin,
              offerType: best.type,
              amount: best.amount,
              receive: best.receive,
              rate: rate(best),
              decision: "blocked",
              reason,
              ...(reference ? { referenceRate: reference } : {}),
            });
            this.store.markSeen(best.uuid);
            await this.notifyRiskBlock(best, reason, reference);
            blockedUuid ??= best.uuid;
            continue;
          }
          this.store.markSeen(best.uuid);
          this.recordScan(
            offers.length,
            candidates.length,
            `Aplicada ${best.uuid}`,
          );
          return {
            inspected: offers.length,
            candidates: candidates.length,
            action: `aplicada ${best.uuid}`,
          };
        }
        this.store.markSeen(best.uuid);
        await this.notify(
          `SIMULACIÓN: aplicaría a venta ${best.amount} QUSD por ${best.receive} ${this.marketCurrency(bestCoin)} (${rate(best).toFixed(2)} ${this.marketCurrency(bestCoin)}/QUSD) en ${this.marketLabel(bestCoin)}.\nOferta: ${best.uuid}`,
        );
        this.store.audit(
          "simulated_apply",
          `Compra simulada a ${rate(best).toFixed(2)} ${this.marketCurrency(bestCoin)}/QUSD (${bestCoin})`,
          best.uuid,
        );
        this.recordScan(
          offers.length,
          candidates.length,
          `Simulada ${best.uuid}`,
        );
        return {
          inspected: offers.length,
          candidates: candidates.length,
          action: `simulada ${best.uuid}`,
        };
      }

      const rankedBuys = buyCandidates
        .slice()
        .sort((left, right) => this.opportunityScore(right) - this.opportunityScore(left));
      for (const bestExternalBuy of rankedBuys) {
        if (this.mode() !== "real") break;
        const coin = this.offerMarket(bestExternalBuy);
        if (!this.huntEnabled(coin, "sell")) continue;
        const configured = this.market(coin)!;
        const reference = median(
          items
            .filter(
              (item) =>
                item.offer.coin === coin && item.offer.type === "buy",
            )
            .map((item) => item.rate),
        );
        const expectedMargin = configured.buyMaxRate
          ? ((rate(bestExternalBuy) * (1 - configured.sellFeePercent / 100) -
              configured.buyMaxRate) /
              configured.buyMaxRate) *
            100
          : 0;
        const result = await this.opportunityOrchestrator.execute({
          target: bestExternalBuy,
          referenceRate: reference ?? rate(bestExternalBuy),
          expectedMarginPercent: expectedMargin,
          priceDecision: reference ? "eligible" : "blocked",
          priceReason: reference
            ? "La tasa supera el mínimo configurado y tiene referencia de mercado."
            : "No existe una referencia de mercado válida.",
          canApply: () => this.huntEnabled(coin, "sell"),
        });
        if (result.applicationConfirmed) {
          this.store.recordDecisionEvent({
            uuid: bestExternalBuy.uuid, coin, offerType: bestExternalBuy.type,
            amount: bestExternalBuy.amount, receive: bestExternalBuy.receive,
            rate: rate(bestExternalBuy), decision: "applied",
            reason: "Aplicación automática confirmada.", checks: result.decision.checks,
            ...(reference ? { referenceRate: reference } : {}),
          });
          this.store.markSeen(bestExternalBuy.uuid);
          this.recordScan(
            offers.length,
            candidates.length,
            `Venta aplicada ${bestExternalBuy.uuid}`,
          );
          return {
            inspected: offers.length,
            candidates: candidates.length,
            action: `venta aplicada ${bestExternalBuy.uuid}`,
          };
        }
        this.store.audit(
          "risk_block",
          result.decision.reasons.join(" · "),
          bestExternalBuy.uuid,
        );
        this.store.recordDecisionEvent({
          uuid: bestExternalBuy.uuid,
          coin,
          offerType: bestExternalBuy.type,
          amount: bestExternalBuy.amount,
          receive: bestExternalBuy.receive,
          rate: rate(bestExternalBuy),
          decision: "blocked",
          reason: result.decision.reasons.join(" · "),
          checks: result.decision.checks,
          ...(reference ? { referenceRate: reference } : {}),
        });
        this.store.upsertTradingAlert({
          uuid: bestExternalBuy.uuid, coin, offerType: bestExternalBuy.type,
          amount: bestExternalBuy.amount, receive: bestExternalBuy.receive,
          rate: rate(bestExternalBuy), decision: "blocked",
          reason: result.decision.reasons.join(" · "),
          ...(reference ? { referenceRate: reference } : {}),
        });
        await this.notifyRiskBlock(
          bestExternalBuy,
          result.decision.reasons.join(" · "),
          reference,
        );
        blockedUuid ??= bestExternalBuy.uuid;
      }

      for (const offer of buyCandidates) {
        if (this.mode() === "real") continue;
        this.store.markSeen(offer.uuid);
        await this.notify(
          `Oportunidad de VENTA detectada en ${this.marketLabel(this.offerMarket(offer))} (requiere /apply manual): ${offer.amount} QUSD por ${offer.receive} ${this.marketCurrency(this.offerMarket(offer))} (${rate(offer).toFixed(2)} ${this.marketCurrency(this.offerMarket(offer))}/QUSD).\nOferta: ${offer.uuid}`,
        );
        this.store.audit(
          "sell_alert",
          `Venta candidata a ${rate(offer).toFixed(2)} ${this.marketCurrency(this.offerMarket(offer))}/QUSD (${offer.coin})`,
          offer.uuid,
        );
      }
      const result = blockedUuid ? `Bloqueada ${blockedUuid}` : "Sin aplicación";
      this.recordScan(offers.length, candidates.length, result);
      return {
        inspected: offers.length,
        candidates: candidates.length,
        ...(blockedUuid ? { action: `bloqueada ${blockedUuid}` } : {}),
      };
  }

  async applyManually(uuid: string): Promise<string> {
    const strategy = this.strategy();
    this.requireRealMode();
    const offer = await this.qva.getOffer(uuid);
    if (offer.status !== "open" || !this.isMarket(offer.coin))
      throw new Error(
        "La oferta ya no está abierta o no usa un mercado fiat compatible.",
      );
    if (offer.type === "sell") {
      const market = this.market(this.offerMarket(offer))!;
      const transfer = outgoingFiatCost(
        offer.amount,
        rate(offer),
        market.outgoingTransferFee,
      );
      if (transfer.effectiveRate > market.buyMaxRate)
        throw new Error(
          `La tasa efectiva ${transfer.effectiveRate.toFixed(2)} supera tu máximo de compra ${market.buyMaxRate.toFixed(2)}.`,
        );
      if (!this.canFund(offer))
        throw new Error("Saldo fiat declarado insuficiente para esta compra.");
      await this.applyBuyQusd(offer, false);
      return "Aplicaste a una venta; realiza el pago y usa /paid con la referencia.";
    }
    if (rate(offer) < this.market(this.offerMarket(offer))!.sellMinRate)
      throw new Error(
        `La tasa ${rate(offer).toFixed(2)} no alcanza tu mínimo de venta.`,
      );
    const balance = await this.qva.qusdBalance();
    if (balance - strategy.reserve < offer.amount)
      throw new Error(
        `Saldo QUSD insuficiente. Disponible para operar: ${(balance - strategy.reserve).toFixed(2)} QUSD.`,
      );
    await this.monetaryIntents.execute({
      kind: "apply",
      operationUuid: uuid,
      request: { uuid },
      action: () => this.qva.apply(uuid),
    });
    this.store.createOperation({
      uuid,
      offerType: "buy",
      coin: this.offerMarket(offer),
      amount: offer.amount,
      receive: offer.receive,
      rate: rate(offer),
      state: "applied",
      autoApplied: false,
      cancelAt: null,
      createdAt: Date.now(),
      ...(offer.User?.uuid ? { counterpartyId: offer.User.uuid } : {}),
    });
    await this.sendChatBestEffort(uuid);
    this.store.audit(
      "manual_apply_sell",
      `Aplicación manual a oferta de compra`,
      uuid,
    );
    return "Aplicaste como vendedor de QUSD. Espera el pago fiat y usa /received solo después de verificarlo.";
  }

  dismissBlockedOffer(uuid: string): void {
    const store = this.store as Store;
    const alert = store.tradingAlert(uuid);
    if (!alert || alert.decision !== "blocked" || alert.resolvedAt !== null)
      throw new Error("La oferta bloqueada ya no está pendiente de revisión.");
    store.resolveTradingAlert(uuid, "dismissed");
    store.audit("blocked_offer_dismissed", "Oferta bloqueada descartada por el usuario.", uuid);
  }

  async previewBlockedOffer(uuid: string) {
    const store = this.store as Store;
    const alert = store.tradingAlert(uuid);
    if (!alert || alert.decision !== "blocked" || alert.resolvedAt !== null)
      throw new Error("La oferta bloqueada ya no está pendiente de revisión.");
    const offer = await this.qva.getOffer(uuid);
    if (offer.status !== "open" || !this.isMarket(offer.coin)) {
      store.resolveTradingAlert(uuid, "expired");
      store.audit("blocked_offer_expired", "La oferta dejó de estar abierta durante la revisión.", uuid);
      throw new Error("La oferta ya no está abierta.");
    }
    const referenceRate = alert.referenceRate ?? rate(offer);
    const deviationPercent = referenceRate
      ? ((rate(offer) - referenceRate) / referenceRate) * 100
      : 0;
    let plannedCancellations: Array<{
      uuid: string;
      coin: string;
      amount: number;
      rate: number;
      consumeQusd: number;
      restoreQusd: number;
    }> = [];
    let liquidityReason = "No requiere cancelar ofertas propias.";
    if (offer.type === "buy") {
      const [balance, ownOffers] = await Promise.all([
        this.qva.qusdBalance(),
        this.qva.listOffers({ my: true, take: 100, page: 1, status: "open" }),
      ]);
      const liquidity = planLiquidity({
        target: offer,
        availableQusd: balance,
        reserveQusd: this.marketConfig.current().risk.minQusdReserve,
        ownOffers,
        marketEconomics: liquidityEconomics(this.marketConfig.current()),
      });
      plannedCancellations = liquidity.cancel.map(({ uuid: ownUuid, coin, amount, rate: ownRate, consumeQusd, restoreQusd }) => ({
        uuid: ownUuid,
        coin,
        amount,
        rate: ownRate,
        consumeQusd,
        restoreQusd,
      }));
      liquidityReason = liquidity.reason;
    }
    store.audit("blocked_offer_reviewed", "Se generó una previsualización sin mutaciones remotas.", uuid);
    return {
      uuid,
      coin: offer.coin,
      offerType: offer.type,
      amount: offer.amount,
      receive: offer.receive,
      rate: rate(offer),
      referenceRate,
      deviationPercent,
      plannedCancellations,
      liquidityReason,
    };
  }

  async applyBlockedOffer(uuid: string): Promise<string> {
    const store = this.store as Store;
    const alert = store.tradingAlert(uuid);
    if (!alert || alert.decision !== "blocked" || alert.resolvedAt !== null)
      throw new Error("La oferta bloqueada ya no está pendiente de revisión.");
    this.requireRealMode();
    const offer = await this.qva.getOffer(uuid);
    if (offer.status !== "open" || !this.isMarket(offer.coin)) {
      store.resolveTradingAlert(uuid, "expired");
      throw new Error("La oferta ya no está abierta o el mercado no es compatible.");
    }
    const referenceRate = alert.referenceRate ?? rate(offer);
    store.audit(
      "price_guard_override_requested",
      "El usuario autorizó omitir únicamente el bloqueo de precio/mediana; se mantienen todos los límites de riesgo.",
      uuid,
    );
    if (offer.type === "sell") {
      const decision = await this.evaluateAutomaticBuy(offer, referenceRate);
      if (decision.kind !== "apply") {
        store.audit("blocked_offer_safety_rejected", decision.reasons.join(" · "), uuid);
        throw new Error(decision.reasons.join(" · "));
      }
      await this.applyBuyQusd(offer, false, referenceRate);
      store.resolveTradingAlert(uuid, "applied");
      store.resolveDecisionEventsForOffer(uuid, "applied");
      store.audit("blocked_offer_applied", "Oferta aplicada tras revisión manual segura.", uuid);
      return "Aplicación confirmada. Realiza el pago fiat solo después de verificar los datos.";
    }
    const market = this.market(offer.coin)!;
    const expectedMargin = market.buyMaxRate
      ? ((rate(offer) * (1 - market.sellFeePercent / 100) - market.buyMaxRate) /
          market.buyMaxRate) * 100
      : 0;
    const result = await this.opportunityOrchestrator.execute({
      target: offer,
      referenceRate,
      expectedMarginPercent: expectedMargin,
      priceDecision: "eligible",
      priceReason: "Bloqueo de precio/mediana revisado y autorizado manualmente.",
    });
    if (!result.applicationConfirmed) {
      store.audit("blocked_offer_safety_rejected", result.decision.reasons.join(" · "), uuid);
      throw new Error(result.decision.reasons.join(" · "));
    }
    store.resolveTradingAlert(uuid, "applied");
    store.resolveDecisionEventsForOffer(uuid, "applied");
    store.audit("blocked_offer_applied", "Oferta aplicada mediante el workflow compensable.", uuid);
    return "Aplicación confirmada. Verifica el pago fiat recibido antes de confirmar la operación.";
  }

  async acknowledge(uuid: string): Promise<void> {
    const operation = this.requireOperation(uuid);
    if (operation.offerType !== "sell")
      throw new Error(
        "En esta operación no debes pagar fiat; espera la transferencia y confirma recepción cuando corresponda.",
      );
    if (operation.state !== "applied")
      throw new Error("La operación ya no está esperando tu respuesta.");
    this.store.updateOperation(uuid, "acknowledged");
    this.store.audit(
      "acknowledged",
      "Usuario indicó que realizará el pago",
      uuid,
    );
  }

  async markPaid(uuid: string, reference: string): Promise<void> {
    this.requireRealMode();
    const operation = this.requireOperation(uuid);
    if (
      operation.offerType !== "sell" ||
      !["applied", "acknowledged"].includes(operation.state)
    )
      throw new Error(
        "Esta operación no permite marcar pago en su estado actual.",
      );
    if (!reference.trim())
      throw new Error("La referencia de transferencia es obligatoria.");
    await this.qva.getOffer(uuid); // comprueba sesión y estado remoto antes de la acción irreversible
    await this.monetaryIntents.execute({
      kind: "paid",
      operationUuid: uuid,
      request: { uuid, reference: reference.trim() },
      action: () => this.qva.markPaid(uuid, reference.trim()),
    });
    this.store.updateOperation(uuid, "paid");
    this.store.audit("marked_paid", "Pago fiat marcado por el usuario", uuid);
  }

  async confirmReceived(uuid: string): Promise<void> {
    this.requireRealMode();
    const operation = this.requireOperation(uuid);
    if (operation.offerType !== "buy")
      throw new Error(
        "En una compra de QUSD debes marcar pago, no confirmar recepción.",
      );
    await this.qva.getOffer(uuid);
    await this.monetaryIntents.execute({
      kind: "received",
      operationUuid: uuid,
      request: { uuid },
      action: () => this.qva.confirmReceived(uuid),
    });
    this.store.updateOperation(uuid, "completed");
    this.store.audit("received", "Usuario confirmó recepción de fiat", uuid);
  }

  async cancel(uuid: string, automatic = false): Promise<void> {
    this.requireRealMode();
    const operation = this.requireOperation(uuid);
    if (
      automatic &&
      (operation.offerType !== "sell" ||
        !operation.autoApplied ||
        operation.state !== "applied")
    )
      throw new Error(
        "Cancelación automática no permitida para esta operación.",
      );
    await this.qva.getOffer(uuid);
    await this.monetaryIntents.execute({
      kind: "cancel",
      operationUuid: uuid,
      request: { uuid, automatic },
      action: () => this.qva.cancel(uuid),
    });
    this.store.updateOperation(uuid, "cancelled");
    this.store.audit(
      automatic ? "auto_cancel" : "cancel",
      automatic ? "Venció el plazo de 10 min" : "Cancelada por el usuario",
      uuid,
    );
  }

  async expireOperations(): Promise<void> {
    if (this.mode() !== "real") return;
    for (const operation of this.store.pendingCancellations(Date.now())) {
      try {
        if (await this.acknowledgeFromOwnChat(operation.uuid, operation.createdAt))
          continue;
        const remote = await this.qva.getOffer(operation.uuid);
        if (isTerminal(remote.status)) {
          this.closeRemoteOperation(
            operation.uuid,
            `Estado remoto terminal: ${remote.status}`,
          );
          continue;
        }
        await this.monetaryIntents.execute({
          kind: "cancel",
          operationUuid: operation.uuid,
          request: { uuid: operation.uuid, automatic: true },
          action: () => this.qva.cancel(operation.uuid),
        });
        this.store.updateOperation(operation.uuid, "cancelled");
        this.store.audit(
          "auto_cancel",
          `Venció el plazo de ${this.automationConfig().autoCancelMinutes} min`,
          operation.uuid,
        );
        await this.notify(
          `Operación ${operation.uuid} cancelada automáticamente: no respondiste en ${this.automationConfig().autoCancelMinutes} min.`,
        );
      } catch (error) {
        if (
          error instanceof QvaApiError &&
          (error.status === 403 || error.status === 404)
        ) {
          this.closeRemoteOperation(
            operation.uuid,
            "QvaPay indica que ya no eres participante o la oferta no existe",
          );
          continue;
        }
        if (isMutationUncertain(error)) {
          this.store.updateOperation(operation.uuid, "applied", null);
          this.store.audit(
            "auto_cancel_reconciliation_required",
            error instanceof Error ? error.message : String(error),
            operation.uuid,
          );
          try {
            await this.notify(
              `⚠️ No se pudo confirmar la cancelación automática de ${operation.uuid}. Se detuvieron los reintentos; requiere conciliación manual con QvaPay.`,
            );
          } catch (notificationError) {
            this.store.audit(
              "notification_warning",
              notificationError instanceof Error
                ? notificationError.message
                : String(notificationError),
              operation.uuid,
            );
          }
          continue;
        }
        this.scheduleAutoCancelRetry(operation.uuid, error);
        try {
          await this.notify(`⚠️ No pude verificar el chat de ${operation.uuid}; aplacé la cancelación automática para proteger una operación que podrías estar pagando.`);
        } catch { /* el aplazamiento ya quedó persistido */ }
      }
    }
  }

  async syncChatAcknowledgements(): Promise<void> {
    if (this.mode() !== "real") return;
    for (const operation of this.store.pendingCancellations(Number.MAX_SAFE_INTEGER)) {
      try {
        await this.acknowledgeFromOwnChat(operation.uuid, operation.createdAt);
      } catch (error) {
        this.store.audit("chat_poll_warning", error instanceof Error ? error.message : String(error), operation.uuid);
      }
    }
  }

  async syncRemoteOperations(): Promise<number> {
    let changed = 0;
    for (const operation of this.store.activeOperations()) {
      try {
        const remote = await this.qva.getOffer(operation.uuid);
        const next = operationStateFromRemote(operation.state, remote.status);
        this.store.set(`operation_sync_error:${operation.uuid}`, "");
        if (next === operation.state) continue;
        this.store.updateOperation(operation.uuid, next);
        if (next === "cancelled" || next === "completed")
          this.store.set(`retry:auto_cancel:${operation.uuid}`, "0");
        this.store.audit(
          "remote_operation_synced",
          `Estado local ${operation.state} actualizado a ${next}; QvaPay informó ${remote.status}.`,
          operation.uuid,
        );
        changed += 1;
      } catch (error) {
        if (error instanceof QvaApiError && error.status === 404) {
          this.closeRemoteOperation(
            operation.uuid,
            "QvaPay ya no encuentra la operación durante la sincronización periódica.",
          );
          changed += 1;
          continue;
        }
        const message = error instanceof Error ? error.message : String(error);
        const key = `operation_sync_error:${operation.uuid}`;
        if (this.store.get(key) === message) continue;
        this.store.set(key, message);
        this.store.audit("operation_sync_warning", message, operation.uuid);
      }
    }
    return changed;
  }

  async listOwnOffers(): Promise<P2pOffer[]> {
    return this.qva.listOffers({ my: true, take: 20, page: 1, status: "open" });
  }

  async syncFiatFromQva(): Promise<number> {
    const startedAt = new Map<FiatMarket, number>();
    for (const { code: coin } of this.markets()) {
      const value = Number(
        this.store.get(`fiat_ledger_started_at:${coin}`) ?? 0,
      );
      if (!value) {
        this.store.set(`fiat_ledger_started_at:${coin}`, String(Date.now()));
        this.store.audit(
          "fiat_ledger_started",
          `Saldo ${this.marketLabel(coin)} fijado como base; no se importó historial previo`,
        );
      } else startedAt.set(coin, value);
    }
    const profile = await this.qva.profile();
    const [created, asPeer] = await Promise.all([
      this.qva.listOffersPage({
        my: true,
        take: 50,
        page: 1,
        orderBy: "updated_at",
        orderType: "desc",
      }),
      this.qva.listOffersPage({
        peer: profile.uuid,
        take: 50,
        page: 1,
        orderBy: "updated_at",
        orderType: "desc",
      }),
    ]);
    const offers = new Map<string, P2pOffer>();
    for (const offer of [...created.offers, ...asPeer.offers])
      offers.set(offer.uuid, offer);
    let movements = 0;
    for (const offer of offers.values()) {
      const updatedAt = offer.updated_at
        ? Date.parse(offer.updated_at)
        : Number.NaN;
      if (!this.isMarket(offer.coin)) continue;
      const coin = offer.coin;
      const marketStartedAt = startedAt.get(coin);
      if (
        !marketStartedAt ||
        !Number.isFinite(updatedAt) ||
        updatedAt < marketStartedAt
      )
        continue;
      const creator = offer.User?.uuid === profile.uuid;
      const peer = offer.Peer?.uuid === profile.uuid;
      const paysFiat =
        (creator && offer.type === "buy") || (peer && offer.type === "sell");
      const receivesFiat =
        (creator && offer.type === "sell") || (peer && offer.type === "buy");
      const needsFiatMovement =
        (paysFiat && ["paid", "completed"].includes(offer.status)) ||
        (receivesFiat && offer.status === "completed");
      if (!needsFiatMovement) continue;

      const fiatAmount = numeric(offer.receive);
      if (!fiatAmount) {
        const warningKey = `fiat_sync_invalid_amount:${offer.uuid}`;
        if (this.store.get(warningKey) !== "true") {
          this.store.set(warningKey, "true");
          this.store.audit(
            "fiat_sync_skipped",
            `Oferta ${coin} omitida: importe fiat inválido (${String(offer.receive)})`,
            offer.uuid,
          );
        }
        continue;
      }

      if (
        paysFiat &&
        ["paid", "completed"].includes(offer.status) &&
        this.store.recordFiatMovement(
          offer.uuid,
          coin,
          "debit",
          fiatAmount + (this.market(coin)?.outgoingTransferFee ?? 0),
          "QvaPay reconciliado",
        )
      )
        movements += 1;
      if (
        receivesFiat &&
        offer.status === "completed" &&
        this.store.recordFiatMovement(
          offer.uuid,
          coin,
          "credit",
          fiatAmount,
          "QvaPay reconciliado",
        )
      )
        movements += 1;
    }
    for (const market of this.markets())
      this.marketConfig.updateBalance(
        market.code,
        this.fiatBalance(market.code),
      );
    this.store.set("last_fiat_sync", String(Date.now()));
    if (movements)
      this.store.audit(
        "fiat_sync",
        `${movements} movimiento(s) reconciliado(s)`,
      );
    return movements;
  }

  async refreshOwnOffer(uuid: string): Promise<void> {
    this.requireRealMode();
    const offer = (await this.listOwnOffers()).find(
      (candidate) => candidate.uuid === uuid,
    );
    if (!offer) throw new Error("No es una oferta propia abierta.");
    const refreshed = await this.monetaryIntents.execute({
      kind: "edit_offer",
      operationUuid: uuid,
      request: { uuid, refresh: true },
      action: () =>
        this.qva.editOffer(uuid, {
          message: (offer.message ?? this.automationConfig().welcomeMessage).slice(0, 79),
        }),
    });
    this.recordRefresh(uuid, refreshed?.updated_at);
    this.store.audit(
      "refresh_offer",
      "Oferta propia actualizada manualmente",
      uuid,
    );
  }

  async createOwnOffer(
    coin: FiatMarket,
    type: "buy" | "sell",
    amount: number,
    fiatPerQusd: number,
  ): Promise<P2pOffer> {
    this.requireRealMode();
    if (amount <= 0 || fiatPerQusd <= 0)
      throw new Error("El importe y la tasa deben ser positivos.");
    const market = this.market(coin);
    if (!market) throw new Error("Mercado no configurado.");
    if (
      type === "buy" &&
      market.purchaseMaxQusd > 0 &&
      amount > market.purchaseMaxQusd
    )
      throw new Error(
        `Las compras en ${market.label} están limitadas a ${market.purchaseMaxQusd} QUSD por oferta.`,
      );
    const open = await this.listOwnOffers();
    if (open.length >= this.strategy().maxOpenOffers)
      throw new Error(
        `Ya alcanzaste el máximo de ${this.strategy().maxOpenOffers} ofertas abiertas.`,
      );
    const receive = ownOfferFiatTotal(
      amount,
      fiatPerQusd,
      type,
      market.currency,
    );
    if (type === "buy") {
      const committed = open
        .filter(
          (offer) =>
            offer.type === "buy" &&
            offer.coin === coin &&
            offer.status === "open",
        )
        .reduce(
          (sum, offer) => sum + offer.receive + market.outgoingTransferFee,
          0,
        );
      const available = this.fiatBalance(coin) - committed;
      const required = receive + market.outgoingTransferFee;
      if (required > available + 0.000001)
        throw new Error(
          `Saldo ${this.marketLabel(coin)} insuficiente. Disponible para nuevas compras: ${available.toFixed(2)} ${this.marketCurrency(coin)}.`,
        );
    }
    if (
      !this.market(coin)?.paymentDetails.length ||
      this.market(coin)?.paymentDetails.some((detail) => !detail.value)
    )
      throw new Error(
        `Configura los datos de pago de ${this.marketLabel(coin)} antes de crear ofertas.`,
      );
    const idempotencyKey = randomUUID();
    const message = this.automationConfig().welcomeMessage.slice(0, 79);
    const request = {
      type,
      coin,
      amount,
      receive,
      details: this.market(coin)!.paymentDetails,
      ...(message ? { message } : {}),
      idempotencyKey,
    };
    const offer = await this.monetaryIntents.execute({
      kind: "create_offer",
      request,
      action: () => this.qva.createOffer(request),
      idempotencyKey,
    });
    this.store.audit(
      "create_offer",
      `Oferta propia ${type} en ${coin}: ${amount} QUSD a tasa solicitada ${fiatPerQusd}; total fiat ${receive} (tasa efectiva ${receive / amount})`,
      offer.uuid,
    );
    return offer;
  }

  async editOwnOffer(
    uuid: string,
    amount: number,
    fiatPerQusd: number,
  ): Promise<void> {
    this.requireRealMode();
    if (amount <= 0 || fiatPerQusd <= 0)
      throw new Error("El importe y la tasa deben ser positivos.");
    const offer = (await this.listOwnOffers()).find(
      (candidate) => candidate.uuid === uuid,
    );
    if (!offer) throw new Error("No es una oferta propia abierta.");
    if (!this.isMarket(offer.coin))
      throw new Error("La oferta no usa un mercado fiat compatible.");
    const market = this.market(offer.coin);
    if (
      offer.type === "buy" &&
      market &&
      market.purchaseMaxQusd > 0 &&
      amount > market.purchaseMaxQusd
    )
      throw new Error(
        `Las compras en ${market.label} están limitadas a ${market.purchaseMaxQusd} QUSD por oferta.`,
      );
    if (offer.type === "buy") {
      const committed = (await this.listOwnOffers())
        .filter(
          (candidate) =>
            candidate.uuid !== uuid &&
            candidate.type === "buy" &&
            candidate.coin === offer.coin &&
            candidate.status === "open",
        )
        .reduce(
          (sum, candidate) =>
            sum + candidate.receive + (market?.outgoingTransferFee ?? 0),
          0,
        );
      const available = this.fiatBalance(offer.coin) - committed;
      const receive = ownOfferFiatTotal(
        amount,
        fiatPerQusd,
        offer.type,
        market?.currency ?? "",
      );
      const required = receive + (market?.outgoingTransferFee ?? 0);
      if (required > available + 0.000001)
        throw new Error(
          `Saldo ${this.marketLabel(offer.coin)} insuficiente. Disponible para esta oferta: ${available.toFixed(2)} ${this.marketCurrency(offer.coin)}.`,
        );
    }
    const receive = ownOfferFiatTotal(
      amount,
      fiatPerQusd,
      offer.type,
      market?.currency ?? "",
    );
    const recentlyConfirmed = this.store.recentMutationIntents(20).some(
      (intent) => {
        const request = isRecord(intent.request) ? intent.request : undefined;
        return intent.kind === "edit_offer" &&
          intent.operationUuid === uuid &&
          intent.state === "confirmed" &&
          Date.now() - intent.updatedAt <= 60_000 &&
          request !== undefined &&
          sameObservableAmount(request.amount, amount) &&
          sameObservableAmount(request.receive, receive);
      },
    );
    if (
      recentlyConfirmed &&
      sameObservableAmount(offer.amount, amount) &&
      sameObservableAmount(offer.receive, receive)
    ) {
      this.store.audit(
        "edit_offer_unchanged",
        "QvaPay ya refleja el importe y el total solicitados; se omitió una edición duplicada.",
        uuid,
      );
      return;
    }
    await this.monetaryIntents.execute({
      kind: "edit_offer",
      operationUuid: uuid,
      request: { uuid, amount, receive },
      action: () => this.qva.editOffer(uuid, { amount, receive }),
    });
    this.store.audit(
      "edit_offer",
      `Oferta propia ${offer.coin} actualizada: ${amount} QUSD a tasa solicitada ${fiatPerQusd}; total fiat ${receive} (tasa efectiva ${receive / amount})`,
      uuid,
    );
  }

  async editOwnOfferFromSnapshot(
    offer: {
      uuid: string;
      coin: string;
      type: "buy";
      rate: number;
      currentAmount: number;
    },
    amount: number,
  ): Promise<void> {
    this.requireRealMode();
    if (offer.type !== "buy" || !this.isMarket(offer.coin))
      throw new Error("El reajuste solo admite ofertas propias de compra configuradas.");
    const market = this.market(offer.coin)!;
    if (
      !Number.isFinite(amount) ||
      amount < MIN_OFFER_QUSD ||
      !Number.isFinite(offer.currentAmount) ||
      amount > offer.currentAmount + 0.000001
    )
      throw new Error(`Importe de reajuste inválido para ${market.label}.`);
    const receive = ownOfferFiatTotal(amount, offer.rate, "buy", market.currency);
    await this.monetaryIntents.execute({
      kind: "edit_offer",
      operationUuid: offer.uuid,
      request: { uuid: offer.uuid, amount, receive },
      action: () => this.qva.editOffer(offer.uuid, { amount, receive }),
    });
    this.store.audit(
      "edit_offer",
      `Oferta propia ${offer.coin} reajustada a ${amount} QUSD; total fiat ${receive}`,
      offer.uuid,
    );
  }

  async cancelOwnOfferFromSnapshot(uuid: string): Promise<void> {
    this.requireRealMode();
    await this.monetaryIntents.execute({
      kind: "cancel_offer",
      operationUuid: uuid,
      request: { uuid },
      action: () => this.qva.cancel(uuid),
    });
    this.store.audit("cancel_own_offer", "Oferta propia cancelada por reajuste", uuid);
  }

  async cancelOwnOffer(uuid: string): Promise<void> {
    this.requireRealMode();
    const offer = (await this.listOwnOffers()).find(
      (candidate) => candidate.uuid === uuid,
    );
    if (!offer) throw new Error("No es una oferta propia abierta.");
    await this.monetaryIntents.execute({
      kind: "cancel_offer",
      operationUuid: uuid,
      request: { uuid },
      action: () => this.qva.cancel(uuid),
    });
    this.store.audit(
      "cancel_own_offer",
      "Oferta propia abierta cancelada",
      uuid,
    );
  }

  async qusdBalance(): Promise<number> {
    const value = await this.qva.qusdBalance();
    this.qusdBalanceCache = { value, updatedAt: Date.now() };
    return value;
  }

  lastRefresh(uuid: string): number | undefined {
    const raw = this.store.get(`last_refresh:${uuid}`);
    const value = raw ? Number(raw) : Number.NaN;
    return Number.isFinite(value) ? value : undefined;
  }

  logs(limit = 12) {
    return this.store.recentAudit(limit);
  }
  fiatMovements(coin: FiatMarket, limit = 5) {
    return this.store.recentFiat(coin, limit);
  }

  operationalState(): {
    paused: boolean;
    fiat: Record<FiatMarket, number>;
    refresh: boolean;
    active: number;
    lastScan?: {
      at: number;
      inspected: number;
      candidates: number;
      result: string;
    };
    scanCoverage?: {
      at: number;
      includedBuySide: boolean;
      markets: Array<{
        coin: FiatMarket;
        sides: Array<"buy" | "sell">;
        total: number;
        eligible: number;
        blocked: number;
      }>;
    };
    mutationBudget: {
      applyReadyAt: number;
      editReadyAt: number;
      cancelReadyAt: number;
    };
  } {
    const raw = this.store.get("last_scan");
    let lastScan:
      | { at: number; inspected: number; candidates: number; result: string }
      | undefined;
    try {
      if (raw) lastScan = JSON.parse(raw) as typeof lastScan;
    } catch {
      /* Ignora datos antiguos */
    }
    let scanCoverage: ReturnType<TradingEngine["operationalState"]>["scanCoverage"];
    try {
      const coverageRaw = this.store.get("last_scan_coverage");
      if (coverageRaw) scanCoverage = JSON.parse(coverageRaw) as typeof scanCoverage;
    } catch {
      /* Ignora una instantánea de cobertura antigua o incompleta. */
    }
    const throttleAt = (policy: "apply" | "edit" | "cancel") =>
      Number(this.store.get(`qva_throttle:${policy}`) ?? 0);
    return {
      paused: this.isPaused(),
      fiat: Object.fromEntries(
        this.markets().map((market) => [
          market.code,
          this.fiatBalance(market.code),
        ]),
      ),
      refresh: this.refreshEnabled(),
      active: this.store.activeOperations().length,
      ...(lastScan ? { lastScan } : {}),
      ...(scanCoverage ? { scanCoverage } : {}),
      mutationBudget: {
        applyReadyAt: throttleAt("apply") + 30_001,
        editReadyAt: throttleAt("edit") + 20_000,
        cancelReadyAt: throttleAt("cancel") + 20_000,
      },
    };
  }

  async refreshOwnOffers(): Promise<void> {
    if (!this.refreshEnabled() || this.isPaused() || this.mode() !== "real")
      return;
    if (this.refreshRoundInFlight) return;
    this.refreshRoundInFlight = true;
    try {
      const now = Date.now();
      const lastGlobalEdit = Number(this.store.get("last_offer_edit_at") ?? 0);
      const refreshSpacingMs =
        this.automationConfig().offerRefreshSpacingSeconds * 1_000;
      if (now - lastGlobalEdit < refreshSpacingMs) return;
      const due = (await this.listOwnOffers())
        .map((offer) => {
          const remoteUpdatedAt = offer.updated_at
            ? Date.parse(offer.updated_at)
            : Number.NaN;
          const localUpdatedAt = Number(
            this.store.get(`last_refresh:${offer.uuid}`) ?? 0,
          );
          return {
            offer,
            lastUpdatedAt: Math.max(
              localUpdatedAt,
              Number.isFinite(remoteUpdatedAt) ? remoteUpdatedAt : 0,
            ),
          };
        })
        .filter(({ offer, lastUpdatedAt }) => {
        const retryAt = Number(
          this.store.get(`refresh_retry:${offer.uuid}`) ?? 0,
        );
          return retryAt <= now &&
            now - lastUpdatedAt >=
              this.automationConfig().offerRefreshIntervalMinutes * 60_000;
        })
        .sort((left, right) => left.lastUpdatedAt - right.lastUpdatedAt);
      const next = due[0]?.offer;
      if (!next) return;
      try {
        const refreshed = await this.qva.editOffer(next.uuid, {
          message: next.message ?? "",
        });
        this.recordRefresh(next.uuid, refreshed?.updated_at);
        this.store.audit(
          "refresh_offer",
          "Oferta propia actualizada en turno automático",
          next.uuid,
        );
      } catch (error) {
        this.scheduleRefreshRetry(next.uuid, error);
      }
    } finally {
      this.refreshRoundInFlight = false;
    }
  }

  status(): string {
    const active = this.store.activeOperations();
    return [
      `Estado: ${this.isPaused() ? "INACTIVO" : "ACTIVO"}`,
      ...this.markets().map(
        (market) =>
          `Saldo ${market.label}: ${this.fiatBalance(market.code).toFixed(2)} ${market.currency}`,
      ),
      `Refresco: ${this.refreshEnabled() ? "activo" : "apagado"}`,
      `Operaciones activas: ${active.length}`,
    ].join("\n");
  }

  private classifyOffer(offer: P2pOffer, statistics?: P2pAverage): MarketItem {
    const value = rate(offer);
    if (
      offer.status !== "open" ||
      !this.isMarket(offer.coin) ||
      offer.amount <= 0 ||
      offer.receive <= 0
    )
      return {
        offer,
        rate: value,
        decision: "ignored",
        reason: "Oferta no operable",
      };
    const coin = this.offerMarket(offer);
    const configured = this.market(coin)!;
    if (Boolean(offer.only_vip))
      return {
        offer,
        rate: value,
        decision: "ignored",
        reason:
          "Oferta exclusiva para usuarios VIP; QvaPay no permite aplicarla con esta cuenta.",
      };
    if (
      (offer.type === "sell" && !this.huntEnabled(coin, "buy")) ||
      (offer.type === "buy" && !this.huntEnabled(coin, "sell"))
    ) return {
      offer,
      rate: value,
      decision: "ignored",
      reason: `Cacería de ${offer.type === "sell" ? "compra" : "venta"} detenida`,
    };
    const buyMax = configured.buyMaxRate;
    const sellMin = configured.sellMinRate;
    if (offer.type === "sell") {
      const market = this.market(coin);
      if (market?.purchaseMaxQusd && offer.amount > market.purchaseMaxQusd)
        return {
          offer,
          rate: value,
          decision: "ignored",
          reason: `Supera límite de ${market.purchaseMaxQusd} QUSD por compra`,
        };
      const transfer = outgoingFiatCost(
        offer.amount,
        value,
        configured.outgoingTransferFee,
      );
      if (value > buyMax)
        return {
          offer,
          rate: value,
          decision: "ignored",
          reason: `Supera máximo de compra (${buyMax} ${this.marketCurrency(coin)}/QUSD)`,
        };
      if (transfer.effectiveRate > buyMax)
        return {
          offer,
          rate: value,
          decision: "blocked",
          reason: `La tasa efectiva ${transfer.effectiveRate.toFixed(2)} supera el máximo de compra ${buyMax.toFixed(2)} ${this.marketCurrency(coin)}/QUSD (nominal ${value.toFixed(2)} + comisión ${transfer.fee.toFixed(2)})`,
        };
      const marketMedian = numeric(statistics?.median_sell);
      if (!marketMedian)
        return {
          offer,
          rate: value,
          decision: "blocked",
          reason: "Mediana P2P no disponible; compra automática bloqueada",
        };
      const priceGuardPercent =
        configured.priceGuardPercent ??
        this.automationConfig().priceGuardPercent;
      const floor = marketMedian * (1 - priceGuardPercent / 100);
      if (value < floor)
        return {
          offer,
          rate: value,
          decision: "blocked",
          reason: `${priceGuardPercent}% por debajo de la mediana de venta (${marketMedian.toFixed(2)})`,
        };
      if (!this.canFund(offer))
        return {
          offer,
          rate: value,
          decision: "ignored",
          reason: "Saldo fiat declarado insuficiente",
        };
      return {
        offer,
        rate: value,
        decision: "auto_buy",
        reason: "Compra automática elegible",
      };
    }
    if (value < sellMin)
      return {
        offer,
        rate: value,
        decision: "ignored",
        reason: `No alcanza mínimo de venta (${sellMin} ${this.marketCurrency(coin)}/QUSD)`,
      };
    const marketMedian = numeric(statistics?.median_buy);
    if (!marketMedian)
      return {
        offer,
        rate: value,
        decision: "blocked",
        reason: "Mediana P2P no disponible; venta bloqueada",
      };
    const priceGuardPercent =
      configured.priceGuardPercent ??
      this.automationConfig().priceGuardPercent;
    const ceiling = marketMedian * (1 + priceGuardPercent / 100);
    if (value > ceiling)
      return {
        offer,
        rate: value,
        decision: "blocked",
        reason: `${priceGuardPercent}% por encima de la mediana de compra (${marketMedian.toFixed(2)})`,
      };
    return {
      offer,
      rate: value,
      decision: "manual_sell",
      reason: "Venta elegible con aplicación manual",
    };
  }

  private canFund(offer: P2pOffer): boolean {
    const committed = this.store
      .activeOperations()
      .filter(
        (op) => op.offerType === "sell" && op.coin === this.offerMarket(offer),
      )
      .reduce(
        (sum, op) =>
          sum + op.receive + (this.market(op.coin)?.outgoingTransferFee ?? 0),
        0,
      );
    return (
      this.fiatBalance(this.offerMarket(offer)) - committed >=
      offer.receive +
        (this.market(this.offerMarket(offer))?.outgoingTransferFee ?? 0)
    );
  }

  private async evaluateAutomaticBuy(
    offer: P2pOffer,
    reference?: number,
  ): Promise<RiskDecision> {
    const store = this.store as Store;
    const config = this.marketConfig.current();
    const market = this.market(this.offerMarket(offer))!;
    const currentRate = rate(offer);
    const transfer = outgoingFiatCost(
      offer.amount,
      currentRate,
      market.outgoingTransferFee,
    );
    const expectedRevenue =
      market.sellMinRate * offer.amount * (1 - market.sellFeePercent / 100);
    const expectedMargin = transfer.total
      ? ((expectedRevenue - transfer.total) / transfer.total) * 100
      : 0;
    const effectiveRateAllowed = transfer.effectiveRate <= market.buyMaxRate;
    const now = Date.now();
    return evaluateRisk({
      now,
      opportunity: {
        uuid: offer.uuid,
        market: offer.coin,
        side: "buy_qusd",
        qusdAmount: offer.amount,
        requiredFiat: transfer.total,
        quotedRate: currentRate,
        referenceRate: reference ?? currentRate,
        observedAt: now,
        ...(offer.User?.uuid ? { counterpartyId: offer.User.uuid } : {}),
      },
      limits: config.risk,
      priceDecision:
        !effectiveRateAllowed
          ? "blocked"
          : config.risk.reviewedAt === null
          ? "manual_review"
          : reference
            ? "eligible"
            : "blocked",
      priceReason:
        !effectiveRateAllowed
          ? `La tasa efectiva ${transfer.effectiveRate.toFixed(2)} supera el máximo de compra ${market.buyMaxRate.toFixed(2)} (nominal ${currentRate.toFixed(2)} + comisión ${transfer.fee.toFixed(2)}).`
          : config.risk.reviewedAt === null
          ? "Los límites globales todavía no han sido revisados desde el panel."
          : reference
            ? "La tasa cumple el máximo de compra configurado."
            : "No existe una referencia de mercado válida.",
      expectedMarginPercent: expectedMargin,
      qusdBalance: await this.qva.qusdBalance(),
      fiatAvailable: this.fiatBalance(offer.coin),
      concurrentQusdExposure:
        store.activeOperations().reduce(
          (sum, operation) => sum + operation.amount,
          0,
        ) + store.activeReservedQusd(),
      dailyAppliedQusd: store.dailyAppliedQusd(dayStart(now)),
      activeOperations: store.activeOperations().length,
      consecutiveErrors: Number(store.get("consecutive_errors") ?? 0),
      paused: this.isPaused(),
      emergencyStop: store.get("emergency_stop") === "true",
      hasUnresolvedMutation: store.hasUnresolvedMutation(),
      ...this.riskCooldowns(offer),
    });
  }

  private syncWebAlerts(
    items: MarketItem[],
    scannedOfferTypes?: Array<"buy" | "sell">,
    snapshots: Array<MarketSnapshot & { coin: FiatMarket; side: "buy" | "sell" }> = [],
  ): void {
    if (this.isPaused() || this.mode() !== "real") {
      this.store.syncTradingAlerts([]);
      return;
    }
    this.store.syncTradingAlerts(
      items.flatMap((item) => {
        if (item.decision === "ignored")
          return [];
        const snapshot = snapshots.find(
          (entry) => entry.coin === item.offer.coin && entry.side === item.offer.type,
        );
        const referenceRate = numeric(
          item.offer.type === "sell"
            ? snapshot?.average?.median_sell
            : snapshot?.average?.median_buy,
        );
        return [
          {
            uuid: item.offer.uuid,
            coin: this.offerMarket(item.offer),
            offerType: item.offer.type,
            amount: item.offer.amount,
            receive: item.offer.receive,
            rate: item.rate,
            decision: item.decision,
            reason: item.reason,
            ...(referenceRate ? { referenceRate } : {}),
          },
        ];
      }),
      scannedOfferTypes,
    );
  }

  private opportunityScore(offer: P2pOffer): number {
    const market = this.market(this.offerMarket(offer))!;
    const quoted = rate(offer);
    if (offer.type === "sell")
      return quoted
        ? ((market.sellMinRate * offer.amount * (1 - market.sellFeePercent / 100) -
            outgoingFiatCost(
              offer.amount,
              quoted,
              market.outgoingTransferFee,
            ).total) /
            outgoingFiatCost(
              offer.amount,
              quoted,
              market.outgoingTransferFee,
            ).total) *
            100
        : Number.NEGATIVE_INFINITY;
    return market.buyMaxRate
      ? ((quoted * (1 - market.sellFeePercent / 100) - market.buyMaxRate) /
          market.buyMaxRate) *
          100
      : Number.NEGATIVE_INFINITY;
  }

  private persistScanCoverage(
    snapshots: Array<MarketSnapshot & { coin: FiatMarket; side: "buy" | "sell" }>,
    items: MarketItem[],
    includedBuySide: boolean,
  ): void {
    const scannedAt = Date.now();
    const coverage = this.activeMarkets().map((market) => {
      const marketItems = items.filter((item) => item.offer.coin === market.code);
      const sides = snapshots
        .filter((snapshot) => snapshot.coin === market.code)
        .map((snapshot) => snapshot.side);
      const total = snapshots
        .filter((snapshot) => snapshot.coin === market.code)
        .reduce((sum, snapshot) => sum + snapshot.total, 0);
      const statistics = snapshots
        .filter((snapshot) => snapshot.coin === market.code)
        .reduce<P2pAverage>(
          (combined, snapshot) => ({ ...combined, ...snapshot.average }),
          {},
        );
      const previousOffers =
        this.store.loadRemoteResource<{
          offers?: Array<P2pOffer & { rate?: number; decision?: string; reason?: string }>;
        }>(`market:${market.code}`)?.data.offers ?? [];
      const retainedOffers = includedBuySide
        ? []
        : previousOffers.filter((offer) => offer.type === "buy");
      const visibleItems = [
        ...marketItems.map((item) => ({
          ...item.offer,
          rate: item.rate,
          decision: item.decision,
          reason: item.reason,
        })),
        ...retainedOffers,
      ];
      this.store.saveRemoteResource(
        `market:${market.code}`,
        {
          total: Math.max(total, visibleItems.length),
          offers: visibleItems,
        },
        scannedAt,
      );
      if (Object.keys(statistics).length) {
        const previous = this.store.loadRemoteResource<Record<string, P2pAverage>>("averages")?.data ?? {};
        this.store.saveRemoteResource(
          "averages",
          { ...previous, [market.code]: statistics },
          scannedAt,
        );
      }
      this.store.recordMarketObservation({
        coin: market.code,
        ...optionalPositive("averageBuy", statistics.average_buy),
        ...optionalPositive("averageSell", statistics.average_sell),
        ...optionalPositive("medianBuy", statistics.median_buy),
        ...optionalPositive("medianSell", statistics.median_sell),
        ...optionalPositive("bestBuy", bestOfferRate(visibleItems, "buy")),
        ...optionalPositive("bestSell", bestOfferRate(visibleItems, "sell")),
        openOffers: Math.max(total, visibleItems.length),
        eligible: marketItems.filter(
          (item) => item.decision === "auto_buy" || item.decision === "manual_sell",
        ).length,
      });
      return {
        coin: market.code,
        sides,
        total,
        eligible: marketItems.filter((item) => item.decision === "auto_buy" || item.decision === "manual_sell").length,
        blocked: marketItems.filter((item) => item.decision === "blocked").length,
      };
    });
    this.store.set(
      "last_scan_coverage",
      JSON.stringify({ at: scannedAt, includedBuySide, markets: coverage }),
    );
  }

  private persistIncrementalMarketOffer(
    snapshot: MarketSnapshot & { coin: FiatMarket; side: "buy" | "sell" },
    items: MarketItem[],
  ): void {
    const previous = this.store.loadRemoteResource<{
      offers?: Array<P2pOffer & { rate?: number; decision?: string; reason?: string }>;
    }>(`market:${snapshot.coin}`)?.data.offers ?? [];
    const incoming = items.map((item) => ({
      ...item.offer,
      rate: item.rate,
      decision: item.decision,
      reason: item.reason,
    }));
    const incomingIds = new Set(incoming.map((offer) => offer.uuid));
    const offers = [
      ...incoming,
      ...previous.filter((offer) => !incomingIds.has(offer.uuid)),
    ].slice(0, 100);
    this.store.saveRemoteResource(
      `market:${snapshot.coin}`,
      { total: offers.length, offers },
      snapshot.scannedAt,
    );
    if (snapshot.average && Object.keys(snapshot.average).length) {
      const averages = this.store.loadRemoteResource<Record<string, P2pAverage>>("averages")?.data ?? {};
      this.store.saveRemoteResource(
        "averages",
        { ...averages, [snapshot.coin]: { ...averages[snapshot.coin], ...snapshot.average } },
        snapshot.scannedAt,
      );
    }
  }

  private async notifyRiskBlock(
    offer: P2pOffer,
    reason: string,
    referenceRate?: number,
  ): Promise<void> {
    const key = `risk_notice_fingerprint:${offer.uuid}`;
    const fingerprint = JSON.stringify({
      amount: offer.amount,
      receive: offer.receive,
      rate: rate(offer),
      reason,
      referenceRate: referenceRate ?? null,
    });
    if (this.store.get(key) === fingerprint) return;
    const now = Date.now();
    const coin = this.offerMarket(offer);
    await this.notify(
      `🛡️ Compra automática bloqueada: ${reason}`,
      undefined,
      {
        kind: "blocked-offer",
        alert: {
          uuid: offer.uuid,
          coin,
          offerType: offer.type,
          amount: offer.amount,
          receive: offer.receive,
          rate: rate(offer),
          reason,
          ...(referenceRate ? { referenceRate } : {}),
          updatedAt: now,
        },
      },
    );
    this.store.set(key, fingerprint);
  }

  private async applyBuyQusd(
    offer: P2pOffer,
    automatic: boolean,
    referenceRate?: number,
    deferPostApply = false,
  ): Promise<void> {
    if (automatic && !this.huntEnabled(this.offerMarket(offer), "buy"))
      throw new Error("La cacería de compra fue detenida antes de aplicar.");
    const market = this.market(this.offerMarket(offer))!;
    const transfer = outgoingFiatCost(
      offer.amount,
      rate(offer),
      market.outgoingTransferFee,
    );
    await this.monetaryIntents.execute({
      kind: "apply",
      operationUuid: offer.uuid,
      request: { uuid: offer.uuid, automatic },
      action: () => this.qva.apply(offer.uuid),
    });
    this.store.createOperation({
      uuid: offer.uuid,
      offerType: "sell",
      coin: this.offerMarket(offer),
      amount: offer.amount,
      receive: offer.receive,
      rate: rate(offer),
      state: "applied",
      autoApplied: automatic,
      cancelAt: automatic
        ? Date.now() + this.automationConfig().autoCancelMinutes * 60_000
        : null,
      createdAt: Date.now(),
      ...(offer.User?.uuid ? { counterpartyId: offer.User.uuid } : {}),
      ...(referenceRate === undefined ? {} : { referenceRate }),
    });
    this.store.audit(
      automatic ? "auto_apply_buy" : "manual_apply_buy",
      `Compra de ${offer.amount} QUSD · tasa nominal ${rate(offer).toFixed(2)} · comisión ${transfer.fee.toFixed(2)} · tasa efectiva ${transfer.effectiveRate.toFixed(2)}`,
      offer.uuid,
    );
    this.store.recordDecisionEvent({
      uuid: offer.uuid,
      coin: this.offerMarket(offer),
      offerType: offer.type,
      amount: offer.amount,
      receive: offer.receive,
      rate: rate(offer),
      decision: "applied",
      reason: `${automatic ? "Aplicación automática" : "Aplicación manual"} confirmada a tasa efectiva ${transfer.effectiveRate.toFixed(2)} (nominal ${rate(offer).toFixed(2)} + comisión ${transfer.fee.toFixed(2)}).`,
      ...(referenceRate === undefined ? {} : { referenceRate }),
    });
    const postApply = async () => {
      await this.sendChatBestEffort(offer.uuid);
      await this.notify(
        `Aplicaste a ${offer.amount} QUSD por ${offer.receive} ${this.marketCurrency(this.offerMarket(offer))} en ${this.marketLabel(this.offerMarket(offer))}.\nTasa nominal ${rate(offer).toFixed(2)} · comisión ${transfer.fee.toFixed(2)} · tasa efectiva ${transfer.effectiveRate.toFixed(2)} ${this.marketCurrency(this.offerMarket(offer))}/QUSD.\nPaga y usa /paid ${offer.uuid} REFERENCIA.\n${automatic ? `Cancelaré automáticamente en ${this.automationConfig().autoCancelMinutes} min si no indicas que pagarás: /ack ${offer.uuid}` : ""}`,
        offer.uuid,
        {
          kind: "operation-applied",
          uuid: offer.uuid,
          coin: this.offerMarket(offer),
          amount: offer.amount,
        },
      );
    };
    if (deferPostApply) queueMicrotask(() => void postApply().catch((error) => {
      this.store.audit(
        "notification_warning",
        error instanceof Error ? error.message : String(error),
        offer.uuid,
      );
    }));
    else await postApply();
  }

  private requireOperation(uuid: string) {
    const operation = this.store.getOperation(uuid);
    if (!operation)
      throw new Error("No existe una operación local con ese UUID.");
    return operation;
  }
  private async sendChatBestEffort(uuid: string): Promise<void> {
    try {
      const sentAt = Date.now();
      const sent = await this.qva.sendChat(uuid, this.automationConfig().welcomeMessage);
      this.store.set(`chat:auto_message:${uuid}`, JSON.stringify({ id: sent.id ?? null, sentAt: sent.createdAt ?? sentAt }));
    } catch (error) {
      this.store.audit(
        "chat_warning",
        error instanceof Error ? error.message : String(error),
        uuid,
      );
      await this.notify(
        `⚠️ La operación ${uuid} quedó registrada, pero no se pudo enviar el mensaje automático al chat P2P.`,
      );
    }
  }

  private async acknowledgeFromOwnChat(uuid: string, appliedAt: number): Promise<boolean> {
    const [profile, messages] = await Promise.all([this.qva.profile(), this.qva.listChat(uuid)]);
    let automatic: { id?: string | null; sentAt?: number } = {};
    try { automatic = JSON.parse(this.store.get(`chat:auto_message:${uuid}`) ?? "{}"); } catch { /* ignora metadatos dañados */ }
    const own = messages.find((message) =>
      message.peerId === profile.uuid &&
      message.id !== automatic.id &&
      (message.createdAt === undefined || message.createdAt >= Math.max(appliedAt, automatic.sentAt ?? appliedAt)),
    );
    if (!own) return false;
    this.store.updateOperation(uuid, "acknowledged", null);
    this.store.set(`chat:ack_message:${uuid}`, JSON.stringify({ id: own.id, detectedAt: Date.now() }));
    this.store.audit("chat_acknowledged", "Mensaje propio detectado; autocancelación detenida.", uuid);
    await this.notify(`✅ Detecté tu mensaje en el chat de ${uuid}. La cancelación automática quedó detenida.`);
    return true;
  }
  private offerMarket(offer: Pick<P2pOffer, "coin">): FiatMarket {
    if (!this.isMarket(offer.coin))
      throw new Error(`Mercado fiat no compatible: ${offer.coin}`);
    return offer.coin;
  }
  private requireRealMode(): void {
    if (this.mode() !== "real" || !this.cfg.realTradingAllowed)
      throw new Error(
        "Acción bloqueada: configura CONFIRM_REAL_TRADING=true y reinicia QvaApply.",
      );
  }

  private async handleError(
    action: string,
    error: unknown,
    uuid?: string,
  ): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    if (isQvaPayFailure(error)) {
      const detail = qvaPayFailureDetail(action, error);
      this.store.audit(`${action}_qvapay_error`, detail, uuid);
      this.store.set(
        "last_qvapay_error",
        JSON.stringify({ at: Date.now(), action, detail, ...(uuid ? { uuid } : {}) }),
      );
      if (error instanceof QvaApiError && error.status === 401)
        this.setPaused(true, "sesión de QvaPay inválida");
      await this.notify(
        `${detail}\nEste fallo procede de QvaPay o de la conexión y no se contabiliza como error interno del bot.${
          error instanceof QvaApiError && error.status === 401
            ? "\nEl bot fue pausado; ejecuta pnpm login."
            : ""
        }`,
      );
      return;
    }
    const failures = Number(this.store.get("consecutive_errors") ?? 0) + 1;
    this.store.set("consecutive_errors", String(failures));
    this.store.audit(`${action}_error`, message, uuid);
    const threshold = this.marketConfig.current().risk.maxConsecutiveErrors;
    if (
      (error instanceof QvaApiError && error.status === 401) ||
      failures >= threshold
    )
      this.setPaused(true, "protección automática por errores");
    await this.notify(
      `Error en ${action}${uuid ? ` (${uuid})` : ""}: ${message}${error instanceof QvaApiError && error.status === 401 ? "\nEl bot fue pausado; ejecuta pnpm login." : ""}`,
    );
  }

  private async getAverages(): Promise<Record<string, P2pAverage> | undefined> {
    if (this.averagesCache && this.averagesCache.expiresAt > Date.now())
      return this.averagesCache.value;
    try {
      const value = await this.qva.p2pAverages();
      this.averagesCache = { value, expiresAt: Date.now() + 60_000 };
      return value;
    } catch (error) {
      this.store.audit(
        "averages_error",
        error instanceof Error ? error.message : String(error),
      );
      return undefined;
    }
  }

  private closeRemoteOperation(uuid: string, detail: string): void {
    this.store.updateOperation(uuid, "cancelled");
    this.store.set(`retry:auto_cancel:${uuid}`, "0");
    this.store.audit("remote_operation_closed", detail, uuid);
  }

  private scheduleAutoCancelRetry(uuid: string, error: unknown): void {
    const attempts =
      Number(this.store.get(`retry:auto_cancel:${uuid}`) ?? 0) + 1;
    const delay = Math.min(
      10 * 60_000,
      60_000 * 2 ** Math.min(attempts - 1, 4),
    );
    this.store.set(`retry:auto_cancel:${uuid}`, String(attempts));
    this.store.updateOperation(uuid, "applied", Date.now() + delay);
    this.store.audit(
      "auto_cancel_retry",
      `Reintento ${attempts} en ${Math.round(delay / 60_000)} min: ${error instanceof Error ? error.message : String(error)}`,
      uuid,
    );
  }

  private scheduleRefreshRetry(uuid: string, error: unknown): void {
    const key = `refresh_attempts:${uuid}`;
    const attempts = Number(this.store.get(key) ?? 0) + 1;
    const delay = Math.min(
      10 * 60_000,
      60_000 * 2 ** Math.min(attempts - 1, 4),
    );
    this.store.set(key, String(attempts));
    this.store.set(`refresh_retry:${uuid}`, String(Date.now() + delay));
    this.store.audit(
      "refresh_retry",
      `Reintento ${attempts} en ${Math.round(delay / 60_000)} min: ${error instanceof Error ? error.message : String(error)}`,
      uuid,
    );
  }

  private recordRefresh(uuid: string, updatedAt?: string): void {
    const timestamp = updatedAt ? Date.parse(updatedAt) : Date.now();
    this.store.set(
      `last_refresh:${uuid}`,
      String(Number.isFinite(timestamp) ? timestamp : Date.now()),
    );
    this.store.set("last_offer_edit_at", String(Date.now()));
    this.store.set(`refresh_retry:${uuid}`, "0");
    this.store.set(`refresh_attempts:${uuid}`, "0");
  }

  private recordScan(
    inspected: number,
    candidates: number,
    result: string,
  ): void {
    const now = Date.now();
    const snapshot = { at: now, inspected, candidates, result };
    this.store.set("consecutive_errors", "0");
    this.store.set("last_scan", JSON.stringify(snapshot));
    const fingerprint = JSON.stringify({ inspected, candidates, result });
    const previous = this.store.get("last_scan_audit_fingerprint");
    const lastAuditAt = Number(this.store.get("last_scan_audit_at") ?? 0);
    if (previous === fingerprint && now - lastAuditAt < 60_000) return;
    this.store.set("last_scan_audit_fingerprint", fingerprint);
    this.store.set("last_scan_audit_at", String(now));
    this.store.audit(
      "scan_complete",
      `${inspected} ofertas · ${candidates} candidatas · ${result}`,
    );
  }

  private riskCooldowns(offer: P2pOffer) {
    const store = this.store as Store;
    const marketAt = store.lastOperationAt(offer.coin);
    const counterpartyAt = offer.User?.uuid
      ? store.lastOperationAt(offer.coin, offer.User.uuid)
      : undefined;
    return {
      ...(marketAt === undefined ? {} : { lastMarketOperationAt: marketAt }),
      ...(counterpartyAt === undefined
        ? {}
        : { lastCounterpartyOperationAt: counterpartyAt }),
    };
  }
}

function isQvaPayFailure(error: unknown): boolean {
  return (
    error instanceof QvaApiError ||
    error instanceof QvaConnectionError ||
    error instanceof QvaMutationUncertainError ||
    (error instanceof Error && error.message.includes("QvaPay"))
  );
}

function isDefinitiveQvaApplyRejection(error: unknown): error is QvaApiError {
  return (
    error instanceof QvaApiError &&
    [400, 403, 404, 409].includes(error.status)
  );
}

function isDefinitiveAccountRestriction(error: unknown): error is QvaApiError {
  return (
    error instanceof QvaApiError &&
    [403, 404].includes(error.status) &&
    /\bVIP\b|KYC/i.test(error.message)
  );
}

function qvaPayFailureDetail(action: string, error: unknown): string {
  if (error instanceof QvaApiError)
    return `⚠️ QvaPay rechazó ${action} (HTTP ${error.status}): ${error.message}`;
  if (error instanceof QvaConnectionError)
    return `🌐 No se pudo completar ${action} por la conexión con QvaPay: ${error.message}`;
  if (error instanceof QvaMutationUncertainError)
    return `⚠️ QvaPay no confirmó ${action}: ${error.message}`;
  return `⚠️ QvaPay devolvió un dato no utilizable durante ${action}: ${
    error instanceof Error ? error.message : String(error)
  }`;
}

/** @deprecated Use TradingEngine. Kept while Telegram and HTTP adapters migrate. */
export { TradingEngine as TradingService };

function reconcileOwnOfferMutation(
  intent: ReturnType<TradingRepository["recentMutationIntents"]>[number],
  ownOffers: P2pOffer[],
): Record<string, unknown> | undefined {
  const request = isRecord(intent.request) ? intent.request : undefined;
  if (!request) return undefined;

  if (intent.kind === "cancel_offer" && intent.operationUuid) {
    if (ownOffers.some((offer) => offer.uuid === intent.operationUuid))
      return undefined;
    // listOwnOffers solicita 20 posiciones. Si la página está llena, la
    // ausencia no demuestra que la oferta haya dejado de estar abierta.
    if (ownOffers.length >= 20) return undefined;
    return { outcome: "not_open" };
  }

  if (intent.kind === "edit_offer" && intent.operationUuid) {
    const remote = ownOffers.find((offer) => offer.uuid === intent.operationUuid);
    if (!remote) return undefined;
    if (request.refresh === true)
      return { outcome: "open", remoteStatus: remote.status };
    if (
      !sameObservableAmount(remote.amount, request.amount) ||
      !sameObservableAmount(remote.receive, request.receive)
    ) return undefined;
    return {
      outcome: "matched",
      remoteStatus: remote.status,
      remoteAmount: remote.amount,
      remoteReceive: remote.receive,
    };
  }

  if (intent.kind === "create_offer") {
    const remote = ownOffers.find((offer) => {
      const createdAt = offer.created_at ? Date.parse(offer.created_at) : Number.NaN;
      return offer.type === request.type &&
        offer.coin === request.coin &&
        sameObservableAmount(offer.amount, request.amount) &&
        sameObservableAmount(offer.receive, request.receive) &&
        Number.isFinite(createdAt) &&
        createdAt >= intent.createdAt - 60_000;
    });
    if (!remote) return undefined;
    return {
      outcome: "matched",
      remoteUuid: remote.uuid,
      remoteStatus: remote.status,
    };
  }

  return undefined;
}

function sameObservableAmount(left: unknown, right: unknown): boolean {
  const a = Number(left);
  const b = Number(right);
  return Number.isFinite(a) &&
    Number.isFinite(b) &&
    Math.round((a + Number.EPSILON) * 100) ===
      Math.round((b + Number.EPSILON) * 100);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export const rate = (offer: Pick<P2pOffer, "amount" | "receive">): number =>
  offer.receive / offer.amount;
const numeric = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : typeof value === "string" &&
        Number.isFinite(Number(value)) &&
        Number(value) > 0
      ? Number(value)
      : undefined;
const snapshotKey = (coin: FiatMarket, side: "buy" | "sell"): string =>
  `${coin}:${side}`;
const isTerminal = (status: string): boolean =>
  ["cancelled", "canceled", "completed"].includes(
    status.toLowerCase(),
  );

function operationStateFromRemote(
  current: OperationState,
  remoteStatus: string,
): OperationState {
  switch (remoteStatus.toLowerCase()) {
    case "completed":
      return "completed";
    case "cancelled":
    case "canceled":
    case "open":
      return "cancelled";
    case "revision":
      return "revision";
    case "paid":
      return "paid";
    case "processing":
      return ["acknowledged", "paid", "revision"].includes(current)
        ? current
        : "applied";
    default:
      return current;
  }
}

function operationStateFromFeed(
  current: OperationState,
  event: Exclude<P2pFeedEvent, "p2p.created" | "p2p.reopened">,
): OperationState {
  if (current === "completed" || current === "cancelled") return current;
  switch (event) {
    case "p2p.applied":
      return ["acknowledged", "paid", "revision"].includes(current)
        ? current
        : "applied";
    case "p2p.paid":
      return "paid";
    case "p2p.completed":
      return "completed";
    case "p2p.cancelled":
      return "cancelled";
  }
}

function reconciledOperationMutationState(
  kind: string,
  current: OperationState,
  remoteStatus: string,
): OperationState | undefined {
  const status = remoteStatus.toLowerCase();
  if (kind === "paid" && ["paid", "completed"].includes(status))
    return operationStateFromRemote(current, status);
  if (kind === "received" && status === "completed") return "completed";
  if (
    kind === "cancel" &&
    ["open", "cancelled", "canceled", "completed"].includes(status)
  )
    return operationStateFromRemote(current, status);
  return undefined;
}

function operationStatusShowsApplication(status: string): boolean {
  return ["processing", "paid", "revision", "completed"].includes(status);
}

function isRecoverableOperationOffer(offer: P2pOffer): boolean {
  return (
    (offer.type === "buy" || offer.type === "sell") &&
    typeof offer.coin === "string" &&
    offer.coin.length > 0 &&
    Number.isFinite(offer.amount) &&
    offer.amount > 0 &&
    Number.isFinite(offer.receive) &&
    offer.receive > 0
  );
}

function optionalPositive<K extends string>(key: K, value: unknown): Partial<Record<K, number>> {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0
    ? ({ [key]: parsed } as Record<K, number>)
    : {};
}

function bestOfferRate(
  offers: Array<P2pOffer & { rate?: number }>,
  type: "buy" | "sell",
): number | undefined {
  const rates = offers
    .filter((offer) => offer.type === type)
    .map((offer) => Number(offer.rate ?? offer.receive / offer.amount))
    .filter((value) => Number.isFinite(value) && value > 0);
  if (!rates.length) return undefined;
  return type === "buy" ? Math.max(...rates) : Math.min(...rates);
}

function huntingChangeDetail(values: Parameters<TradingEngine["updateHunting"]>[0]): string {
  const changes = [
    values.buyRunning === undefined ? undefined : `compra general=${values.buyRunning ? "activa" : "detenida"}`,
    values.sellRunning === undefined ? undefined : `venta general=${values.sellRunning ? "activa" : "detenida"}`,
    values.market ? `mercado=${values.market.code}` : undefined,
  ].filter(Boolean);
  return changes.join(" · ") || "Sin cambios";
}

function liquidityEconomics(config: TradingConfig) {
  return Object.fromEntries(
    config.markets.map((market) => [
      market.code,
      {
        buyMaxRate: market.buyMaxRate,
        sellFeePercent: market.sellFeePercent,
        outgoingTransferFee: market.outgoingTransferFee,
      },
    ]),
  );
}

function dayStart(now: number): number {
  const date = new Date(now);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}
