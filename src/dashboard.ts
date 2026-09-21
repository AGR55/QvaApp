import { randomUUID } from "node:crypto";
import type { config as Config } from "./config.js";
import { QvaApiError, QvaMutationUncertainError, QvaPayClient } from "./qvapay.js";
import { rate, type TradingService } from "./trading.js";
import { MarketConfigService, type TradingConfig } from "./market-config.js";
import type { FiatMarket, P2pOffer } from "./types.js";
import type {
  RebalanceJob,
  RebalanceJobAdjustment,
  RebalanceJobState,
  Store,
} from "./store.js";
import { proportionalBudgetPlan, type BudgetPlan } from "./budget.js";
import { MIN_OFFER_QUSD, ownOfferFiatTotal } from "./market-math.js";
import type { HuntingSyncCoordinator } from "./hunting-sync.js";

type RuntimeConfig = typeof Config;
type OfferView = ReturnType<typeof offerView>;
type MarketView = {
  offers: (OfferView & { decision: string; reason: string })[];
  total: number;
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
  ) {}

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
    fiat: number;
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
      const view = item.kind.startsWith("rebalance-")
        ? "ofertas"
        : item.kind === "operation-applied"
          ? "operaciones"
          : "auditoria";
      return {
        id: item.id,
        type: item.kind,
        message: item.message,
        alert,
        url: `/?view=${view}&operation=${encodeURIComponent(item.operationUuid ?? "")}`,
        createdAt: item.createdAt,
      };
    });
  }

  acknowledgeNotification(id: string): void {
    this.store.acknowledgeNotification(id);
  }

  localSnapshot() {
    const state = this.trading.operationalState();
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
    const market = Object.fromEntries(
      this.trading.markets().map((configured) => [
        configured.code,
        this.store.loadRemoteResource<MarketView>(
          `market:${configured.code}`,
        )?.data ?? { offers: [], total: 0 },
      ]),
    ) as Record<FiatMarket, MarketView>;
    const strategy = this.trading.strategy();
    const budget = Object.fromEntries(
      this.trading
        .markets()
        .map((configured) => [
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
    return {
      generatedAt: Date.now(),
      freshness: {
        balance: balanceResource?.updatedAt ?? null,
        ownOffers: ownOffersResource?.updatedAt ?? null,
        transactions: transactionResource?.updatedAt ?? null,
        markets: Object.fromEntries(
          this.trading.markets().map((configured) => [
            configured.code,
            this.store.loadRemoteResource(`market:${configured.code}`)
              ?.updatedAt ?? null,
          ]),
        ),
      },
      balance,
      state,
      ownOffers: ownOfferViews,
      market,
      averages,
      hunting: this.marketConfig.current().hunting,
      automation: this.marketConfig.current().automation,
      transactions: transactionResource?.data ?? [],
      strategy,
      markets: this.marketConfig.publicMarkets(),
      availability: {
        qusd: {
          reported: balance,
          reserve: strategy.reserve,
          available: Math.max(0, balance - strategy.reserve),
          committedSell: ownOfferViews
            .filter((offer) => offer.type === "sell" && offer.status === "open")
            .reduce((sum, offer) => sum + offer.amount, 0),
        },
        fiat: Object.fromEntries(
          this.trading.markets().map((configured) => {
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
      history: this.store.dashboardHistory(Date.now() - 90 * 86_400_000),
      marketHistory: this.store.marketHistory(Date.now() - 24 * 3_600_000),
      rankings: rankings(
        this.trading.markets(),
        market,
        this.store.marketHistory(Date.now() - 24 * 3_600_000),
      ),
      activity: this.store.recentAudit(50),
      alerts: this.store.recentTradingAlerts(),
      risk: {
        limits: this.marketConfig.current().risk,
        usage: {
          exposureQusd:
            this.store.activeOperations().reduce(
              (sum, operation) => sum + operation.amount,
              0,
            ) + this.store.activeReservedQusd(),
          dailyAppliedQusd: this.store.dailyAppliedQusd(startOfDay()),
          activeOperations: this.store.activeOperations().length,
          unresolvedMutation: this.store.hasUnresolvedMutation(),
          emergencyStop: this.store.get("emergency_stop") === "true",
        },
      },
      recoverableWorkflows: this.store.recoverableWorkflows(),
      workflows: this.store.tradeWorkflows(),
      workflowOffers: Object.fromEntries(
        this.store
          .tradeWorkflows()
          .map((workflow) => [workflow.id, this.store.workflowOwnOffers(workflow.id)]),
      ),
      capitalReservations: this.store.capitalReservations(),
      cooperativeNetwork: this.cooperativeNetwork(),
      mutationIntents: this.store.recentMutationIntents(100),
      operations: this.store.visibleOperations(),
      integrity: {
        schemaVersion: this.store.schemaVersion(),
        configRevisionChainValid: this.store.verifyConfigRevisionChain(),
      },
    };
  }

  async refreshBalance() {
    const data = await this.trading.qusdBalance();
    const updatedAt = Date.now();
    this.store.saveRemoteResource("balance", data, updatedAt);
    this.recordDashboardPoint();
    return { data, updatedAt };
  }

  async refreshOwnOffers() {
    const data = (await this.trading.listOwnOffers()).map(offerView);
    const updatedAt = Date.now();
    this.store.saveRemoteResource("own-offers", data, updatedAt);
    this.recordDashboardPoint();
    return { data, updatedAt };
  }

  async refreshTransactions() {
    const data: TransactionView[] = (await this.qva.listTransactions())
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

  async refreshCache(): Promise<void> {
    const results = await Promise.allSettled([
      this.refreshBalance(),
      this.refreshOwnOffers(),
      this.refreshTransactions(),
      ...this.trading.activeMarkets().map((market) =>
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
    const balance = this.store.loadRemoteResource<number>("balance")?.data;
    const ownOffers =
      this.store.loadRemoteResource<OfferView[]>("own-offers")?.data;
    if (balance === undefined || ownOffers === undefined) return;
    this.store.recordDashboardSnapshot({
      qusdBalance: balance,
      cupBalance: state.fiat.BANK_CUP ?? 0,
      prepagoBalance: state.fiat.BANDECPREPAGO ?? 0,
      openOffers: ownOffers.length,
      activeOperations: state.active,
    });
  }

  marketAnalytics(coin: string) {
    return {
      coin,
      history: this.store.marketHistory(Date.now() - 24 * 3_600_000, coin),
    };
  }

  private currentBudgetDeficits(): BudgetPlan[] {
    return Object.values(this.localSnapshot().budget)
      .filter((plan): plan is BudgetPlan => (plan as BudgetPlan).deficit > 0);
  }
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
    updatedAt: offer.updated_at,
    createdAt: offer.created_at,
  };
}

/** @deprecated Use DashboardReadModel. */
export { DashboardReadModel as DashboardService };
