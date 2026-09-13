import assert from "node:assert/strict";
import test from "node:test";
import { roundRateForIndex } from "../src/market-math.js";

test("redondea la compra hacia arriba con la precisión del índice", () => {
  assert.equal(roundRateForIndex(1.051, "buy", 1.06), 1.06);
  assert.equal(roundRateForIndex(924.01, "buy", 925), 925);
});

test("redondea la venta hacia abajo con la precisión del índice", () => {
  assert.equal(roundRateForIndex(1.1249, "sell", 1.12), 1.12);
  assert.equal(roundRateForIndex(1_025.99, "sell", 1_025), 1_025);
});
