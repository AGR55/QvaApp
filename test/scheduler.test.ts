import assert from "node:assert/strict";
import test from "node:test";
import { Scheduler } from "../src/scheduler.js";

test("impide solapar dos ejecuciones de la misma tarea", async () => {
  let release: (() => void) | undefined;
  let calls = 0;
  const scheduler = new Scheduler();
  scheduler.register("scan", 1_000, async () => {
    calls += 1;
    await new Promise<void>((resolve) => {
      release = resolve;
    });
  });

  const first = scheduler.run("scan");
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(await scheduler.run("scan"), false);
  assert.equal(calls, 1);
  release?.();
  assert.equal(await first, true);
});

test("detiene intervalos y rechaza nuevas ejecuciones al cerrar", async () => {
  const scheduler = new Scheduler();
  scheduler.register("job", 1_000, async () => undefined);
  scheduler.start();
  scheduler.stop();
  assert.equal(await scheduler.run("job"), false);
});
