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

test("prioriza la menos rentable pero permite liberar una oferta igual o mejor", () => {
  const plan = planLiquidity({
    target,
    availableQusd: 10,
    reserveQusd: 10,
    ownOffers: [own("equal", 30, 1_020), own("better", 30, 1_030)],
  });

  assert.equal(plan.feasible, true);
  assert.deepEqual(plan.cancel.map((offer) => offer.uuid), ["equal"]);
});

test("usa el QUSD retenido en una venta propia aunque su tasa publicada sea mejor", () => {
  const plan = planLiquidity({
    target: { ...target, amount: 58.63, receive: 58.63 * 1_020 },
    availableQusd: 0,
    reserveQusd: 0,
    ownOffers: [own("locked-qusd", 100, 1_030)],
  });

  assert.equal(plan.feasible, true);
  assert.equal(plan.plannedReleaseQusd, 100);
  assert.equal(plan.cancel[0]?.uuid, "locked-qusd");
  assert.equal(plan.cancel[0]?.consumeQusd, 58.63);
  assert.equal(plan.cancel[0]?.restoreQusd, 41.37);
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

test("combina ventas propias de distintos mercados y reserva solo el volumen necesario", () => {
  const plan = planLiquidity({
    target: { ...target, amount: 73, receive: 72_400 },
    availableQusd: 0,
    reserveQusd: 0,
    ownOffers: [
      own("cup-one", 16.51, 975),
      own("cup-two", 20, 985),
      own("classic-one", 20, 1.13, { coin: "CLASICA" }),
      own("classic-two", 50, 1.13, { coin: "CLASICA" }),
    ],
    marketEconomics: {
      BANK_CUP: { buyMaxRate: 930, sellFeePercent: 0, outgoingTransferFee: 0 },
      CLASICA: { buyMaxRate: 1.06, sellFeePercent: 0, outgoingTransferFee: 0.08 },
    },
  });

  assert.equal(plan.feasible, true);
  assert.ok(plan.cancel.some((offer) => offer.coin === "CLASICA"));
  assert.ok(plan.plannedReleaseQusd >= 73);
  assert.equal(
    plan.cancel.reduce((sum, offer) => sum + offer.consumeQusd, 0),
    73,
  );
  assert.ok(
    Math.abs(
      plan.cancel.reduce((sum, offer) => sum + offer.restoreQusd, 0) -
        (plan.plannedReleaseQusd - 73),
    ) < 0.000001,
  );
});

test("la liberación también cubre una reserva QUSD parcialmente descubierta", () => {
  const plan = planLiquidity({
    target,
    availableQusd: 5,
    reserveQusd: 10,
    ownOffers: [own("enough", 40, 1_000)],
  });

  assert.equal(plan.requiredReleaseQusd, 35);
  assert.equal(plan.feasible, true);
  assert.equal(plan.cancel[0]?.consumeQusd, 35);
  assert.equal(plan.cancel[0]?.restoreQusd, 5);
});
