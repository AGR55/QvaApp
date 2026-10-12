import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { MarketConfigService } from "../src/market-config.js";
import { Store } from "../src/store.js";
import { TradingEngine } from "../src/trading.js";
import type { P2pOffer } from "../src/types.js";

function setup() {
  const dataDir = mkdtempSync(join(tmpdir(), "qvaapply-manual-cancel-"));
  const store = new Store(dataDir);
  const cfg = {
    dataDir, initialUsdFiatBalance: 0, buyQusdMaxRate: 930,
    sellQusdMinRate: 1_000, buyQusdUsdMaxRate: 1.06,
    sellQusdUsdMinRate: 1.12, cupPurchaseMaxQusd: 150,
    maxOpenOwnOffers: 10, priceGuardPercent: 15, qusdReserve: 0,
    realTradingAllowed: true, autoCancelMs: 600_000,
    offerRefreshIntervalMs: 300_000,
    paymentDetails: { BANK_CUP: [], BANDECPREPAGO: [] },
  };
  const markets = new MarketConfigService(dataDir, cfg as never, store);
  const config = markets.current();
  config.risk.reviewedAt = Date.now();
  for (const market of config.markets) market.active = market.code === "BANK_CUP";
  config.markets[0]!.fiatBalance = 100_000;
  markets.save(config);
  store.set("fiat_balance:BANK_CUP", "100000");
  store.set("paused", "false");
  store.set("mode", "real");
  store.recordMarketObservation({ coin: "BANK_CUP", medianSell: 930, openOffers: 20, eligible: 0 });
  return { dataDir, store, cfg, markets };
}

const rejectedOffer: P2pOffer = {
  uuid: "manual-cancelled-offer", type: "sell", coin: "BANK_CUP",
  amount: 10, receive: 9_200, status: "open", User: { uuid: "peer" },
};

test("manual cancellation excludes repeated reopen events across restart", async () => {
  const { dataDir, store, cfg, markets } = setup();
  store.createOperation({
    uuid: rejectedOffer.uuid, offerType: "sell", coin: "BANK_CUP",
    amount: 10, receive: 9_200, rate: 920, state: "applied",
    autoApplied: true, cancelAt: null, createdAt: Date.now(),
  });
  let applications = 0;
  const qva = {
    getOffer: async () => ({ ...rejectedOffer, status: "processing" }),
    cancel: async () => undefined,
    apply: async () => { applications += 1; },
  };
  const trading = new TradingEngine(store, qva as never, cfg as never, markets, async () => undefined);
  await trading.cancel(rejectedOffer.uuid);

  for (let count = 0; count < 3; count++) {
    await trading.ingestMarketOffer(rejectedOffer, Date.now(), "p2p.reopened");
  }
  assert.equal(applications, 0, "reopened cancelled offer must never be automatically applied");
  assert.equal(store.getOperation(rejectedOffer.uuid)?.state, "cancelled");
  store.close();

  const restartedStore = new Store(dataDir);
  const restartedMarkets = new MarketConfigService(dataDir, cfg as never, restartedStore);
  const restartedTrading = new TradingEngine(restartedStore, {
    apply: async () => { applications += 1; },
  } as never, cfg as never, restartedMarkets, async () => undefined);
  await restartedTrading.ingestMarketOffer(rejectedOffer, Date.now(), "p2p.reopened");
  assert.equal(applications, 0, "manual cancel exclusion must survive process restart");
  restartedStore.close();
});

test("manual cancellation remains excluded when the remote cancellation fails", async () => {
  const { store, cfg, markets } = setup();
  store.createOperation({
    uuid: rejectedOffer.uuid, offerType: "sell", coin: "BANK_CUP",
    amount: 10, receive: 9_200, rate: 920, state: "applied",
    autoApplied: true, cancelAt: null, createdAt: Date.now(),
  });
  let applications = 0;
  const trading = new TradingEngine(store, {
    getOffer: async () => { throw new Error("remote timeout"); },
    cancel: async () => undefined,
    apply: async () => { applications += 1; },
  } as never, cfg as never, markets, async () => undefined);
  await assert.rejects(trading.cancel(rejectedOffer.uuid), /remote timeout/);
  await trading.ingestMarketOffer(rejectedOffer, Date.now(), "p2p.reopened");
  assert.equal(applications, 0);
  assert.equal(store.countAudit("manual_cancel_auto_exclusion"), 1);
  store.close();
});

test("una operación pagada o completada no se cancela aunque quede un botón antiguo", async () => {
  for (const state of ["paid", "completed"] as const) {
    const { store, cfg, markets } = setup();
    store.createOperation({ uuid: `terminal-${state}`, offerType: "sell", coin: "BANK_CUP",
      amount: 10, receive: 9200, rate: 920, state, autoApplied: true,
      cancelAt: null, createdAt: Date.now() });
    let remoteReads = 0, cancels = 0;
    const trading = new TradingEngine(store, {
      getOffer: async () => { remoteReads++; return { ...rejectedOffer, status: "processing" }; },
      cancel: async () => { cancels++; },
    } as never, cfg as never, markets, async () => undefined);
    await assert.rejects(trading.cancel(`terminal-${state}`), /ya no se puede cancelar/);
    assert.equal(remoteReads, 0);
    assert.equal(cancels, 0);
    store.close();
  }
});

test("el estado terminal remoto impide cancelar una operación local desactualizada", async () => {
  const { store, cfg, markets } = setup();
  store.createOperation({ uuid: "remote-completed", offerType: "sell", coin: "BANK_CUP",
    amount: 10, receive: 9200, rate: 920, state: "applied", autoApplied: true,
    cancelAt: null, createdAt: Date.now() });
  let cancels = 0;
  const trading = new TradingEngine(store, {
    getOffer: async () => ({ ...rejectedOffer, status: "completed" }),
    cancel: async () => { cancels++; },
  } as never, cfg as never, markets, async () => undefined);
  await assert.rejects(trading.cancel("remote-completed"), /estado completed/);
  assert.equal(cancels, 0);
  store.close();
});

test("marcar pago envía el ID a QvaPay solo si la operación remota sigue activa", async () => {
  const { store, cfg, markets } = setup();
  store.createOperation({ uuid: "payable", offerType: "sell", coin: "BANK_CUP",
    amount: 10, receive: 9200, rate: 920, state: "applied", autoApplied: true,
    cancelAt: null, createdAt: Date.now() });
  const sent: string[] = [];
  let remoteStatus = "completed";
  const trading = new TradingEngine(store, {
    getOffer: async () => ({ ...rejectedOffer, status: remoteStatus }),
    markPaid: async (_uuid: string, reference: string) => { sent.push(reference); },
  } as never, cfg as never, markets, async () => undefined);
  await assert.rejects(trading.markPaid("payable", "TX-1"), /estado completed/);
  assert.deepEqual(sent, []);
  remoteStatus = "processing";
  await trading.markPaid("payable", "TX-1");
  assert.deepEqual(sent, ["TX-1"]);
  assert.equal(store.getOperation("payable")?.state, "paid");
  store.close();
});

test("un pago incierto no vuelve a enviarse al escribir otro ID", async () => {
  const { store, cfg, markets } = setup();
  store.createOperation({ uuid: "pending-payment", offerType: "sell", coin: "BANK_CUP",
    amount: 10, receive: 9200, rate: 920, state: "applied", autoApplied: true,
    cancelAt: null, createdAt: Date.now() });
  store.createMutationIntent({ intentId: "uncertain-paid", operationUuid: "pending-payment",
    kind: "paid", request: { reference: "TX-1" } });
  store.updateMutationIntent("uncertain-paid", "uncertain");
  let sent = 0;
  const trading = new TradingEngine(store, {
    getOffer: async () => ({ ...rejectedOffer, status: "processing" }),
    markPaid: async () => { sent++; }, cancel: async () => { sent++; },
  } as never, cfg as never, markets, async () => undefined);
  await assert.rejects(trading.markPaid("pending-payment", "TX-2"), /pendiente de conciliación/);
  await assert.rejects(trading.cancel("pending-payment"), /pendiente de conciliación/);
  assert.equal(sent, 0);
  store.close();
});

test("manual cancel exclusion also blocks the fast automatic sale lane", async () => {
  const { store, cfg, markets } = setup();
  const cancelledBuyOffer: P2pOffer = {
    uuid: "manual-cancelled-buy-offer", type: "buy", coin: "BANK_CUP",
    amount: 10, receive: 10_500, status: "open", User: { uuid: "peer" },
  };
  store.createOperation({
    uuid: cancelledBuyOffer.uuid, offerType: "buy", coin: "BANK_CUP",
    amount: 10, receive: 10_500, rate: 1_050, state: "applied",
    autoApplied: false, cancelAt: null, createdAt: Date.now(),
  });
  let applications = 0;
  const trading = new TradingEngine(store, {
    getOffer: async () => ({ ...cancelledBuyOffer, status: "processing" }),
    cancel: async () => undefined,
    qusdBalance: async () => 100,
    apply: async () => { applications += 1; },
  } as never, cfg as never, markets, async () => undefined);
  await trading.cancel(cancelledBuyOffer.uuid);
  const reopened = await trading.ingestMarketOffer(cancelledBuyOffer, Date.now(), "p2p.reopened");
  assert.equal(applications, 0);
  assert.match(reopened.action ?? "", /cancelación manual/);
  store.close();
});

test("historical manual cancel audit entries are backfilled once", () => {
  const { dataDir, store } = setup();
  store.audit("cancel", "Cancelada por el usuario", "legacy-cancelled-offer");
  store.audit("auto_cancel", "Venció el plazo", "legacy-auto-cancelled");
  store.close();
  const db = new DatabaseSync(join(dataDir, "qvaapply.sqlite"));
  db.prepare("DELETE FROM schema_migrations WHERE version >= 22").run();
  db.prepare("DELETE FROM manual_cancel_exclusions WHERE offer_uuid = ?").run("legacy-cancelled-offer");
  db.close();

  const migrated = new Store(dataDir);
  assert.equal(migrated.isExcludedAfterManualCancel("legacy-cancelled-offer"), true);
  assert.equal(migrated.isExcludedAfterManualCancel("legacy-auto-cancelled"), false);
  assert.equal(migrated.schemaVersion(), 26);
  migrated.close();
});

test("an unrelated eligible offer remains automatically applicable", async () => {
  const { store, cfg, markets } = setup();
  let applications = 0;
  const trading = new TradingEngine(store, {
    apply: async () => { applications += 1; },
  } as never, cfg as never, markets, async () => undefined);
  const result = await trading.ingestMarketOffer({ ...rejectedOffer, uuid: "eligible-neighbor" }, Date.now(), "p2p.reopened");
  assert.equal(applications, 1);
  assert.match(result.action ?? "", /aplicada/);
  store.close();
});
