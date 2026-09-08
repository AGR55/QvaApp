import assert from "node:assert/strict";
import test from "node:test";
import { allocateBudget, marginCalculation } from "../src/dashboard.js";

test("calcula margen neto y punto de equilibrio incluyendo comisión", () => {
  const result = marginCalculation(970, 1010, 35, 0.25);
  assert.equal(result.cost, 33_950);
  assert.equal(result.netRevenue, 35_261.625);
  assert.equal(result.netProfit, 1_311.625);
  assert.ok(result.breakEvenRate > 970);
});

test("el margen incorpora la comisión fija de la transferencia saliente", () => {
  const result = marginCalculation(1.04, 1.12, 10, 0, 0.08);
  assert.ok(Math.abs(result.cost - 10.48) < 0.000001);
  assert.ok(Math.abs(result.breakEvenRate - 1.048) < 0.000001);
});

test("distribuye presupuesto por mejores tasas sin exceder la reserva", () => {
  const allocation = allocateBudget(35_000, 1_000, 35, [
    { rate: 980, amount: 20 },
    { rate: 970, amount: 20 },
  ]);
  assert.deepEqual(allocation, [
    { rate: 970, fiat: 19_400, qusd: 20 },
    { rate: 980, fiat: 14_600, qusd: 14.89795918367347 },
  ]);
});
