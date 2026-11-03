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

test("ingesta lenta no detiene sondeos; solo queda la página más reciente por mercado y lado", async () => {
  const scheduler = new Scheduler();
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const older = { ...page, scannedAt: 2000 };
  const newer = { ...page, scannedAt: 3000 };
  const stale = { ...page, scannedAt: 2500 };
  const another = { ...page, coin: "ZELLE" as MarketPageUpdate["coin"], scannedAt: 4000 };
  const updates = [page, older, newer, stale, another];
  const ingested: Array<{ update: MarketPageUpdate; realtimeRecovery: boolean | undefined }> = [];
  registerMarketHuntingLoops(scheduler, { mode: () => "hybrid", processNext: async () => false,
    pollNext: async () => updates.shift() }, {
    isPaused: () => false,
    ingestMarketUpdate: async (update, options) => {
      ingested.push({ update, realtimeRecovery: options?.realtimeRecovery });
      if (update === page) await blocked;
      return { inspected: 0, candidates: 0 };
    },
  });
  await scheduler.run("scan");
  await scheduler.run("scan");
  await scheduler.run("scan");
  await scheduler.run("scan");
  await scheduler.run("scan");
  assert.equal(updates.length, 0);
  assert.deepEqual(ingested.map(item => item.update), [page]);
  release();
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.deepEqual(ingested, [
    { update: page, realtimeRecovery: true },
    { update: newer, realtimeRecovery: true },
    { update: another, realtimeRecovery: true },
  ]);
  scheduler.stop();
});

test("error de ingesta se informa y el consumidor sigue con páginas pendientes", async () => {
  const scheduler = new Scheduler();
  let reject!: (error: Error) => void;
  const blocked = new Promise<void>((_resolve, rejectPromise) => { reject = rejectPromise; });
  const next = { ...page, scannedAt: 2000 };
  const updates = [page, next];
  const ingested: MarketPageUpdate[] = [], errors: unknown[] = [];
  const expected = new Error("fallo");
  registerMarketHuntingLoops(scheduler, { mode: () => "hybrid", processNext: async () => false, pollNext: async () => updates.shift() }, {
    isPaused: () => false,
    ingestMarketUpdate: async update => { ingested.push(update); if (update === page) await blocked; return { inspected: 0, candidates: 0 }; },
  }, { onError: error => { errors.push(error); } });
  await scheduler.run("scan"); await scheduler.run("scan");
  reject(expected);
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.deepEqual(errors, [expected]);
  assert.deepEqual(ingested, [page, next]);
  scheduler.stop();
});

test("pausa y stop impiden evaluar páginas pendientes", async () => {
  for (const stop of [false, true]) {
    const scheduler = new Scheduler();
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const updates = [page, { ...page, scannedAt: 2000 }];
    let paused = false, ingested = 0;
    const loops = registerMarketHuntingLoops(scheduler, { mode: () => "hybrid", processNext: async () => false, pollNext: async () => updates.shift() }, {
      isPaused: () => paused,
      ingestMarketUpdate: async () => { ingested++; await blocked; return { inspected: 0, candidates: 0 }; },
    });
    await scheduler.run("scan"); await scheduler.run("scan");
    const stopping = stop ? loops.stop() : undefined;
    if (!stop) paused = true;
    release();
    await stopping;
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(ingested, 1);
    scheduler.stop();
  }
});

test("cambio de generación invalida consultas en curso y páginas pendientes", async () => {
  const scheduler = new Scheduler();
  let releaseIngest!: () => void, releasePoll!: () => void;
  const ingestion = new Promise<void>(resolve => { releaseIngest = resolve; });
  const polling = new Promise<void>(resolve => { releasePoll = resolve; });
  let version = 0, calls = 0;
  const ingested: MarketPageUpdate[] = [];
  const loops = registerMarketHuntingLoops(scheduler, { mode: () => "hybrid", processNext: async () => false,
    pollNext: async () => { calls++; if (calls === 3) await polling; return { ...page, scannedAt: calls * 1000 }; } }, {
    isPaused: () => false,
    ingestMarketUpdate: async update => { ingested.push(update); await ingestion; return { inspected: 0, candidates: 0 }; },
  }, { generation: () => String(version) });
  await scheduler.run("scan");
  await scheduler.run("scan");
  const inFlight = scheduler.run("scan");
  version++;
  releasePoll(); await inFlight;
  releaseIngest();
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.deepEqual(ingested.map(update => update.scannedAt), [1000]);
  await loops.stop();
  scheduler.stop();
});

test("stop espera feed, sondeo y evaluación en curso", async () => {
  const scheduler = new Scheduler();
  let releaseFeed!: () => void, releasePoll!: () => void, releaseIngest!: () => void;
  const feed = new Promise<void>(resolve => { releaseFeed = resolve; });
  const poll = new Promise<void>(resolve => { releasePoll = resolve; });
  const ingestion = new Promise<void>(resolve => { releaseIngest = resolve; });
  let calls = 0, stopped = false;
  const loops = registerMarketHuntingLoops(scheduler, { mode: () => "hybrid", processNext: async () => { await feed; return true; },
    pollNext: async () => { if (++calls === 2) await poll; return page; } }, {
    isPaused: () => false, ingestMarketUpdate: async () => { await ingestion; return { inspected: 0, candidates: 0 }; },
  });
  await scheduler.run("scan");
  const feedTask = scheduler.run("market_feed"), pollTask = scheduler.run("scan");
  const stopping = loops.stop().then(() => { stopped = true; });
  releaseFeed(); releasePoll();
  await Promise.all([feedTask, pollTask]);
  assert.equal(stopped, false);
  releaseIngest(); await stopping;
  assert.equal(stopped, true);
  scheduler.stop();
});

test("mide cola y evaluación y aísla fallos de telemetría", async () => {
  const scheduler = new Scheduler();
  let release!: () => void, clock = 10;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const next = { ...page, scannedAt: 2000 };
  const updates = [page, next];
  const timings: Array<{ queueMs: number; evaluationMs: number; outcome: string }> = [];
  const loops = registerMarketHuntingLoops(scheduler, { mode: () => "hybrid", processNext: async () => false, pollNext: async () => updates.shift() }, {
    isPaused: () => false,
    ingestMarketUpdate: async update => { if (update === page) await blocked; else clock = 40; return { inspected: 0, candidates: 0 }; },
  }, { monotonicNow: () => clock, onEvaluationTiming: item => { timings.push(item); throw new Error("telemetría"); } });
  await scheduler.run("scan");
  clock = 15; await scheduler.run("scan");
  clock = 30; release();
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.deepEqual(timings.map(({ queueMs, evaluationMs, outcome }) => ({ queueMs, evaluationMs, outcome })), [
    { queueMs: 0, evaluationMs: 20, outcome: "success" },
    { queueMs: 15, evaluationMs: 10, outcome: "success" },
  ]);
  await loops.stop(); scheduler.stop();
});

test("una generación nueva reemplaza página pendiente incluso con reloj anterior", async () => {
  const scheduler = new Scheduler();
  let release!: () => void, version = 0;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const old = { ...page, scannedAt: 3000 }, fresh = { ...page, scannedAt: 2000 };
  const updates = [page, old, fresh], ingested: MarketPageUpdate[] = [];
  const loops = registerMarketHuntingLoops(scheduler, { mode: () => "hybrid", processNext: async () => false, pollNext: async () => updates.shift() }, {
    isPaused: () => false,
    ingestMarketUpdate: async update => { ingested.push(update); if (update === page) await blocked; return { inspected: 0, candidates: 0 }; },
  }, { generation: () => String(version) });
  await scheduler.run("scan"); await scheduler.run("scan");
  version++; await scheduler.run("scan");
  release(); await new Promise<void>(resolve => setImmediate(resolve));
  assert.deepEqual(ingested, [page, fresh]);
  await loops.stop(); scheduler.stop();
});

test("prefiere secuencia de despacho sobre reloj de respuesta para páginas pendientes", async () => {
  const scheduler = new Scheduler();
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const earlier = { ...page, dispatchSequence: 2, scannedAt: 3000 };
  const later = { ...page, dispatchSequence: 3, scannedAt: 2000 };
  const updates = [{ ...page, dispatchSequence: 1 }, earlier, later, { ...earlier, scannedAt: 4000 }];
  const ingested: MarketPageUpdate[] = [];
  const loops = registerMarketHuntingLoops(scheduler, { mode: () => "hybrid", processNext: async () => false,
    pollNext: async () => updates.shift() }, {
    isPaused: () => false,
    ingestMarketUpdate: async update => { ingested.push(update); if (update.dispatchSequence === 1) await blocked; return { inspected: 0, candidates: 0 }; },
  });
  for (let i = 0; i < 4; i++) await scheduler.run("scan");
  release(); await new Promise<void>(resolve => setImmediate(resolve));
  assert.deepEqual(ingested.map(update => update.dispatchSequence), [1, 3]);
  await loops.stop(); scheduler.stop();
});

test("una lectura lenta no bloquea otra y stop espera todas sin evaluar respuestas posteriores", async () => {
  const scheduler = new Scheduler();
  const releases: Array<() => void> = [];
  let calls = 0;
  const ingested: MarketPageUpdate[] = [];
  const loops = registerMarketHuntingLoops(scheduler, { mode: () => "hybrid", processNext: async () => false,
    pollNext: async () => {
      const call = ++calls;
      if (call !== 2) await new Promise<void>(resolve => { releases.push(resolve); });
      return { ...page, scannedAt: call * 1000 };
    } }, {
    isPaused: () => false,
    ingestMarketUpdate: async update => { ingested.push(update); return { inspected: 0, candidates: 0 }; },
  });
  await scheduler.run("scan"); await scheduler.run("scan");
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.deepEqual(ingested.map(update => update.scannedAt), [2000]);
  await scheduler.run("scan"); await scheduler.run("scan"); await scheduler.run("scan"); await scheduler.run("scan");
  assert.equal(calls, 5, "máximo cuatro lecturas retenidas");
  let stopped = false;
  const stopping = loops.stop().then(() => { stopped = true; });
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(stopped, false);
  releases.forEach(release => release());
  await stopping;
  assert.deepEqual(ingested.map(update => update.scannedAt), [2000]);
  scheduler.stop();
});

test("los descartes por reemplazo, capacidad, pausa y cierre se registran", async () => {
  for (const finalReason of ["control", "shutdown"] as const) {
    const scheduler = new Scheduler();
    let release!: () => void, paused = false;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const updates = [page, { ...page, scannedAt: 2000 }, { ...page, scannedAt: 3000 },
      ...Array.from({ length: 65 }, (_, index) => ({ ...page, coin: `TEST_${index}` as MarketPageUpdate["coin"], scannedAt: 4000 + index }))];
    const reasons: string[] = [];
    const loops = registerMarketHuntingLoops(scheduler, { mode: () => "hybrid", processNext: async () => false, pollNext: async () => updates.shift() }, {
      isPaused: () => paused,
      ingestMarketUpdate: async () => { await blocked; return { inspected: 0, candidates: 0 }; },
    }, { onEvaluationTiming: item => { if (item.reason) reasons.push(item.reason); } });
    while (updates.length) await scheduler.run("scan");
    if (finalReason === "control") { paused = true; await scheduler.run("scan"); }
    const stopping = loops.stop();
    release(); await stopping;
    assert.ok(reasons.includes("superseded"));
    assert.ok(reasons.includes("capacity"));
    assert.ok(reasons.includes(finalReason));
    scheduler.stop();
  }
});

test("la cola tiene límite y descarta la clave pendiente más antigua", async () => {
  const scheduler = new Scheduler();
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const updates = [page, ...Array.from({ length: 65 }, (_, index) => ({
    ...page, coin: `TEST_${index}` as MarketPageUpdate["coin"], scannedAt: index + 2000,
  }))];
  const ingested: MarketPageUpdate[] = [];
  registerMarketHuntingLoops(scheduler, { mode: () => "hybrid", processNext: async () => false, pollNext: async () => updates.shift() }, {
    isPaused: () => false,
    ingestMarketUpdate: async update => { ingested.push(update); if (update === page) await blocked; return { inspected: 0, candidates: 0 }; },
  });
  for (let index = 0; index < 66; index++) await scheduler.run("scan");
  release();
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(ingested.length, 65);
  assert.equal(ingested[1]?.coin, "TEST_1");
  assert.equal(ingested.at(-1)?.coin, "TEST_64");
  scheduler.stop();
});
