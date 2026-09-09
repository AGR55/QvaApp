import assert from "node:assert/strict";
import test from "node:test";
import {
  conservativeRiskLimits,
  evaluateRisk,
  type RiskContext,
} from "../src/core/risk-policy.js";

const now = Date.parse("2026-09-06T12:00:00Z");

function context(overrides: Partial<RiskContext> = {}): RiskContext {
  return {
    now,
    opportunity: {
      uuid: "offer-1",
      market: "BANK_CUP",
      side: "sell_qusd",
      qusdAmount: 20,
      requiredFiat: 20_000,
      quotedRate: 1_010,
      referenceRate: 1_005,
      observedAt: now - 5_000,
      counterpartyId: "peer-1",
    },
    limits: { ...conservativeRiskLimits },
    priceDecision: "eligible",
    priceReason: "Supera el mínimo de venta.",
    expectedMarginPercent: 2,
    qusdBalance: 100,
    fiatAvailable: 100_000,
    concurrentQusdExposure: 5,
    dailyAppliedQusd: 20,
    activeOperations: 1,
    consecutiveErrors: 0,
    paused: false,
    emergencyStop: false,
    hasUnresolvedMutation: false,
    ...overrides,
  };
}

test("autoriza una oportunidad solo cuando todas las reglas pasan", () => {
  const decision = evaluateRisk(context());

  assert.equal(decision.kind, "apply");
  assert.equal(decision.requiredQusd, 20);
  assert.equal(decision.requiredFiat, 0);
  assert.equal(decision.projectedExposureQusd, 25);
  assert.ok(decision.checks.every((check) => check.status !== "fail"));
});

test("devuelve todas las razones de bloqueo en una sola evaluación", () => {
  const decision = evaluateRisk(
    context({
      emergencyStop: true,
      hasUnresolvedMutation: true,
      activeOperations: 2,
      dailyAppliedQusd: 95,
      concurrentQusdExposure: 45,
      qusdBalance: 25,
    }),
  );

  assert.equal(decision.kind, "blocked");
  assert.ok(decision.reasons.length >= 5);
  assert.ok(
    decision.checks.some(
      (check) => check.code === "unresolved_mutation" && check.status === "fail",
    ),
  );
  assert.ok(
    decision.checks.some(
      (check) => check.code === "qusd_capital" && check.status === "fail",
    ),
  );
});

test("distingue una oferta ignorada de una oferta bloqueada", () => {
  const decision = evaluateRisk(
    context({
      priceDecision: "ignored",
      priceReason: "No alcanza el precio mínimo configurado.",
    }),
  );

  assert.equal(decision.kind, "ignored");
  assert.deepEqual(decision.reasons, [
    "No alcanza el precio mínimo configurado.",
  ]);
});

test("mantiene la revisión manual aunque otros límites pasen", () => {
  const decision = evaluateRisk(
    context({
      priceDecision: "manual_review",
      priceReason: "La referencia de mercado tiene pocas muestras.",
    }),
  );

  assert.equal(decision.kind, "manual_review");
  assert.equal(decision.checks[0]?.code, "price_policy");
});

test("solo la cotización antigua bloquea; slippage y cooldown son advertencias", () => {
  const decision = evaluateRisk(
    context({
      opportunity: {
        ...context().opportunity,
        quotedRate: 1_030,
        observedAt: now - 60_000,
      },
      lastMarketOperationAt: now - 10_000,
      lastCounterpartyOperationAt: now - 60_000,
    }),
  );

  assert.equal(decision.kind, "blocked");
  assert.ok(decision.checks.some((check) => check.code === "quote_age" && check.status === "fail"));
  for (const code of ["slippage", "market_cooldown", "counterparty_cooldown"])
    assert.ok(decision.checks.some((check) => check.code === code && check.status === "warning"));
});

test("slippage y cooldown no impiden aplicar cuando pasan las protecciones duras", () => {
  const decision = evaluateRisk(context({
    opportunity: { ...context().opportunity, quotedRate: 1_030, observedAt: now },
    lastMarketOperationAt: now - 10_000,
    lastCounterpartyOperationAt: now - 60_000,
  }));

  assert.equal(decision.kind, "apply");
  assert.equal(decision.checks.filter((check) => check.status === "warning").length, 3);
});

test("una compra de QUSD consume fiat, no la reserva QUSD", () => {
  const base = context();
  const decision = evaluateRisk(
    context({
      opportunity: {
        ...base.opportunity,
        side: "buy_qusd",
        requiredFiat: 20_000,
      },
      fiatAvailable: 19_999,
      qusdBalance: 0,
    }),
  );

  assert.equal(decision.kind, "blocked");
  assert.equal(decision.requiredQusd, 0);
  assert.equal(decision.requiredFiat, 20_000);
  assert.ok(
    decision.checks.some(
      (check) => check.code === "fiat_capital" && check.status === "fail",
    ),
  );
});

test("rechaza NaN e infinitos para fallar de forma segura", () => {
  assert.throws(
    () => evaluateRisk(context({ dailyAppliedQusd: Number.NaN })),
    /finitos y no negativos/,
  );
});
