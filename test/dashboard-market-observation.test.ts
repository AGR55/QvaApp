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
