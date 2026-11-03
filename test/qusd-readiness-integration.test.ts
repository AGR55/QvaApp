import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { MarketConfigService } from "../src/market-config.js";
import { Store } from "../src/store.js";
import { TradingEngine } from "../src/trading.js";
import type { P2pOffer } from "../src/types.js";

function gate() {
  let release!: () => void, enter!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const entered = new Promise<void>(resolve => { enter = resolve; });
  return { blocked, entered, enter, release };
}

function setup(gateway: object) {
  const dataDir = mkdtempSync(join(tmpdir(), "qva-qusd-readiness-"));
  const store = new Store(dataDir);
  const cfg = { dataDir, initialUsdFiatBalance: 0, buyQusdMaxRate: 930, sellQusdMinRate: 1000,
    buyQusdUsdMaxRate: 1.06, sellQusdUsdMinRate: 1.12, cupPurchaseMaxQusd: 150,
    maxOpenOwnOffers: 10, priceGuardPercent: 15, qusdReserve: 0, realTradingAllowed: true,
    autoCancelMs: 600000, offerRefreshIntervalMs: 300000, paymentDetails: { BANK_CUP: [], BANDECPREPAGO: [] } };
  const markets = new MarketConfigService(dataDir, cfg as never, store);
  const config = markets.current();
  config.risk.reviewedAt = Date.now();
  config.markets.forEach(market => { market.active = market.code === "BANK_CUP"; });
  markets.save(config);
  store.set("paused", "false"); store.set("mode", "real");
  store.recordMarketObservation({ coin: "BANK_CUP", medianSell: 930, openOffers: 20, eligible: 0 });
  const trading = new TradingEngine(store, gateway as never, cfg as never, markets, async () => undefined);
  return { store, markets, trading, async close() { await new Promise(resolve => setImmediate(resolve)); store.close(); rmSync(dataDir, { recursive: true, force: true }); } };
}

function offer(uuid: string): P2pOffer {
  return { uuid, type: "buy", coin: "BANK_CUP", amount: 10, receive: 11000, status: "open", only_vip: false };
}

test("la lectura urgente avanza durante calentamiento lento y la respuesta anterior no sobrescribe saldo nuevo", async t => {
  const hold = gate();
  let reads = 0, posts = 0;
  const state = setup({ qusdBalance: async (options?: { priority?: boolean }) => {
    reads++;
    if (!options?.priority) { hold.enter(); await hold.blocked; return 100; }
    return 0;
  }, apply: async () => { posts++; }, sendChat: async () => ({}) });
  t.after(() => state.close());
  const warm = state.trading.refreshHuntingQusdBalance();
  try {
    await hold.entered;
    let finished = false;
    const decision = state.trading.ingestMarketOffer(offer("urgent-first")).then(result => { finished = true; return result; });
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(finished, true, "la consulta urgente no espera a la lectura en segundo plano");
    assert.match((await decision).action ?? "", /insuficiente/i);
    assert.equal(reads, 2);
    hold.release(); await warm;
    assert.match((await state.trading.ingestMarketOffer(offer("urgent-second"))).action ?? "", /insuficiente/i);
    assert.equal(posts, 0);
    assert.equal(reads, 2, "la respuesta tardía no reemplaza el saldo urgente");
  } finally { hold.release(); await warm; }
});

test("calentamiento alimenta venta y solo lee saldo", async t => {
  let reads = 0, posts = 0, listed = 0, edits = 0;
  const state = setup({ qusdBalance: async () => { reads++; return 100; },
    listOffers: async () => { listed++; return []; }, editOffer: async () => { edits++; },
    apply: async (_uuid: string, options: { beforeDispatch: (ms: number) => Promise<boolean> }) => {
      assert.equal(await options.beforeDispatch(0), true); posts++;
    }, sendChat: async () => ({}) });
  t.after(() => state.close());
  await state.trading.refreshHuntingQusdBalance();
  assert.equal(reads, 1); assert.equal(posts, 0); assert.equal(listed, 0); assert.equal(edits, 0);
  const result = await state.trading.ingestMarketOffer(offer("warm-sale"));
  assert.match(result.action ?? "", /venta aplicada/);
  assert.equal(reads, 1); assert.equal(posts, 1);
  assert.ok(state.store.getOperation("warm-sale"));
});

test("un cambio de epoch durante calentamiento descarta saldo viejo", async t => {
  const hold = gate();
  let reads = 0, posts = 0;
  const state = setup({ qusdBalance: async () => {
    if (++reads === 1) { hold.enter(); await hold.blocked; return 100; }
    return 0;
  }, apply: async () => { posts++; } });
  t.after(() => state.close());
  const warm = state.trading.refreshHuntingQusdBalance();
  try {
    await hold.entered;
    state.store.set("qusd_balance_epoch", "1");
    hold.release(); await warm;
    const result = await state.trading.ingestMarketOffer(offer("new-epoch"));
    assert.match(result.action ?? "", /insuficiente/i);
    assert.equal(reads, 2); assert.equal(posts, 0);
  } finally { hold.release(); await warm; }
});

test("pausa y reanudación durante calentamiento no publican ni repiten la lectura anterior", async t => {
  const hold = gate();
  let reads = 0, posts = 0;
  const state = setup({ qusdBalance: async () => {
    if (++reads === 1) { hold.enter(); await hold.blocked; return 100; }
    return 0;
  }, apply: async () => { posts++; } });
  t.after(() => state.close());
  const warm = state.trading.refreshHuntingQusdBalance();
  try {
    await hold.entered;
    state.trading.setPaused(true); state.trading.setPaused(false);
    hold.release(); await warm;
    assert.equal(reads, 1, "el calentamiento invalidado no se reintenta");
    const result = await state.trading.ingestMarketOffer(offer("after-pause"));
    assert.match(result.action ?? "", /insuficiente/i);
    assert.equal(reads, 2); assert.equal(posts, 0);
  } finally { hold.release(); await warm; }
});

test("desactivar la cacería durante calentamiento impide publicar su saldo", async t => {
  const hold = gate();
  let reads = 0, posts = 0;
  const state = setup({ qusdBalance: async () => {
    if (++reads === 1) { hold.enter(); await hold.blocked; return 100; }
    return 0;
  }, apply: async () => { posts++; } });
  t.after(() => state.close());
  const warm = state.trading.refreshHuntingQusdBalance();
  try {
    await hold.entered;
    state.trading.updateHunting({ sellRunning: false });
    hold.release(); await warm;
    assert.equal(reads, 1);
    state.trading.updateHunting({ sellRunning: true });
    const result = await state.trading.ingestMarketOffer(offer("after-hunt-control"));
    assert.match(result.action ?? "", /insuficiente/i);
    assert.equal(reads, 2); assert.equal(posts, 0);
  } finally { hold.release(); await warm; }
});

for (const kind of ["fixed", "flexible"] as const) {
  test(`una ${kind} confirmada no reconstruye saldo tras cambio de epoch durante POST`, async t => {
    const hold = gate();
    let reads = 0, posts = 0;
    const state = setup({ qusdBalance: async () => ++reads === 1 ? 100 : 0,
      apply: async (_uuid: string, options: { amount?: number; beforeDispatch: (ms: number) => Promise<boolean> }) => {
        assert.equal(await options.beforeDispatch(0), true);
        posts++; hold.enter(); await hold.blocked;
        return kind === "flexible" ? { order: "confirmed-order", amount: options.amount, receive: options.amount! * 1100 } : undefined;
      }, sendChat: async () => ({}) });
    t.after(() => state.close());
    const first = kind === "fixed" ? offer("post-first") : { ...offer("post-first"), offer_kind: "flexible", available_amount: 10, order_min: 10, order_max: 10 };
    const applying = state.trading.ingestMarketOffer(first);
    try {
      await hold.entered;
      state.store.set("qusd_balance_epoch", "1");
      assert.equal(await state.trading.qusdBalance(), 0);
      hold.release();
      assert.match((await applying).action ?? "", /venta aplicada/);
      assert.ok(state.store.getOperation("post-first"), "conserva la operación confirmada");
      assert.match((await state.trading.ingestMarketOffer(offer("post-second"))).action ?? "", /insuficiente/i);
      assert.equal(posts, 1);
      assert.equal(reads, 3, "el saldo se vuelve a validar tras confirmación concurrente");
    } finally { hold.release(); await applying; }
  });
}

test("una deuda cooperativa nueva durante POST no infla el saldo bruto proyectado", async t => {
  const hold = gate();
  let reads = 0, posts = 0;
  const state = setup({ qusdBalance: async () => { reads++; return 100; },
    apply: async (_uuid: string, options: { beforeDispatch: (ms: number) => Promise<boolean> }) => {
      assert.equal(await options.beforeDispatch(0), true);
      posts++; hold.enter(); await hold.blocked;
    }, sendChat: async () => ({}) });
  t.after(() => state.close());
  const applying = state.trading.ingestMarketOffer(offer("debt-first"));
  try {
    await hold.entered;
    state.store.set("cooperative_qusd_owed", "50");
    hold.release();
    assert.match((await applying).action ?? "", /venta aplicada/);
    assert.ok(state.store.getOperation("debt-first"));
    const second = { ...offer("debt-second"), amount: 50, receive: 55000 };
    assert.match((await state.trading.ingestMarketOffer(second)).action ?? "", /insuficiente/i);
    assert.equal(posts, 1);
    assert.equal(reads, 1);
  } finally { hold.release(); await applying; }
});

for (const stateName of ["paused", "emergency", "hunt-disabled"] as const) {
  test(`calentamiento respeta ${stateName}`, async t => {
    let reads = 0;
    const state = setup({ qusdBalance: async () => { reads++; return 100; } });
    t.after(() => state.close());
    if (stateName === "paused") state.trading.setPaused(true);
    if (stateName === "emergency") state.trading.setEmergencyStop(true);
    if (stateName === "hunt-disabled") {
      const config = state.markets.current(); config.hunting.sellRunning = false; state.markets.save(config);
    }
    await state.trading.refreshHuntingQusdBalance();
    assert.equal(reads, 0);
  });
}

test("un fallo de calentamiento no crea un saldo válido para una venta posterior", async t => {
  let reads = 0, posts = 0;
  const state = setup({ qusdBalance: async () => { reads++; throw new Error("saldo no disponible"); }, apply: async () => { posts++; } });
  t.after(() => state.close());
  await assert.rejects(state.trading.refreshHuntingQusdBalance(), /saldo/i);
  await assert.rejects(state.trading.ingestMarketOffer(offer("failed-warmup")), /saldo/i);
  assert.equal(reads, 2); assert.equal(posts, 0);
  assert.equal(state.store.getOperation("failed-warmup"), undefined);
});
