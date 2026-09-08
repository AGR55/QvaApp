import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { MarketConfigService } from "../src/market-config.js";
import { Store } from "../src/store.js";
import { TradingEngine } from "../src/trading.js";
import type { P2pOffer } from "../src/types.js";

function setup() {
  const dataDir = mkdtempSync(join(tmpdir(), "qvaapply-scan-integration-"));
  const store = new Store(dataDir);
  const cfg = {
    dataDir,
    initialUsdFiatBalance: 0,
    buyQusdMaxRate: 930,
    sellQusdMinRate: 1_000,
    buyQusdUsdMaxRate: 1.06,
    sellQusdUsdMinRate: 1.12,
    cupPurchaseMaxQusd: 150,
    maxOpenOwnOffers: 10,
    priceGuardPercent: 15,
    qusdReserve: 0,
    realTradingAllowed: true,
    autoCancelMs: 600_000,
    offerRefreshIntervalMs: 300_000,
    paymentDetails: { BANK_CUP: [], BANDECPREPAGO: [] },
  };
  const markets = new MarketConfigService(dataDir, cfg as never, store);
  const next = markets.current();
  next.risk.reviewedAt = Date.now();
  next.markets.forEach((market) => {
    market.active = market.code === "BANK_CUP";
  });
  next.markets[0]!.fiatBalance = 100_000;
  markets.save(next);
  store.set("fiat_balance:BANK_CUP", "100000");
  store.set("paused", "false");
  store.set("mode", "real");
  return { dataDir, store, cfg, markets };
}

test("el escaneo real cancela liquidez peor y aplica a la mejor compra externa", async () => {
  const { store, cfg, markets } = setup();
  const target: P2pOffer = { uuid: "target-buy", type: "buy", coin: "BANK_CUP", amount: 20, receive: 20_400, status: "open", User: { uuid: "peer" } };
  const own: P2pOffer = { uuid: "own-sell", type: "sell", coin: "BANK_CUP", amount: 20, receive: 19_800, status: "open", details: { cuenta: "123" } };
  const calls: string[] = [];
  const qva = {
    listOffersPage: async () => ({ offers: [target], total: 1, currentPage: 1, perPage: 20 }),
    p2pAverages: async () => ({ BANK_CUP: { average_buy: 1_015, average_sell: 930 } }),
    qusdBalance: async () => 10,
    listOffers: async () => [own],
    cancel: async (uuid: string) => void calls.push(`cancel:${uuid}`),
    apply: async (uuid: string) => void calls.push(`apply:${uuid}`),
  };
  const trading = new TradingEngine(store, qva as never, cfg as never, markets, async () => undefined);

  const result = await trading.scan();

  assert.equal(result.action, "venta aplicada target-buy");
  assert.deepEqual(calls, ["cancel:own-sell", "apply:target-buy"]);
  assert.equal(store.getOperation(target.uuid)?.autoApplied, true);
  assert.equal(store.getOperation(target.uuid)?.referenceRate, 1_020);
  assert.equal(store.getTradeWorkflow(store.tradeWorkflows()[0]!.id)?.state, "applied");
  store.close();
});

test("detiene compra y venta por separado sin consultar el lado deshabilitado", async () => {
  const { store, cfg, markets } = setup();
  const queries: string[] = [];
  const qva = {
    listOffersPage: async (params: { type: string }) => {
      queries.push(params.type);
      return { offers: [], total: 0, currentPage: 1, perPage: 100 };
    },
    p2pAverages: async () => ({}),
  };
  const trading = new TradingEngine(store, qva as never, cfg as never, markets, async () => undefined);

  trading.updateHunting({ buyRunning: false, sellRunning: true });
  await trading.scan();
  assert.deepEqual(queries, ["buy"]);

  queries.length = 0;
  trading.updateHunting({ buyRunning: true, sellRunning: false });
  store.set("market_scan_round", "0");
  await trading.scan();
  assert.deepEqual(queries, ["sell"]);

  queries.length = 0;
  trading.updateHunting({
    sellRunning: true,
    market: { code: "BANK_CUP", huntBuyEnabled: false, huntSellEnabled: false },
  });
  store.set("market_scan_round", "0");
  await trading.scan();
  assert.deepEqual(queries, []);
  store.close();
});

test("conserva la selección y los precios de cacería por mercado", () => {
  const { store, cfg, markets, dataDir } = setup();
  const trading = new TradingEngine(store, {} as never, cfg as never, markets, async () => undefined);
  trading.updateHunting({
    market: {
      code: "BANK_CUP",
      huntBuyEnabled: false,
      huntSellEnabled: true,
      buyMaxRate: 925,
      sellMinRate: 1_025,
    },
  });

  const reopened = new MarketConfigService(dataDir, cfg as never, store);
  assert.equal(reopened.find("BANK_CUP")?.huntBuyEnabled, false);
  assert.equal(reopened.find("BANK_CUP")?.huntSellEnabled, true);
  assert.equal(reopened.find("BANK_CUP")?.buyMaxRate, 925);
  assert.equal(reopened.find("BANK_CUP")?.sellMinRate, 1_025);
  assert.ok(store.countAudit("hunting_control") > 0);
  store.close();
});

test("revalida la cacería de compra después de evaluar el riesgo", async () => {
  const { store, cfg, markets } = setup();
  const target: P2pOffer = { uuid: "stopped-before-apply", type: "sell", coin: "BANK_CUP", amount: 10, receive: 9_200, status: "open", User: { uuid: "peer" } };
  let applications = 0;
  let trading: TradingEngine;
  const qva = {
    listOffersPage: async (params: { type?: string }) => ({ offers: params.type === "sell" ? [target] : [], total: 1, currentPage: 1, perPage: 100 }),
    p2pAverages: async () => ({}),
    qusdBalance: async () => {
      trading.updateHunting({ buyRunning: false });
      return 100;
    },
    apply: async () => void (applications += 1),
  };
  trading = new TradingEngine(store, qva as never, cfg as never, markets, async () => undefined);

  const result = await trading.scan();

  assert.equal(result.action, "error");
  assert.equal(applications, 0);
  assert.equal(store.getOperation(target.uuid), undefined);
  store.close();
});

test("consulta hasta cien ofertas por lado y ordena por mejor tasa", async () => {
  const { store, cfg, markets } = setup();
  const queries: Record<string, unknown>[] = [];
  const qva = {
    listOffersPage: async (params: Record<string, unknown>) => {
      queries.push(params);
      return { offers: [], total: 0, currentPage: 1, perPage: 100 };
    },
    p2pAverages: async () => ({ BANK_CUP: { average_buy: 1_015, average_sell: 930 } }),
  };
  const trading = new TradingEngine(store, qva as never, cfg as never, markets, async () => undefined);

  await trading.scan();
  await trading.scan();

  assert.deepEqual(queries.map(({ take, type, orderBy, orderType }) => ({ take, type, orderBy, orderType })), [
    { take: 100, type: "sell", orderBy: "best_rate", orderType: "desc" },
    { take: 100, type: "buy", orderBy: "best_rate", orderType: "desc" },
    { take: 100, type: "sell", orderBy: "best_rate", orderType: "desc" },
  ]);
  store.close();
});

test("si la mejor compra queda bloqueada intenta la siguiente elegible", async () => {
  const { store, cfg, markets } = setup();
  const next = markets.current();
  next.risk.marketCooldownSeconds = 0;
  next.risk.counterpartyCooldownSeconds = 3_600;
  markets.save(next);
  store.createOperation({
    uuid: "previous-peer",
    offerType: "sell",
    coin: "BANK_CUP",
    amount: 1,
    receive: 925,
    rate: 925,
    state: "completed",
    autoApplied: true,
    cancelAt: null,
    createdAt: Date.now(),
    counterpartyId: "blocked-peer",
  });
  const offers: P2pOffer[] = [
    { uuid: "blocked-best", type: "sell", coin: "BANK_CUP", amount: 10, receive: 9_200, status: "open", User: { uuid: "blocked-peer" } },
    { uuid: "eligible-next", type: "sell", coin: "BANK_CUP", amount: 10, receive: 9_250, status: "open", User: { uuid: "new-peer" } },
  ];
  const applied: string[] = [];
  const qva = {
    listOffersPage: async (params: { type?: string }) => ({ offers: params.type === "sell" ? offers : [], total: offers.length, currentPage: 1, perPage: 100 }),
    p2pAverages: async () => ({ BANK_CUP: { average_buy: 1_015, average_sell: 930 } }),
    qusdBalance: async () => 100,
    apply: async (uuid: string) => void applied.push(uuid),
    sendChat: async () => undefined,
  };
  const trading = new TradingEngine(store, qva as never, cfg as never, markets, async () => undefined);

  const result = await trading.scan();

  assert.equal(result.action, "aplicada eligible-next");
  assert.deepEqual(applied, ["eligible-next"]);
  store.close();
});

test("el escaneo no muta si un límite global bloquea la compra automática", async () => {
  const { store, cfg, markets } = setup();
  const next = markets.current();
  next.risk.maxDailyAppliedQusd = 25;
  next.risk.marketCooldownSeconds = 0;
  markets.save(next);
  store.createOperation({
    uuid: "daily-volume-used",
    offerType: "sell",
    coin: "BANK_CUP",
    amount: 20,
    receive: 18_400,
    rate: 920,
    state: "completed",
    autoApplied: true,
    cancelAt: null,
    createdAt: Date.now(),
  });
  const target: P2pOffer = { uuid: "target-sell", type: "sell", coin: "BANK_CUP", amount: 10, receive: 9_200, status: "open", User: { uuid: "peer" } };
  let mutations = 0;
  const qva = {
    listOffersPage: async () => ({ offers: [target], total: 1, currentPage: 1, perPage: 20 }),
    p2pAverages: async () => ({ BANK_CUP: { average_buy: 1_015, average_sell: 930 } }),
    qusdBalance: async () => 100,
    apply: async () => void (mutations += 1),
  };
  const trading = new TradingEngine(store, qva as never, cfg as never, markets, async () => undefined);

  const result = await trading.scan();

  assert.equal(result.action, "bloqueada target-sell");
  assert.equal(mutations, 0);
  assert.equal(store.getOperation(target.uuid), undefined);
  store.close();
});

test("el cooldown persistido bloquea una segunda operación inmediata del mercado", async () => {
  const { store, cfg, markets } = setup();
  store.createOperation({
    uuid: "previous",
    offerType: "sell",
    coin: "BANK_CUP",
    amount: 1,
    receive: 920,
    rate: 920,
    state: "completed",
    autoApplied: true,
    cancelAt: null,
    createdAt: Date.now(),
    counterpartyId: "peer-previous",
  });
  const target: P2pOffer = { uuid: "target-cooldown", type: "sell", coin: "BANK_CUP", amount: 10, receive: 9_200, status: "open", User: { uuid: "peer-new" } };
  let mutations = 0;
  const qva = {
    listOffersPage: async () => ({ offers: [target], total: 1, currentPage: 1, perPage: 20 }),
    p2pAverages: async () => ({ BANK_CUP: { average_buy: 1_015, average_sell: 930 } }),
    qusdBalance: async () => 100,
    apply: async () => void (mutations += 1),
  };
  const trading = new TradingEngine(store, qva as never, cfg as never, markets, async () => undefined);

  const result = await trading.scan();

  assert.equal(result.action, "bloqueada target-cooldown");
  assert.equal(mutations, 0);
  store.close();
});

test("pausa automáticamente al alcanzar errores consecutivos configurados", async () => {
  const { store, cfg, markets } = setup();
  const qva = {
    listOffersPage: async () => { throw new Error("fallo de lectura"); },
  };
  const trading = new TradingEngine(store, qva as never, cfg as never, markets, async () => undefined);

  await trading.scan();
  await trading.scan();
  await trading.scan();

  assert.equal(store.get("consecutive_errors"), "3");
  assert.equal(trading.isPaused(), true);
  store.close();
});
