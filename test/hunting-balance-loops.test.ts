import assert from "node:assert/strict";
import test from "node:test";
import { registerHuntingBalanceLoops } from "../src/application/hunting-balance-loops.js";
import { Scheduler } from "../src/scheduler.js";

test("cierre espera trabajos completos antes de cerrar caché y no inicia otros", async () => {
  const scheduler = new Scheduler();
  let releaseWarm!: () => void, releasePreparation!: () => void;
  const warming = new Promise<void>(resolve => { releaseWarm = resolve; });
  const preparation = new Promise<void>(resolve => { releasePreparation = resolve; });
  const events: string[] = [];
  const loops = registerHuntingBalanceLoops(scheduler, {
    refreshHuntingQusdBalance: async () => { events.push("warm"); await warming; events.push("warm-completed"); },
    prepareHuntingLiquidity: async () => { events.push("prepare"); await preparation; events.push("prepare-completed"); },
    stopHuntingBalanceReads: async () => { events.push("cache-stopped"); },
  });
  const warm = scheduler.run("hunting_balance");
  const prepare = scheduler.run("hunting_liquidity");
  const closing = loops.stop();
  releaseWarm(); await warm;
  assert.equal(events.includes("cache-stopped"), false);
  await scheduler.run("hunting_balance");
  assert.equal(events.filter(event => event === "warm").length, 1);
  releasePreparation(); await prepare; await closing;
  assert.deepEqual(events, ["warm", "prepare", "warm-completed", "prepare-completed", "cache-stopped"]);
  scheduler.stop();
});
