/**
 * Operaciones de conformidad para `src/application/market-hunting-loops.ts`.
 *
 * Cada operación reproduce un escenario determinista del test de origen
 * (sondeo, feed, cola de páginas, generaciones, pausa, cierre, telemetría y
 * capacidad) y devuelve solo trazas observables. No hay red, reloj real ni
 * temporizadores duraderos.
 */
import { Scheduler } from "../../../src/scheduler.js";
import { registerMarketHuntingLoops } from "../../../src/application/market-hunting-loops.js";
import type { MarketPageUpdate } from "../../../src/market-source.js";

type Input = Record<string, unknown>;

const page: MarketPageUpdate = {
  coin: "BANK_CUP",
  side: "sell",
  page: { offers: [], total: 0, currentPage: 1, perPage: 100 },
  scannedAt: 1_000,
  sourceAccountId: "reader",
};

function deferred(): { promise: Promise<void>; resolve: () => void; reject: (error: Error) => void } {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

export const ops = {
  "market-hunting.polling-progress": async () => {
    const scheduler = new Scheduler();
    const entered = deferred();
    const blocked = deferred();
    let polls = 0;
    let ingested = 0;
    registerMarketHuntingLoops(scheduler, {
      mode: () => "hybrid",
      processNext: async () => {
        entered.resolve();
        await blocked.promise;
        return true;
      },
      pollNext: async () => {
        polls += 1;
        return page;
      },
    }, {
      isPaused: () => false,
      ingestMarketUpdate: async (update, options) => {
        if (update !== page || options?.realtimeRecovery !== true) throw new Error("ingesta inesperada");
        ingested += 1;
        return { inspected: 0, candidates: 0 };
      },
    } as never);
    const feed = scheduler.run("market_feed");
    await entered.promise;
    const scan = await scheduler.run("scan");
    const pollsAfter = polls;
    const ingestedAfter = ingested;
    const secondFeed = await scheduler.run("market_feed");
    blocked.resolve();
    await feed;
    scheduler.stop();
    return { scan, polls: pollsAfter, ingested: ingestedAfter, secondFeed };
  },

  "market-hunting.feed-progress": async () => {
    const scheduler = new Scheduler();
    const blocked = deferred();
    let polls = 0;
    let feed = 0;
    let paused = false;
    registerMarketHuntingLoops(scheduler, {
      mode: () => "hybrid",
      processNext: async () => {
        feed += 1;
        return true;
      },
      pollNext: async () => {
        polls += 1;
        await blocked.promise;
        return undefined;
      },
    }, {
      isPaused: () => paused,
      ingestMarketUpdate: async () => ({ inspected: 0, candidates: 0 }),
    } as never);
    const poll = scheduler.run("scan");
    const feedRun = await scheduler.run("market_feed");
    const feedAfter = feed;
    blocked.resolve();
    await poll;
    paused = true;
    await scheduler.run("scan");
    await scheduler.run("market_feed");
    const pollsAfter = polls;
    const feedTotal = feed;
    scheduler.stop();
    return { feedRun, feedAfter, polls: pollsAfter, feedTotal };
  },

  "market-hunting.latest-page": async () => {
    const scheduler = new Scheduler();
    const blocked = deferred();
    const older = { ...page, scannedAt: 2_000 };
    const newer = { ...page, scannedAt: 3_000 };
    const stale = { ...page, scannedAt: 2_500 };
    const another = { ...page, coin: "ZELLE" as MarketPageUpdate["coin"], scannedAt: 4_000 };
    const updates = [page, older, newer, stale, another];
    const ingested: { update: MarketPageUpdate; realtimeRecovery: boolean | undefined }[] = [];
    registerMarketHuntingLoops(scheduler, {
      mode: () => "hybrid",
      processNext: async () => false,
      pollNext: async () => updates.shift(),
    }, {
      isPaused: () => false,
      ingestMarketUpdate: async (update, options) => {
        ingested.push({ update, realtimeRecovery: options?.realtimeRecovery });
        if (update === page) await blocked.promise;
        return { inspected: 0, candidates: 0 };
      },
    } as never);
    for (let index = 0; index < 5; index += 1) await scheduler.run("scan");
    const remaining = updates.length;
    const before = ingested.map((item) => item.update.scannedAt);
    blocked.resolve();
    await tick();
    const after = ingested.map((item) => ({ scannedAt: item.update.scannedAt, realtimeRecovery: item.realtimeRecovery }));
    scheduler.stop();
    return { remaining, before, after };
  },

  "market-hunting.ingest-error": async () => {
    const scheduler = new Scheduler();
    const blocked = deferred();
    const next = { ...page, scannedAt: 2_000 };
    const updates = [page, next];
    const ingested: number[] = [];
    const errors: string[] = [];
    const expected = new Error("fallo");
    registerMarketHuntingLoops(scheduler, {
      mode: () => "hybrid",
      processNext: async () => false,
      pollNext: async () => updates.shift(),
    }, {
      isPaused: () => false,
      ingestMarketUpdate: async (update) => {
        ingested.push(update.scannedAt);
        if (update === page) await blocked.promise;
        return { inspected: 0, candidates: 0 };
      },
    } as never, { onError: (error) => { errors.push(error instanceof Error ? error.message : String(error)); } });
    await scheduler.run("scan");
    await scheduler.run("scan");
    blocked.reject(expected);
    await tick();
    scheduler.stop();
    return { errors, ingested };
  },

  "market-hunting.pause-stop": async () => {
    const outcomes: { stop: boolean; ingested: number }[] = [];
    for (const stop of [false, true]) {
      const scheduler = new Scheduler();
      const blocked = deferred();
      const updates = [page, { ...page, scannedAt: 2_000 }];
      let paused = false;
      let ingested = 0;
      const loops = registerMarketHuntingLoops(scheduler, {
        mode: () => "hybrid",
        processNext: async () => false,
        pollNext: async () => updates.shift(),
      }, {
        isPaused: () => paused,
        ingestMarketUpdate: async () => {
          ingested += 1;
          await blocked.promise;
          return { inspected: 0, candidates: 0 };
        },
      } as never);
      await scheduler.run("scan");
      await scheduler.run("scan");
      const stopping = stop ? loops.stop() : undefined;
      if (!stop) paused = true;
      blocked.resolve();
      await stopping;
      await tick();
      outcomes.push({ stop, ingested });
      scheduler.stop();
    }
    return { outcomes };
  },

  "market-hunting.generation-invalidate": async () => {
    const scheduler = new Scheduler();
    const ingestion = deferred();
    const polling = deferred();
    let version = 0;
    let calls = 0;
    const ingested: number[] = [];
    const loops = registerMarketHuntingLoops(scheduler, {
      mode: () => "hybrid",
      processNext: async () => false,
      pollNext: async () => {
        calls += 1;
        if (calls === 3) await polling.promise;
        return { ...page, scannedAt: calls * 1_000 };
      },
    }, {
      isPaused: () => false,
      ingestMarketUpdate: async (update) => {
        ingested.push(update.scannedAt);
        await ingestion.promise;
        return { inspected: 0, candidates: 0 };
      },
    } as never, { generation: () => String(version) });
    await scheduler.run("scan");
    await scheduler.run("scan");
    const inFlight = scheduler.run("scan");
    version += 1;
    polling.resolve();
    await inFlight;
    ingestion.resolve();
    await tick();
    await loops.stop();
    scheduler.stop();
    return { ingested };
  },

  "market-hunting.stop-waits": async () => {
    const scheduler = new Scheduler();
    const feed = deferred();
    const poll = deferred();
    const ingestion = deferred();
    let calls = 0;
    let stopped = false;
    const loops = registerMarketHuntingLoops(scheduler, {
      mode: () => "hybrid",
      processNext: async () => {
        await feed.promise;
        return true;
      },
      pollNext: async () => {
        calls += 1;
        if (calls === 2) await poll.promise;
        return page;
      },
    }, {
      isPaused: () => false,
      ingestMarketUpdate: async () => {
        await ingestion.promise;
        return { inspected: 0, candidates: 0 };
      },
    } as never);
    await scheduler.run("scan");
    const feedTask = scheduler.run("market_feed");
    const pollTask = scheduler.run("scan");
    const stopping = loops.stop().then(() => {
      stopped = true;
    });
    feed.resolve();
    poll.resolve();
    await Promise.all([feedTask, pollTask]);
    const beforeIngestion = stopped;
    ingestion.resolve();
    await stopping;
    const afterIngestion = stopped;
    scheduler.stop();
    return { beforeIngestion, afterIngestion };
  },

  "market-hunting.timing": async () => {
    const scheduler = new Scheduler();
    const blocked = deferred();
    let clock = 10;
    const next = { ...page, scannedAt: 2_000 };
    const updates = [page, next];
    const timings: Array<{ queueMs: number; evaluationMs: number; outcome: string }> = [];
    const loops = registerMarketHuntingLoops(scheduler, {
      mode: () => "hybrid",
      processNext: async () => false,
      pollNext: async () => updates.shift(),
    }, {
      isPaused: () => false,
      ingestMarketUpdate: async (update) => {
        if (update === page) await blocked.promise;
        else clock = 40;
        return { inspected: 0, candidates: 0 };
      },
    } as never, {
      monotonicNow: () => clock,
      onEvaluationTiming: (item) => {
        timings.push({ queueMs: item.queueMs, evaluationMs: item.evaluationMs, outcome: item.outcome });
        throw new Error("telemetría");
      },
    });
    await scheduler.run("scan");
    clock = 15;
    await scheduler.run("scan");
    clock = 30;
    blocked.resolve();
    await tick();
    await loops.stop();
    scheduler.stop();
    return { timings };
  },

  "market-hunting.generation-replaces": async () => {
    const scheduler = new Scheduler();
    const blocked = deferred();
    let version = 0;
    const old = { ...page, scannedAt: 3_000 };
    const fresh = { ...page, scannedAt: 2_000 };
    const updates = [page, old, fresh];
    const ingested: number[] = [];
    const loops = registerMarketHuntingLoops(scheduler, {
      mode: () => "hybrid",
      processNext: async () => false,
      pollNext: async () => updates.shift(),
    }, {
      isPaused: () => false,
      ingestMarketUpdate: async (update) => {
        ingested.push(update.scannedAt);
        if (update === page) await blocked.promise;
        return { inspected: 0, candidates: 0 };
      },
    } as never, { generation: () => String(version) });
    await scheduler.run("scan");
    await scheduler.run("scan");
    version += 1;
    await scheduler.run("scan");
    blocked.resolve();
    await tick();
    await loops.stop();
    scheduler.stop();
    return { ingested };
  },

  "market-hunting.dispatch-sequence": async () => {
    const scheduler = new Scheduler();
    const blocked = deferred();
    const earlier = { ...page, dispatchSequence: 2, scannedAt: 3_000 };
    const later = { ...page, dispatchSequence: 3, scannedAt: 2_000 };
    const updates = [{ ...page, dispatchSequence: 1 }, earlier, later, { ...earlier, scannedAt: 4_000 }];
    const ingested: number[] = [];
    const loops = registerMarketHuntingLoops(scheduler, {
      mode: () => "hybrid",
      processNext: async () => false,
      pollNext: async () => updates.shift(),
    }, {
      isPaused: () => false,
      ingestMarketUpdate: async (update) => {
        ingested.push(update.dispatchSequence ?? -1);
        if (update.dispatchSequence === 1) await blocked.promise;
        return { inspected: 0, candidates: 0 };
      },
    } as never);
    for (let index = 0; index < 4; index += 1) await scheduler.run("scan");
    blocked.resolve();
    await tick();
    await loops.stop();
    scheduler.stop();
    return { ingested };
  },

  "market-hunting.slow-read": async () => {
    const scheduler = new Scheduler();
    const releases: Array<() => void> = [];
    let calls = 0;
    const ingested: number[] = [];
    const loops = registerMarketHuntingLoops(scheduler, {
      mode: () => "hybrid",
      processNext: async () => false,
      pollNext: async () => {
        const call = ++calls;
        if (call !== 2) {
          await new Promise<void>((resolve) => {
            releases.push(resolve);
          });
        }
        return { ...page, scannedAt: call * 1_000 };
      },
    }, {
      isPaused: () => false,
      ingestMarketUpdate: async (update) => {
        ingested.push(update.scannedAt);
        return { inspected: 0, candidates: 0 };
      },
    } as never);
    await scheduler.run("scan");
    await scheduler.run("scan");
    await tick();
    const first = [...ingested];
    await scheduler.run("scan");
    await scheduler.run("scan");
    await scheduler.run("scan");
    await scheduler.run("scan");
    const callsAfter = calls;
    let stopped = false;
    const stopping = loops.stop().then(() => {
      stopped = true;
    });
    await tick();
    const stoppedBeforeRelease = stopped;
    releases.forEach((release) => release());
    await stopping;
    scheduler.stop();
    return { first, calls: callsAfter, stoppedBeforeRelease, after: [...ingested] };
  },

  "market-hunting.discard-reasons": async () => {
    const outcomes: { finalReason: string; reasons: string[] }[] = [];
    for (const finalReason of ["control", "shutdown"] as const) {
      const scheduler = new Scheduler();
      const blocked = deferred();
      let paused = false;
      const updates = [page, { ...page, scannedAt: 2_000 }, { ...page, scannedAt: 3_000 },
        ...Array.from({ length: 65 }, (_, index) => ({
          ...page,
          coin: `TEST_${index}` as MarketPageUpdate["coin"],
          scannedAt: 4_000 + index,
        }))];
      const reasons: string[] = [];
      const loops = registerMarketHuntingLoops(scheduler, {
        mode: () => "hybrid",
        processNext: async () => false,
        pollNext: async () => updates.shift(),
      }, {
        isPaused: () => paused,
        ingestMarketUpdate: async () => {
          await blocked.promise;
          return { inspected: 0, candidates: 0 };
        },
      } as never, {
        onEvaluationTiming: (item) => {
          if (item.reason) reasons.push(item.reason);
        },
      });
      while (updates.length) await scheduler.run("scan");
      if (finalReason === "control") {
        paused = true;
        await scheduler.run("scan");
      }
      const stopping = loops.stop();
      blocked.resolve();
      await stopping;
      outcomes.push({ finalReason, reasons });
      scheduler.stop();
    }
    return { outcomes };
  },

  "market-hunting.queue-limit": async () => {
    const scheduler = new Scheduler();
    const blocked = deferred();
    const updates = [page, ...Array.from({ length: 65 }, (_, index) => ({
      ...page,
      coin: `TEST_${index}` as MarketPageUpdate["coin"],
      scannedAt: index + 2_000,
    }))];
    const ingested: MarketPageUpdate[] = [];
    registerMarketHuntingLoops(scheduler, {
      mode: () => "hybrid",
      processNext: async () => false,
      pollNext: async () => updates.shift(),
    }, {
      isPaused: () => false,
      ingestMarketUpdate: async (update) => {
        ingested.push(update);
        if (update === page) await blocked.promise;
        return { inspected: 0, candidates: 0 };
      },
    } as never);
    for (let index = 0; index < 66; index += 1) await scheduler.run("scan");
    blocked.resolve();
    await tick();
    scheduler.stop();
    return {
      count: ingested.length,
      firstAfterHead: ingested[1]?.coin ?? null,
      last: ingested.at(-1)?.coin ?? null,
    };
  },
};
