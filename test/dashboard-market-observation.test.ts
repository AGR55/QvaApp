import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DashboardReadModel } from "../src/dashboard.js";
import { MarketConfigService } from "../src/market-config.js";
import { Store } from "../src/store.js";

test("guarda mediana, tamaño de muestra y fecha por lado del mercado", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "qvaapply-market-observation-"));
  const store = new Store(dataDir);
  const config = {
    dataDir,
    initialUsdFiatBalance: 0,
    buyQusdMaxRate: 930,
    sellQusdMinRate: 980,
    buyQusdUsdMaxRate: 1.06,
    sellQusdUsdMinRate: 1.12,
    cupPurchaseMaxQusd: 150,
    maxOpenOwnOffers: 10,
    priceGuardPercent: 15,
    qusdReserve: 0,
    realTradingAllowed: true,
    paymentDetails: { BANK_CUP: [], BANDECPREPAGO: [] },
  };
  const markets = new MarketConfigService(dataDir, config as never, store);
  let inspections = 0;
  let balanceReads = 0;
  const trading = {
    operationalState: () => ({ fiat: {} }),
    qusdBalance: async () => {
      balanceReads += 1;
      return 42;
    },
    inspectMarketSide: async (_coin: string, side: "buy" | "sell") => {
      inspections += 1;
      return {
        scannedAt: 1_800_000_000_000,
        total: 3,
        items: [920, 940, 930].map((value, index) => ({
          offer: {
            uuid: side + "-" + index,
            type: side,
            coin: "BANK_CUP",
            amount: 1,
            receive: value,
            status: "open",
          },
          rate: value,
          decision: "ignored",
          reason: "test",
        })),
      };
    },
  };
  const dashboard = new DashboardReadModel(
    trading as never,
    {} as never,
    config as never,
    store,
    markets,
  );

  const [result, coalesced] = await Promise.all([
    dashboard.refreshMarketSide("BANK_CUP", "buy"),
    dashboard.refreshMarketSide("BANK_CUP", "buy"),
  ]);
  const saved = store.loadRemoteResource<{
    median?: number;
    samples: number;
    total: number;
  }>("market-side:BANK_CUP:buy");

  assert.equal(result.data.median, 930);
  assert.equal(coalesced, result);
  assert.equal(inspections, 1);
  assert.equal(saved?.data.median, 930);
  assert.equal(saved?.data.samples, 3);
  assert.equal(saved?.data.total, 3);
  assert.equal(saved?.updatedAt, 1_800_000_000_000);
  assert.equal(dashboard.marketSideObservations("BANK_CUP").buy?.updatedAt, saved?.updatedAt);

  const [balance, duplicateBalance] = await Promise.all([
    dashboard.refreshBalance(),
    dashboard.refreshBalance(),
  ]);
  assert.equal(balance, duplicateBalance);
  assert.equal(balanceReads, 1);
  assert.equal(balance.data, 42);
});

test("actualiza las medianas de web y Telegram sin abrir pantallas ni ejecutar cacerías", async t => {
  const dataDir = mkdtempSync(join(tmpdir(), "qvaapply-background-observation-"));
  const store = new Store(dataDir);
  t.after(() => store.close());
  const config = { dataDir, initialUsdFiatBalance: 0, buyQusdMaxRate: 930, sellQusdMinRate: 980,
    buyQusdUsdMaxRate: 1.06, sellQusdUsdMinRate: 1.12, cupPurchaseMaxQusd: 150,
    maxOpenOwnOffers: 10, priceGuardPercent: 15, qusdReserve: 0, realTradingAllowed: true,
    paymentDetails: { BANK_CUP: [], BANDECPREPAGO: [] } };
  const markets = new MarketConfigService(dataDir, config as never, store);
  const next = markets.current();
  for (const market of next.markets) market.active = market.code === "BANK_CUP";
  markets.save(next);
  const old = Date.now() - 101 * 3_600_000;
  store.saveRemoteResource("averages", { BANK_CUP: { median_buy: 10, median_sell: 20 } }, old);
  store.saveRemoteResource("market-side:BANK_CUP:sell", { median: 20, samples: 3, total: 3, offers: [] }, old);
  const calls: string[] = [];
  const trading = {
    inspectMarketSide: async (coin: string, side: "buy" | "sell") => {
      calls.push(`${coin}:${side}`);
      return { scannedAt: Date.now(), total: 3,
        average: { [side === "buy" ? "median_buy" : "median_sell"]: side === "buy" ? 1000 : 930 },
        items: [920, 940, 930].map((rate, index) => ({ offer: { uuid: `${side}-${index}`, type: side,
          coin, amount: 1, receive: rate, status: "open" }, rate, decision: "ignored", reason: "observación" })) };
    },
  };
  const dashboard = new DashboardReadModel(trading as never, {} as never, config as never, store, markets);
  await dashboard.refreshNextMarketObservation();
  assert.deepEqual(calls, ["BANK_CUP:sell"], "cada turno solo hace una lectura de un lado");
  assert.equal(store.loadRemoteResource<{ BANK_CUP: { median_sell: number; median_buy: number } }>("averages")?.data.BANK_CUP.median_sell, 930);
  assert.equal(store.loadRemoteResource<{ BANK_CUP: { median_buy: number } }>("averages")?.data.BANK_CUP.median_buy, 10,
    "no se reemplaza la observación del otro lado antes de leerlo");
  assert.ok(dashboard.marketSideObservations("BANK_CUP").sell!.updatedAt > old);
  assert.equal(store.recentSellMedian("BANK_CUP"), 930, "la referencia segura se renueva con la muestra leída");
  await dashboard.refreshNextMarketObservation();
  assert.deepEqual(calls, ["BANK_CUP:sell", "BANK_CUP:buy"]);
  assert.equal(store.loadRemoteResource<{ BANK_CUP: { median_buy: number } }>("averages")?.data.BANK_CUP.median_buy, 1000);
  await dashboard.refreshNextMarketObservation();
  assert.equal(calls.length, 2, "las lecturas frescas no generan consultas adicionales");
});

test("una muestra insuficiente no rejuvenece la mediana de seguridad anterior", async t => {
  const dataDir = mkdtempSync(join(tmpdir(), "qvaapply-sparse-observation-"));
  const store = new Store(dataDir);
  t.after(() => store.close());
  const config = { dataDir, initialUsdFiatBalance: 0, buyQusdMaxRate: 930, sellQusdMinRate: 980,
    buyQusdUsdMaxRate: 1.06, sellQusdUsdMinRate: 1.12, cupPurchaseMaxQusd: 150,
    maxOpenOwnOffers: 10, priceGuardPercent: 15, qusdReserve: 0, realTradingAllowed: true,
    paymentDetails: { BANK_CUP: [], BANDECPREPAGO: [] } };
  const markets = new MarketConfigService(dataDir, config as never, store);
  store.saveRemoteResource("averages", { BANK_CUP: { median_sell: 930 } }, Date.now() - 101 * 3_600_000);
  const trading = { inspectMarketSide: async () => ({ scannedAt: Date.now(), total: 1,
    items: [{ offer: { uuid: "single", type: "sell", coin: "BANK_CUP", amount: 1, receive: 1,
      status: "open" }, rate: 1, decision: "blocked", reason: "muestra insuficiente" }] }) };
  const dashboard = new DashboardReadModel(trading as never, {} as never, config as never, store, markets);
  await dashboard.refreshMarketSide("BANK_CUP", "sell");
  assert.equal(store.recentSellMedian("BANK_CUP"), undefined);
  assert.equal(store.loadRemoteResource<{ BANK_CUP: { median_sell?: number } }>("averages")?.data.BANK_CUP.median_sell, undefined);
});
