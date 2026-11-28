/**
 * Operaciones de conformidad para `src/application/hunting-balance-loops.ts`.
 *
 * El escenario reproduce el cierre ordenado: dos trabajos en curso retienen
 * `stop()` hasta completar sus guardas posteriores, no se inicia trabajo nuevo
 * tras el cierre y la caché de saldo se cierra al final.
 */
import { Scheduler } from "../../../src/scheduler.js";
import { registerHuntingBalanceLoops } from "../../../src/application/hunting-balance-loops.js";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

export const ops = {
  "hunting-balance.stop": async () => {
    const scheduler = new Scheduler();
    const warming = deferred();
    const preparation = deferred();
    const events: string[] = [];
    const loops = registerHuntingBalanceLoops(scheduler, {
      refreshHuntingQusdBalance: async () => {
        events.push("warm");
        await warming.promise;
        events.push("warm-completed");
      },
      prepareHuntingLiquidity: async () => {
        events.push("prepare");
        await preparation.promise;
        events.push("prepare-completed");
      },
      stopHuntingBalanceReads: async () => {
        events.push("cache-stopped");
      },
    });

    const warm = scheduler.run("hunting_balance");
    const prepare = scheduler.run("hunting_liquidity");
    const closing = loops.stop();
    warming.resolve();
    await warm;
    const cacheStoppedAfterWarm = events.includes("cache-stopped");
    await scheduler.run("hunting_balance");
    const warmCount = events.filter((event) => event === "warm").length;
    preparation.resolve();
    await prepare;
    await closing;
    scheduler.stop();
    return { events, cacheStoppedAfterWarm, warmCount };
  },
};
