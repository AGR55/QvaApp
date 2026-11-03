import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { MarketConfigService } from "../src/market-config.js";
import type { MarketPageUpdate } from "../src/market-source.js";
import { QvaApiError } from "../src/qvapay.js";
import { Store } from "../src/store.js";
import { TradingEngine } from "../src/trading.js";

function gate() {
  let release!: () => void, enter!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const entered = new Promise<void>(resolve => { enter = resolve; });
  return { release, enter, entered, blocked };
}

function setup(gateway: object) {
  const dataDir = mkdtempSync(join(tmpdir(), "qva-serialized-ingest-"));
  const store = new Store(dataDir);
  const cfg = { dataDir, initialUsdFiatBalance: 0, buyQusdMaxRate: 930, sellQusdMinRate: 1000,
    buyQusdUsdMaxRate: 1.06, sellQusdUsdMinRate: 1.12, cupPurchaseMaxQusd: 150,
    maxOpenOwnOffers: 10, priceGuardPercent: 15, qusdReserve: 0, realTradingAllowed: true,
    autoCancelMs: 600000, offerRefreshIntervalMs: 300000, paymentDetails: { BANK_CUP: [], BANDECPREPAGO: [] } };
  const markets = new MarketConfigService(dataDir, cfg as never, store);
  const config = markets.current();
  config.markets.forEach(market => { market.active = market.code === "BANK_CUP"; });
  markets.save(config);
  store.set("paused", "false");
  store.set("mode", "real");
  store.set("fiat_balance:BANK_CUP", "100000");
  store.recordMarketObservation({ coin: "BANK_CUP", medianSell: 930, openOffers: 20, eligible: 0 });
  const trading = new TradingEngine(store, gateway as never, cfg as never, markets, async () => undefined);
  return { store, trading, async close() { await new Promise(resolve => setImmediate(resolve)); store.close(); rmSync(dataDir, { recursive: true, force: true }); } };
}

function page(uuid: string): MarketPageUpdate {
  return { coin: "BANK_CUP", side: "sell", sourceAccountId: "reader", scannedAt: Date.now(),
    page: { offers: [{ uuid, coin: "BANK_CUP", type: "sell", amount: 10, receive: 9200, status: "open", only_vip: false }],
      total: 1, currentPage: 1, perPage: 100 } };
}

test("una página híbrida espera un escaneo manual y se aplica una sola vez", async t => {
  const hold = gate();
  const applied: string[] = [];
  let first = true;
  const state = setup({
    listOffersPage: async () => { if (first) { first = false; hold.enter(); await hold.blocked; } return { offers: [], total: 0, currentPage: 1, perPage: 100 }; },
    p2pAverages: async () => ({}), apply: async (uuid: string) => { applied.push(uuid); }, sendChat: async () => ({}),
  });
  t.after(() => state.close());
  const scan = state.trading.scan();
  await hold.entered;
  const pending = state.trading.ingestMarketUpdate(page("after-manual"), { realtimeRecovery: true });
  hold.release();
  await scan;
  const result = await pending;
  assert.equal(result.action, "aplicada after-manual");
  assert.deepEqual(applied, ["after-manual"]);
  assert.ok(state.store.getOperation("after-manual"));
});

test("dos páginas concurrentes distintas se procesan ambas", async t => {
  const hold = gate();
  const applied: string[] = [];
  const state = setup({ apply: async (uuid: string) => { applied.push(uuid); if (uuid === "first-page") { hold.enter(); await hold.blocked; } }, sendChat: async () => ({}) });
  t.after(() => state.close());
  const first = state.trading.ingestMarketUpdate(page("first-page"), { realtimeRecovery: true });
  await hold.entered;
  const second = state.trading.ingestMarketUpdate(page("second-page"), { realtimeRecovery: true });
  hold.release();
  const results = await Promise.all([first, second]);
  assert.deepEqual(results.map(result => result.action), ["aplicada first-page", "aplicada second-page"]);
  assert.deepEqual(applied, ["first-page", "second-page"]);
  assert.ok(state.store.getOperation("first-page"));
  assert.ok(state.store.getOperation("second-page"));
});

for (const change of ["pause-resume", "stale"] as const) test(`página en espera se descarta tras ${change}`, async t => {
  const hold = gate();
  const applied: string[] = [];
  const state = setup({ apply: async (uuid: string) => { applied.push(uuid); hold.enter(); await hold.blocked; }, sendChat: async () => ({}) });
  t.after(() => state.close());
  const first = state.trading.ingestMarketUpdate(page("prior-page"), { realtimeRecovery: true });
  await hold.entered;
  let current = true;
  const waiting = state.trading.ingestMarketUpdate(page("obsolete-page"), { realtimeRecovery: true, isCurrent: () => current });
  if (change === "pause-resume") { state.trading.setPaused(true); state.trading.setPaused(false); }
  else current = false;
  hold.release();
  await first;
  const result = await waiting;
  assert.equal(result.inspected, 0);
  assert.match(result.action ?? "", /descartada/);
  assert.deepEqual(applied, ["prior-page"]);
  assert.equal(state.store.getOperation("obsolete-page"), undefined);
});

for (const change of ["pause-resume", "stale"] as const) test(`página activa invalidada durante promedios no proyecta ni aplica: ${change}`, async t => {
  const hold = gate();
  let posts = 0, current = true;
  const state = setup({
    p2pAverages: async () => { hold.enter(); await hold.blocked; return { BANK_CUP: { median_sell: 930 } }; },
    apply: async () => { posts++; }, sendChat: async () => ({}),
  });
  t.after(() => state.close());
  const initial = { offers: [{ uuid: "previous", type: "buy" }] };
  state.store.saveRemoteResource("market:BANK_CUP", initial);
  const pending = state.trading.ingestMarketUpdate(page("during-average"), { isCurrent: () => current });
  await hold.entered;
  if (change === "pause-resume") { state.trading.setPaused(true); state.trading.setPaused(false); }
  else current = false;
  hold.release();
  const result = await pending;
  assert.match(result.action ?? "", /descartada/);
  assert.equal(posts, 0);
  assert.equal(state.store.getOperation("during-average"), undefined);
  assert.deepEqual(state.store.loadRemoteResource("market:BANK_CUP")?.data, initial);
});

for (const change of ["pause-resume", "stale"] as const) test(`preflight rechaza página invalidada antes del POST: ${change}`, async t => {
  const hold = gate();
  let posts = 0, guards = 0, current = true;
  const state = setup({
    apply: async (_uuid: string, options: { beforeDispatch: (ms: number) => Promise<boolean> }) => {
      hold.enter(); await hold.blocked;
      guards++;
      if (!await options.beforeDispatch(0)) throw new QvaApiError(409, "no enviado", undefined, "LOCAL_CONDITIONS_CHANGED");
      posts++;
    },
    sendChat: async () => ({}),
  });
  t.after(() => state.close());
  const pending = state.trading.ingestMarketUpdate(page("before-dispatch"), { realtimeRecovery: true, isCurrent: () => current });
  await hold.entered;
  if (change === "pause-resume") { state.trading.setPaused(true); state.trading.setPaused(false); }
  else current = false;
  hold.release();
  await pending;
  assert.equal(guards, 1);
  assert.equal(posts, 0);
  assert.equal(state.store.getOperation("before-dispatch"), undefined);
  assert.equal(state.store.applicationReservedCapital().count, 0);
});

test("la invalidación de una página retenida no afecta al feed independiente", async t => {
  const hold = gate();
  let current = true;
  const applied: string[] = [];
  const state = setup({
    p2pAverages: async () => { hold.enter(); await hold.blocked; return {}; },
    apply: async (uuid: string, options: { beforeDispatch: (ms: number) => Promise<boolean> }) => {
      assert.equal(await options.beforeDispatch(0), true);
      applied.push(uuid);
    },
    sendChat: async () => ({}),
  });
  t.after(() => state.close());
  const pending = state.trading.ingestMarketUpdate(page("stale-page"), { isCurrent: () => current });
  await hold.entered;
  current = false;
  const result = await state.trading.ingestMarketOffer(page("fresh-feed").page.offers[0]!);
  assert.equal(result.action, "aplicada fresh-feed");
  hold.release();
  assert.match((await pending).action ?? "", /descartada/);
  assert.deepEqual(applied, ["fresh-feed"]);
  assert.ok(state.store.getOperation("fresh-feed"));
  assert.equal(state.store.getOperation("stale-page"), undefined);
});
