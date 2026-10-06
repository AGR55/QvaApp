import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { analyticsDay, analyticsOffer, analyticsTransaction, buildTradingAnalytics, type AnalyticsTransaction } from "../src/trading-analytics.js";
import { analyticsBars } from "../web/lib/analytics-bars.js";
import { Store } from "../src/store.js";
import { QvaPayClient } from "../src/qvapay.js";
import { DashboardReadModel } from "../src/dashboard.js";
import { MarketConfigService } from "../src/market-config.js";
import { DatabaseSync } from "node:sqlite";

const now = Date.parse("2026-10-05T16:00:00Z");
const markets = [{ code: "BANK_CUP", label: "CUP", currency: "CUP" }, { code: "CLASICA", label: "Clásica", currency: "USD" }];
function tx(uuid: string, side: "buy" | "sell", qusd: number, fiat: number, ago: number, coin = "BANK_CUP"): AnalyticsTransaction {
  return { uuid, createdAt: now - ago * 86_400_000, updatedAt: now - ago * 86_400_000,
    amount: qusd, payerUuid: side === "sell" ? "me" : "other", recipientUuid: side === "buy" ? "me" : "other",
    p2p: { uuid: `offer-${uuid}`, coin, amount: qusd, receive: fiat, status: "completed" } };
}
function report(transactions: AnalyticsTransaction[], days = 7) {
  return buildTradingAnalytics({ transactions, accountUuid: "me", markets, fiat: [], days, now });
}

test("FIFO usa inventario anterior al filtro, asigna costes parciales y admite pérdidas", () => {
  const result = report([tx("buy", "buy", 10, 9000, 20), tx("sell", "sell", 4, 4000, 3), tx("sell-loss", "sell", 4, 3200, 2)]);
  assert.equal(result.volume, 8);
  assert.equal(result.markets[0]?.estimatedProfit, 0); // +400 then -400.
  assert.equal(result.markets[0]?.matchedQusd, 8);
  assert.equal(result.markets[0]?.fiatSpent, 0);
});

test("ofertas completadas alimentan volumen aunque las transacciones no incluyan P2P y las cantidades no coincidan", () => {
  const offers = [
    { uuid: "buy", type: "buy", coin: "BANK_CUP", amount: 8, receive: 7200, status: "completed", updated_at: new Date(now - 2 * 86_400_000).toISOString(), User: { uuid: "me" }, Peer: { uuid: "other" } },
    { uuid: "sell", type: "buy", coin: "BANK_CUP", amount: 3, receive: 3000, status: "completed", updated_at: new Date(now - 86_400_000).toISOString(), User: { uuid: "other" }, Peer: { uuid: "me" } },
  ] as const;
  const parsed = offers.map((offer) => analyticsOffer(offer as never, "me")!);
  assert.deepEqual(parsed.map((row) => row.side), ["incoming", "outgoing"]);
  const result = buildTradingAnalytics({ transactions: [{ uuid: "wallet-only", amount: 5, createdAt: now, updatedAt: now,
    payerUuid: "other", recipientUuid: "me" }], offers: parsed, accountUuid: "me", fiat: [], markets, days: 7, now });
  assert.equal(result.completed, 2);
  assert.equal(result.volume, 11);
  assert.equal(result.markets[0]?.bought, 8);
  assert.equal(result.markets[0]?.sold, 3);
  assert.equal(result.totals.incoming, 5);
});

test("oferta en revisión o sin participación propia identificada no se cuenta como completada", () => {
  const offer = { uuid: "review", type: "buy", coin: "BANK_CUP", amount: 8, receive: 7200,
    updated_at: new Date(now).toISOString(), User: { uuid: "me" } };
  assert.equal(analyticsOffer({ ...offer, status: "revision" } as never, "me"), undefined);
  assert.equal(analyticsOffer({ ...offer, status: "completed", User: { uuid: "other" } } as never, "me"), undefined);
});

test("no atribuye beneficio a inventario inicial desconocido ni mezcla CUP con USD", () => {
  const result = report([tx("initial-sale", "sell", 10, 11000, 5), tx("usd-buy", "buy", 10, 10, 4, "CLASICA"), tx("usd-sell", "sell", 20, 22, 2, "CLASICA")]);
  assert.equal(result.coverage.unmatchedSoldQusd, 20);
  assert.equal(result.currencies.find((r) => r.currency === "USD")?.profit, 1);
  assert.equal(result.currencies.find((r) => r.currency === "CUP")?.profit, 0);
});

test("deduplica oferta y transacción; revisión y direcciones contradictorias no producen ganancias", () => {
  const first = tx("buy", "buy", 10, 9000, 4);
  const review = { ...tx("review", "sell", 10, 10000, 3), p2p: { ...tx("review", "sell", 10, 10000, 3).p2p!, status: "revision" } };
  const duplicate = { ...first, uuid: "escrow", payerUuid: "me", recipientUuid: "other" };
  const result = report([first, first, duplicate, review]);
  assert.equal(result.volume, 10);
  assert.equal(result.completed, 1);
  assert.equal(result.markets[0]?.unknown, 10);
  assert.equal(result.markets[0]?.estimatedProfit, 0);
});

test("movimientos fiat verificados incluyen costes registrados y aclaran la dirección", () => {
  const buy = tx("buy", "buy", 10, 10, 4, "CLASICA"), sell = tx("sell", "sell", 10, 11, 1, "CLASICA");
  delete buy.payerUuid; delete buy.recipientUuid;
  const result = buildTradingAnalytics({ transactions: [buy, sell], accountUuid: "me", markets, days: 7, now,
    fiat: [{ uuid: "offer-buy", direction: "debit", amount: 10.08 }] });
  assert.ok(Math.abs(result.markets[0]!.estimatedProfit - .92) < 1e-8);
});

test("cambiar la densidad de barras conserva cantidades y usa días de La Habana", () => {
  const result = report([tx("one", "buy", 10, 9000, 20), tx("two", "sell", 15, 15000, 1)], 30);
  const bars = analyticsBars(result.daily, 10);
  assert.equal(bars.length, 10);
  assert.equal(bars.reduce((sum: number, row: { count: number }) => sum + row.count, 0), 2);
  assert.equal(bars.reduce((sum: number, row: { incoming: number }) => sum + row.incoming, 0), 10);
  assert.equal(analyticsDay(Date.parse("2026-10-05T02:00:00Z")), "2026-10-04");
});

test("el archivo separa cuentas, conserva la última versión y sobrevive a reinicios", () => {
  const path = mkdtempSync(join(tmpdir(), "qva-analytics-"));
  const store = new Store(path);
  const first = tx("same", "buy", 10, 9000, 2);
  store.saveAnalyticsTransactions("me", [first, first]);
  store.saveAnalyticsTransactions("other", [{ ...first, amount: 99 }]);
  store.saveAnalyticsTransactions("me", [{ ...first, amount: 1, updatedAt: first.updatedAt - 1 }]);
  store.close();
  const restored = new Store(path);
  assert.equal(restored.analyticsTransactions("me", 0).length, 1);
  assert.equal(restored.analyticsTransactions("me", 0)[0]?.amount, 10);
  assert.equal(restored.analyticsTransactions("other", 0)[0]?.amount, 99);
  restored.close();
});

test("persiste ofertas completadas y fotos de capital sin reconstruir el pasado", () => {
  const path = mkdtempSync(join(tmpdir(), "qva-portfolio-"));
  const store = new Store(path);
  const offer = { uuid: "one", coin: "BANK_CUP", amount: 5, receive: 5000, side: "incoming" as const, completedAt: now };
  store.saveAnalyticsOffers("me", [offer]);
  store.recordPortfolioSnapshot({ createdAt: now, accountUuid: "me", qusdFree: 10, qusdCommitted: 5, fiatQusd: 20,
    totalQusd: 35, fiat: { BANK_CUP: { amount: 20000, rate: 1000, qusd: 20 } } });
  store.close();
  const restored = new Store(path);
  assert.deepEqual(restored.analyticsOffers("me", 0), [offer]);
  assert.equal(restored.analyticsOffers("other", 0).length, 0);
  assert.equal(restored.portfolioHistory("me", 0)[0]?.totalQusd, 35);
  assert.equal(restored.portfolioHistory("other", 0).length, 0);
  restored.close();
});

test("la foto de capital suma QUSD libre, ofertas comprometidas y fiat de varios mercados", async () => {
  const path = mkdtempSync(join(tmpdir(), "qva-capital-total-"));
  const store = new Store(path), tick = Date.now();
  store.set("analytics_account_uuid", "me");
  const runtime = { qusdReserve: 2, maxOpenOwnOffers: 4, buyQusdMaxRate: 930, sellQusdMinRate: 980,
    buyQusdUsdMaxRate: 1.06, sellQusdUsdMinRate: 1.12, cupPurchaseMaxQusd: 35, initialUsdFiatBalance: 0,
    paymentDetails: { BANK_CUP: [], BANDECPREPAGO: [] } };
  const marketConfig = new MarketConfigService(path, runtime as never, store);
  store.recordMarketObservation({ coin: "BANK_CUP", medianSell: 1000, openOffers: 5, eligible: 5 });
  store.saveRemoteResource("own-offers", [{ uuid: "open", type: "sell", status: "open", amount: 5, ownerUuid: "me" }], tick);
  store.saveRemoteResource("portfolio-commitments", [{ uuid: "pending", type: "buy", status: "paid", amount: 3, ownerUuid: "other", peerUuid: "me" }], tick);
  const trading = { qusdBalance: async () => 10, operationalState: () => ({ fiat: { BANK_CUP: 2000 }, active: 1 }) };
  const readModel = new DashboardReadModel(trading as never, {} as never, {} as never, store, marketConfig);
  await readModel.refreshBalance();
  const point = store.portfolioHistory("me", 0)[0]!;
  assert.equal(point.qusdFree, 10);
  assert.equal(point.qusdCommitted, 8);
  assert.equal(point.fiatQusd, 2);
  assert.equal(point.totalQusd, 20);
  store.close();
});

test("QvaPay pagina con límites oficiales y normaliza decimales sin archivar identidades privadas", async () => {
  let url = "";
  const qva = new QvaPayClient(() => "test-token", { fetch: async (input) => {
    url = String(input);
    return new Response(JSON.stringify({ total: 61, transactions: [{ uuid: "one", amount: "10.50", status: "paid", created_at: "2026-10-01T00:00:00Z",
      User: { uuid: "me", name: "private" }, PaidBy: { uuid: "other" }, P2P: { uuid: "offer", amount: "10.50", receive: "9450", coin: "BANK_CUP", status: "completed" } }] }));
  } });
  const page = await qva.listTransactionsPage({ page: 2, take: 30, dateFrom: "2026-01-01T00:00:00Z", dateTo: "2026-10-05T00:00:00Z" });
  assert.equal(new URL(url).searchParams.get("take"), "30");
  assert.equal(new URL(url).searchParams.get("page"), "2");
  assert.equal(page.total, 61);
  assert.equal(page.transactions[0]?.amount, 10.5);
  assert.equal(analyticsTransaction(page.transactions[0]!)?.p2p?.receive, 9450);
  assert.doesNotMatch(JSON.stringify(page.transactions), /private/);
  await assert.rejects(qva.listTransactionsPage({ take: 31 }), /Paginación/);
});

test("el histórico P2P puede leer ofertas completadas con detalles de pago ajenos mal formados", async () => {
  const qva = new QvaPayClient(() => "test-token", { fetch: async () => new Response(JSON.stringify({
    total: 1, current_page: 1, per_page: 100, data: [{ uuid: "completed-1", type: "sell", coin: "BANK_CUP",
      amount: "7", receive: "7000", status: "completed", updated_at: new Date(now).toISOString(),
      User: { uuid: "me" }, Peer: { uuid: "other" }, details: [{ broken: true }] }],
  })) });
  await assert.rejects(qva.listOffersPage({ my: true, status: "completed" }), /datos de pago inválidos/);
  const page = await qva.listOffersPage({ my: true, status: "completed" }, { analyticsOnly: true });
  assert.equal(analyticsOffer(page.offers[0]!, "me")?.side, "outgoing");
});

test("la importación P2P de fondo conserva el cursor y llena las gráficas sin transacciones relacionadas", async () => {
  const path = mkdtempSync(join(tmpdir(), "qva-offer-history-"));
  const store = new Store(path);
  store.set("analytics_account_uuid", "me");
  const pages: number[] = [];
  const offer = (index: number) => ({ uuid: `completed-${index}`, type: "buy", coin: "BANK_CUP", amount: 1,
    receive: 1000, status: "completed", updated_at: new Date().toISOString(), User: { uuid: "me" }, Peer: { uuid: "other" } });
  const qva = { listOffersPage: async (params: { page: number }) => {
    pages.push(params.page);
    return { offers: params.page === 1 ? Array.from({ length: 100 }, (_, index) => offer(index)) : [offer(100)], total: 101 };
  } };
  const readModel = new DashboardReadModel({} as never, qva as never, {} as never, store, {} as never);
  await readModel.refreshCompletedOfferHistory();
  await readModel.refreshCompletedOfferHistory();
  assert.deepEqual(pages, [1, 2]);
  assert.equal(store.analyticsOffers("me", 0).length, 101);
  assert.equal(store.loadRemoteResource<{ complete: boolean }>("analytics_offers_history:me")?.data.complete, true);
  store.close();
});

test("la consulta existente alterna actualización reciente y backfill; un fallo conserva el cursor", async () => {
  const path = mkdtempSync(join(tmpdir(), "qva-analytics-sync-"));
  const store = new Store(path);
  store.set("analytics_account_uuid", "me");
  const runtime = { qusdReserve: 2, maxOpenOwnOffers: 4, buyQusdMaxRate: 930, sellQusdMinRate: 980,
    buyQusdUsdMaxRate: 1.06, sellQusdUsdMinRate: 1.12, cupPurchaseMaxQusd: 35, initialUsdFiatBalance: 110,
    paymentDetails: { BANK_CUP: [], BANDECPREPAGO: [] } };
  const marketConfig = new MarketConfigService(path, runtime as never, store);
  const calls: { page?: number; dateTo?: string }[] = [];
  let fail = false;
  const qva = { listTransactionsPage: async (params: { page?: number; dateTo?: string }) => {
    calls.push(params);
    if (fail) throw new Error("red caída");
    return { total: 90, transactions: Array.from({ length: 30 }, (_, i) => ({ uuid: `tx-${params.page ?? 1}-${i}`, amount: 10,
      status: "paid", created_at: new Date(Date.now() - i * 1000).toISOString(), User: { uuid: "me" } })) };
  } };
  const readModel = new DashboardReadModel({} as never, qva as never, {} as never, store, marketConfig);
  await readModel.refreshTransactions();
  const fresh = store.loadRemoteResource("transactions")!;
  await readModel.refreshTransactions();
  assert.ok(calls[1]?.dateTo);
  assert.equal(store.loadRemoteResource("transactions")?.updatedAt, fresh.updatedAt);
  fail = true;
  await assert.rejects(readModel.refreshTransactions(), /red caída/);
  fail = false;
  await readModel.refreshTransactions();
  assert.equal(calls[2]?.page, 2);
  assert.equal(calls[3]?.page, 2);
  const before = calls.length;
  assert.ok(readModel.tradingAnalytics(30).coverage.transactions > 0);
  assert.equal(calls.length, before, "consultar el informe no inicia ninguna consulta remota");
  store.close();
});

test("el saldo conserva puntos horarios antiguos y detalle reciente sin retener datos de más de 90 días", () => {
  const path = mkdtempSync(join(tmpdir(), "qva-analytics-balance-"));
  const store = new Store(path), db = new DatabaseSync(join(path, "qvaapply.sqlite"));
  const now = Date.now(), oldHour = Math.floor((now - 60 * 86_400_000) / 3_600_000) * 3_600_000;
  const insert = db.prepare("INSERT INTO dashboard_snapshots(created_at, qusd_balance, cup_balance, prepago_balance, open_offers, active_operations) VALUES (?, 100, 0, 0, 0, 0)");
  for (const time of [now - 100 * 86_400_000, oldHour + 1000, oldHour + 2000, now - 86_400_000, now - 86_400_000 + 1000]) insert.run(time);
  db.close();
  store.recordDashboardSnapshot({ qusdBalance: 110, cupBalance: 0, prepagoBalance: 0, openOffers: 0, activeOperations: 0 });
  const points = store.dashboardHistory(0);
  assert.equal(points.length, 4);
  assert.equal(points[0]?.createdAt, oldHour + 2000);
  store.close();
});
