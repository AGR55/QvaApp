import assert from "node:assert/strict";
import test from "node:test";
import { Scheduler } from "../src/scheduler.js";
import { registerMarketHuntingLoops } from "../src/application/market-hunting-loops.js";
import type { MarketPageUpdate } from "../src/market-source.js";

const page: MarketPageUpdate = { coin: "BANK_CUP", side: "sell", page: { offers: [], total: 0, currentPage: 1, perPage: 100 }, scannedAt: 1000, sourceAccountId: "reader" };

test("polling progresa mientras una oportunidad del feed espera respuesta", async () => {
  const scheduler = new Scheduler();
  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const blocked = new Promise<void>(resolve => { release = resolve; });
  let polls = 0, ingested = 0;
  registerMarketHuntingLoops(scheduler, { mode: () => "hybrid", processNext: async () => { entered(); await blocked; return true; }, pollNext: async () => { polls++; return page; } }, {
    isPaused: () => false,
    ingestMarketUpdate: async (update, options) => { assert.equal(update, page); assert.equal(options?.realtimeRecovery, true); ingested++; return { inspected: 0, candidates: 0 }; },
  });
  const feed = scheduler.run("market_feed");
  await started;
  assert.equal(await scheduler.run("scan"), true);
  assert.equal(polls, 1); assert.equal(ingested, 1);
  assert.equal(await scheduler.run("market_feed"), false, "no solapa su propio worker");
  release(); await feed; scheduler.stop();
});

test("el feed progresa durante polling lento y ambos respetan la pausa del usuario", async () => {
  const scheduler = new Scheduler();
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  let polls = 0, feed = 0, paused = false;
  registerMarketHuntingLoops(scheduler, { mode: () => "hybrid", processNext: async () => { feed++; return true; }, pollNext: async () => { polls++; await blocked; return undefined; } }, { isPaused: () => paused, ingestMarketUpdate: async () => ({ inspected: 0, candidates: 0 }) });
  const poll = scheduler.run("scan");
  assert.equal(await scheduler.run("market_feed"), true);
  assert.equal(feed, 1);
  release(); await poll;
  paused = true;
  await scheduler.run("scan"); await scheduler.run("market_feed");
  assert.equal(polls, 1); assert.equal(feed, 1); scheduler.stop();
});
