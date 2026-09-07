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
