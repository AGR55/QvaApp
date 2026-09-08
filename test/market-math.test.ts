import assert from "node:assert/strict";
import test from "node:test";
import { median, outgoingFiatCost } from "../src/market-math.js";

test("calcula la mediana sin dejar que extremos dominen la referencia", () => {
  assert.equal(median([1.03, 1.04, 8, 1.02, 1.05]), 1.04);
  assert.equal(median([930, 910, 940, 920]), 925);
});

test("la mediana ignora valores inválidos y puede quedar sin referencia", () => {
  assert.equal(median([Number.NaN, 0, -1, Number.POSITIVE_INFINITY]), undefined);
});

test("el costo de salida suma la comisión fija y expone la tasa efectiva", () => {
  assert.deepEqual(outgoingFiatCost(10, 1.04, 0.08), {
    nominal: 10.4,
    fee: 0.08,
    total: 10.48,
    effectiveRate: 1.048,
  });
  assert.equal(outgoingFiatCost(10, 1.04, 0).total, 10.4);
});
