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
  const dataDir = mkdtempSync(join(tmpdir(), "qva-cancel-race-"));
  const store = new Store(dataDir);
  const cfg = { dataDir, initialUsdFiatBalance: 0, buyQusdMaxRate: 930,
    sellQusdMinRate: 1000, buyQusdUsdMaxRate: 1.06, sellQusdUsdMinRate: 1.12,
    cupPurchaseMaxQusd: 150, maxOpenOwnOffers: 10, priceGuardPercent: 15,
    qusdReserve: 0, realTradingAllowed: true, autoCancelMs: 600000,
    offerRefreshIntervalMs: 300000, paymentDetails: { BANK_CUP: [], BANDECPREPAGO: [] } };
  const markets = new MarketConfigService(dataDir, cfg as never, store);
  const config = markets.current();
  config.risk.reviewedAt = Date.now();
  config.markets.forEach(m => { m.active = m.code === "BANK_CUP"; });
  markets.save(config);
  store.set("fiat_balance:BANK_CUP", "100000");
  store.set("paused", "false");
  store.set("mode", "real");
  store.recordMarketObservation({ coin: "BANK_CUP", medianSell: 930, openOffers: 20, eligible: 0 });
  return { dataDir, store, cfg, markets };
}

for (const reference of ["missing", "stale", "future"] as const) {
  test(`mediana ${reference} no permite la toma rápida ni se rejuvenece por otro mercado`, async t => {
    const { dataDir, store, cfg, markets } = setup();
    t.after(() => store.close());
    const db = new DatabaseSync(join(dataDir, "qvaapply.sqlite"));
    if (reference === "missing") db.prepare("DELETE FROM market_observations WHERE coin='BANK_CUP'").run();
    else db.prepare("UPDATE market_observations SET created_at=? WHERE coin='BANK_CUP'").run(Date.now() + (reference === "future" ? 60000 : -301000));
    db.close();
    store.recordMarketObservation({ coin: "BANDECPREPAGO", medianSell: 1.06, openOffers: 10, eligible: 0 });
    let applies = 0;
    const trading = new TradingEngine(store, { apply: async () => { applies++; } } as never, cfg as never, markets, async () => undefined);
    const result = await trading.ingestMarketOffer({ uuid: `median-${reference}`, type: "sell", coin: "BANK_CUP", amount: 10, receive: 9200, status: "open" });
    assert.equal(applies, 0);
    assert.match(result.action ?? "", /mediana reciente no disponible/i);
    assert.equal(result.candidates, 0);
  });
}

for (const type of ["sell", "buy"] as const) {
  test(`reaplicación manual explícita ${type} actualiza una cancelada sin retirar exclusión automática`, async t => {
    const { store, cfg, markets } = setup();
    t.after(() => store.close());
    const uuid = `manual-reactivation-${type}`;
    store.createOperation({ uuid, offerType: type, coin: "BANK_CUP", amount: 5, receive: 5000,
      rate: 1000, state: "cancelled", autoApplied: true, cancelAt: null, createdAt: Date.now() });
    store.excludeAutomaticReapplyAfterManualCancel(uuid);
    let applies = 0;
    const offer: P2pOffer = { uuid, type, coin: "BANK_CUP", amount: 10, receive: type === "sell" ? 9200 : 10200, status: "open" };
    const trading = new TradingEngine(store, {
      getOffer: async () => offer, apply: async () => { applies++; },
      sendChat: async () => ({}), qusdBalance: async () => 100,
    } as never, cfg as never, markets, async () => undefined);
    await trading.applyManually(uuid);
    assert.equal(applies, 1);
    assert.equal(store.getOperation(uuid)?.state, "applied");
    assert.equal(store.getOperation(uuid)?.amount, 10);
    assert.equal(store.getOperation(uuid)?.receive, offer.receive);
    assert.equal(store.isExcludedAfterManualCancel(uuid), true);
    await trading.ingestMarketOffer(offer, Date.now(), "p2p.reopened");
    assert.equal(applies, 1);
  });
}

test("una cancelada con movimientos de dinero nunca se reactiva manualmente", async t => {
  const { store, cfg, markets } = setup();
  t.after(() => store.close());
  const uuid = "manual-reactivation-with-money";
  store.createOperation({ uuid, offerType: "sell", coin: "BANK_CUP", amount: 5, receive: 5000,
    rate: 1000, state: "cancelled", autoApplied: true, cancelAt: null, createdAt: Date.now() });
  store.recordFiatMovement(uuid, "BANK_CUP", "debit", 5000, "test");
  let calls = 0;
  const trading = new TradingEngine(store, { apply: async () => { calls++; }, getOffer: async () => { calls++; } } as never, cfg as never, markets, async () => undefined);
  await assert.rejects(trading.applyManually(uuid), /movimientos de dinero/);
  assert.equal(calls, 0);
  assert.equal(store.getOperation(uuid)?.state, "cancelled");
});

test("precio sospechosamente bajo se bloquea usando la mediana local, sin consultas remotas", async t => {
  const { store, cfg, markets } = setup();
  t.after(() => store.close());
  let applies = 0;
  const trading = new TradingEngine(store, {
    apply: async () => { applies++; return {}; },
    p2pAverages: async () => { throw new Error("no consultar medianas por oferta"); },
    getOffer: async () => { throw new Error("no consultar detalle por oferta fresca"); },
  } as never, cfg as never, markets, async () => undefined);
  const result = await trading.ingestMarketOffer({ uuid: "suspicious-cheap", type: "sell", coin: "BANK_CUP", amount: 5, receive: 5, status: "open" });
  assert.equal(applies, 0);
  assert.match(result.action ?? "", /mediana|sospechoso/i);
  assert.equal(store.decisionEvents({ decision: "blocked", status: "pending" }).pending, 1);
});

test("venta rápida vuelve a comprobar el mínimo vigente después de esperar el saldo", async t => {
  const { store, cfg, markets } = setup();
  t.after(() => store.close());
  let ready!: () => void;
  const waiting = new Promise<void>(resolve => { ready = resolve; });
  let release!: (value: number) => void;
  const balance = new Promise<number>(resolve => { release = resolve; });
  let applies = 0;
  const trading = new TradingEngine(store, {
    qusdBalance: async () => { ready(); return balance; },
    apply: async () => { applies++; return {}; },
    sendChat: async () => ({}),
  } as never, cfg as never, markets, async () => undefined);
  const offer: P2pOffer = { uuid: "price-changed", type: "buy", coin: "BANK_CUP", amount: 10, receive: 10100, status: "open" };
  const run = trading.ingestMarketOffer(offer);
  await waiting;
  const changed = markets.current();
  changed.markets.find(m => m.code === "BANK_CUP")!.sellMinRate = 1020;
  markets.save(changed);
  release(100);
  const result = await run;
  assert.equal(applies, 0, "no aplicar usando el mínimo anterior a una espera asíncrona");
  assert.equal(store.getOperation(offer.uuid), undefined);
  assert.match(result.action ?? "", /tasa|mínimo|precio/i);
});

test("una exclusión registrada mientras espera saldo impide la aplicación automática", async t => {
  const { store, cfg, markets } = setup();
  t.after(() => store.close());
  let ready!: () => void;
  const waiting = new Promise<void>(resolve => { ready = resolve; });
  let release!: (value: number) => void;
  const balance = new Promise<number>(resolve => { release = resolve; });
  let applies = 0;
  const trading = new TradingEngine(store, {
    qusdBalance: async () => { ready(); return balance; },
    apply: async () => { applies++; },
  } as never, cfg as never, markets, async () => undefined);
  const uuid = "excluded-during-balance";
  const run = trading.ingestMarketOffer({ uuid, type: "buy", coin: "BANK_CUP", amount: 10, receive: 10200, status: "open" });
  await waiting;
  store.excludeAutomaticReapplyAfterManualCancel(uuid);
  release(100);
  await run;
  assert.equal(applies, 0);
});

for (const type of ["buy", "sell"] as const) {
  for (const amount of [Number.NaN, Number.POSITIVE_INFINITY]) {
    test(`vía rápida rechaza importes no finitos: ${type} ${amount}`, async t => {
      const { store, cfg, markets } = setup();
      t.after(() => store.close());
      let applies = 0;
      const trading = new TradingEngine(store, {
        qusdBalance: async () => 100,
        apply: async () => { applies++; return {}; },
        sendChat: async () => ({}),
      } as never, cfg as never, markets, async () => undefined);
      const result = await trading.ingestMarketOffer({ uuid: `invalid-${type}-${amount}`, type, coin: "BANK_CUP", amount, receive: 9200, status: "open" });
      assert.equal(applies, 0);
      assert.equal(result.candidates, 0);
    });
  }
}
