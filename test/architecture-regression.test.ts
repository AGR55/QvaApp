import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DashboardService } from "../src/dashboard.js";
import { MarketConfigService } from "../src/market-config.js";
import { Store } from "../src/store.js";
import { TradingService } from "../src/trading.js";

function runtimeConfig(dataDir: string) {
  return {
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
}

test("los cambios de estrategia alteran inmediatamente la clasificación", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "qvaapply-strategy-source-"));
  const store = new Store(dataDir);
  const cfg = runtimeConfig(dataDir);
  const markets = new MarketConfigService(dataDir, cfg as never, store);
  store.set("fiat_balance:BANK_CUP", "10000");
  const qva = {
    listOffersPage: async () => ({
      offers: [
        {
          uuid: "offer",
          type: "sell",
          coin: "BANK_CUP",
          amount: 10,
          receive: 9_200,
          status: "open",
        },
      ],
      total: 1,
      currentPage: 1,
      perPage: 20,
    }),
    p2pAverages: async () => ({ BANK_CUP: { average_sell: 930 } }),
  };
  const trading = new TradingService(
    store,
    qva as never,
    cfg as never,
    markets,
    async () => undefined,
  );

  trading.updateStrategy({ buyMaxCup: 900 });

  const item = (await trading.inspectMarket("BANK_CUP")).items[0];
  assert.equal(item?.decision, "ignored");
  assert.match(item?.reason ?? "", /900 CUP\/QUSD/);
});

test("el límite de ofertas se lee de la configuración persistida", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "qvaapply-offer-limit-source-"));
  const store = new Store(dataDir);
  const cfg = runtimeConfig(dataDir);
  const markets = new MarketConfigService(dataDir, cfg as never, store);
  const next = markets.current();
  next.maxOpenOffers = 1;
  next.markets.find((market) => market.code === "BANK_CUP")!.paymentDetails = [
    { name: "cuenta", value: "123" },
  ];
  markets.save(next);
  store.set("mode", "real");
  const qva = {
    listOffers: async () => [
      {
        uuid: "existing",
        type: "buy",
        coin: "BANK_CUP",
        amount: 5,
        receive: 4_500,
        status: "open",
      },
    ],
    createOffer: async () => {
      throw new Error("no debe crear");
    },
  };
  const trading = new TradingService(
    store,
    qva as never,
    cfg as never,
    markets,
    async () => undefined,
  );

  await assert.rejects(
    () => trading.createOwnOffer("BANK_CUP", "sell", 5, 980),
    /máximo de 1 ofertas abiertas/,
  );
});

test("el dashboard persiste una sola observación completa por mercado", async () => {
  const dataDir = mkdtempSync(
    join(tmpdir(), "qvaapply-dashboard-observation-"),
  );
  const store = new Store(dataDir);
  const cfg = runtimeConfig(dataDir);
  const markets = new MarketConfigService(dataDir, cfg as never, store);
  const averages = Object.fromEntries(
    markets
      .markets()
      .map((market) => [market.code, { average_buy: 980, average_sell: 930 }]),
  );
  const qva = {
    listOffers: async () => [],
    listOffersPage: async (params: { coin: string }) => ({
      offers: [
        {
          uuid: `offer-${params.coin}`,
          type: "sell",
          coin: params.coin,
          amount: 1,
          receive: 930,
          status: "open",
        },
      ],
      total: 1,
      currentPage: 1,
      perPage: 20,
    }),
    p2pAverages: async () => averages,
    qusdBalance: async () => 10,
    listTransactions: async () => [],
  };
  const trading = new TradingService(
    store,
    qva as never,
    cfg as never,
    markets,
    async () => undefined,
  );
  trading.setFiatBalance("BANK_CUP", 10_000);
  const dashboard = new DashboardService(
    trading,
    qva as never,
    cfg as never,
    store,
    markets,
  );

  await dashboard.snapshot();

  const history = store.marketHistory(0, "BANK_CUP");
  assert.equal(history.length, 1);
  assert.equal(history[0]?.openOffers, 1);
  assert.equal(history[0]?.eligible, 1);
});
