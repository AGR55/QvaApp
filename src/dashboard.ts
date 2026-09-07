import type { config as Config } from "./config.js";
import { QvaPayClient } from "./qvapay.js";
import { rate, type TradingService } from "./trading.js";
import { MarketConfigService, type TradingConfig } from "./market-config.js";
import type { FiatMarket, P2pOffer } from "./types.js";
import type { Store } from "./store.js";
import { proportionalBudgetPlan } from "./budget.js";

type RuntimeConfig = typeof Config;

export function marginCalculation(
  buyRate: number,
  sellRate: number,
  amount: number,
  sellFeePercent: number,
) {
  const cost = buyRate * amount;
  const grossRevenue = sellRate * amount;
  const netRevenue = grossRevenue * (1 - sellFeePercent / 100);
  return {
    cost,
    grossRevenue,
    netRevenue,
    netProfit: netRevenue - cost,
    marginPercent: cost ? ((netRevenue - cost) / cost) * 100 : 0,
    breakEvenRate:
      1 - sellFeePercent / 100 > 0 ? buyRate / (1 - sellFeePercent / 100) : 0,
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

export class DashboardReadModel {
  constructor(
    private readonly trading: TradingService,
    private readonly qva: QvaPayClient,
    _cfg: RuntimeConfig,
    private readonly store: Store,
    private readonly marketConfig: MarketConfigService,
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
  async setPaused(paused: boolean): Promise<void> {
    if (paused) {
      this.trading.setPaused(true, "panel web");
      return;
    }
    await this.trading.activate();
  }
  setMode(mode: "simulation" | "real"): void {
    this.trading.setMode(mode);
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

  async snapshot() {
    const state = this.trading.operationalState();
    const ownOffers = await this.trading.listOwnOffers();
    const averages = await this.qva.p2pAverages();
    const market = {} as Record<
      FiatMarket,
      {
        offers: (ReturnType<typeof offerView> & {
          decision: string;
          reason: string;
        })[];
        total: number;
      }
    >;
    const readings = await Promise.all(
      this.trading
        .activeMarkets()
        .map(async (configured) => ({
          configured,
          current: await this.trading.inspectMarket(configured.code),
        })),
    );
    for (const { configured, current } of readings) {
      market[configured.code] = {
        total: current.total,
        offers: current.items.map((item) => ({
          ...offerView(item.offer),
          decision: item.decision,
          reason: item.reason,
        })),
      };
      const average = averages[configured.code];
      this.store.recordMarketObservation({
        coin: configured.code,
        ...maybeNumber("averageBuy", numeric(average?.average_buy)),
        ...maybeNumber("averageSell", numeric(average?.average_sell)),
        ...maybeNumber("bestBuy", bestRate(current.items, "buy")),
        ...maybeNumber("bestSell", bestRate(current.items, "sell")),
        openOffers: current.total,
        eligible: current.items.filter(
          (item) =>
            item.decision === "auto_buy" || item.decision === "manual_sell",
        ).length,
      });
    }
    const [balance, transactions] = await Promise.all([
      this.trading.qusdBalance(),
      this.qva.listTransactions(),
    ]);
    this.store.recordDashboardSnapshot({
      qusdBalance: balance,
      cupBalance: state.fiat.BANK_CUP ?? 0,
      prepagoBalance: state.fiat.BANDECPREPAGO ?? 0,
      openOffers: ownOffers.length,
      activeOperations: state.active,
    });
    const strategy = this.trading.strategy();
    const ownOfferViews = ownOffers.map(offerView);
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
          ),
        ]),
    );
    return {
      generatedAt: Date.now(),
      balance,
      state,
      ownOffers: ownOfferViews,
      market,
      averages,
      transactions: transactions
        .slice(0, 12)
        .map((tx) => ({
          uuid: tx.uuid,
          amount: tx.amount,
          description: tx.description ?? "Transacción",
          status: tx.status,
          createdAt: tx.created_at,
          coin: tx.Wallet?.Coin?.tick ?? tx.P2P?.coin ?? "QUSD",
          p2p: tx.P2P
            ? {
                amount: tx.P2P.amount,
                receive: tx.P2P.receive,
                status: tx.P2P.status,
              }
            : undefined,
        })),
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
      mutationIntents: this.store.recentMutationIntents(100),
      operations: this.store.operations(),
      integrity: {
        schemaVersion: this.store.schemaVersion(),
        configRevisionChainValid: this.store.verifyConfigRevisionChain(),
      },
    };
  }

  async marketAnalytics(coin: string) {
    const [averageMap, page] = await Promise.all([
      this.qva.p2pAverages(),
      this.qva.listOffersPage({ coin, status: "open", take: 100, page: 1 }),
    ]);
    const offers = page.offers.filter(
      (offer) => offer.amount > 0 && offer.receive > 0,
    );
    const rates = (type: "buy" | "sell") =>
      offers.filter((offer) => offer.type === type).map((offer) => rate(offer));
    const average = averageMap[coin];
    this.store.recordMarketObservation({
      coin,
      ...maybeNumber("averageBuy", numeric(average?.average_buy)),
      ...maybeNumber("averageSell", numeric(average?.average_sell)),
      ...maybeNumber("medianBuy", median(rates("buy"))),
      ...maybeNumber("medianSell", median(rates("sell"))),
      ...maybeNumber(
        "bestBuy",
        bestRate(offers.map((offer) => ({ offer, rate: rate(offer) })), "buy"),
      ),
      ...maybeNumber(
        "bestSell",
        bestRate(offers.map((offer) => ({ offer, rate: rate(offer) })), "sell"),
      ),
      openOffers: page.total,
      eligible: 0,
    });
    return {
      coin,
      history: this.store.marketHistory(startOfDay(), coin),
      latest: {
        averageBuy: numeric(average?.average_buy),
        averageSell: numeric(average?.average_sell),
        medianBuy: median(rates("buy")),
        medianSell: median(rates("sell")),
        points: page.total,
      },
    };
  }
}

function numeric(value: unknown): number | undefined {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : undefined;
}
function median(values: number[]): number | undefined {
  if (!values.length) return undefined;
  const sorted = values.slice().sort((a, b) => a - b),
    middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

function maybeNumber<K extends string>(
  key: K,
  value: number | undefined,
): Partial<Record<K, number>> {
  return value === undefined ? {} : ({ [key]: value } as Record<K, number>);
}
function startOfDay(): number {
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  return now.getTime();
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
          const amount = Math.min(source.amount, buy.fiatBalance / source.rate);
          const profit =
            target.rate * amount * (1 - sell.sellFeePercent / 100) -
            source.rate * amount;
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
