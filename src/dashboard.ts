import { randomUUID } from "node:crypto";
import type { config as Config } from "./config.js";
import { QvaApiError, QvaMutationUncertainError, QvaPayClient } from "./qvapay.js";
import { rate, type TradingService } from "./trading.js";
import { MarketConfigService, type TradingConfig } from "./market-config.js";
import type { FiatMarket, P2pAverage, P2pOffer } from "./types.js";
import type {
  RebalanceJob,
  RebalanceJobAdjustment,
  RebalanceJobState,
  Store,
} from "./store.js";
import { proportionalBudgetPlan, type BudgetPlan } from "./budget.js";
import { median, MIN_OFFER_QUSD, ownOfferFiatTotal } from "./market-math.js";
import type { HuntingSyncCoordinator } from "./hunting-sync.js";
import type { CooperativeHunter } from "./cooperative-hunter.js";
import { PaymentSmsService, type PaymentReceiptInput } from "./payment-sms.js";
import { MobileOperatorService } from "./mobile-operator.js";
import {
  SelfServiceRecovery,
  type ManualRecoveryOutcome,
} from "./self-service-recovery.js";
import { analyticsOffers, analyticsTransaction, buildTradingAnalytics } from "./trading-analytics.js";
import { OperationChatService } from "./operation-chat.js";
import { opportunityDiagnostics, readOperationalHealth } from "./operational-insights.js";

type RuntimeConfig = typeof Config;
type OfferView = ReturnType<typeof offerView>;
type MarketView = {
  offers: (OfferView & { decision: string; reason: string })[];
  total: number;
};
export type MarketSideObservation = {
  offers: (OfferView & { decision: string; reason: string })[];
  total: number;
  median?: number;
  samples: number;
};
type TransactionView = {
  uuid: string;
  amount: number;
  description: string;
  status: string;
  createdAt?: string;
  coin: string;
  p2p?: { amount?: number; receive?: number; status?: string };
};

const REBALANCE_OWN_OFFERS_MAX_AGE_MS = 60_000;

export function compactMarketHistory<T extends { coin: string; createdAt: number }>(
  history: T[],
  maxPerMarket: number,
): T[] {
  if (!Number.isInteger(maxPerMarket) || maxPerMarket < 2)
    throw new RangeError("El histórico compacto requiere al menos dos puntos por mercado.");
  const groups = new Map<string, T[]>();
  for (const point of history) {
    const group = groups.get(point.coin);
    if (group) group.push(point);
    else groups.set(point.coin, [point]);
  }
  const compact: T[] = [];
  for (const group of groups.values()) {
    if (group.length <= maxPerMarket) {
      compact.push(...group);
      continue;
    }
    for (let index = 0; index < maxPerMarket; index += 1)
      compact.push(group[Math.round(index * (group.length - 1) / (maxPerMarket - 1))]!);
  }
  return compact.sort((a, b) => a.createdAt - b.createdAt);
}

export interface BudgetRebalancePreview {
  plans: BudgetPlan[];
  updatedAt: number | null;
}

export function marginCalculation(
  buyRate: number,
  sellRate: number,
  amount: number,
  sellFeePercent: number,
  outgoingTransferFee = 0,
) {
  const cost = buyRate * amount + outgoingTransferFee;
  const grossRevenue = sellRate * amount;
  const netRevenue = grossRevenue * (1 - sellFeePercent / 100);
  return {
    cost,
    grossRevenue,
    netRevenue,
    netProfit: netRevenue - cost,
    marginPercent: cost ? ((netRevenue - cost) / cost) * 100 : 0,
    breakEvenRate:
      amount > 0 && 1 - sellFeePercent / 100 > 0
        ? cost / amount / (1 - sellFeePercent / 100)
        : 0,
  };
}

export function allocateBudget(
  budget: number,
  reserve: number,
  maximumPerOffer: number,
  opportunities: { rate: number; amount: number }[],
) {
  let remaining = Math.max(0, budget - reserve);
  return opportunities
    .slice()
    .sort((a, b) => a.rate - b.rate)
    .flatMap((opportunity) => {
      const fiat = Math.min(
        remaining,
        opportunity.rate * Math.min(opportunity.amount, maximumPerOffer),
      );
      if (fiat <= 0) return [];
      remaining -= fiat;
      return [{ rate: opportunity.rate, fiat, qusd: fiat / opportunity.rate }];
    });
}

function rebalanceIntentMatches(
  request: unknown,
  adjustment: RebalanceJobAdjustment,
): boolean {
  if (!request || typeof request !== "object" || Array.isArray(request))
    return false;
  const record = request as Record<string, unknown>;
  if (adjustment.action === "cancel") return record.uuid === adjustment.uuid;
  return Number(record.amount).toFixed(2) === adjustment.targetAmount.toFixed(2) &&
    Number(record.receive).toFixed(2) === adjustment.receive.toFixed(2);
}

export class DashboardReadModel {
  private rebalanceExecution: Promise<void> | undefined;
  private readonly pendingReads = new Map<string, Promise<unknown>>();
  private marketObservationCursor = 0;
  private readonly paymentSms: PaymentSmsService;
  private readonly mobileOperator: MobileOperatorService;
  private readonly recovery: SelfServiceRecovery;
  private readonly operationChat: OperationChatService;

  constructor(
    private readonly trading: TradingService,
    private readonly qva: QvaPayClient,
    _cfg: RuntimeConfig,
    private readonly store: Store,
    private readonly marketConfig: MarketConfigService,
    private readonly onRebalanceEvent?: (
      job: RebalanceJob,
      event: "completed" | "attention",
    ) => void | Promise<void>,
    private readonly huntingSync?: HuntingSyncCoordinator,
    private readonly cooperativeHunter?: CooperativeHunter,
  ) {
    this.operationChat = new OperationChatService(store, qva);
    this.paymentSms = new PaymentSmsService(
      store,
      qva,
      { markPaid: (uuid, reference) => trading.markPaid(uuid, reference) },
      (market) => marketConfig.current().markets.find((item) => item.code === market)?.currency,
    );
    this.mobileOperator = new MobileOperatorService(store, {
      operations: () => store.visibleOperations(),
      alerts: () => this.notifications(),
      markets: () => this.marketConfig.publicMarkets(),
      markPaid: (uuid, reference) => trading.markPaid(uuid, reference),
      confirmReceived: (uuid) => trading.confirmReceived(uuid),
      cancel: (uuid) => trading.cancel(uuid),
    });
    this.recovery = new SelfServiceRecovery(store, trading);
  }

  recoveryItems() {
    return this.recovery.list();
  }
  opportunityDiagnostics(hours: number, coin?: string) {
    return this.coalesceRead(`diagnostics:${hours}:${coin??'all'}`,()=>opportunityDiagnostics(this.store,hours,coin));
  }
  operationalHealth() { return readOperationalHealth(this.store); }
  fiatHistory(coin: string, page: number) { return this.store.fiatBalanceHistory(coin,page); }
  recordRecoveryEvidence(intentId: string, evidence: string) { return this.recovery.recordEvidence(intentId, evidence); }
  acknowledgeRecoveryIntent(intentId: string) { return this.recovery.acknowledge(intentId); }

  setCooperativeHunting(enabled: boolean): void {
    if (!this.cooperativeHunter) throw new Error("Cacería cooperativa no disponible.");
    this.cooperativeHunter.setEnabled(enabled);
  }
  async checkCooperativeHunting(): Promise<void> { await this.cooperativeHunter?.reconcile(); }
  markCooperativeDistributed(uuid: string): void {
    if (!this.cooperativeHunter) throw new Error("Cacería cooperativa no disponible.");
    this.cooperativeHunter.markDistributed(uuid);
  }

  checkRecoveryIntent(intentId: string) {
    return this.recovery.check(intentId);
  }

  resolveRecoveryIntent(input: {
    intentId: string;
    expectedUpdatedAt: number;
    outcome: ManualRecoveryOutcome;
    reason: string;
    evidence: string;
    confirmed: true;
  }) {
    return this.recovery.resolveManual(input);
  }

  pairMobileOperator(label: string) { return this.mobileOperator.pair(label); }
  checkMobileOperator(token: string, write = false) { return this.mobileOperator.check(token, write); }
  mobileOperators() { return this.mobileOperator.list(); }
  revokeMobileOperator(id: string) { return this.mobileOperator.revoke(id); }
  mobileOperations(limit: number) { return this.mobileOperator.operations(limit); }
  mobileAlerts() { return this.mobileOperator.alerts(); }
  mobileMarkets() { return this.mobileOperator.markets(); }
  mobileReceiptOutcomes() {
    return this.paymentSms.receipts().slice(0, 100).map((receipt) => ({
      id: receipt.id, status: receipt.state, receivedAt: receipt.receivedAt,
      operationUuid: receipt.operationUuid, reason: receipt.reason,
    }));
  }
  mobileOperationAction(operatorId: string, uuid: string, action: "paid" | "received" | "cancel", reference?: string) {
    return this.mobileOperator.act(operatorId, uuid, action, reference);
  }
  readOperationChat(uuid: string) { return this.operationChat.read(uuid); }
  refreshOperationChat(uuid: string) { return this.operationChat.refresh(uuid); }
  sendOperationChat(uuid: string, message: string) { return this.operationChat.send(uuid, message); }
  markOperationChatRead(uuid: string) { return this.operationChat.markRead(uuid); }
  operationChatUnread() { return this.operationChat.unreadCounts(); }
  syncOperationChats() { return this.operationChat.syncActive(); }

  pairSmsDevice(label: string) { return this.paymentSms.pairDevice(label); }
  revokeSmsDevice(id: string) { return this.paymentSms.revokeDevice(id); }
  smsDevices() { return this.paymentSms.devices(); }
  paymentReceipts() { return this.paymentSms.receipts(); }
  processPendingPaymentReceipts() { return this.paymentSms.processPending(); }
  checkSmsDevice(token: string) { return this.paymentSms.checkDevice(token); }
  receivePaymentReceipt(token: string, input: PaymentReceiptInput) {
    return this.paymentSms.receive(token, input);
  }

  updateStrategy(
    values: Parameters<TradingService["updateStrategy"]>[0],
  ): void {
    this.trading.updateStrategy(values);
  }
  config(): TradingConfig {
    return this.marketConfig.current();
  }
  configRevisions() {
    return this.store.configRevisionHistory();
  }
  auditLog() {
    return this.store.recentAudit(1_000);
  }
  operationalLogs(options: Parameters<Store["operationalLogs"]>[0]) {
    return this.store.operationalLogs(options);
  }
  saveConfig(next: TradingConfig, reason?: string): void {
    this.trading.saveConfig(
      next,
      "panel",
      reason?.trim() || "Configuración actualizada desde el panel local",
    );
  }
  saveMarketIcon(input: {
    name: string;
    mimeType: string;
    base64: string;
  }): { url: string } {
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(input.base64))
      throw new Error("El contenido del icono no usa Base64 válido.");
    const content = Buffer.from(input.base64, "base64");
    const saved = this.marketConfig.saveMarketIcon(
      input.name,
      input.mimeType,
      content,
    );
    return { url: saved.url };
  }
  marketIcon(name: string) {
    return this.marketConfig.marketIcon(name);
  }
  cooperativeNetwork() {
    return this.huntingSync?.state() ?? {
      enabled: false,
      httpConnected: false,
      natsConnected: false,
      snapshot: {},
      contributions: {},
      lastHttpAt: null,
      lastNatsAt: null,
      lastError: null,
    };
  }
  async publishCooperativeContribution(input: {
    coin: string;
    minimal: number;
    price: number;
  }): Promise<void> {
    if (!this.huntingSync) throw new Error("La red cooperativa no está configurada.");
    await this.huntingSync.publish(input);
  }
  async withdrawCooperativeContribution(coin: string): Promise<void> {
    if (!this.huntingSync) throw new Error("La red cooperativa no está configurada.");
    await this.huntingSync.withdraw(coin);
  }
  async reconcileCooperativeNetwork(): Promise<void> {
    if (!this.huntingSync) throw new Error("La red cooperativa no está configurada.");
    await this.huntingSync.reconcile();
    await this.huntingSync.syncCapacity();
  }
  async createOwnOffer(
    coin: FiatMarket,
    type: "buy" | "sell",
    amount: number,
    rate: number,
  ) {
    return this.trading.createOwnOffer(coin, type, amount, rate);
  }
  async editOwnOffer(
    uuid: string,
    amount: number,
    rate: number,
  ): Promise<void> {
    await this.trading.editOwnOffer(uuid, amount, rate);
  }
  async cancelOwnOffer(uuid: string): Promise<void> {
    await this.trading.cancelOwnOffer(uuid);
  }
  budgetRebalancePreview(): BudgetRebalancePreview {
    const resource = this.store.loadRemoteResource<OfferView[]>("own-offers");
    return {
      plans: this.currentBudgetDeficits(),
      updatedAt: resource?.updatedAt ?? null,
    };
  }
  async refreshBudgetRebalancePreview(): Promise<BudgetRebalancePreview> {
    await this.refreshOwnOffers();
    return this.budgetRebalancePreview();
  }
  startBudgetRebalance(
    requested: { uuid: string; amount: number }[],
  ): RebalanceJob {
    if (!requested.length) throw new Error("No hay ajustes para aplicar.");
    const ownOffers = this.store.loadRemoteResource<OfferView[]>("own-offers");
    if (
      !ownOffers ||
      Date.now() - ownOffers.updatedAt > REBALANCE_OWN_OFFERS_MAX_AGE_MS
    )
      throw new Error(
        "Es necesario actualizar las ofertas antes de aplicar el reajuste.",
      );
    const current = this.store.pendingRebalanceJobs(1)[0];
    if (current)
      throw new Error(`Ya existe un reajuste en curso (${current.id}). Espera a que termine o requiera atención.`);
    const snapshot = this.localSnapshot();
    const deficits = Object.values(snapshot.budget)
      .filter((plan): plan is BudgetPlan => (plan as BudgetPlan).deficit > 0);
    if (!deficits.length)
      throw new Error("El capital declarado ya cubre todas las ofertas abiertas.");

    const eligible = new Set(
      deficits.flatMap((plan) => plan.adjustments.map((item) => item.uuid)),
    );
    const changes = new Map<string, number>();
    for (const adjustment of requested) {
      if (changes.has(adjustment.uuid))
        throw new Error(`La oferta ${adjustment.uuid} está repetida.`);
      if (!eligible.has(adjustment.uuid))
        throw new Error(`La oferta ${adjustment.uuid} no forma parte del reajuste vigente.`);
      if (!Number.isFinite(adjustment.amount) || adjustment.amount < 0)
        throw new Error("Los importes propuestos no son válidos.");
      changes.set(adjustment.uuid, precisionQusd(adjustment.amount));
    }

    const offers = snapshot.ownOffers.filter(
      (offer) => offer.type === "buy" && offer.status === "open",
    );
    for (const [uuid, amount] of changes) {
      const offer = offers.find((item) => item.uuid === uuid);
      if (!offer) throw new Error(`La oferta ${uuid} ya no está abierta.`);
      if (amount > offer.amount + 0.000001)
        throw new Error("El reajuste solo puede reducir el importe de una oferta.");
    }

    for (const plan of deficits) {
      const market = snapshot.markets.find((item) => item.code === plan.coin);
      if (!market) throw new Error(`No existe la configuración de ${plan.coin}.`);
      const projected = offers
        .filter((offer) => offer.coin === plan.coin)
        .reduce((sum, offer) => {
          const amount = changes.get(offer.uuid);
          if (amount === 0) return sum;
          if (amount === undefined)
            return sum + Number(offer.receive) + market.outgoingTransferFee;
          return sum + ownOfferFiatTotal(amount, offer.rate, "buy", market.currency)
            + market.outgoingTransferFee;
        }, 0);
      if (projected > plan.available + 0.000001)
        throw new Error(
          `El ajuste de ${market.label} todavía compromete ${projected.toFixed(2)} ${market.currency}; el límite declarado es ${plan.available.toFixed(2)}.`,
        );
    }

    const adjustments: RebalanceJobAdjustment[] = [...changes].map(
      ([uuid, targetAmount]) => {
        const offer = offers.find((item) => item.uuid === uuid)!;
        return {
          uuid,
          coin: offer.coin,
          currentAmount: offer.amount,
          targetAmount,
          rate: offer.rate,
          receive: targetAmount > 0
            ? ownOfferFiatTotal(targetAmount, offer.rate, "buy", this.marketConfig.find(offer.coin)?.currency ?? "")
            : 0,
          action: targetAmount === 0 ? "cancel" : "edit",
          state: "pending",
        };
      },
    );
    const job = this.store.createRebalanceJob(randomUUID(), adjustments);
    void this.runBudgetRebalances();
    return job;
  }

  rebalanceJob(id: string): RebalanceJob | undefined {
    return this.store.rebalanceJob(id);
  }

  async runBudgetRebalances(): Promise<void> {
    if (this.rebalanceExecution) return this.rebalanceExecution;
    this.rebalanceExecution = this.processBudgetRebalances();
    try {
      await this.rebalanceExecution;
    } finally {
      this.rebalanceExecution = undefined;
    }
  }

  private async processBudgetRebalances(): Promise<void> {
    for (const stored of this.store.pendingRebalanceJobs()) {
      let job = stored;
      let adjustments = job.adjustments.map((item) =>
        item.state === "applying"
          ? { ...item, state: "reconciliation_required" as const }
          : item,
      );
      if (adjustments.some((item) => item.state === "reconciliation_required")) {
        await this.trading.reconcilePendingStandaloneMutations();
        const intents = this.store.recentMutationIntents(500);
        adjustments = adjustments.map((item) => {
          if (item.state !== "reconciliation_required") return item;
          const intent = intents.find((candidate) =>
            candidate.operationUuid === item.uuid &&
            candidate.kind === (item.action === "edit" ? "edit_offer" : "cancel_offer") &&
            rebalanceIntentMatches(candidate.request, item)
          );
          if (intent?.state === "confirmed" || intent?.state === "reconciled") {
            const { error: _error, ...confirmed } = item;
            return { ...confirmed, state: "completed" as const };
          }
          if (intent?.state === "rejected")
            return { ...item, state: "failed" as const, error: intent.error ?? "QvaPay rechazó el cambio." };
          return item;
        });
        if (adjustments.some((item) => item.state === "reconciliation_required")) {
          this.store.updateRebalanceJob(job.id, "reconciliation_required", adjustments, "Esperando confirmación remota.");
          continue;
        }
      }

      for (let index = 0; index < adjustments.length; index += 1) {
        const adjustment = adjustments[index]!;
        if (adjustment.state !== "pending") continue;
        adjustments[index] = { ...adjustment, state: "applying" };
        this.store.updateRebalanceJob(job.id, "applying", adjustments);
        try {
          if (adjustment.action === "cancel")
            await this.trading.cancelOwnOfferFromSnapshot(adjustment.uuid);
          else
            await this.trading.editOwnOfferFromSnapshot(
              {
                uuid: adjustment.uuid,
                coin: adjustment.coin,
                type: "buy",
                rate: adjustment.rate,
                currentAmount: adjustment.currentAmount,
              },
              adjustment.targetAmount,
            );
          adjustments[index] = { ...adjustment, state: "completed" };
          this.store.updateRebalanceJob(job.id, "applying", adjustments);
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          if (
            error instanceof QvaMutationUncertainError ||
            (error instanceof QvaApiError && error.status >= 500)
          ) {
            adjustments[index] = {
              ...adjustment,
              state: "reconciliation_required",
              error: detail,
            };
            this.store.updateRebalanceJob(job.id, "reconciliation_required", adjustments, detail);
            job = this.store.rebalanceJob(job.id)!;
            await this.onRebalanceEvent?.(job, "attention");
          } else {
            adjustments[index] = { ...adjustment, state: "failed", error: detail };
            const state: RebalanceJobState = adjustments.some((item) => item.state === "completed")
              ? "partial"
              : "failed";
            this.store.updateRebalanceJob(job.id, state, adjustments, detail);
            job = this.store.rebalanceJob(job.id)!;
            await this.onRebalanceEvent?.(job, "attention");
          }
          break;
        }
      }

      if (adjustments.every((item) => item.state === "completed")) {
        this.store.updateRebalanceJob(job.id, "completed", adjustments);
        job = this.store.rebalanceJob(job.id)!;
        await this.refreshOwnOffers().catch(() => undefined);
        await this.onRebalanceEvent?.(job, "completed");
      } else if (adjustments.some((item) => item.state === "failed")) {
        const currentState = this.store.rebalanceJob(job.id)?.state;
        if (currentState !== "partial" && currentState !== "failed") {
          const state: RebalanceJobState = adjustments.some(
            (item) => item.state === "completed",
          )
            ? "partial"
            : "failed";
          const detail = adjustments.find((item) => item.state === "failed")
            ?.error ?? "Uno de los cambios fue rechazado.";
          this.store.updateRebalanceJob(job.id, state, adjustments, detail);
          job = this.store.rebalanceJob(job.id)!;
          await this.onRebalanceEvent?.(job, "attention");
        }
      }
    }
  }
  async setPaused(paused: boolean): Promise<void> {
    if (paused) {
      this.trading.setPaused(true, "panel web");
      return;
    }
    await this.trading.activate();
  }
  setRefresh(enabled: boolean): void {
    this.trading.setRefresh(enabled);
  }
  setEmergencyStop(enabled: boolean): void {
    this.trading.setEmergencyStop(enabled, "panel web");
  }
  reconcileWorkflow(workflowId: string) {
    return this.trading.reconcileWorkflow(workflowId);
  }
  acknowledge(uuid: string): Promise<void> {
    return this.trading.acknowledge(uuid);
  }
  markPaid(uuid: string, reference: string): Promise<void> {
    return this.trading.markPaid(uuid, reference);
  }
  confirmReceived(uuid: string): Promise<void> {
    return this.trading.confirmReceived(uuid);
  }
  cancelOperation(uuid: string): Promise<void> {
    return this.trading.cancel(uuid);
  }
  updateHunting(values: Parameters<TradingService["updateHunting"]>[0]): void {
    this.trading.updateHunting(values);
  }
  previewBlockedOffer(uuid: string) {
    return this.trading.previewBlockedOffer(uuid);
  }
  applyBlockedOffer(uuid: string) {
    return this.trading.applyBlockedOffer(uuid);
  }
  dismissBlockedOffer(uuid: string): void {
    this.trading.dismissBlockedOffer(uuid);
  }
  decisionEvents(options: Parameters<Store["decisionEvents"]>[0]) {
    return this.store.decisionEvents(options);
  }
  dismissAllDecisionEvents(throughId: number) {
    return { dismissed: this.store.dismissAllBlockedDecisions(throughId) };
  }
  dismissDecisionEvent(id: number): void {
    const event = this.store.decisionEvent(id);
    if (!this.store.resolveDecisionEvent(id, "dismissed"))
      throw new Error("El evento ya fue resuelto o no existe.");
    if (event) this.store.resolveTradingAlert(event.uuid, "dismissed");
    if (event) this.store.audit("blocked_offer_dismissed", "Versión de decisión descartada por el usuario.", event.uuid);
  }

  notifications() {
    return this.store.pendingUserNotifications().map((item) => {
      const event = item.payload;
      const alert = event.alert ?? {
            uuid: event.uuid,
            coin: event.coin,
            amount: event.amount,
          };
      const view = item.kind === "system-health" ? "caceria" : item.kind.startsWith("rebalance-")
        ? "ofertas"
        : item.kind === "operation-applied" || item.kind === "own-offer-applied"
          ? "operaciones"
          : "auditoria";
      return {
        id: item.id,
        type: item.kind,
        message: item.message,
        alert,
        url: item.kind === "system-health" ? "/?view=caceria" : item.kind === "recovery-blocked"
          ? `/?view=auditoria&intent=${encodeURIComponent(String(event.intentId ?? ""))}`
          : `/?view=${view}&operation=${encodeURIComponent(item.operationUuid ?? "")}`,
        createdAt: item.createdAt,
      };
    });
  }

  acknowledgeNotification(id: string): void {
    this.store.acknowledgeNotification(id);
  }

  localSnapshot() {
    const generatedAt = Date.now();
    const state = this.trading.operationalState();
    const configuredMarkets = this.trading.markets();
    const currentConfig = this.marketConfig.current();
    const balanceResource = this.store.loadRemoteResource<number>("balance");
    const ownOffersResource =
      this.store.loadRemoteResource<OfferView[]>("own-offers");
    const transactionResource =
      this.store.loadRemoteResource<TransactionView[]>("transactions");
    const averagesResource = this.store.loadRemoteResource<
      Record<string, unknown>
    >("averages");
    const balance = balanceResource?.data ?? 0;
    const ownOfferViews = ownOffersResource?.data ?? [];
    const averages = averagesResource?.data ?? {};
    const marketResources = new Map(
      configuredMarkets.map((configured) => [
        configured.code,
        this.store.loadRemoteResource<MarketView>(`market:${configured.code}`),
      ]),
    );
    const market = Object.fromEntries(
      configuredMarkets.map((configured) => [
        configured.code,
        marketResources.get(configured.code)?.data ?? { offers: [], total: 0 },
      ]),
    ) as Record<FiatMarket, MarketView>;
    const strategy = this.trading.strategy();
    const budget = Object.fromEntries(
      configuredMarkets.map((configured) => [
          configured.code,
          proportionalBudgetPlan(
            ownOfferViews,
            configured.code,
            state.fiat[configured.code] ?? 0,
            strategy.buyMax[configured.code] ?? configured.buyMaxRate,
            configured.outgoingTransferFee,
            configured.currency,
          ),
        ]),
    );
    const marketHistory = this.store.marketHistory(
      generatedAt - 24 * 3_600_000,
    );
    const activeOperations = this.store.activeOperations();
    const workflows = this.store.tradeWorkflows();
    const integrity = this.store.configRevisionIntegrity();
    const unresolvedMutations = this.store.unresolvedMutationIntents();
    return {
      generatedAt,
      freshness: {
        balance: balanceResource?.updatedAt ?? null,
        ownOffers: ownOffersResource?.updatedAt ?? null,
        transactions: transactionResource?.updatedAt ?? null,
        markets: Object.fromEntries(
          configuredMarkets.map((configured) => [
            configured.code,
            marketResources.get(configured.code)?.updatedAt ?? null,
          ]),
        ),
      },
      balance,
      state,
      ownOffers: ownOfferViews,
      market,
      averages,
      hunting: currentConfig.hunting,
      automation: currentConfig.automation,
      transactions: transactionResource?.data ?? [],
      strategy,
      markets: this.marketConfig.publicMarkets(),
      availability: {
        qusd: {
          reported: balance,
          reserve: strategy.reserve,
          available: Math.max(0, balance - strategy.reserve - Number(this.store.get("cooperative_qusd_owed") ?? 0)),
          committedSell: ownOfferViews
            .filter((offer) => offer.type === "sell" && offer.status === "open")
            .reduce((sum, offer) => sum + offer.amount, 0),
        },
        fiat: Object.fromEntries(
          configuredMarkets.map((configured) => {
            const plan = budget[configured.code] as {
              available: number;
              committed: number;
            };
            return [
              configured.code,
              {
                declared: plan.available,
                committed: plan.committed,
                available: Math.max(0, plan.available - plan.committed),
              },
            ];
          }),
        ),
      },
      discoveredMarkets: Object.keys(averages)
        .filter((coin) => !this.marketConfig.find(coin))
        .map((code) => ({ code, label: code, currency: "" })),
      budget,
      history: sampleHistory(this.store.dashboardHistory(generatedAt - 90 * 86_400_000), 180),
      marketHistory: compactMarketHistory(marketHistory, 96),
      rankings: rankings(configuredMarkets, market, marketHistory),
      activity: this.store.recentAudit(50),
      alerts: this.store.recentTradingAlerts(),
      risk: {
        limits: currentConfig.risk,
        usage: {
          exposureQusd:
            activeOperations.reduce(
              (sum, operation) => sum + operation.amount,
              0,
            ) + this.store.activeReservedQusd(),
          dailyAppliedQusd: this.store.dailyAppliedQusd(startOfDay()),
          activeOperations: activeOperations.length,
          unresolvedMutation: this.store.hasUnresolvedMutation(),
          emergencyStop: this.store.get("emergency_stop") === "true",
        },
      },
      recoverableWorkflows: this.store.recoverableWorkflows(),
      workflows,
      workflowOffers: Object.fromEntries(
        workflows.map((workflow) => [
          workflow.id,
          this.store.workflowOwnOffers(workflow.id),
        ]),
      ),
      capitalReservations: this.store.capitalReservations(),
      cooperativeNetwork: this.cooperativeNetwork(),
      cooperativeHunting: { enabled: this.cooperativeHunter?.enabled() ?? false,
        executions: this.cooperativeHunter?.executions() ?? [], qusdOwed: Number(this.store.get("cooperative_qusd_owed") ?? 0) },
      mutationIntents: this.store.recentMutationIntents(100),
      unresolvedMutations,
      recoveryNoticeCount: unresolvedMutations.filter(intent => !this.store.get(`recovery_ack:${intent.intentId}`)).length,
      operations: this.store.visibleOperations().map(operation => {
        const raw = this.store.get(`cooperative_owner_fiat:${operation.uuid}`);
        return { ...operation, ...(raw === undefined || raw === "" ? {} : { cooperativeOwnerFiat: Number(raw) }) };
      }),
      integrity: {
        schemaVersion: this.store.schemaVersion(),
        configRevisionChainValid: integrity.valid,
        configRevisionChainChecking: integrity.checking,
        configRevisionChainCheckedAt: integrity.checkedAt,
        ...(integrity.error ? { configRevisionChainError: integrity.error } : {}),
      },
    };
  }

  async refreshBalance() {
    return this.coalesceRead("balance", async () => {
      const data = await this.trading.qusdBalance();
      const updatedAt = Date.now();
      this.store.saveRemoteResource("balance", data, updatedAt);
      this.recordDashboardPoint();
      return { data, updatedAt };
    });
  }

  async refreshOwnOffers() {
    const data = (await this.trading.listOwnOffers()).map(offerView);
    const updatedAt = Date.now();
    this.store.saveRemoteResource("own-offers", data, updatedAt);
    this.recordDashboardPoint();
    return { data, updatedAt };
  }

  async refreshPortfolioCommitments() {
    return this.coalesceRead("portfolio-commitments", async () => {
      const processing = await this.qva.listOffersPage({ my: true, take: 100, page: 1, status: "processing", sortByStatus: false }, { analyticsOnly: true });
      const paid = await this.qva.listOffersPage({ my: true, take: 100, page: 1, status: "paid", sortByStatus: false }, { analyticsOnly: true });
      if (processing.total > processing.offers.length || paid.total > paid.offers.length)
        throw new Error("Demasiadas operaciones pendientes para valorar el capital con una sola página.");
      const offers = [...processing.offers, ...paid.offers].map(offerView);
      const updatedAt = Date.now();
      this.store.saveRemoteResource("portfolio-commitments", offers, updatedAt);
      this.recordDashboardPoint();
      return { data: offers, updatedAt };
    });
  }

  async refreshCompletedOfferHistory() {
    return this.coalesceRead("completed-offer-history", async () => {
      const account = this.store.get("analytics_account_uuid");
      if (!account) return;
      const key = `analytics_offers_history:v2:${account}`;
      const previous = this.store.loadRemoteResource<{ page: number; complete: boolean; limited?: boolean }>(key)?.data
        ?? { page: 1, complete: false };
      const pageNumber = previous.complete ? 1 : previous.page;
      const page = await this.qva.listOffersPage({ my: true, take: 100, page: pageNumber,
        sortByStatus: false, orderBy: "updated_at", orderType: "desc" }, { analyticsOnly: true });
      // Reuse the bounded accounting poll: the market listing omits child orders.
      const offers = page.offers.map(offer => offer.offer_kind === "flexible"
        ? this.store.loadRemoteResource<P2pOffer>(`fiat-flexible:${offer.uuid}`)?.data ?? offer : offer);
      this.store.removeAnalyticsOffers(account, offers.filter(offer => offer.offer_kind === "flexible").map(offer => offer.uuid));
      this.store.saveAnalyticsOffers(account, offers.flatMap(offer => analyticsOffers(offer, account)));
      const complete = page.offers.length < 100 || pageNumber * 100 >= page.total;
      this.store.saveRemoteResource(key, { page: complete ? pageNumber : pageNumber + 1, complete }, Date.now());
    });
  }

  async refreshTransactions() {
    return this.coalesceRead("transactions", async () => {
    const account = this.store.get("analytics_account_uuid");
    const key = `analytics_history:${account ?? "pending"}`;
    const saved = this.store.loadRemoteResource<{ page: number; anchor: number; complete: boolean; limited?: boolean }>(key);
    const now = Date.now();
    const cached = this.store.loadRemoteResource<TransactionView[]>("transactions");
    const history = saved && (now - saved.updatedAt < 6 * 3_600_000 || !saved.data.complete)
      ? saved.data : { page: 1, anchor: now, complete: false };
    const backfill = Boolean(account && !history.complete && cached && now - cached.updatedAt < 60_000);
    const page = await this.qva.listTransactionsPage(backfill ? {
      page: history.page, take: 30,
      dateFrom: new Date(history.anchor - 365 * 86_400_000).toISOString(), dateTo: new Date(history.anchor).toISOString(),
    } : { take: 30 });
    if (account) {
      this.store.saveAnalyticsTransactions(account, page.transactions.flatMap((tx) => {
        const normalized = analyticsTransaction(tx); return normalized ? [normalized] : [];
      }));
      if (backfill) this.store.saveRemoteResource(key, { ...history, page: history.page + 1,
        complete: page.transactions.length < 30 || (page.total !== undefined && history.page * 30 >= page.total) || history.page >= 400,
        limited: history.page >= 400 && page.transactions.length === 30 && (page.total === undefined || history.page * 30 < page.total) }, now);
    }
    if (backfill && cached) return { data: cached.data, updatedAt: cached.updatedAt };
    const data: TransactionView[] = page.transactions
      .slice(0, 12)
      .map((tx) => ({
        uuid: tx.uuid,
        amount: tx.amount,
        description: tx.description ?? "Transacción",
        status: tx.status,
        ...(tx.created_at ? { createdAt: tx.created_at } : {}),
        coin: tx.Wallet?.Coin?.tick ?? tx.P2P?.coin ?? "QUSD",
        ...(tx.P2P
          ? {
              p2p: {
                ...(tx.P2P.amount === undefined
                  ? {}
                  : { amount: tx.P2P.amount }),
                ...(tx.P2P.receive === undefined
                  ? {}
                  : { receive: tx.P2P.receive }),
                ...(tx.P2P.status === undefined
                  ? {}
                  : { status: tx.P2P.status }),
              },
            }
          : {}),
      }));
    const updatedAt = Date.now();
    this.store.saveRemoteResource("transactions", data, updatedAt);
    return { data, updatedAt };
    });
  }

  tradingAnalytics(days = 30) {
    if (![7, 30, 90].includes(days)) throw new Error("Periodo de análisis inválido.");
    const now = Date.now(), account = this.store.get("analytics_account_uuid") ?? "";
    const report = buildTradingAnalytics({ transactions: account ? this.store.analyticsTransactions(account, now - 365 * 86_400_000) : [],
      offers: account ? this.store.analyticsOffers(account, now - 365 * 86_400_000) : [],
      accountUuid: account, fiat: this.store.analyticsFiatMovements(), markets: this.marketConfig.publicMarkets(), days, now });
    const history = this.store.loadRemoteResource<{ complete: boolean; page: number; limited?: boolean }>(`analytics_history:${account}`);
    const offersHistory = this.store.loadRemoteResource<{ complete: boolean; page: number }>(`analytics_offers_history:v2:${account}`);
    return { ...report, balanceHistory: sampleHistory(this.store.dashboardHistory(now - days * 86_400_000), 120),
      portfolioHistory: account ? this.store.portfolioHistory(account, now - days * 86_400_000) : [],
      portfolioStatus: this.store.loadRemoteResource("portfolio-status")?.data ?? null,
      sync: { accountKnown: Boolean(account), complete: Boolean(history?.data.complete && !history.data.limited), limited: history?.data.limited ?? false,
        offersComplete: Boolean(offersHistory?.data.complete), offerPages: offersHistory?.data.page ?? 0,
        pages: Math.max(0, (history?.data.page ?? 1) - 1), updatedAt: history?.updatedAt ?? this.store.loadRemoteResource("transactions")?.updatedAt ?? null } };
  }

  async refreshOperations() {
    await this.trading.syncRemoteOperations();
    return { data: this.store.visibleOperations(), updatedAt: Date.now() };
  }

  async refreshMarket(coin: string) {
    if (!this.marketConfig.find(coin)) throw new Error("Mercado inválido.");
    const current = await this.trading.inspectMarket(coin);
    const data: MarketView = {
      total: current.total,
      offers: current.items.map((item) => ({
        ...offerView(item.offer),
        decision: item.decision,
        reason: item.reason,
      })),
    };
    const updatedAt = current.scannedAt;
    this.store.saveRemoteResource(`market:${coin}`, data, updatedAt);
    for (const side of ["buy", "sell"] as const) {
      const items = current.items.filter((item) => item.offer.type === side);
      const sideData: MarketSideObservation = {
        offers: items.map((item) => ({
          ...offerView(item.offer),
          decision: item.decision,
          reason: item.reason,
        })),
        total: items.length,
        samples: items.filter((item) => Number.isFinite(item.rate) && item.rate > 0).length,
        ...(current.average?.[side === "buy" ? "median_buy" : "median_sell"] === undefined
          ? {}
          : { median: current.average[side === "buy" ? "median_buy" : "median_sell"] }),
      };
      this.store.saveRemoteResource(`market-side:${coin}:${side}`, sideData, updatedAt);
    }
    const previousAverages =
      this.store.loadRemoteResource<Record<string, unknown>>("averages")?.data ??
      {};
    const averages = {
      ...previousAverages,
      ...(current.average ? { [coin]: current.average } : {}),
    };
    this.store.saveRemoteResource("averages", averages, updatedAt);
    this.store.recordMarketObservation({
      coin,
      ...maybeNumber("averageBuy", numeric(current.average?.average_buy)),
      ...maybeNumber("averageSell", numeric(current.average?.average_sell)),
      ...maybeNumber("medianBuy", numeric(current.average?.median_buy)),
      ...maybeNumber("medianSell", numeric(current.average?.median_sell)),
      ...maybeNumber("bestBuy", bestRate(current.items, "buy")),
      ...maybeNumber("bestSell", bestRate(current.items, "sell")),
      openOffers: current.total,
      eligible: current.items.filter(
        (item) =>
          item.decision === "auto_buy" || item.decision === "manual_sell",
      ).length,
    });
    return { data, updatedAt, average: current.average };
  }

  marketSideObservations(coin: string): Partial<Record<"buy" | "sell", { data: MarketSideObservation; updatedAt: number }>> {
    const result: Partial<Record<"buy" | "sell", { data: MarketSideObservation; updatedAt: number }>> = {};
    for (const side of ["buy", "sell"] as const) {
      const cached = this.store.loadRemoteResource<MarketSideObservation>(`market-side:${coin}:${side}`);
      if (cached) result[side] = { data: cached.data, updatedAt: cached.updatedAt };
    }
    return result;
  }

  async refreshMarketSide(coin: string, side: "buy" | "sell") {
    return this.coalesceRead(`market-side:${coin}:${side}`, () =>
      this.refreshMarketSideOnce(coin, side),
    );
  }

  async refreshNextMarketObservation(): Promise<void> {
    const jobs = this.marketConfig.current().markets.filter(market => market.active)
      .flatMap(market => (["sell", "buy"] as const).map(side => ({ coin: market.code, side })));
    if (!jobs.length) return;
    // One background read per turn; never share the hunting decision queue.
    const job = jobs[this.marketObservationCursor++ % jobs.length]!;
    const cached = this.store.loadRemoteResource(`market-side:${job.coin}:${job.side}`);
    if (cached && Date.now() - cached.updatedAt < 60_000) return;
    await this.refreshMarketSide(job.coin, job.side);
  }

  private async refreshMarketSideOnce(coin: string, side: "buy" | "sell") {
    if (!this.marketConfig.find(coin)) throw new Error("Mercado inválido.");
    const current = await this.trading.inspectMarketSide(coin, side);
    const items = current.items.filter((item) => item.offer.type === side);
    const medianValue = median(items.map((item) => item.rate));
    const data: MarketSideObservation = {
      offers: items.map((item) => ({
        ...offerView(item.offer),
        decision: item.decision,
        reason: item.reason,
      })),
      total: current.total,
      samples: items.filter((item) => Number.isFinite(item.rate) && item.rate > 0).length,
      ...(medianValue === undefined ? {} : { median: medianValue }),
    };
    const updatedAt = current.scannedAt;
    this.store.saveRemoteResource(`market-side:${coin}:${side}`, data, updatedAt);

    // The display cache and the trading reference have distinct requirements:
    // only the validated median from the complete market inspection renews the
    // safety reference. A single offer cannot serve as its own reference.
    const medianKey = side === "buy" ? "median_buy" : "median_sell";
    const averageKey = side === "buy" ? "average_buy" : "average_sell";
    const previous = this.store.loadRemoteResource<Record<string, P2pAverage>>("averages")?.data ?? {};
    const statistics = { ...previous[coin] };
    delete statistics[medianKey];
    delete statistics[averageKey];
    const safeMedian = numeric(current.average?.[medianKey]);
    const average = numeric(current.average?.[averageKey]);
    if (safeMedian !== undefined) statistics[medianKey] = safeMedian;
    if (average !== undefined) statistics[averageKey] = average;
    this.store.saveRemoteResource("averages", { ...previous, [coin]: statistics }, updatedAt);
    this.store.recordMarketObservation({
      coin,
      ...(side === "buy"
        ? { ...maybeNumber("medianBuy", safeMedian), ...maybeNumber("averageBuy", average) }
        : { ...maybeNumber("medianSell", safeMedian), ...maybeNumber("averageSell", average) }),
      ...maybeNumber(side === "buy" ? "bestBuy" : "bestSell", bestRate(current.items, side)),
      openOffers: current.total,
      eligible: items.filter(item => item.decision === "auto_buy" || item.decision === "manual_sell").length,
    });

    const otherSide = side === "buy" ? "sell" : "buy";
    const other = this.store.loadRemoteResource<MarketSideObservation>(`market-side:${coin}:${otherSide}`)?.data;
    const offers = [...(other?.offers ?? []), ...data.offers];
    const marketData: MarketView = {
      offers,
      total: (other?.total ?? 0) + data.total,
    };
    this.store.saveRemoteResource(`market:${coin}`, marketData, updatedAt);
    return { data, updatedAt };
  }

  private coalesceRead<T>(key: string, read: () => Promise<T>): Promise<T> {
    const pending = this.pendingReads.get(key);
    if (pending) return pending as Promise<T>;
    const request = Promise.resolve().then(read);
    this.pendingReads.set(key, request);
    const clear = () => {
      if (this.pendingReads.get(key) === request) this.pendingReads.delete(key);
    };
    void request.then(clear, clear);
    return request;
  }

  async refreshCache(options: { refreshMarkets?: boolean } = {}): Promise<void> {
    const results = await Promise.allSettled([
      this.refreshBalance(),
      this.refreshOwnOffers(),
      this.refreshTransactions(),
      ...(options.refreshMarkets === false ? [] : this.trading.activeMarkets()).map((market) =>
        this.refreshMarket(market.code),
      ),
    ]);
    const errors = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    if (errors.length)
      throw new AggregateError(
        errors,
        `No se pudieron actualizar ${errors.length} recurso(s) del panel.`,
      );
  }

  async snapshot() {
    await this.refreshCache();
    return this.localSnapshot();
  }

  private recordDashboardPoint(): void {
    const state = this.trading.operationalState();
    const balanceResource = this.store.loadRemoteResource<number>("balance");
    const ownResource = this.store.loadRemoteResource<OfferView[]>("own-offers");
    const balance = balanceResource?.data;
    const ownOffers = ownResource?.data;
    if (balance === undefined || ownOffers === undefined) return;
    this.store.recordDashboardSnapshot({
      qusdBalance: balance,
      cupBalance: state.fiat.BANK_CUP ?? 0,
      prepagoBalance: state.fiat.BANDECPREPAGO ?? 0,
      openOffers: ownOffers.length,
      activeOperations: state.active,
    });
    const pending = this.store.loadRemoteResource<OfferView[]>("portfolio-commitments");
    const now = Date.now();
    if (!pending || !balanceResource || !ownResource ||
      [pending.updatedAt, balanceResource.updatedAt, ownResource.updatedAt].some((at) => now - at > 300_000)) {
      this.store.saveRemoteResource("portfolio-status", { reason: "Esperando saldos y ofertas recientes." }, now);
      return;
    }
    const account = this.store.get("analytics_account_uuid");
    const commitments = new Map([...ownOffers, ...pending.data].map((offer) => [offer.uuid, offer]));
    const qusdCommitted = [...commitments.values()].filter((offer) =>
      (offer.type === "sell" && offer.ownerUuid === account) || (offer.type === "buy" && offer.peerUuid === account))
      .reduce((total, offer) => total + (offer.status === "open" && offer.offerKind === "flexible"
        ? offer.availableAmount ?? offer.amount : offer.amount), 0);
    const fiat: Record<string, { amount: number; rate: number; qusd: number }> = {};
    const missing: string[] = [];
    let fiatQusd = 0;
    for (const market of this.marketConfig.publicMarkets()) {
      const amount = state.fiat[market.code] ?? 0;
      if (!Number.isFinite(amount) || amount < 0) { missing.push(market.label); continue; }
      if (amount === 0) continue;
      const rate = this.store.recentValuationRate(market.code, now);
      if (!rate) { missing.push(market.label); continue; }
      const qusd = amount / rate;
      fiat[market.code] = { amount, rate, qusd }; fiatQusd += qusd;
    }
    if (missing.length || !account) {
      this.store.saveRemoteResource("portfolio-status", { reason: missing.length
        ? `Falta cotización reciente para: ${missing.join(", ")}.` : "Esperando identidad de QvaPay." }, now);
      return;
    }
    const liabilityQusd = Number(this.store.get("cooperative_qusd_owed") ?? 0);
    this.store.recordPortfolioSnapshot({ createdAt: now, accountUuid: account, qusdFree: balance, qusdCommitted,
      fiatQusd, liabilityQusd, totalQusd: balance + qusdCommitted + fiatQusd - liabilityQusd, fiat });
    this.store.saveRemoteResource("portfolio-status", { reason: null, updatedAt: now }, now);
  }

  marketAnalytics(coin: string) {
    return {
      coin,
      history: compactMarketHistory(this.store.marketHistory(Date.now() - 24 * 3_600_000, coin), 240),
    };
  }

  private currentBudgetDeficits(): BudgetPlan[] {
    return Object.values(this.localSnapshot().budget)
      .filter((plan): plan is BudgetPlan => (plan as BudgetPlan).deficit > 0);
  }
}

function sampleHistory<T>(history: T[], limit: number): T[] {
  if (history.length <= limit) return history;
  return Array.from({ length: limit }, (_, index) =>
    history[Math.round(index * (history.length - 1) / (limit - 1))]!,
  );
}

function precisionQusd(value: number): number {
  const amount = Math.max(
    0,
    Math.floor((value + Number.EPSILON) * 100) / 100,
  );
  return amount < MIN_OFFER_QUSD ? 0 : amount;
}

function numeric(value: unknown): number | undefined {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : undefined;
}
function startOfDay(): number {
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  return now.getTime();
}
function maybeNumber<K extends string>(
  key: K,
  value: number | undefined,
): Partial<Record<K, number>> {
  return value === undefined ? {} : ({ [key]: value } as Record<K, number>);
}
function bestRate(
  items: { rate: number; offer: P2pOffer }[],
  type: "buy" | "sell",
): number | undefined {
  const rates = items
    .filter((item) => item.offer.type === type && item.rate > 0)
    .map((item) => item.rate);
  return rates.length
    ? type === "sell"
      ? Math.min(...rates)
      : Math.max(...rates)
    : undefined;
}
function rankings(
  configured: import("./market-config.js").MarketConfig[],
  market: Record<
    string,
    {
      offers: (ReturnType<typeof offerView> & { decision: string })[];
      total: number;
    }
  >,
  history: { coin: string; openOffers: number; eligible: number }[],
) {
  const rotation = configured
    .map((item) => {
      const samples = history.filter((point) => point.coin === item.code);
      return {
        code: item.code,
        label: item.label,
        observed: samples.reduce((sum, point) => sum + point.openOffers, 0),
        eligible: samples.reduce((sum, point) => sum + point.eligible, 0),
      };
    })
    .sort((a, b) => b.eligible - a.eligible || b.observed - a.observed);
  const potential = configured
    .flatMap((buy) => {
      const source = market[buy.code]?.offers
        .filter(
          (offer) => offer.type === "sell" && offer.decision === "auto_buy",
        )
        .sort((a, b) => a.rate - b.rate)[0];
      if (!source) return [];
      return configured
        .filter(
          (sell) => sell.code !== buy.code && sell.currency === buy.currency,
        )
        .map((sell) => {
          const target = market[sell.code]?.offers
            .filter(
              (offer) =>
                offer.type === "buy" && offer.decision === "manual_sell",
            )
            .sort((a, b) => b.rate - a.rate)[0];
          if (!target) return undefined;
          const spendableFiat = Math.max(0, buy.fiatBalance - buy.outgoingTransferFee);
          const amount = Math.min(source.amount, spendableFiat / source.rate);
          const profit =
            target.rate * amount * (1 - sell.sellFeePercent / 100) -
            source.rate * amount -
            buy.outgoingTransferFee;
          return {
            buy: buy.code,
            sell: sell.code,
            amount,
            profit,
            marginPercent: source.rate
              ? (profit / (source.rate * amount)) * 100
              : 0,
          };
        })
        .filter((value): value is NonNullable<typeof value> => Boolean(value));
    })
    .filter((value) => value.profit > 0)
    .sort((a, b) => b.profit - a.profit);
  return { rotation, potential };
}

export function offerView(offer: P2pOffer) {
  const coin: FiatMarket = offer.coin;
  return {
    uuid: offer.uuid,
    type: offer.type,
    coin,
    amount: offer.amount,
    receive: offer.receive,
    rate: rate(offer),
    status: offer.status,
    ownerUuid: offer.User?.uuid ?? offer.owner_uuid,
    peerUuid: offer.Peer?.uuid,
    offerKind: offer.offer_kind,
    availableAmount: offer.available_amount != null && Number.isFinite(Number(offer.available_amount)) && Number(offer.available_amount) >= 0
      ? Number(offer.available_amount) : undefined,
    updatedAt: offer.updated_at,
    createdAt: offer.created_at,
  };
}

/** @deprecated Use DashboardReadModel. */
export { DashboardReadModel as DashboardService };
