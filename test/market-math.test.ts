import assert from "node:assert/strict";
import test from "node:test";
import {
  median,
  outgoingFiatCost,
  ownOfferFiatTotal,
} from "../src/market-math.js";

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

test("redondea compras CUP hacia abajo al múltiplo de diez", () => {
  assert.equal(ownOfferFiatTotal(9, 973.7, "buy", "CUP"), 8_760);
  assert.equal(ownOfferFiatTotal(10, 920, "buy", "CUP"), 9_200);
});

test("redondea ventas CUP hacia arriba al múltiplo de diez", () => {
  assert.equal(ownOfferFiatTotal(9, 973.7, "sell", "CUP"), 8_770);
  assert.equal(ownOfferFiatTotal(10, 920, "sell", "CUP"), 9_200);
});

test("conserva la precisión razonable en mercados que no son CUP", () => {
  assert.equal(ownOfferFiatTotal(2, 1.06, "buy", "USD"), 2.12);
  assert.equal(ownOfferFiatTotal(3, 1.123456789, "sell", "USD"), 3.37037037);
});

test("rechaza una compra CUP que no puede producir una decena positiva", () => {
  assert.throws(
    () => ownOfferFiatTotal(0.1, 1.06, "buy", "CUP"),
    /total fiat válido/i,
  );
});
