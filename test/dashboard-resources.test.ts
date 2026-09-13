import assert from "node:assert/strict";
import test from "node:test";
import { dashboardResources } from "../web/lib/dashboard-resources.js";

const snapshot = {
  markets: [
    { code: "BANK_CUP", active: true, huntBuyEnabled: true, huntSellEnabled: false },
    { code: "CLASICA", active: true, huntBuyEnabled: false, huntSellEnabled: false },
  ],
};

test("saldo y ofertas propias se sincronizan desde cualquier vista", () => {
  for (const view of ["resumen", "mercado", "ofertas", "caceria", "operaciones", "ajustes"]) {
    const keys = dashboardResources(view, "CLASICA", snapshot).map(([key]) => key);
    assert.ok(keys.includes("balance"), `${view} no incluyó balance`);
    assert.ok(keys.includes("ownOffers"), `${view} no incluyó ownOffers`);
    assert.equal(new Set(keys).size, keys.length, `${view} repitió recursos`);
  }
});
