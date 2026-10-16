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

test("el panel delega controles de cacería al motor", () => {
  const calls: unknown[] = [];
  const dashboard = new DashboardReadModel(
    { updateHunting: (value: unknown) => calls.push(value) } as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );
  dashboard.updateHunting({
    sellRunning: false,
    market: { code: "CLASICA", huntBuyEnabled: true, buyMaxRate: 1.04 },
  });
  assert.deepEqual(calls, [{
    sellRunning: false,
    market: { code: "CLASICA", huntBuyEnabled: true, buyMaxRate: 1.04 },
  }]);
});


test("el refresco periódico reutiliza mercados y el manual permite actualizarlos", async () => {
  const calls: string[] = [];
  const dashboard = new DashboardReadModel(
    { activeMarkets: () => [{ code: "CUP" }, { code: "CLASICA" }] } as never,
    {} as never, {} as never, {} as never, {} as never,
  );
  dashboard.refreshBalance = async () => { calls.push("balance"); return undefined as never; };
  dashboard.refreshOwnOffers = async () => { calls.push("own"); return undefined as never; };
  dashboard.refreshTransactions = async () => { calls.push("transactions"); return undefined as never; };
  dashboard.refreshMarket = async (code) => { calls.push(code); return undefined as never; };
  await dashboard.refreshCache({ refreshMarkets: false });
  assert.deepEqual(calls, ["balance", "own", "transactions"]);
  calls.length = 0;
  await dashboard.refreshCache();
  assert.deepEqual(calls, ["balance", "own", "transactions", "CUP", "CLASICA"]);
});
