import assert from "node:assert/strict";
import test from "node:test";
import { DashboardReadModel } from "../src/dashboard.js";

test("el panel valida QvaPay al reanudar y pausa localmente", async () => {
  const calls: string[] = [];
  const trading = {
    setPaused: (paused: boolean, source: string) => calls.push(`pause:${paused}:${source}`),
    activate: async () => void calls.push("activate"),
  };
  const dashboard = new DashboardReadModel(
    trading as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );

  await dashboard.setPaused(true);
  await dashboard.setPaused(false);

  assert.deepEqual(calls, ["pause:true:panel web", "activate"]);
});
