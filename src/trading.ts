import { huntingRequirementReason } from "./hunting-requirements.js";
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
import { ReconciliationScheduler } from "./reconciliation-scheduler.js";
import { applyReadyAt } from "./core/apply-budget.js";
import { sizeFlexibleOffer, orderForOperation, matchingRecoveryOrder } from "./flexible-order.js";

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
  kind: "operation-applied" | "own-offer-applied" | "reconciliation-required";
  uuid: string;
  coin: FiatMarket;
  amount: number;
  eventVersion?: string;
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
  private readonly reconciliationInFlight = new Set<string>();
  private averagesCache?: {
    value: Record<string, P2pAverage>;
    expiresAt: number;
  };
  private refreshRoundInFlight = false;
  private qusdBalanceCache?: { value: number; updatedAt: number; epoch: string };
  private readinessInFlight = false;
  private liquidityPreparingUuid?: string;
  private nextLiquidityPreparationAt = 0;
  private scanInFlight: Promise<{
    inspected: number;
    candidates: number;
    action?: string;
  }> | undefined;
  private decisionTail: Promise<void> = Promise.resolve();
  private ownDecisionPending = 0;
  private fiatDecisions = 0;
  private readonly fiatDecisionWaiters: Array<() => void> = [];
  private readonly offersInFlight = new Set<string>();
  private secondaryObserver?: (offer: P2pOffer, receivedAt: number) => void;
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

  observeSecondaryOpportunities(observer: (offer: P2pOffer, receivedAt: number) => void): void {
    this.secondaryObserver = observer;
  }

  ownDecisionBusy(): boolean { return this.ownDecisionPending > 0; }

  isOwnMarketOffer(offer: P2pOffer): boolean {
    const account = this.store.get("analytics_account_uuid");
    return this.ownsOfferUuid(offer.uuid) || Boolean(account &&
      [offer.owner_uuid,offer.User?.uuid,offer.Peer?.uuid].includes(account));
  }

  cooperativeOwnCapacity(coin: string, ownerFiat: number): boolean {
    const committed = this.store.activeOperations().filter(op => op.coin === coin && op.offerType === "sell" && !this.store.hasFiatMovement(op.uuid))
      .reduce((sum,op) => sum + this.operationFiatCost(op),0);
    const reserved = Number(this.store.get(`cooperative_fiat_reserved:${coin}`) ?? 0);
    const open = this.store.loadRemoteResource<{ type: string; coin: string; status: string; receive: number }[]>("own-offers")?.data ?? [];
    const advertised = open.filter(offer => offer.type === "buy" && offer.coin === coin && offer.status === "open")
      .reduce((sum,offer) => sum + this.cooperativeOwnerCost(coin, offer.receive), 0);
    return Number.isFinite(ownerFiat) && ownerFiat >= 0 && this.fiatBalance(coin) - committed - advertised - this.store.applicationReservedCapital(coin).fiat - this.uncertainFlexibleCapital("sell", coin) - this.store.cooperativeParticipantReserved(coin) >= reserved;
  }

  cooperativeOwnerCost(coin: string, amount: number): number { return amount + (amount > 0 ? this.market(coin)?.outgoingTransferFee ?? 0 : 0); }

  private operationFiatCost(operation: { uuid: string; coin: string; receive: number }): number {
    const raw = this.store.get(`cooperative_owner_fiat:${operation.uuid}`);
    const amount = raw !== undefined && raw !== "" ? Number(raw) : operation.receive;
    return this.cooperativeOwnerCost(operation.coin, amount);
  }

  private recordOutgoingFiat(operation: { uuid: string; coin: string; receive: number }, source: string, occurredAt?: number): boolean {
    const cost = this.operationFiatCost(operation);
    if (cost === 0) return false;
    const before = this.fiatBalance(operation.coin);
    const changed = this.store.recordFiatMovement(operation.uuid, operation.coin, "debit", cost, source, occurredAt);
    const raw = this.store.get(`cooperative_owner_fiat:${operation.uuid}`);
    if (changed && this.fiatBalance(operation.coin) < before && raw !== undefined && raw !== "") {
      const key = `cooperative_local_balance:${operation.coin}`;
      const previous = this.store.get(key);
      // Only this share was already debited by Sync Core. Preserve any personal
      // movement still waiting to be synchronized instead of resetting its base.
      if (previous !== undefined && previous !== "" && Number.isFinite(Number(previous)))
        this.store.set(key, String(Number(previous) - Number(raw)));
    }
    return changed;
  }

  cooperativeSafetyReason(offer: P2pOffer): string | undefined {
    if (this.mode() !== "real" || this.isPaused() || this.store.get("emergency_stop") === "true") return "Motor propio detenido";
    if (this.store.hasUnresolvedMutationForOffer(offer.uuid)) return "Oferta pendiente de conciliación";
    if (!this.isMarket(offer.coin) || offer.type !== "sell" || offer.status !== "open" || offer.offer_kind === "flexible") return "Oferta no compatible";
    if (explicitFlag(offer.only_vip) !== "false") return "Restricción VIP";
    const requirementReason = huntingRequirementReason(this.store, offer);
    if (requirementReason) return requirementReason;
    const account = this.store.get("analytics_account_uuid");
    if (this.ownsOfferUuid(offer.uuid) || account && (offer.owner_uuid === account || offer.User?.uuid === account)) return "Oferta propia";
    if (this.isExcludedAfterManualCancel(offer.uuid) || this.store.getOperation(offer.uuid)) return "Oferta excluida o ya registrada";
    const state = this.store.latestMarketFeedState(offer.uuid);
    if (state && state.status !== "open") return "Oferta invalidada por el feed";
    return this.suspiciousBuyPriceReason(offer);
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
    const previousBalances = new Map(this.marketConfig.markets().map((market) => [market.code, this.fiatBalance(market.code)]));
    const saved = this.marketConfig.save(
      next,
      source,
      reason,
    );
    for (const market of saved.markets) {
      this.store.set(`fiat_balance:${market.code}`, String(market.fiatBalance));
      if (source === "panel" && previousBalances.get(market.code) !== market.fiatBalance) {
        this.store.set(`cooperative_balance_declared:${market.code}`, randomUUID());
        this.store.set(`fiat_balance_declared_at:${market.code}`, String(Date.now()));
      }
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
    this.store.set(`fiat_balance_declared_at:${coin}`, String(Date.now()));
    this.marketConfig.updateBalance(coin, amount);
    this.store.set(`cooperative_balance_declared:${coin}`, randomUUID());
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
    const lastPauseChange = this.store.lastPauseChange();
    const legacyAutomaticPause = lastPauseChange?.action === "paused" &&
      /desde (protección automática por errores|sesión de QvaPay inválida)/.test(lastPauseChange.detail);
    this.setPaused(
      this.store.get("emergency_stop") === "true" ||
        (this.store.get("paused") === "true" && !legacyAutomaticPause),
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

  async reconcilePendingStandaloneMutations(options: {
    intentId?: string;
    force?: boolean;
  } = {}): Promise<number> {
    let reconciled = 0;
    const retry = new ReconciliationScheduler(this.store);
    const recordCheck = (intentId: string, error: string) => this.store.set(
      `reconciliation_last_check:${intentId}`,
      JSON.stringify({ checkedAt: Date.now(), error: safeRecoveryCheckError(error) }),
    );
    const pending = this.store
      .recoverableMutationIntents()
      .filter((intent) =>
        !intent.workflowId &&
        (!options.intentId || intent.intentId === options.intentId) &&
        !this.reconciliationInFlight.has(intent.intentId) &&
        (options.force === true || retry.canAttempt(intent.intentId, Date.now())),
      );
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
    let ownOfferCheckError: string | undefined;
    if (pendingOwnOffers.length) {
      try {
        ownOffers = await this.listOwnOffers();
      } catch (error) {
        ownOfferCheckError = qvaPayFailureDetail("consultar las ofertas propias", error);
        this.store.audit(
          "standalone_offer_reconciliation_pending",
          qvaPayFailureDetail("consultar las ofertas propias", error),
        );
      }
    }
    for (const intent of pending) {
      const current = this.store.getMutationIntent(intent.intentId);
      if (!current || current.state !== intent.state || current.updatedAt !== intent.updatedAt ||
        this.reconciliationInFlight.has(intent.intentId)) continue;
      this.reconciliationInFlight.add(intent.intentId);
      try {
        recordCheck(intent.intentId, "La consulta no confirmó todavía el resultado de la mutación.");
        if (operationKinds.has(intent.kind) && intent.operationUuid) {
          const operation = this.store.getOperation(intent.operationUuid);
          if (!operation) {
            recordCheck(intent.intentId, "No existe una operación local asociada; se requiere revisión.");
            continue;
          }
          try {
            const remote = orderForOperation(await this.qva.getOffer(intent.operationUuid), operation.orderUuid);
            const next = reconciledOperationMutationState(
              intent.kind,
              operation.state,
              remote.status,
            );
            if (!next) continue;
            if (next !== operation.state)
              this.store.updateOperation(intent.operationUuid, next);
            this.recordFlexibleFiat(operation, remote.status, remote.updated_at ? Date.parse(remote.updated_at) : undefined);
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
            recordCheck(intent.intentId, qvaPayFailureDetail(`conciliar ${intent.kind}`, error));
            this.store.audit(
              "operation_mutation_reconciliation_pending",
              qvaPayFailureDetail(`conciliar ${intent.kind}`, error),
              intent.operationUuid,
            );
          }
          continue;
        }
        if (ownOfferKinds.has(intent.kind)) {
          if (!ownOffers) {
            if (ownOfferCheckError) recordCheck(intent.intentId, ownOfferCheckError);
            continue;
          }
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
          const request = isRecord(intent.request) ? intent.request : {};
          if (request.offerKind === "flexible" || remote.offer_kind === "flexible") {
            const saved = isRecord(intent.response) ? intent.response : {};
            const knownOrder = typeof saved.order === "string" ? saved.order : this.store.getOperation(uuid)?.orderUuid;
            let account = this.store.get("analytics_account_uuid");
            if (!knownOrder && !account) {
              account = (await this.qva.profile()).uuid;
              if (account) this.store.set("analytics_account_uuid", account);
            }
            const order = knownOrder ? remote.Orders?.find(item => item.uuid === knownOrder)
              : matchingRecoveryOrder(remote, Number(request.amount), intent.createdAt, account);
            if (!order) { recordCheck(intent.intentId, "No hay una orden propia inequívoca; registra evidencia o vuelve a comprobar."); continue; }
            const state = operationStateFromRemote("applied", order.status);
            this.store.createOperation({ uuid, orderUuid: order.uuid, offerType: remote.type, coin: remote.coin,
              amount: order.amount, receive: order.receive, rate: order.receive / order.amount,
              state, autoApplied: request.automatic === true, cancelAt: null, createdAt: intent.createdAt,
              ...(remote.User?.uuid ? { counterpartyId: remote.User.uuid } : {}) });
            const recovered = this.store.getOperation(uuid);
            if (recovered?.orderUuid === order.uuid) {
              this.store.updateOperation(uuid, state);
              this.recordFlexibleFiat(recovered, order.status, order.updated_at ? Date.parse(order.updated_at) : remote.updated_at ? Date.parse(remote.updated_at) : undefined);
            }
            this.store.updateMutationIntent(intent.intentId, "reconciled", { order: order.uuid, remoteStatus: order.status });
            this.store.audit("flexible_order_reconciled", `Orden propia ${order.uuid} confirmada en QvaPay.`, uuid);
            reconciled++;
            continue;
          }
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
              if (isRecord(intent.request) && intent.request.capitalReserve) {
                const account = this.store.get("analytics_account_uuid") ?? (await this.qva.profile()).uuid;
                if (!account || remote.Peer?.uuid !== account) {
                  recordCheck(intent.intentId, "La operación remota no identifica esta cuenta como contraparte; se conserva su reserva.");
                  continue;
                }
              }
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
          if (isRecord(intent.request) && intent.request.offerKind === "flexible") {
            recordCheck(intent.intentId, qvaPayFailureDetail("conciliar orden flexible", error));
            continue;
          }
          const checkedAt = Date.now();
          this.store.set(
            `reconciliation_last_check:${intent.intentId}`,
            JSON.stringify({
              checkedAt,
              error: safeRecoveryCheckError(qvaPayFailureDetail("conciliar la aplicación", error)),
            }),
          );
          // An inaccessible detail is not proof of rejection. A later, authenticated
          // cancellation corroborates that this UUID has no remaining payable deal.
          const terminal = this.store.latestMarketFeedState(uuid);
          if (
            error instanceof QvaApiError && error.status === 404 &&
            terminal?.event === "p2p.cancelled" && terminal.status === "cancelled" &&
            terminal.sentAt > intent.createdAt && terminal.sentAt <= Date.now() &&
            terminal.receivedAt >= intent.createdAt
          ) {
            const existing = this.store.getOperation(uuid);
            // Cancellation does not establish what happened to money already sent.
            if (existing && ["paid", "revision"].includes(existing.state)) continue;
            if (existing && !["completed", "cancelled"].includes(existing.state))
              this.store.updateOperation(uuid, "cancelled");
            this.store.updateMutationIntent(intent.intentId, "reconciled", {
              remoteStatus: "cancelled", evidence: "authenticated_feed_and_detail_404",
              eventSentAt: terminal.sentAt,
            });
            this.store.audit(
              "standalone_apply_reconciled",
              "El feed autenticado confirmó la cancelación posterior de esta oferta; no quedan obligaciones activas. El 404 aislado no se interpretó como VIP ni rechazo.",
              uuid,
            );
            reconciled += 1;
            continue;
          }
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
      } finally {
        this.reconciliationInFlight.delete(intent.intentId);
        if (this.store.recoverableMutationIntents().some((item) => item.intentId === intent.intentId))
          retry.recordFailure(intent.intentId, Date.now());
        else retry.clear(intent.intentId);
      }
    }
    return reconciled;
  }

  reconcileWorkflow(workflowId: string) {
    return this.opportunityOrchestrator.reconcile(workflowId);
  }

  isReconciliationInFlight(intentId: string): boolean {
    return this.reconciliationInFlight.has(intentId);
  }

  private offerRejectionDetail(action: string, error: unknown, uuid: string): string {
    if (error instanceof QvaApiError && error.code?.startsWith("LOCAL_"))
      return `Validación local: ${error.message}`;
    const detail = qvaPayFailureDetail(action, error);
    if (!(error instanceof QvaApiError) || ![403, 404].includes(error.status)) return detail;
    const latest = this.store.latestMarketFeedState(uuid);
    if (!latest || latest.sentAt > Date.now()) return detail;
    if (latest.event === "p2p.applied" && latest.status === "processing")
      return `${detail}; feed autenticado: oferta ocupada por una aplicación (no identifica quién).`;
    if (latest.event === "p2p.cancelled" && latest.status === "cancelled")
      return `${detail}; feed autenticado: oferta cancelada.`;
    return detail;
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
    const previousMedian = type === "sell" ? this.store.recentSellMedian(coin) : undefined;
    const guard = this.market(coin)?.priceGuardPercent ?? this.automationConfig().priceGuardPercent;
    const samples = [...new Map(matchingOffers
      .filter(offer => Number.isFinite(rate(offer)) && rate(offer) > 0)
      .filter(offer => !previousMedian || rate(offer) >= previousMedian * (1 - guard / 100))
      .map(offer => [offer.uuid, rate(offer)])).values()];
    const officialMedian = numeric(averages?.[coin]?.[type === "buy" ? "median_buy" : "median_sell"]);
    // One offer (or repeated UUIDs) cannot become its own safety reference.
    const marketMedian = type === "buy"
      ? median(matchingOffers.map(rate))
      : officialMedian ?? (samples.length >= 3 ? median(samples) : undefined);
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

  async ingestMarketUpdate(update: MarketPageUpdate, options: { realtimeRecovery?: boolean } = {}): Promise<{
    inspected: number;
    candidates: number;
    action?: string;
  }> {
    if (this.scanInFlight) return this.scanInFlight;
    const run = options.realtimeRecovery ? this.ingestRealtimeRecovery(update) : this.ingestMarketUpdateOnce(update);
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
    event: "p2p.created" | "p2p.reopened" | "p2p.range_created" | "p2p.range_updated" = "p2p.created",
    sentAt?: string,
  ): Promise<{ inspected: number; candidates: number; action?: string }> {
    if (this.offersInFlight.has(offer.uuid)) return { inspected: 1, candidates: 0, action: "Aplicación a esta oferta ya en curso" };
    this.offersInFlight.add(offer.uuid);
    try {
    const decide = async () => {
      if (event === "p2p.reopened" && offer.status === "open" && this.ownsOfferUuid(offer.uuid)) {
        const cycleKey = `trading:own_offer_cycle:${offer.uuid}`;
        const current = Number(this.store.get(cycleKey) ?? 0);
        this.store.set(cycleKey, String(Number.isSafeInteger(current) && current >= 0 ? current + 1 : 1));
      }
      return this.ingestPreparedMarketOffer(offer, receivedAt, event, sentAt);
    };
    const result = await (offer.type === "sell" ? this.withFiatDecision(decide) : this.withDecisionTurn(decide));
    const secondary = this.secondaryObserver;
    const publishedAt = sentAt ? Date.parse(sentAt) : Number.NaN;
    if (result.candidates === 0 && secondary) setImmediate(() => secondary(offer,
      Number.isFinite(publishedAt) ? Math.min(receivedAt, publishedAt) : receivedAt));
    return result;
    } finally { this.offersInFlight.delete(offer.uuid); }
  }

  private async withFiatDecision<T>(action: () => Promise<T>): Promise<T> {
    this.ownDecisionPending++;
    if (this.fiatDecisions >= 2) await new Promise<void>(resolve => this.fiatDecisionWaiters.push(resolve));
    else this.fiatDecisions++;
    try { return await action(); }
    finally {
      this.ownDecisionPending--;
      const next = this.fiatDecisionWaiters.shift();
      if (next) next(); else this.fiatDecisions--;
    }
  }

  private applicationRequest(offer: P2pOffer, extra: Record<string, unknown> = {}) {
    return { uuid: offer.uuid, coin: offer.coin, offerType: offer.type,
      amount: offer.amount, receive: offer.receive, offerKind: offer.offer_kind ?? "fixed", ...extra,
      capitalReserve: { coin: offer.coin, amount: offer.amount,
        fiat: offer.type === "sell" ? offer.receive + (this.market(offer.coin)?.outgoingTransferFee ?? 0) : 0,
        qusd: offer.type === "buy" ? offer.amount : 0 } };
  }

  private withDecisionTurn<T>(action: () => Promise<T>): Promise<T> {
    this.ownDecisionPending++;
    const next = this.decisionTail.then(action, action);
    this.decisionTail = next.then(() => undefined, () => undefined);
    return next.finally(() => { this.ownDecisionPending--; });
  }

  private async ingestRealtimeRecovery(update: MarketPageUpdate): Promise<{ inspected: number; candidates: number; action?: string }> {
    const snapshot = { ...await this.marketSnapshotFromPage(update.coin, update.side, update.page, update.scannedAt, true),
      coin: update.coin, side: update.side };
    this.persistIncrementalMarketOffer(snapshot, snapshot.items);
    // Only fresh, distinct observations may renew the safety reference. Cached
    // averages are display context and must not become a fresh trading median.
    const previousMedian = this.store.recentSellMedian(update.coin);
    const guard = this.market(update.coin)?.priceGuardPercent ?? this.automationConfig().priceGuardPercent;
    const samples = [...new Map(snapshot.items.filter(item => Number.isFinite(item.rate) && item.rate > 0 &&
      (!previousMedian || item.rate >= previousMedian * (1 - guard / 100)))
      .map(item => [item.offer.uuid, item.rate])).values()];
    if (update.side === "sell" && samples.length >= 3 && Date.now() - update.scannedAt <= 5_000)
      this.store.recordMarketObservation({ coin: update.coin, medianSell: median(samples)!,
        openOffers: snapshot.total, eligible: 0 });
    let candidates = 0;
    for (const item of snapshot.items.slice().sort((a, b) => this.opportunityScore(b.offer) - this.opportunityScore(a.offer))) {
      const result = await this.ingestMarketOffer(item.offer, update.scannedAt, "p2p.created", new Date(update.scannedAt).toISOString());
      candidates += result.candidates;
      if (result.action?.startsWith("aplicada ") || result.action?.startsWith("venta aplicada "))
        return { inspected: snapshot.items.length, candidates, action: result.action };
    }
    return { inspected: snapshot.items.length, candidates };
  }

  private async ingestPreparedMarketOffer(
    offer: P2pOffer,
    receivedAt: number,
    event: "p2p.created" | "p2p.reopened" | "p2p.range_created" | "p2p.range_updated",
    sentAt?: string,
  ): Promise<{ inspected: number; candidates: number; action?: string }> {
    if (this.isExcludedAfterManualCancel(offer.uuid))
      return { inspected: 1, candidates: 0, action: "Excluida por cancelación manual" };
    if (this.store.getOperation(offer.uuid))
      return { inspected: 1, candidates: 0, action: "Oferta con una operación local previa; requiere acción manual" };
    if (this.isPaused()) return { inspected: 0, candidates: 0, action: "pausado" };
    if (offer.status !== "open")
      return { inspected: 1, candidates: 0, action: `ya no disponible (${offer.status})` };
    const accountUuid = this.store.get("analytics_account_uuid");
    if (this.ownsOfferUuid(offer.uuid) || (accountUuid && (offer.owner_uuid === accountUuid || offer.User?.uuid === accountUuid)))
      return { inspected: 1, candidates: 0, action: "oferta propia; no consume cupo de aplicación" };
    if (!this.isMarket(offer.coin))
      return { inspected: 1, candidates: 0, action: "mercado no configurado" };
    if (!this.huntEnabled(offer.coin, offer.type === "sell" ? "buy" : "sell"))
      return { inspected: 0, candidates: 0, action: "mercado o cacería inactivos" };
    const vipFlag = explicitFlag(offer.only_vip);
    if (vipFlag === "true")
      return { inspected: 1, candidates: 0, action: "Oferta exclusiva para usuarios VIP" };
    if (vipFlag === "unknown")
      return { inspected: 1, candidates: 0, action: "restricción VIP no interpretable" };
    const requirementReason = huntingRequirementReason(this.store, offer);
    if (requirementReason) return { inspected: 1, candidates: 0, action: requirementReason };
    const candidate = offer;
    const observedAt = receivedAt;
    const publishedAt = sentAt ? Date.parse(sentAt) : Number.NaN;
    if (Number.isFinite(publishedAt) && Date.now() - publishedAt > 5_000) {
      return { inspected: 1, candidates: 0, action: "Cotización del feed antigua (>5 s); pendiente de una observación fresca" };
    }
    if (candidate.offer_kind === "flexible") return this.takeFlexibleOffer(candidate, true, observedAt, event === "p2p.range_updated" || event === "p2p.range_created");
    return candidate.type === "sell"
      ? this.ingestFastFiatFundedOffer(candidate, receivedAt, event, observedAt)
      : this.ingestFastQusdFundedOffer(candidate, receivedAt, event, observedAt);
  }

  private async takeFlexibleOffer(offer: P2pOffer, automatic: boolean, observedAt = Date.now(), renewed = false): Promise<{ inspected: number; candidates: number; action: string }> {
    const skip = (action: string) => ({ inspected: 1, candidates: 0, action });
    if (automatic && !renewed && this.store.isSeen(offer.uuid)) return skip("Oferta ya evaluada");
    if (!this.isMarket(offer.coin) || offer.status !== "open" || offer.can_take_flexible === false)
      return skip("Oferta flexible no disponible para esta cuenta");
    if (this.store.getOperation(offer.uuid) || this.store.hasUnresolvedMutationForOffer(offer.uuid) || this.isExcludedAfterManualCancel(offer.uuid))
      return skip("Oferta con operación previa o conciliación pendiente");
    const market = this.market(offer.coin)!;
    const quote = rate(offer);
    if (!Number.isFinite(quote) || quote <= 0 || (offer.type === "sell" ? quote > market.buyMaxRate : quote < market.sellMinRate))
      return skip("La tasa flexible no cumple el objetivo");
    const { sized, desired, balance } = await this.sizeFlexibleTake(offer);
    if (offer.type === "buy" && desired && (!sized || sized.amount < desired.amount)) {
      if (this.liquidityPreparingUuid) return skip("Saldo QUSD en preparación; se conserva el disponible verificado");
      this.requireRealMode();
      let freshAt = observedAt;
      const result = await this.opportunityOrchestrator.execute({
        target: desired, referenceRate: quote,
        expectedMarginPercent: (quote * (1 - market.sellFeePercent / 100) / market.buyMaxRate - 1) * 100,
        priceDecision: "eligible", priceReason: "La tasa flexible cumple el mínimo de venta.",
        unavailableQusd: this.uncertainFlexibleCapital("buy") + this.store.applicationReservedCapital().qusd,
        automatic,
        onTargetRefreshed: () => { freshAt = Date.now(); },
        ...(automatic ? { canApply: (intentId?: string, queued = 0) =>
          this.automaticDispatchAllowed(desired, intentId, Math.max(queued, Date.now() - freshAt), false) } : {}),
      });
      // Cancellation, application and restoration all change the remote balance.
      delete this.qusdBalanceCache;
      if (!result.applicationConfirmed) return skip(result.decision.reasons.join(" · "));
      this.store.markSeen(offer.uuid);
      queueMicrotask(() => void this.sendChatBestEffort(offer.uuid).catch(error =>
        this.store.audit("notification_warning", String(error), offer.uuid)));
      return { inspected: 1, candidates: 1, action: `venta aplicada ${offer.uuid}` };
    }
    if (!sized) return skip("El saldo libre o los límites no alcanzan el mínimo de la orden");
    if (offer.type === "sell" && outgoingFiatCost(sized.amount, quote, market.outgoingTransferFee).effectiveRate > market.buyMaxRate)
      return skip("La tasa con comisión supera el máximo de compra");
    if (automatic && !await this.automaticDispatchAllowed(sized, undefined, Date.now() - observedAt))
      return skip("Las condiciones de la cacería cambiaron");
    this.requireRealMode();
    let result: { order: string; amount: number; receive: number };
    try {
      result = await this.monetaryIntents.execute({
      kind: "apply", operationUuid: offer.uuid,
      request: this.applicationRequest(sized, { automatic }),
      action: async intentId => {
        const response = await this.qva.apply(offer.uuid, { amount: sized.amount,
          beforeDispatch: (queued: number) => automatic ? this.automaticDispatchAllowed(sized, intentId, Math.max(queued, Date.now() - observedAt))
            : sized.type === "sell" ? this.canFund(sized, intentId)
            : this.fastLaneQusdBalance(intentId).then(available => available - Math.max(this.strategy().reserve, this.marketConfig.current().risk.minQusdReserve) >= sized.amount) });
        if (!response?.order || response.amount !== sized.amount || !Number.isFinite(response.receive) || response.receive <= 0)
          throw new QvaMutationUncertainError("aplicar orden flexible", new Error("Respuesta de orden incompleta o importe distinto"));
        return response;
      },
    });
    } catch (error) {
      if (!automatic || !isDefinitiveQvaApplyRejection(error)) throw error;
      if (!error.code?.startsWith("LOCAL_")) this.store.markSeen(offer.uuid);
      this.store.audit("flexible_order_rejected", error.message, offer.uuid);
      return skip(error.message);
    }
    this.store.createOperation({ uuid: offer.uuid, orderUuid: result.order, offerType: offer.type, coin: offer.coin,
      amount: result.amount, receive: result.receive, rate: result.receive / result.amount,
      state: "applied", autoApplied: automatic, cancelAt: null, createdAt: Date.now(),
      ...(offer.User?.uuid ? { counterpartyId: offer.User.uuid } : {}) });
    if (offer.type === "buy") this.qusdBalanceCache = { epoch: this.store.get("qusd_balance_epoch") ?? "0", value: Math.max(0, balance + this.cooperativeQusdOwed() - result.amount), updatedAt: Date.now() };
    this.store.markSeen(offer.uuid);
    this.store.audit("flexible_order_applied", `Orden ${result.order}: ${result.amount} QUSD por ${result.receive} ${market.currency}.`, offer.uuid);
    queueMicrotask(() => void Promise.all([this.sendChatBestEffort(offer.uuid), this.notify(
      `Orden flexible aplicada: ${result.amount} QUSD.`, offer.uuid,
      { kind: "operation-applied", uuid: offer.uuid, coin: offer.coin, amount: result.amount },
    )]).catch(error => this.store.audit("notification_warning", String(error), offer.uuid)));
    return { inspected: 1, candidates: 1, action: `${offer.type === "sell" ? "aplicada" : "venta aplicada"} ${offer.uuid}` };
  }

  private async sizeFlexibleTake(offer: P2pOffer) {
    const market = this.market(offer.coin)!;
    const quote = rate(offer);
    const balance = offer.type === "buy" ? await this.fastLaneQusdBalance() : 0;
    const risk = this.marketConfig.current().risk;
    const pending = this.store.applicationReservedCapital();
    const reserve = Math.max(this.strategy().reserve, risk.minQusdReserve);
    const capacity = offer.type === "sell"
      ? (this.freeFiat(offer.coin) - market.outgoingTransferFee) / quote
      : Math.max(0, balance - reserve - this.uncertainFlexibleCapital("buy"));
    const active = this.store.activeOperations();
    const limit = Math.min(risk.maxQusdPerOperation,
      risk.maxConcurrentQusdExposure - active.reduce((sum, op) => sum + op.amount, 0) - this.store.activeReservedQusd() - pending.amount,
      risk.maxDailyAppliedQusd - this.store.dailyAppliedQusd(dayStart(Date.now())) - pending.amount,
      offer.type === "sell" && market.purchaseMaxQusd ? market.purchaseMaxQusd : Infinity);
    const sized = sizeFlexibleOffer(offer, capacity, limit);
    const desired = sizeFlexibleOffer(offer, Number.MAX_SAFE_INTEGER, limit);
    return { sized: active.length + pending.count >= risk.maxConcurrentOperations ? undefined : sized,
      desired: active.length + pending.count >= risk.maxConcurrentOperations ? undefined : desired, balance };
  }

  private uncertainFlexibleCapital(side: "buy" | "sell", coin?: string, ignoreIntent?: string): number {
    return this.store.unresolvedMutationIntents().reduce((sum, intent) => {
      const request = isRecord(intent.request) ? intent.request : {};
      if (intent.intentId === ignoreIntent || request.capitalReserve || intent.kind !== "apply" || request.offerKind !== "flexible" || request.offerType !== side ||
        (coin && request.coin !== coin) || (intent.operationUuid && this.store.getOperation(intent.operationUuid))) return sum;
      const value = Number(side === "buy" ? request.amount : request.receive);
      return sum + (Number.isFinite(value) && value > 0 ? value : 0) +
        (side === "sell" && coin ? this.market(coin)?.outgoingTransferFee ?? 0 : 0);
    }, 0);
  }

  cooperativeSyncFiat(coin: string): number {
    const personal = this.store.activeOperations().filter(op => op.offerType === "sell" && op.coin === coin &&
      this.store.get(`cooperative_owner_fiat:${op.uuid}`) === undefined && !this.store.hasFiatMovement(op.uuid))
      .reduce((sum, op) => sum + this.operationFiatCost(op), 0);
    return Math.max(0, this.fiatBalance(coin) - personal - this.uncertainFlexibleCapital("sell", coin) - this.store.applicationReservedCapital(coin).fiat);
  }

  cooperativePublishFiat(coin: string): number { return this.freeFiat(coin); }

  private freeFiat(coin: string, ignoreIntent?: string): number {
    const committed = this.store.activeOperations().filter(op => op.offerType === "sell" && op.coin === coin && !this.store.hasFiatMovement(op.uuid))
      .reduce((sum, op) => sum + this.operationFiatCost(op), 0);
    return Math.max(0, this.fiatBalance(coin) - committed - this.store.cooperativeParticipantReserved(coin) - Number(this.store.get(`cooperative_fiat_reserved:${coin}`) ?? 0) - this.uncertainFlexibleCapital("sell", coin, ignoreIntent) - this.store.applicationReservedCapital(coin, ignoreIntent).fiat);
  }

  private async ingestFastFiatFundedOffer(
    offer: P2pOffer,
    receivedAt: number,
    event: "p2p.created" | "p2p.reopened" | "p2p.range_created" | "p2p.range_updated",
    observedAt = receivedAt,
  ): Promise<{ inspected: number; candidates: number; action?: string }> {
    const decisionStartedAt = Date.now();
    if (this.isPaused()) return { inspected: 0, candidates: 0, action: "pausado" };
    if (offer.status !== "open" || !this.isMarket(offer.coin) || !Number.isFinite(offer.amount) || !Number.isFinite(offer.receive) || offer.amount <= 0 || offer.receive <= 0)
      return { inspected: 1, candidates: 0, action: "ignorada" };
    if (this.isExcludedAfterManualCancel(offer.uuid))
      return { inspected: 1, candidates: 0, action: "Excluida por cancelación manual" };
    const coin = this.offerMarket(offer);
    const market = this.market(coin)!;
    const quotedRate = rate(offer);
    const transfer = outgoingFiatCost(offer.amount, quotedRate, market.outgoingTransferFee);
    const suspiciousPriceReason = this.suspiciousBuyPriceReason(offer);
    let decision: MarketItem["decision"] = "auto_buy";
    let reason = "Compra inmediata elegible por precio y capital";
    const vipFlag = explicitFlag(offer.only_vip);
    if (vipFlag === "true" || vipFlag === "unknown") {
      decision = "ignored";
      reason = vipFlag === "true"
        ? "Oferta exclusiva para usuarios VIP"
        : "Restricción VIP no interpretable";
    } else if (!this.huntEnabled(coin, "buy")) {
      decision = "ignored";
      reason = "Cacería de compra detenida";
    } else if (transfer.effectiveRate > market.buyMaxRate) {
      decision = "ignored";
      reason = `La tasa efectiva ${transfer.effectiveRate.toFixed(6)} supera el máximo ${market.buyMaxRate.toFixed(6)}`;
    } else if (!this.canFund(offer)) {
      decision = "ignored";
      reason = "Saldo fiat declarado insuficiente";
    } else if (suspiciousPriceReason) {
      decision = "blocked";
      reason = suspiciousPriceReason;
    } else if (this.store.isSeen(offer.uuid) && event !== "p2p.reopened") {
      decision = "ignored";
      reason = "Oferta ya evaluada";
    }
    this.persistIncrementalMarketOffer(
      { coin, side: offer.type, items: [], total: 1, scannedAt: receivedAt },
      [{ offer, rate: quotedRate, decision, reason }],
    );
    if (decision === "blocked") this.store.recordDecisionEvent({
      uuid: offer.uuid, coin, offerType: offer.type, amount: offer.amount,
      receive: offer.receive, rate: quotedRate, decision, reason,
    });
    if (decision !== "auto_buy")
      return { inspected: 1, candidates: 0, action: reason };
    if (this.mode() !== "real") {
      this.store.markSeen(offer.uuid);
      return { inspected: 1, candidates: 1, action: `simulada ${offer.uuid}` };
    }
    if (this.store.get("emergency_stop") === "true")
      return { inspected: 1, candidates: 1, action: "interruptor de emergencia" };
    if (this.store.hasUnresolvedMutationForOffer(offer.uuid))
      return { inspected: 1, candidates: 0, action: "oferta pendiente de conciliación" };

    const warnings = this.fastLaneWarnings(offer, transfer.total);
    if (warnings.length) this.store.audit(
      "market_fast_lane_warnings",
      warnings.join(" · "),
      offer.uuid,
    );
    if (!this.huntEnabled(coin, "buy") || !this.canFund(offer))
      return { inspected: 1, candidates: 1, action: "capital o cacería cambió antes de aplicar" };
    try {
      this.store.set("market_feed_last_decision_ms", String(Math.max(0, Date.now() - decisionStartedAt)));
      await this.applyBuyQusd(offer, true, undefined, true, observedAt);
    } catch (error) {
      if (!isDefinitiveQvaApplyRejection(error)) throw error;
      const detail = this.offerRejectionDetail("aplicar a la oferta", error, offer.uuid);
      if (error.code !== "LOCAL_APPLY_QUOTA" && error.code !== "LOCAL_CONDITIONS_CHANGED") this.store.markSeen(offer.uuid);
      this.store.audit(error.code?.startsWith("LOCAL_") ? "automatic_apply_not_sent" : "qvapay_apply_rejected", detail, offer.uuid);
      return { inspected: 1, candidates: 1, action: detail };
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
    event: "p2p.created" | "p2p.reopened" | "p2p.range_created" | "p2p.range_updated",
    observedAt = receivedAt,
  ): Promise<{ inspected: number; candidates: number; action?: string }> {
    const decisionStartedAt = Date.now();
    if (this.isPaused()) return { inspected: 0, candidates: 0, action: "pausado" };
    if (offer.status !== "open" || !this.isMarket(offer.coin) || !Number.isFinite(offer.amount) || !Number.isFinite(offer.receive) || offer.amount <= 0 || offer.receive <= 0)
      return { inspected: 1, candidates: 0, action: "ignorada" };
    if (this.isExcludedAfterManualCancel(offer.uuid))
      return { inspected: 1, candidates: 0, action: "Excluida por cancelación manual" };
    const coin = this.offerMarket(offer);
    const market = this.market(coin)!;
    const quotedRate = rate(offer);
    let decision: MarketItem["decision"] = "manual_sell";
    let reason = "Venta inmediata elegible por precio y capital";
    const vipFlag = explicitFlag(offer.only_vip);
    if (vipFlag === "true" || vipFlag === "unknown") {
      decision = "ignored";
      reason = vipFlag === "true"
        ? "Oferta exclusiva para usuarios VIP"
        : "Restricción VIP no interpretable";
    } else if (offer.offer_kind === "flexible") {
      decision = "ignored";
      reason = "La aplicación parcial de ofertas flexibles todavía no está configurada";
    } else if (!this.huntEnabled(coin, "sell")) {
      decision = "ignored";
      reason = "Cacería de venta detenida";
    } else if (quotedRate < market.sellMinRate) {
      decision = "ignored";
      reason = `La tasa ${quotedRate.toFixed(6)} no alcanza el mínimo ${market.sellMinRate.toFixed(6)}`;
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
    if (this.store.hasUnresolvedMutationForOffer(offer.uuid))
      return { inspected: 1, candidates: 0, action: "oferta pendiente de conciliación" };
    const warnings = this.fastLaneWarnings(offer, 0);
    if (warnings.length) this.store.audit(
      "market_fast_lane_warnings",
      warnings.join(" · "),
      offer.uuid,
    );
    const availableQusd = await this.fastLaneQusdBalance();
    if (availableQusd < offer.amount)
      return { inspected: 1, candidates: 0, action: "Saldo QUSD libre insuficiente" };
    if (!this.isAutomaticSellStillEligible(offer))
      return { inspected: 1, candidates: 1, action: "La tasa, el mínimo de venta o las condiciones de seguridad cambiaron antes de aplicar" };
    try {
      this.store.set("market_feed_last_decision_ms", String(Math.max(0, Date.now() - decisionStartedAt)));
      await this.monetaryIntents.execute({
        kind: "apply",
        operationUuid: offer.uuid,
        request: this.applicationRequest(offer, { automatic: true, fastLane: true }),
        action: (intentId) => this.qva.apply(offer.uuid, {
          beforeDispatch: (queuedForMs) => this.automaticDispatchAllowed(offer, intentId, Math.max(queuedForMs, Date.now() - observedAt)),
        }),
      });
    } catch (error) {
      if (!isDefinitiveQvaApplyRejection(error)) throw error;
      const detail = this.offerRejectionDetail("aplicar a la oferta", error, offer.uuid);
      if (error.code !== "LOCAL_APPLY_QUOTA" && error.code !== "LOCAL_CONDITIONS_CHANGED") this.store.markSeen(offer.uuid);
      this.store.audit(error.code?.startsWith("LOCAL_") ? "automatic_apply_not_sent" : "qvapay_apply_rejected", detail, offer.uuid);
      return { inspected: 1, candidates: 1, action: detail };
    }
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
    this.qusdBalanceCache = { epoch: this.store.get("qusd_balance_epoch") ?? "0", value: Math.max(0, availableQusd + this.cooperativeQusdOwed() - offer.amount), updatedAt: Date.now() };
    this.store.audit(
      "market_fast_lane_applied",
      `Venta aplicada en ${Math.max(0, Date.now() - receivedAt)} ms desde la recepción.`,
      offer.uuid,
    );
    queueMicrotask(() => void (async () => {
      try {
        await Promise.all([this.sendChatBestEffort(offer.uuid), this.notify(
          `Aplicaste a vender ${offer.amount} QUSD por ${offer.receive} ${this.marketCurrency(coin)} en ${this.marketLabel(coin)}.`,
          offer.uuid,
          { kind: "operation-applied", uuid: offer.uuid, coin, amount: offer.amount },
        )]);
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

  async prepareHuntingLiquidity(): Promise<void> {
    const idle = () => this.marketConfig.current().hunting.sellRunning && !this.isPaused() && this.mode() === "real" && this.store.get("emergency_stop") !== "true" &&
      !this.ownDecisionBusy() && this.store.applicationReservedCapital().count === 0 && this.store.activeReservedQusd() === 0;
    const config = this.marketConfig.current();
    if (this.readinessInFlight || !idle() || !config.hunting.sellRunning ||
      !config.markets.some(market => market.active && market.huntSellEnabled)) return;
    this.readinessInFlight = true;
    try {
      const epoch = this.store.get("qusd_balance_epoch") ?? "0";
      const balance = await this.qva.qusdBalance();
      if (!idle() || epoch !== (this.store.get("qusd_balance_epoch") ?? "0")) return;
      this.qusdBalanceCache = { epoch: this.store.get("qusd_balance_epoch") ?? "0", value: balance, updatedAt: Date.now() };
      const targetConfig = this.marketConfig.current();
      const target = targetConfig.risk.maxQusdPerOperation + Math.max(targetConfig.qusdReserve, targetConfig.risk.minQusdReserve) + this.cooperativeQusdOwed();
      if (!Number.isFinite(target) || target <= 0 || balance >= target || Date.now() < this.nextLiquidityPreparationAt) return;
      const account = this.store.get("analytics_account_uuid");
      if (!account) return;
      const own = await this.listOwnOffers();
      if (!idle()) return;
      const offer = own.filter(item => item.type === "sell" && item.status === "open" && item.offer_kind !== "flexible" &&
        item.User?.uuid === account && !item.Peer?.uuid && !this.store.hasUnresolvedMutationForOffer(item.uuid) &&
        this.market(item.coin)?.active && this.huntEnabled(item.coin, "sell"))
        .sort((a,b) => a.amount-b.amount)[0];
      if (!offer) return;
      // Release only the shortfall for one operation at the configured limit.
      const release = Math.min(offer.amount, Math.ceil((target-balance)*100)/100);
      const remaining = Math.round((offer.amount-release)*100)/100;
      this.nextLiquidityPreparationAt = Date.now() + 60_000;
      this.liquidityPreparingUuid = offer.uuid;
      const canPrepare = (intentId: string) => idle() && this.huntEnabled(offer.coin, "sell") &&
        epoch === (this.store.get("qusd_balance_epoch") ?? "0") && !this.store.hasUnresolvedMutationForOffer(offer.uuid, intentId);
      if (remaining >= MIN_OFFER_QUSD) {
        const receive = ownOfferFiatTotal(remaining, rate(offer), "sell", this.marketCurrency(offer.coin));
        await this.monetaryIntents.execute({ kind: "edit_offer", operationUuid: offer.uuid,
          request: { uuid: offer.uuid, amount: remaining, receive, liquidityPreparation: true },
          action: intentId => this.qva.editOffer(offer.uuid, { amount: remaining, receive }, { beforeDispatch: () => canPrepare(intentId) }) });
      } else {
        await this.monetaryIntents.execute({ kind: "cancel_offer", operationUuid: offer.uuid,
          request: { uuid: offer.uuid, liquidityPreparation: true }, action: intentId => this.qva.cancel(offer.uuid, undefined, { beforeDispatch: () => canPrepare(intentId) }) });
      }
      const refreshedEpoch = this.store.get("qusd_balance_epoch") ?? "0";
      const fresh = await this.qva.qusdBalance();
      if (idle() && refreshedEpoch === (this.store.get("qusd_balance_epoch") ?? "0")) this.qusdBalanceCache = { epoch: this.store.get("qusd_balance_epoch") ?? "0", value: fresh, updatedAt: Date.now() };
      this.store.audit("hunting_liquidity_prepared", `Liquidez verificada: ${fresh} QUSD libres; objetivo para una operación: ${target}.`, offer.uuid);
    } finally {
      delete this.liquidityPreparingUuid;
      this.readinessInFlight = false;
    }
  }

  private async fastLaneQusdBalance(ignoreIntent?: string): Promise<number> {
    const epoch = this.store.get("qusd_balance_epoch") ?? "0";
    if (this.qusdBalanceCache && this.qusdBalanceCache.epoch === epoch && Date.now() - this.qusdBalanceCache.updatedAt <= 15_000)
      return Math.max(0, this.qusdBalanceCache.value - this.cooperativeQusdOwed() - this.store.applicationReservedCapital(undefined, ignoreIntent).qusd - this.store.activeReservedQusd());
    const value = await this.qva.qusdBalance({ priority: true });
    if (epoch !== (this.store.get("qusd_balance_epoch") ?? "0")) return this.fastLaneQusdBalance(ignoreIntent);
    this.qusdBalanceCache = { epoch: this.store.get("qusd_balance_epoch") ?? "0", value, updatedAt: Date.now() };
    return Math.max(0, value - this.cooperativeQusdOwed() - this.store.applicationReservedCapital(undefined, ignoreIntent).qusd - this.store.activeReservedQusd());
  }

  private cooperativeQusdOwed(): number {
    const value = Number(this.store.get("cooperative_qusd_owed") ?? 0);
    return Number.isFinite(value) && value >= 0 ? value : Infinity;
  }

  async ingestMarketStateEvent(
    event: Exclude<P2pFeedEvent, "p2p.created" | "p2p.reopened" | "p2p.range_created" | "p2p.range_updated">,
    offer: P2pOffer,
    receivedAt = Date.now(),
  ): Promise<void> {
    if (!this.isMarket(offer.coin)) return;
    const cached = this.store.loadRemoteResource<{
      total?: number;
      offers?: Array<P2pOffer & { rate?: number; decision?: string; reason?: string }>;
    }>(`market:${offer.coin}`);
    if (this.store.getOperation(offer.uuid)?.orderUuid) return;
    const ownOffer = event === "p2p.applied" && this.ownsOfferUuid(offer.uuid);
    if (cached) {
      const offers = (cached.data.offers ?? []).filter((candidate) => candidate.uuid !== offer.uuid);
      this.store.saveRemoteResource(
        `market:${offer.coin}`,
        { ...cached.data, total: Math.min(cached.data.total ?? offers.length, offers.length), offers },
        receivedAt,
      );
    }

    const operation = this.store.getOperation(offer.uuid);
    if (event === "p2p.range_closed") return; // Closing a parent does not settle its orders.
    this.store.resolveTradingAlert(
      offer.uuid,
      event === "p2p.applied" && operation ? "applied" : "expired",
    );
    // A fixed offer can reopen and trade with another peer after cancellation.
    // Its public feed UUID is not evidence of another payment by this account.
    const account = operation ? this.store.get("analytics_account_uuid") : undefined;
    const differentPeer = Boolean(account && offer.Peer?.uuid && offer.Peer.uuid !== account &&
      offer.User?.uuid !== account && offer.owner_uuid !== account && !this.ownsOfferUuid(offer.uuid));
    if (operation && operation.state !== "cancelled" && !differentPeer) {
      const next = operationStateFromFeed(operation.state, event);
      if (next !== operation.state) this.store.updateOperation(offer.uuid, next);
      if (
        (event === "p2p.paid" || event === "p2p.completed") &&
        operation.offerType === "sell"
      ) this.recordOutgoingFiat(operation, "Feed QvaPay", offer.updated_at ? Date.parse(offer.updated_at) : undefined);
      if (event === "p2p.completed" && operation.offerType === "buy")
        this.store.recordFiatMovement(
          operation.uuid,
          operation.coin,
          "credit",
          operation.receive,
          "Feed QvaPay",
          offer.updated_at ? Date.parse(offer.updated_at) : undefined,
        );
    }
    this.store.audit(
      "market_feed_state_applied",
      `${event} proyectado en ${Math.max(0, Date.now() - receivedAt)} ms${operation ? operation.state === "cancelled" || differentPeer ? " sin contabilizar: operación cancelada o peer distinto" : " y Operación sincronizada" : ""}.`,
      offer.uuid,
    );
    if (ownOffer) {
      const cycle = this.store.get(`trading:own_offer_cycle:${offer.uuid}`) ?? "0";
      const updatedAt = typeof offer.updated_at === "string" && offer.updated_at
        ? offer.updated_at
        : "unknown";
      queueMicrotask(() => void this.notify(
        `🔔 Tomaron tu oferta ${offer.uuid} en ${this.marketLabel(offer.coin)}: ${offer.amount} QUSD.`,
        offer.uuid,
        { kind: "own-offer-applied", uuid: offer.uuid, coin: offer.coin, amount: offer.amount, eventVersion: `cycle-${cycle}:updated-${updatedAt}` },
      ).catch((error) => this.store.audit(
        "notification_warning",
        error instanceof Error ? error.message : String(error),
        offer.uuid,
      )));
    }
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
      // Each market is independently priced and funded. Waiting for every
      // configured side can age a good quote out before the round finishes.
      if (!snapshots.length)
        return {
          inspected: snapshots.reduce((sum, item) => sum + item.items.length, 0),
          candidates: 0,
          action: "calentando mercado",
        };
      return this.withDecisionTurn(() => this.processSnapshots(
        snapshots,
        snapshots.some((candidate) => candidate.side === "buy"),
        !snapshots.some((candidate) => candidate.side === "buy"),
      ));
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
      return await this.withDecisionTurn(() => this.processSnapshots(
        snapshots,
        includeBuySide,
        sellHuntMarkets.length === 0,
      ));
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
        if (best.offer_kind === "flexible") {
          const result = await this.takeFlexibleOffer(best, true, snapshots.find(item => item.coin === best.coin && item.side === best.type)?.scannedAt);
          if (result.candidates) return result;
          continue;
        }
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
            await this.applyBuyQusd(best, true, reference, true,
              snapshots.find(snapshot => snapshot.coin === best.coin && snapshot.side === best.type)?.scannedAt ?? Date.now());
          } catch (error) {
            if (!isDefinitiveQvaApplyRejection(error)) throw error;
            const reason = this.offerRejectionDetail("aplicar a la oferta", error, best.uuid);
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
        if (bestExternalBuy.offer_kind === "flexible") {
          const result = await this.takeFlexibleOffer(bestExternalBuy, true, snapshots.find(item => item.coin === bestExternalBuy.coin && item.side === bestExternalBuy.type)?.scannedAt);
          if (result.candidates) return result;
          continue;
        }
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
        const observedAt = snapshots.find(snapshot => snapshot.coin === bestExternalBuy.coin && snapshot.side === bestExternalBuy.type)?.scannedAt ?? Date.now();
        const result = await this.opportunityOrchestrator.execute({
          target: bestExternalBuy,
          unavailableQusd: this.store.applicationReservedCapital().qusd + this.uncertainFlexibleCapital("buy"),
          referenceRate: reference ?? rate(bestExternalBuy),
          expectedMarginPercent: expectedMargin,
          priceDecision: reference ? "eligible" : "blocked",
          priceReason: reference
            ? "La tasa supera el mínimo configurado y tiene referencia de mercado."
            : "No existe una referencia de mercado válida.",
          canApply: (intentId, queuedForMs) => this.automaticDispatchAllowed(bestExternalBuy, intentId,
            Math.max(queuedForMs ?? 0, Date.now() - observedAt), false),
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
    this.assertManualApplicationAllowed(uuid);
    const offer = await this.qva.getOffer(uuid);
    if (offer.status !== "open" || !this.isMarket(offer.coin))
      throw new Error(
        "La oferta ya no está abierta o no usa un mercado fiat compatible.",
      );
    if (offer.offer_kind === "flexible") {
      const result = await this.takeFlexibleOffer(offer, false);
      if (!result.candidates) throw new Error(result.action);
      return "✅ Orden flexible aplicada. Abre Operaciones para gestionar el pago.";
    }
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
    const balance = Math.max(0, await this.qva.qusdBalance() - this.cooperativeQusdOwed());
    if (balance - strategy.reserve < offer.amount)
      throw new Error(
        `Saldo QUSD insuficiente. Disponible para operar: ${(balance - strategy.reserve).toFixed(2)} QUSD.`,
      );
    await this.monetaryIntents.execute({
      kind: "apply",
      operationUuid: uuid,
      request: this.applicationRequest(offer, { automatic: false }),
      action: (intentId) => this.qva.apply(uuid, { beforeDispatch: async () =>
        await this.fastLaneQusdBalance(intentId) - strategy.reserve >= offer.amount }),
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
    }, true);
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
    let offer = await this.qva.getOffer(uuid);
    if (offer.status !== "open" || !this.isMarket(offer.coin)) {
      store.resolveTradingAlert(uuid, "expired");
      store.audit("blocked_offer_expired", "La oferta dejó de estar abierta durante la revisión.", uuid);
      throw new Error("La oferta ya no está abierta.");
    }
    if (offer.offer_kind === "flexible") {
      const { sized } = await this.sizeFlexibleTake(offer);
      if (!sized) throw new Error("El saldo libre o los límites no alcanzan el mínimo de la orden.");
      offer = sized;
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
    if (offer.type === "buy" && offer.offer_kind !== "flexible") {
      const [balance, ownOffers] = await Promise.all([
        this.qva.qusdBalance(),
        this.qva.listOffers({ my: true, take: 100, page: 1, status: "open" }),
      ]);
      const liquidity = planLiquidity({
        target: offer,
        availableQusd: Math.max(0, balance - this.cooperativeQusdOwed()),
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
    if (offer.offer_kind === "flexible") {
      const result = await this.takeFlexibleOffer(offer, false);
      if (!result.candidates) throw new Error(result.action);
      store.resolveTradingAlert(uuid, "applied");
      store.resolveDecisionEventsForOffer(uuid, "applied");
      return "Orden flexible aplicada. Verifica los datos de la orden antes de gestionar su pago.";
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
    if (this.store.hasUnresolvedMutationForOffer(uuid))
      throw new Error("Esta operación tiene una mutación pendiente de conciliación; no repitas el pago.");
    if (
      operation.offerType !== "sell" ||
      !["applied", "acknowledged"].includes(operation.state)
    )
      throw new Error(
        "Esta operación no permite marcar pago en su estado actual.",
      );
    if (!reference.trim())
      throw new Error("La referencia de transferencia es obligatoria.");
    const remote = orderForOperation(await this.qva.getOffer(uuid), operation.orderUuid);
    if (remote.status.toLowerCase() !== "processing")
      throw new Error(`QvaPay muestra la oferta en estado ${remote.status}; no se marcó el pago.`);
    await this.monetaryIntents.execute({
      kind: "paid",
      operationUuid: uuid,
      request: { uuid, orderUuid: operation.orderUuid, reference: reference.trim() },
      action: () => this.qva.markPaid(uuid, reference.trim(), operation.orderUuid),
    });
    this.store.updateOperation(uuid, "paid");
    this.store.audit("marked_paid", "Pago fiat marcado por el usuario", uuid);
  }

  async confirmReceived(uuid: string): Promise<void> {
    this.requireRealMode();
    const operation = this.requireOperation(uuid);
    if (this.store.hasUnresolvedMutationForOffer(uuid))
      throw new Error("Esta operación tiene una mutación pendiente de conciliación.");
    if (operation.offerType !== "buy")
      throw new Error(
        "En una compra de QUSD debes marcar pago, no confirmar recepción.",
      );
    orderForOperation(await this.qva.getOffer(uuid), operation.orderUuid);
    await this.monetaryIntents.execute({
      kind: "received",
      operationUuid: uuid,
      request: { uuid, orderUuid: operation.orderUuid },
      action: () => this.qva.confirmReceived(uuid, operation.orderUuid),
    });
    this.store.updateOperation(uuid, "completed");
    this.recordFlexibleFiat(operation, "completed");
    this.store.audit("received", "Usuario confirmó recepción de fiat", uuid);
  }

  async cancel(uuid: string, automatic = false): Promise<void> {
    if (automatic) throw new Error("La cancelación automática por falta de ACK está desactivada.");
    this.requireRealMode();
    const operation = this.requireOperation(uuid);
    if (this.store.hasUnresolvedMutationForOffer(uuid))
      throw new Error("Esta operación tiene una mutación pendiente de conciliación; no se canceló.");
    if (!["applied", "acknowledged"].includes(operation.state))
      throw new Error("Esta operación ya no se puede cancelar en su estado actual.");
    this.store.excludeAutomaticReapplyAfterManualCancel(uuid);
    const remote = orderForOperation(await this.qva.getOffer(uuid), operation.orderUuid);
    if (remote.status.toLowerCase() !== "processing")
      throw new Error(`QvaPay muestra la oferta en estado ${remote.status}; no se canceló.`);
    const cancellation = await this.monetaryIntents.execute({
      kind: "cancel",
      operationUuid: uuid,
      request: { uuid, automatic, orderUuid: operation.orderUuid },
      action: () => this.qva.cancel(uuid, operation.orderUuid),
    });
    this.store.updateOperation(uuid, cancellation?.status === "revision" || (operation.orderUuid && operation.offerType === "buy" && cancellation?.status !== "cancelled") ? "revision" : "cancelled");
    this.store.audit(
      "cancel",
      "Cancelada por el usuario",
      uuid,
    );
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

  private recordFlexibleFiat(operation: import("./store.js").Operation, status: string, occurredAt?: number): void {
    if (!operation.orderUuid) return;
    if (operation.offerType === "sell" && ["paid", "completed"].includes(status))
      this.recordOutgoingFiat(operation, "Orden flexible confirmada por QvaPay", occurredAt);
    if (operation.offerType === "buy" && status === "completed")
      this.store.recordFiatMovement(operation.uuid, operation.coin, "credit", operation.receive, "Orden flexible confirmada por QvaPay", occurredAt);
  }

  async syncRemoteOperations(): Promise<number> {
    let changed = 0;
    for (const operation of this.store.activeOperations()) {
      try {
        const remote = orderForOperation(await this.qva.getOffer(operation.uuid, { analyticsOnly: true }), operation.orderUuid);
        this.recordFlexibleFiat(operation, remote.status, remote.updated_at ? Date.parse(remote.updated_at) : undefined);
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
    const offers = await this.qva.listOffers({ my: true, take: 20, page: 1, status: "open" });
    this.rememberOwnOfferUuids(offers.map((offer) => offer.uuid));
    return offers;
  }

  private rememberOwnOfferUuids(uuids: string[]): void {
    const key = "trading:owned_offer_uuids";
    let previous: string[] = [];
    try {
      const parsed: unknown = JSON.parse(this.store.get(key) ?? "[]");
      if (Array.isArray(parsed)) previous = parsed.filter((value): value is string => typeof value === "string");
    } catch { /* Fresh QvaPay evidence replaces a corrupt local cache. */ }
    const fresh = [...new Set(uuids.filter((uuid) => uuid.length > 0))];
    const combined = [...previous.filter((uuid) => !fresh.includes(uuid)), ...fresh];
    this.store.set(key, JSON.stringify(combined.slice(-5_000)));
  }

  private ownsOfferUuid(uuid: string): boolean {
    let known: string[] = [];
    try {
      const parsed: unknown = JSON.parse(this.store.get("trading:owned_offer_uuids") ?? "[]");
      if (Array.isArray(parsed)) known = parsed.filter((value): value is string => typeof value === "string");
    } catch { /* Ignore corrupt local evidence. */ }
    if (known.includes(uuid)) return true;

    // Migrate an exact UUID from the previous dashboard cache without a remote request.
    const cached = this.store.loadRemoteResource<Array<{ uuid?: string }>>("own-offers")?.data;
    if (!cached?.some((candidate) => candidate.uuid === uuid)) return false;
    this.rememberOwnOfferUuids([uuid]);
    return true;
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
      }, { analyticsOnly: true }),
      this.qva.listOffersPage({
        peer: profile.uuid,
        take: 50,
        page: 1,
        orderBy: "updated_at",
        orderType: "desc",
      }, { analyticsOnly: true }),
    ]);
    const offers = new Map<string, P2pOffer>();
    for (const offer of [...created.offers, ...asPeer.offers])
      offers.set(offer.uuid, offer);
    let movements = 0;
    for (const offer of offers.values()) {
      if (offer.offer_kind === "flexible") continue; // Order accounting uses authenticated order state.
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
        this.recordOutgoingFiat({ uuid: offer.uuid, coin, receive: fiatAmount }, "QvaPay reconciliado", updatedAt)
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
          updatedAt,
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
    if (type === "sell" && this.cooperativeQusdOwed() > 0 && amount > await this.fastLaneQusdBalance())
      throw new Error("QUSD disponibles insuficientes: el saldo pendiente de repartir al grupo está reservado.");
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
    this.rememberOwnOfferUuids([offer.uuid]);
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
    if (offer.type === "sell" && this.cooperativeQusdOwed() > 0 && amount > offer.amount + await this.fastLaneQusdBalance())
      throw new Error("QUSD disponibles insuficientes: el saldo pendiente de repartir al grupo está reservado.");
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
    const epoch = this.store.get("qusd_balance_epoch") ?? "0";
    const value = await this.qva.qusdBalance();
    if (epoch === (this.store.get("qusd_balance_epoch") ?? "0"))
      this.qusdBalanceCache = { epoch, value, updatedAt: Date.now() };
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
        applyReadyAt: applyReadyAt(this.store, Date.now()),
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
    if (this.isExcludedAfterManualCancel(offer.uuid))
      return { offer, rate: value, decision: "ignored", reason: "Excluida por cancelación manual" };
    if (this.store.getOperation(offer.uuid))
      return { offer, rate: value, decision: "ignored", reason: "Oferta con una operación local previa; requiere acción manual" };
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
    if (offer.offer_kind === "flexible") {
      const sized = sizeFlexibleOffer(offer, offer.type === "sell"
        ? (this.freeFiat(coin) - configured.outgoingTransferFee) / value
        : Number(offer.available_amount),
        Math.min(this.marketConfig.current().risk.maxQusdPerOperation, offer.type === "sell" && configured.purchaseMaxQusd ? configured.purchaseMaxQusd : Infinity));
      if (!sized) return { offer, rate: value, decision: "ignored", reason: "Capital o rango insuficiente para una orden flexible" };
      offer = sized;
    }
    const vipFlag = explicitFlag(offer.only_vip);
    if (vipFlag === "true" || vipFlag === "unknown")
      return {
        offer,
        rate: value,
        decision: "ignored",
        reason: vipFlag === "true"
          ? "Oferta exclusiva para usuarios VIP; QvaPay no permite aplicarla con esta cuenta."
          : "Restricción VIP no interpretable; se omite la oferta por seguridad.",
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
      // A full scan already supplies its fresh reference below. Prefer the
      // prior local median when present so one cheap offer cannot replace it.
      const suspiciousPriceReason = this.suspiciousBuyPriceReason(offer, false);
      if (suspiciousPriceReason)
        return { offer, rate: value, decision: "blocked", reason: suspiciousPriceReason };
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

  private canFund(offer: P2pOffer, ignoreIntent?: string): boolean {
    return this.freeFiat(this.offerMarket(offer), ignoreIntent) >= offer.receive + (this.market(this.offerMarket(offer))?.outgoingTransferFee ?? 0);
  }

  private isExcludedAfterManualCancel(uuid: string): boolean {
    return this.store.isExcludedAfterManualCancel(uuid);
  }

  private assertManualApplicationAllowed(uuid: string): void {
    if (this.store.hasUnresolvedMutationForOffer(uuid))
      throw new Error("Esta oferta tiene una aplicación pendiente de conciliación.");
    const previous = this.store.getOperation(uuid);
    if (previous && (previous.state !== "cancelled" || this.store.hasFiatMovement(uuid)))
      throw new Error("La oferta ya tiene una operación local activa, terminal o con movimientos de dinero; no se puede reaplicar.");
  }

  private isAutomaticSellStillEligible(offer: P2pOffer, ownIntentId?: string): boolean {
    if (this.isPaused() || this.store.get("emergency_stop") === "true" || this.isExcludedAfterManualCancel(offer.uuid)) return false;
    if (this.store.hasUnresolvedMutationForOffer(offer.uuid, ownIntentId) || this.offerInvalidatedByFeed(offer)) return false;
    if (this.store.getOperation(offer.uuid)) return false;
    if (offer.status !== "open" || !this.isMarket(offer.coin) || !Number.isFinite(offer.amount) || !Number.isFinite(offer.receive) || offer.amount <= 0 || offer.receive <= 0) return false;
    const coin = this.offerMarket(offer);
    const currentRate = rate(offer);
    return this.huntEnabled(coin, "sell") && Number.isFinite(currentRate) && currentRate > 0 && currentRate >= this.market(coin)!.sellMinRate;
  }

  private isAutomaticBuyStillEligible(offer: P2pOffer, ownIntentId?: string): boolean {
    if (this.isPaused() || this.store.get("emergency_stop") === "true" || this.isExcludedAfterManualCancel(offer.uuid)) return false;
    if (this.store.hasUnresolvedMutationForOffer(offer.uuid, ownIntentId) || this.offerInvalidatedByFeed(offer)) return false;
    if (this.store.getOperation(offer.uuid)) return false;
    if (offer.status !== "open" || !this.isMarket(offer.coin) || !Number.isFinite(offer.amount) || !Number.isFinite(offer.receive) || offer.amount <= 0 || offer.receive <= 0) return false;
    const coin = this.offerMarket(offer);
    const market = this.market(coin)!;
    const quotedRate = rate(offer);
    if (!Number.isFinite(quotedRate) || quotedRate <= 0) return false;
    const transfer = outgoingFiatCost(offer.amount, quotedRate, market.outgoingTransferFee);
    return this.huntEnabled(coin, "buy") && Number.isFinite(transfer.effectiveRate) && transfer.effectiveRate <= market.buyMaxRate &&
      !this.suspiciousBuyPriceReason(offer) && this.canFund(offer, ownIntentId);
  }

  private suspiciousBuyPriceReason(offer: P2pOffer, requireFreshMedian = true): string | undefined {
    const coin = this.offerMarket(offer);
    const reference = this.store.recentSellMedian(coin);
    if (!reference) return requireFreshMedian
      ? "Mediana reciente no disponible (máximo 5 min); compra automática para revisión manual."
      : undefined;
    const guard = this.market(coin)?.priceGuardPercent ?? this.automationConfig().priceGuardPercent;
    const floor = reference * (1 - guard / 100);
    if (rate(offer) < floor)
      return `Precio sospechosamente bajo: ${rate(offer).toFixed(2)}, por debajo de ${floor.toFixed(2)} (${guard}% bajo mediana ${reference.toFixed(2)}).`;
    return undefined;
  }

  private offerInvalidatedByFeed(offer: P2pOffer): boolean {
    const latest = this.store.latestMarketFeedState(offer.uuid);
    const version = offer.updated_at ? Date.parse(offer.updated_at) : NaN;
    if (!latest || Number.isFinite(version) && latest.sentAt < version) return false;
    if (offer.offer_kind === "flexible" && latest.range &&
      (offer.amount > latest.range.available || offer.amount < latest.range.minimum || offer.amount > latest.range.maximum ||
        Math.abs(rate(offer) - latest.range.rate) > 1e-8)) return true;
    return latest.status !== "open";
  }

  private async automaticDispatchAllowed(offer: P2pOffer, ownIntentId?: string, queuedForMs = 0, checkCapital = true): Promise<boolean> {
    const eligible = (candidate: P2pOffer) => !huntingRequirementReason(this.store, candidate) && explicitFlag(candidate.only_vip) === "false" &&
      (candidate.type === "sell" ? this.isAutomaticBuyStillEligible(candidate, ownIntentId) :
        this.isAutomaticSellStillEligible(candidate, ownIntentId));
    if (!eligible(offer)) return false;
    if (checkCapital && offer.type === "buy") {
      const reserve = offer.offer_kind === "flexible" ? Math.max(this.strategy().reserve, this.marketConfig.current().risk.minQusdReserve) : this.strategy().reserve;
      if (await this.fastLaneQusdBalance(ownIntentId) - reserve - this.uncertainFlexibleCapital("buy", undefined, ownIntentId) < offer.amount) return false;
    }
    if (queuedForMs <= 5_000) return true;
    return false;
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
      // Buying QUSD spends fiat: capitalCheck ignores QUSD for this side.
      // A remote balance read only delays dispatch and consumes read quota.
      qusdBalance: 0,
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
      hasUnresolvedMutation: store.hasUnresolvedMutationForOffer(offer.uuid),
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
      snapshots.length ? snapshots.map(({ coin, side }) => ({ coin, side })) : undefined,
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
    const coverage = this.activeMarkets().filter(market => snapshots.some(snapshot => snapshot.coin === market.code)).map((market) => {
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
      const retainedOffers = previousOffers.filter((offer) => !sides.includes(offer.type));
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
    observedAt = Date.now(),
  ): Promise<void> {
    if (automatic && !this.isAutomaticBuyStillEligible(offer))
      throw new Error("La oferta dejó de cumplir las condiciones de compra automática antes de aplicar.");
    if (!automatic) this.assertManualApplicationAllowed(offer.uuid);
    const market = this.market(this.offerMarket(offer))!;
    const transfer = outgoingFiatCost(
      offer.amount,
      rate(offer),
      market.outgoingTransferFee,
    );
    await this.monetaryIntents.execute({
      kind: "apply",
      operationUuid: offer.uuid,
      request: this.applicationRequest(offer, { automatic }),
      action: (intentId) => this.qva.apply(offer.uuid, {
        beforeDispatch: (queuedForMs) => automatic
          ? this.automaticDispatchAllowed(offer, intentId, Math.max(queuedForMs, Date.now() - observedAt))
          : this.canFund(offer, intentId),
      }),
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
      cancelAt: null,
      createdAt: Date.now(),
      ...(offer.User?.uuid ? { counterpartyId: offer.User.uuid } : {}),
      ...(referenceRate === undefined ? {} : { referenceRate }),
    }, !automatic);
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
      await Promise.all([this.sendChatBestEffort(offer.uuid), this.notify(
        `Aplicaste a ${offer.amount} QUSD por ${offer.receive} ${this.marketCurrency(this.offerMarket(offer))} en ${this.marketLabel(this.offerMarket(offer))}.\nTasa nominal ${rate(offer).toFixed(2)} · comisión ${transfer.fee.toFixed(2)} · tasa efectiva ${transfer.effectiveRate.toFixed(2)} ${this.marketCurrency(this.offerMarket(offer))}/QUSD.\nPaga y usa /paid ${offer.uuid} REFERENCIA.`,
        offer.uuid,
        {
          kind: "operation-applied",
          uuid: offer.uuid,
          coin: this.offerMarket(offer),
          amount: offer.amount,
        },
      )]);
    };
    if (automatic || deferPostApply) queueMicrotask(() => void postApply().catch((error) => {
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
      const sent = await this.qva.sendChat(uuid, this.automationConfig().welcomeMessage, this.store.getOperation(uuid)?.orderUuid);
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
    const [profile, messages] = await Promise.all([this.qva.profile(), this.qva.listChat(uuid, this.store.getOperation(uuid)?.orderUuid)]);
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
      await this.notify(
        `${detail}\nEste fallo procede de QvaPay o de la conexión y no se contabiliza como error interno del bot.${error instanceof QvaApiError && error.status === 401 ? "\nLa sesión requiere iniciar sesión de nuevo con pnpm login." : ""}`,
      );
      return;
    }
    const failures = Number(this.store.get("consecutive_errors") ?? 0) + 1;
    this.store.set("consecutive_errors", String(failures));
    this.store.audit(`${action}_error`, message, uuid);
    await this.notify(
      `Error en ${action}${uuid ? ` (${uuid})` : ""}: ${message}`,
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
  if (error instanceof QvaApiError) {
    const category = classifyQvaPayRejection(error);
    const code = error.code ? `, código ${error.code}` : "";
    return `⚠️ QvaPay rechazó ${action} (${category}, HTTP ${error.status}${code}): ${error.message}`;
  }
  if (error instanceof QvaConnectionError)
    return `🌐 No se pudo completar ${action} por la conexión con QvaPay: ${error.message}`;
  if (error instanceof QvaMutationUncertainError)
    return `⚠️ QvaPay no confirmó ${action}: ${error.message}`;
  return `⚠️ QvaPay devolvió un dato no utilizable durante ${action}: ${
    error instanceof Error ? error.message : String(error)
  }`;
}

function safeRecoveryCheckError(value: string): string {
  return value
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/\b\d{6,}\b/g, "[redacted]")
    .slice(0, 400);
}

function classifyQvaPayRejection(error: QvaApiError): string {
  const evidence = `${error.code ?? ""} ${error.message}`;
  if (/\bVIP\b/i.test(evidence)) return "restricción VIP explícita";
  if (/\bKYC\b|verificaci[oó]n de identidad/i.test(evidence))
    return "restricción KYC explícita";
  if (/no puedes aplicar a m[aá]s de \d+ ofertas?\s+P2P|l[ií]mite de ofertas? P2P/i.test(evidence))
    return "límite de operaciones de la cuenta";
  if (/already applied|already taken|ya aplicaste|ya est[aá]s aplicado|ya aplicada/i.test(evidence))
    return "aplicación previa indicada por QvaPay";
  if (/no longer available|not available|expired|no est[aá] disponible|oferta vencida/i.test(evidence))
    return "oferta no disponible indicada por QvaPay";
  if ([403, 404].includes(error.status)) return "permiso o acceso denegado (causa no determinada)";
  return "rechazo no clasificado";
}

function explicitFlag(value: unknown): "true" | "false" | "unknown" {
  if (value === undefined || value === null || value === false || value === 0 || value === "0" || value === "false")
    return "false";
  if (value === true || value === 1 || value === "1" || value === "true")
    return "true";
  return "unknown";
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
  event: Exclude<P2pFeedEvent, "p2p.created" | "p2p.reopened" | "p2p.range_created" | "p2p.range_updated">,
): OperationState {
  if (current === "completed" || current === "cancelled" || event === "p2p.range_closed") return current;
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
