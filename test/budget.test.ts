import assert from "node:assert/strict";
import test from "node:test";
import { proportionalBudgetPlan } from "../src/budget.js";

const offers = [
  {
    uuid: "a",
    coin: "BANK_CUP" as const,
    type: "buy",
    status: "open",
    amount: 10,
    rate: 1_000,
  },
  {
    uuid: "b",
    coin: "BANK_CUP" as const,
    type: "buy",
    status: "open",
    amount: 20,
    rate: 1_000,
  },
];
test("reduce todas las compras proporcionalmente y conserva la tasa", () => {
  const plan = proportionalBudgetPlan(offers, "BANK_CUP", 15_000, 1_010);
  assert.equal(plan.deficit, 15_000);
  assert.deepEqual(
    plan.adjustments.map((item) => [item.uuid, item.proposedQusd, item.rate]),
    [
      ["a", 5, 1_000],
      ["b", 10, 1_000],
    ],
  );
  assert.ok(
    plan.adjustments.reduce((sum, item) => sum + item.proposedFiat, 0) <=
      15_000,
  );
});
test("ignora importes o tasas inválidas para que no inflen el presupuesto", () => {
  const plan = proportionalBudgetPlan(
    [
      ...offers,
      {
        uuid: "bad",
        coin: "BANK_CUP",
        type: "buy",
        status: "open",
        amount: 10,
        rate: 1e18,
      },
    ],
    "BANK_CUP",
    30_000,
    1_010,
  );
  assert.equal(plan.deficit, 0);
  assert.deepEqual(plan.invalid, ["bad"]);
});

test("reserva una comisión fija por cada oferta de compra", () => {
  const plan = proportionalBudgetPlan(
    [
      { uuid: "a", coin: "CLASICA", type: "buy", status: "open", amount: 10, rate: 1.04 },
      { uuid: "b", coin: "CLASICA", type: "buy", status: "open", amount: 5, rate: 1.03 },
    ],
    "CLASICA",
    20,
    1.1,
    0.08,
  );
  assert.ok(Math.abs(plan.committed - 15.71) < 0.000001);
  assert.equal(plan.available, 20);
});

test("usa el total fiat remoto y respeta el redondeo transferible del mercado", () => {
  const plan = proportionalBudgetPlan(
    [{
      uuid: "cup-rounded",
      coin: "BANK_CUP",
      type: "buy",
      status: "open",
      amount: 10,
      rate: 973.7,
      receive: 9_730,
    }],
    "BANK_CUP",
    9_000,
    980,
    0,
    "CUP",
  );

  assert.equal(plan.committed, 9_730);
  assert.ok(plan.adjustments[0]!.proposedFiat <= 9_000);
  assert.equal(plan.adjustments[0]!.rate, 973.7);
});

test("cancela una compra CUP si el presupuesto no alcanza una decena", () => {
  const plan = proportionalBudgetPlan(
    [{
      uuid: "cup-underflow",
      coin: "BANK_CUP",
      type: "buy",
      status: "open",
      amount: 10,
      rate: 973.7,
      receive: 9_730,
    }],
    "BANK_CUP",
    10,
    980,
    0,
    "CUP",
  );

  assert.deepEqual(plan.adjustments, [{
    uuid: "cup-underflow",
    coin: "BANK_CUP",
    rate: 973.7,
    currentQusd: 10,
    proposedQusd: 0,
    currentFiat: 9_730,
    proposedFiat: 0,
    releasedFiat: 9_730,
    action: "cancel",
  }]);
});
