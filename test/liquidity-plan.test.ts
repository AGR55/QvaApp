import assert from "node:assert/strict";
import test from "node:test";
import { planLiquidity } from "../src/core/liquidity-plan.js";
import type { P2pOffer } from "../src/types.js";

const target: P2pOffer = {
  uuid: "external",
  type: "buy",
  coin: "BANK_CUP",
  amount: 30,
  receive: 30_600,
  status: "open",
};

const own = (
  uuid: string,
  amount: number,
  ownRate: number,
  overrides: Partial<P2pOffer> = {},
): P2pOffer => ({
  uuid,
  type: "sell",
  coin: "BANK_CUP",
  amount,
  receive: amount * ownRate,
  status: "open",
  details: { cuenta: `ACC-${uuid}` },
  message: "Pago verificado",
  tags: ["transferencia"],
  ...overrides,
});

test("no cancela si el saldo libre ya cubre la oferta externa", () => {
  const plan = planLiquidity({
    target,
    availableQusd: 50,
    reserveQusd: 10,
    ownOffers: [own("a", 20, 1_000)],
  });

  assert.equal(plan.feasible, true);
  assert.deepEqual(plan.cancel, []);
});

test("elige primero las ventas propias con peor tasa y guarda snapshot", () => {
  const plan = planLiquidity({
    target,
    availableQusd: 15,
    reserveQusd: 10,
    ownOffers: [
      own("better", 20, 1_015),
      own("worst", 10, 990, { only_kyc: 1 }),
      own("middle", 20, 1_000),
    ],
  });

  assert.equal(plan.feasible, true);
  assert.deepEqual(
    plan.cancel.map((offer) => offer.uuid),
    ["worst", "middle"],
  );
  assert.equal(plan.plannedReleaseQusd, 30);
  assert.deepEqual(plan.cancel[0]?.details, [
    { name: "cuenta", value: "ACC-worst" },
  ]);
  assert.equal(plan.cancel[0]?.onlyKyc, true);
});

test("nunca cancela una oferta propia igual o mejor que la externa", () => {
  const plan = planLiquidity({
    target,
    availableQusd: 10,
    reserveQusd: 10,
    ownOffers: [own("equal", 30, 1_020), own("better", 30, 1_030)],
  });

  assert.equal(plan.feasible, false);
  assert.deepEqual(plan.cancel, []);
});

test("no ejecuta un plan parcial si la suma liberada no alcanza", () => {
  const plan = planLiquidity({
    target,
    availableQusd: 15,
    reserveQusd: 10,
    ownOffers: [own("small", 20, 1_000)],
  });

  assert.equal(plan.requiredReleaseQusd, 25);
  assert.equal(plan.feasible, false);
  assert.equal(plan.plannedReleaseQusd, 0);
  assert.deepEqual(plan.cancel, []);
});

test("ignora mercados, tipos y estados que no liberan el QUSD objetivo", () => {
  const plan = planLiquidity({
    target,
    availableQusd: 10,
    reserveQusd: 10,
    ownOffers: [
      own("other-market", 40, 900, { coin: "CLASICA" }),
      own("closed", 40, 900, { status: "processing" }),
      own("buy", 40, 900, { type: "buy" }),
    ],
  });

  assert.equal(plan.feasible, false);
  assert.deepEqual(plan.cancel, []);
});
