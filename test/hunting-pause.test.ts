import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { MarketConfigService } from "../src/market-config.js";
import { Store } from "../src/store.js";
import { TradingEngine } from "../src/trading.js";
import type { P2pOffer } from "../src/types.js";

function setup(gateway: object) {
  const dataDir = mkdtempSync(join(tmpdir(), "qva-hunting-pause-"));
  const store = new Store(dataDir);
  const cfg = { dataDir, initialUsdFiatBalance: 0, buyQusdMaxRate: 930, sellQusdMinRate: 1000,
    buyQusdUsdMaxRate: 1.06, sellQusdUsdMinRate: 1.12, cupPurchaseMaxQusd: 150,
    maxOpenOwnOffers: 10, priceGuardPercent: 15, qusdReserve: 0, realTradingAllowed: true,
    autoCancelMs: 600000, offerRefreshIntervalMs: 300000, paymentDetails: { BANK_CUP: [], BANDECPREPAGO: [] } };
  const markets = new MarketConfigService(dataDir, cfg as never, store);
  store.set("paused", "false"); store.set("mode", "real"); store.set("fiat_balance:BANK_CUP", "100000");
  store.recordMarketObservation({ coin: "BANK_CUP", medianSell: 930, openOffers: 20, eligible: 0 });
  return { store, trading: new TradingEngine(store, gateway as never, cfg as never, markets, async () => undefined) };
}
const offer = (uuid: string, pause?: unknown): P2pOffer => ({ uuid, type: "sell", coin: "BANK_CUP", amount: 10,
  receive: 9200, status: "open", only_vip: false, ...(pause === undefined ? {} : { pause }) } as P2pOffer);

test("una oferta open con pausa o pausa malformada no consulta red ni reserva capital", async t => {
  let calls = 0;
  const { store, trading } = setup({ apply: async () => { calls++; }, qusdBalance: async () => { calls++; return 100; } });
  t.after(() => store.close());
  for (const [i, pause] of [{ reason: "owner", until: null }, { reason: "taker_left", until: "2020-01-01T00:00:00Z" }, {}, false, "unknown"].entries()) {
    const result = await trading.ingestMarketOffer(offer(`paused-${i}`, pause));
    assert.match(result.action ?? "", /pausada/);
    assert.equal(trading.cooperativeSafetyReason(offer(`paused-${i}`, pause)), "Oferta pausada");
  }
  assert.equal(calls, 0);
  assert.equal(store.applicationReservedCapital().count, 0);
  assert.equal(store.recentMutationIntents(10).length, 0);
});

test("resumed reevalúa una oferta vista sin borrar la exclusión de cancelación manual", async t => {
  let calls = 0;
  const { store, trading } = setup({ apply: async () => { calls++; }, sendChat: async () => ({}) });
  t.after(async () => { await new Promise(resolve => setImmediate(resolve)); store.close(); });
  store.markSeen("resumed");
  const result = await trading.ingestMarketOffer(offer("resumed", null), Date.now(), "p2p.resumed");
  assert.equal(result.action, "aplicada resumed");
  assert.equal(calls, 1);
  store.markSeen("excluded");
  store.excludeAutomaticReapplyAfterManualCancel("excluded");
  const excluded = await trading.ingestMarketOffer(offer("excluded", null), Date.now(), "p2p.resumed");
  assert.match(excluded.action ?? "", /cancelación manual/);
  assert.equal(calls, 1);
});

test("pausa recibida durante la espera invalida el preflight antes del POST", async t => {
  let release!: () => void;
  let started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  const wait = new Promise<void>(resolve => { release = resolve; });
  let posts = 0;
  const { store, trading } = setup({ apply: async (_uuid: string, options: { beforeDispatch: (ms: number) => Promise<boolean> }) => {
    started(); await wait;
    if (await options.beforeDispatch(0)) posts++;
    else throw new Error("preflight rechazado");
  } });
  t.after(() => store.close());
  const sent = Date.now();
  const pending = trading.ingestMarketOffer(offer("race"), sent, "p2p.created", new Date(sent).toISOString());
  await ready;
  const pausedAt = sent + 1000;
  for (const event of ["p2p.created", "p2p.reopened"])
    store.enqueueMarketFeedEvent({ key: `tie-${event}`, event, receivedAt: pausedAt,
      payload: { event, sent_at: new Date(pausedAt).toISOString(), data: offer("race", null) } });
  store.enqueueMarketFeedEvent({ key: "pause-race", event: "p2p.paused", receivedAt: pausedAt,
    payload: { event: "p2p.paused", sent_at: new Date(pausedAt).toISOString(), data: offer("race", { reason: "owner", until: null }) } });
  release();
  await assert.rejects(pending, /preflight rechazado/);
  assert.equal(posts, 0);
});

test("una pausa durante la lectura de saldo del preflight impide el POST", async t => {
  let release!: () => void;
  let started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  const wait = new Promise<void>(resolve => { release = resolve; });
  let balanceReads = 0;
  let posts = 0;
  let store!: Store;
  const gateway = {
    qusdBalance: async () => { if (++balanceReads === 2) { started(); await wait; } return 100; },
    apply: async (_uuid: string, options: { beforeDispatch: (ms: number) => Promise<boolean> }) => {
      store.set("qusd_balance_epoch", "1");
      if (await options.beforeDispatch(0)) posts++;
      else throw new Error("preflight rechazado");
    },
  };
  const state = setup(gateway); store = state.store;
  t.after(() => store.close());
  const sent = Date.now();
  const buy = { ...offer("balance-race"), type: "buy" as const, receive: 11000 };
  const pending = state.trading.ingestMarketOffer(buy, sent, "p2p.created", new Date(sent).toISOString());
  await ready;
  const pausedAt = sent + 1000;
  store.enqueueMarketFeedEvent({ key: "pause-balance-race", event: "p2p.paused", receivedAt: pausedAt,
    payload: { event: "p2p.paused", sent_at: new Date(pausedAt).toISOString(), data: { ...buy, pause: { reason: "owner", until: null } } } });
  release();
  await assert.rejects(pending, /preflight rechazado/);
  assert.equal(posts, 0);
});

test("el evento paused retira la oferta visible sin cambiar su operación", async t => {
  const { store, trading } = setup({});
  t.after(() => store.close());
  const paused = offer("visible", { reason: "owner", until: null });
  store.saveRemoteResource("market:BANK_CUP", { total: 1, offers: [paused] });
  store.createOperation({ uuid: paused.uuid, offerType: "sell", coin: paused.coin, amount: paused.amount,
    receive: paused.receive, rate: paused.receive / paused.amount, state: "applied", autoApplied: true,
    cancelAt: null, createdAt: Date.now() });
  await trading.ingestMarketStateEvent("p2p.paused", paused);
  assert.equal(store.getOperation(paused.uuid)?.state, "applied");
  assert.deepEqual(store.loadRemoteResource<{ offers: P2pOffer[] }>("market:BANK_CUP")?.data.offers, []);
});

test("una reanudación antigua no aplica el precio anterior a una reanudación más reciente", async t => {
  let posts = 0;
  const { store, trading } = setup({ apply: async () => { posts++; }, sendChat: async () => ({}) });
  t.after(async () => { await new Promise(resolve => setImmediate(resolve)); store.close(); });
  const at = Date.now() - 3000;
  const older = offer("resume-price", null);
  const newer = { ...older, receive: 9250 };
  for (const [event, time, data] of [
    ["p2p.resumed", at, older],
    ["p2p.paused", at + 1000, { ...older, pause: { reason: "owner", until: null } }],
    ["p2p.resumed", at + 2000, newer],
  ] as const) store.enqueueMarketFeedEvent({ key: `${event}-${time}`, event, receivedAt: time,
    payload: { event, sent_at: new Date(time).toISOString(), data } });
  const stale = await trading.ingestMarketOffer(older, at, "p2p.resumed", new Date(at).toISOString());
  assert.match(stale.action ?? "", /invalidada/);
  assert.equal(posts, 0);
  const result = await trading.ingestMarketOffer(newer, at + 2000, "p2p.resumed", new Date(at + 2000).toISOString());
  assert.equal(result.action, "aplicada resume-price");
  assert.equal(posts, 1);
});

test("el preflight solo repite la consulta del feed cuando espera saldo QUSD", async t => {
  const { store, trading } = setup({ qusdBalance: async () => 100 });
  t.after(() => store.close());
  let reads = 0;
  const original = store.latestMarketFeedState.bind(store);
  store.latestMarketFeedState = uuid => { reads++; return original(uuid); };
  const guard = (trading as unknown as { automaticDispatchAllowed: (value: P2pOffer) => Promise<boolean> }).automaticDispatchAllowed.bind(trading);
  assert.equal(await guard(offer("fiat-guard")), true);
  assert.equal(reads, 1);
  reads = 0;
  assert.equal(await guard({ ...offer("qusd-guard"), type: "buy", receive: 11000 }), true);
  assert.equal(reads, 2);
});
