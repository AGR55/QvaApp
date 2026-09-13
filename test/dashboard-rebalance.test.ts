import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DashboardReadModel, offerView } from "../src/dashboard.js";
import { MarketConfigService } from "../src/market-config.js";
import { QvaMutationUncertainError } from "../src/qvapay.js";
import { Store } from "../src/store.js";

const runtime = {
  qusdReserve: 0,
  maxOpenOwnOffers: 10,
  buyQusdMaxRate: 930,
  sellQusdMinRate: 980,
  buyQusdUsdMaxRate: 1.06,
  sellQusdUsdMinRate: 1.12,
  cupPurchaseMaxQusd: 25,
  initialUsdFiatBalance: 110,
  paymentDetails: { BANK_CUP: [], BANDECPREPAGO: [] },
};

function setup(edit: () => Promise<void> = async () => undefined) {
  const dataDir = mkdtempSync(join(tmpdir(), "qvaapply-dashboard-rebalance-"));
  const store = new Store(dataDir);
  const markets = new MarketConfigService(dataDir, runtime as never, store);
  let remote = {
    uuid: "buy-1",
    type: "buy" as const,
    coin: "BANK_CUP",
    amount: 20,
    receive: 18_600,
    status: "open",
  };
  store.saveRemoteResource("own-offers", [offerView(remote)]);
  let listCalls = 0;
  const trading = {
    markets: () => markets.markets(),
    strategy: () => ({ reserve: 0, buyMax: { BANK_CUP: 930 }, sellMin: { BANK_CUP: 980 } }),
    operationalState: () => ({ fiat: { BANK_CUP: 10_000 }, active: 0, paused: false, refresh: true }),
    editOwnOfferFromSnapshot: async (_offer: unknown, amount: number) => {
      await edit();
      remote = { ...remote, amount, receive: amount * 930 };
    },
    cancelOwnOfferFromSnapshot: async () => undefined,
    reconcilePendingStandaloneMutations: async () => 0,
    listOwnOffers: async () => {
      listCalls += 1;
      return [remote];
    },
  };
  const dashboard = new DashboardReadModel(
    trading as never,
    {} as never,
    runtime as never,
    store,
    markets,
  );
  return { dashboard, store, listCalls: () => listCalls };
}

test("el reajuste responde con un trabajo y evita releer ofertas por cada edición", async () => {
  const { dashboard, store, listCalls } = setup();
  const job = dashboard.startBudgetRebalance([{ uuid: "buy-1", amount: 10 }]);
  assert.equal(job.state, "pending");
  await dashboard.runBudgetRebalances();
  assert.equal(store.rebalanceJob(job.id)?.state, "completed");
  assert.equal(listCalls(), 1, "solo refresca la proyección al finalizar");
  store.close();
});

test("una edición incierta detiene el trabajo para conciliación sin repetirla", async () => {
  let attempts = 0;
  const { dashboard, store } = setup(async () => {
    attempts += 1;
    throw new QvaMutationUncertainError("edit", new Error("timeout"));
  });
  const job = dashboard.startBudgetRebalance([{ uuid: "buy-1", amount: 10 }]);
  await dashboard.runBudgetRebalances();
  assert.equal(store.rebalanceJob(job.id)?.state, "reconciliation_required");
  await dashboard.runBudgetRebalances();
  assert.equal(attempts, 1);
  store.close();
});
