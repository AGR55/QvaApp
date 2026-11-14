/**
 * Generador repetible de goldens de dominio puro (F0).
 *
 * Deriva cada `expect` ejecutando el **oráculo TypeScript congelado** a través
 * de los adaptadores de `parity/adapters/ops/*`, y valida además las
 * aserciones literales de los tests de origen (`check`). No inventa valores:
 * el `expect` es la respuesta real del oráculo bajo el mismo transporte JSON
 * que usa el runner (input serializado y expect re-serializado).
 *
 * Uso:
 *   node --import tsx parity/tools/generate-domain-goldens.ts          # regenera
 *   node --import tsx parity/tools/generate-domain-goldens.ts --check  # solo verifica
 *
 * Cada fichero lleva en `notes` el `goldenHash` (sha256 canónico de `cases`):
 * regenerar sin cambios debe producirlo idéntico.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalHash } from "../lib/canonical.js";
import { conservativeRiskLimits } from "../../src/core/risk-policy.js";
import { ops as riskOps } from "../adapters/ops/risk-policy.js";
import { ops as liquidityOps } from "../adapters/ops/liquidity-plan.js";
import { ops as budgetOps } from "../adapters/ops/budget.js";
import { ops as flexibleOps } from "../adapters/ops/flexible-order.js";
import { ops as huntingOps } from "../adapters/ops/hunting-requirements.js";
import { ops as reconciliationOps } from "../adapters/ops/reconciliation-scheduler.js";
import { ops as applyBudgetOps } from "../adapters/ops/apply-budget.js";
import { ops as marketMathOps } from "../adapters/ops/market-math.js";

type Input = Record<string, unknown>;
type Handler = (input: Input) => unknown;

const COMMIT = "02bb5afc04b5eb95f5ac3996ef7634dedf073d02";
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");
const goldenDir = join(repoRoot, "parity", "golden", "v1", "pure");

const registry: Record<string, Handler> = {
  ...riskOps,
  ...liquidityOps,
  ...budgetOps,
  ...flexibleOps,
  ...huntingOps,
  ...reconciliationOps,
  ...applyBudgetOps,
  ...marketMathOps,
};

interface CaseDef {
  caseId: string;
  op: string;
  source: string;
  input: Input;
  /** Aserciones tomadas literalmente del test de origen. */
  check?: (result: ReturnType<Handler>) => void;
  /** Si el test espera un throw, aquí se declara el contrato de error. */
  expectError?: { class: string; messageIncludes: string };
}

interface ModuleSpec {
  file: string;
  module: string;
  sourceTests: string[];
  notes: string;
  cases: CaseDef[];
}

// ---------------------------------------------------------------------------
// Helpers de construcción de vectores (espejo de los tests de origen)
// ---------------------------------------------------------------------------

const RISK_NOW = Date.parse("2026-09-06T12:00:00Z");

function riskContext(overrides: Input = {}): Input {
  const opportunity: Input = {
    uuid: "offer-1",
    market: "BANK_CUP",
    side: "sell_qusd",
    qusdAmount: 20,
    requiredFiat: 20_000,
    quotedRate: 1_010,
    referenceRate: 1_005,
    observedAt: RISK_NOW - 5_000,
    counterpartyId: "peer-1",
    ...(overrides.opportunity as Input | undefined),
  };
  return {
    now: RISK_NOW,
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
    opportunity,
    limits: { ...conservativeRiskLimits },
  };
}

const LIQUIDITY_TARGET: Input = {
  uuid: "external",
  type: "buy",
  coin: "BANK_CUP",
  amount: 30,
  receive: 30_600,
  status: "open",
};

function own(uuid: string, amount: number, ownRate: number, overrides: Input = {}): Input {
  return {
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
  };
}

const BANK_CUP_OFFERS: Input[] = [
  { uuid: "a", coin: "BANK_CUP", type: "buy", status: "open", amount: 10, rate: 1_000 },
  { uuid: "b", coin: "BANK_CUP", type: "buy", status: "open", amount: 20, rate: 1_000 },
];

const FLEXIBLE_OFFER: Input = {
  uuid: "parent",
  type: "sell",
  coin: "BANK_CUP",
  amount: 100,
  receive: 90_000,
  status: "open",
  offer_kind: "flexible",
  available_amount: "70",
  order_min: "5",
  order_max: "30",
};

function flexibleChild(overrides: Input = {}): Input {
  return {
    uuid: "child",
    amount: 10,
    receive: 9_000,
    status: "paid",
    created_at: new Date(10_000).toISOString(),
    Taker: { uuid: "me" },
    ...overrides,
  };
}

function remoteWithOrders(orders: Input[], overrides: Input = {}): Input {
  return { ...FLEXIBLE_OFFER, Orders: orders, ...overrides };
}

const HUNTING_OFFER: Input = {
  uuid: "offer",
  type: "sell",
  coin: "CUP",
  amount: 10,
  receive: 100,
  status: "open",
  requirements: { min_completed: 25, min_rating: 4 },
};

const RECON_START = 1_800_000_000_000;

// ---------------------------------------------------------------------------
// Especificaciones de lote (casos derivados de los tests reales)
// ---------------------------------------------------------------------------

const modules: ModuleSpec[] = [
  {
    file: "market-math.json",
    module: "src/market-math.ts",
    sourceTests: ["test/market-math.test.ts", "test/rate-rounding.test.ts"],
    notes:
      "Primer lote del arnés: prueba el bucle runner→adaptador→canonización. Los importes/tasas viajan como string decimal de escala fija; una diferencia de tipo (number vs string) es un fallo, no una tolerancia.",
    cases: [
      {
        caseId: "pure/market-math/median/0001",
        op: "market.median",
        source: "test/market-math.test.ts:7",
        input: { values: [1.03, 1.04, 8, 1.02, 1.05] },
        check: (result) => {
          assert.equal((result as { value: string }).value, "1.04000000");
        },
      },
      {
        caseId: "pure/market-math/median/0002",
        op: "market.median",
        source: "test/market-math.test.ts:8",
        input: { values: [930, 910, 940, 920] },
        check: (result) => {
          assert.equal((result as { value: string }).value, "925.00000000");
        },
      },
      {
        caseId: "pure/market-math/median/0003",
        op: "market.median",
        source: "test/market-math.test.ts:12",
        input: { values: [0, -1] },
        check: (result) => {
          assert.equal((result as { value: null }).value, null);
        },
      },
      {
        caseId: "pure/market-math/outgoing-fiat-cost/0001",
        op: "market.outgoingFiatCost",
        source: "test/market-math.test.ts:16",
        input: { qusdAmount: 10, fiatPerQusd: 1.04, fixedFee: 0.08 },
        check: (result) => {
          const value = result as Record<string, string>;
          assert.equal(value.nominal, "10.40000000");
          assert.equal(value.fee, "0.08000000");
          assert.equal(value.total, "10.48000000");
          assert.equal(value.effectiveRate, "1.04800000");
        },
      },
      {
        caseId: "pure/market-math/outgoing-fiat-cost/0002",
        op: "market.outgoingFiatCost",
        source: "test/market-math.test.ts:22",
        input: { qusdAmount: 10, fiatPerQusd: 1.04, fixedFee: 0 },
        check: (result) => {
          const value = result as Record<string, string>;
          assert.equal(value.nominal, "10.40000000");
          assert.equal(value.fee, "0.00000000");
          assert.equal(value.total, "10.40000000");
          assert.equal(value.effectiveRate, "1.04000000");
        },
      },
      {
        caseId: "pure/market-math/own-offer-fiat/CUP-buy/0001",
        op: "market.ownOfferFiatTotal",
        source: "test/market-math.test.ts:26",
        input: { qusdAmount: 9, fiatPerQusd: 973.7, type: "buy", currency: "CUP" },
        check: (result) => {
          assert.equal((result as { value: string }).value, "8760");
        },
      },
      {
        caseId: "pure/market-math/own-offer-fiat/CUP-buy/0002",
        op: "market.ownOfferFiatTotal",
        source: "test/market-math.test.ts:27",
        input: { qusdAmount: 10, fiatPerQusd: 920, type: "buy", currency: "CUP" },
        check: (result) => {
          assert.equal((result as { value: string }).value, "9200");
        },
      },
      {
        caseId: "pure/market-math/own-offer-fiat/CUP-sell/0001",
        op: "market.ownOfferFiatTotal",
        source: "test/market-math.test.ts:31",
        input: { qusdAmount: 9, fiatPerQusd: 973.7, type: "sell", currency: "CUP" },
        check: (result) => {
          assert.equal((result as { value: string }).value, "8770");
        },
      },
      {
        caseId: "pure/market-math/own-offer-fiat/CUP-sell/0002",
        op: "market.ownOfferFiatTotal",
        source: "test/market-math.test.ts:32",
        input: { qusdAmount: 10, fiatPerQusd: 920, type: "sell", currency: "CUP" },
        check: (result) => {
          assert.equal((result as { value: string }).value, "9200");
        },
      },
      {
        caseId: "pure/market-math/own-offer-fiat/USD-buy/0001",
        op: "market.ownOfferFiatTotal",
        source: "test/market-math.test.ts:36",
        input: { qusdAmount: 2, fiatPerQusd: 1.06, type: "buy", currency: "USD" },
        check: (result) => {
          assert.equal((result as { value: string }).value, "2.12000000");
        },
      },
      {
        caseId: "pure/market-math/own-offer-fiat/USD-sell/0001",
        op: "market.ownOfferFiatTotal",
        source: "test/market-math.test.ts:37",
        input: { qusdAmount: 3, fiatPerQusd: 1.123456789, type: "sell", currency: "USD" },
        check: (result) => {
          assert.equal((result as { value: string }).value, "3.37037037");
        },
      },
      {
        caseId: "pure/market-math/own-offer-fiat/CUP-invalid/0001",
        op: "market.ownOfferFiatTotal",
        source: "test/market-math.test.ts:41",
        input: { qusdAmount: 0.1, fiatPerQusd: 1.06, type: "buy", currency: "CUP" },
        expectError: { class: "validation", messageIncludes: "total fiat" },
      },
      {
        caseId: "pure/market-math/round-rate/buy/0001",
        op: "market.roundRateForIndex",
        source: "test/rate-rounding.test.ts:4",
        input: { effectiveRate: 1.051, type: "buy", configuredIndex: 1.06 },
        check: (result) => {
          assert.equal((result as { value: string }).value, "1.06");
        },
      },
      {
        caseId: "pure/market-math/round-rate/buy/0002",
        op: "market.roundRateForIndex",
        source: "test/rate-rounding.test.ts:5",
        input: { effectiveRate: 924.01, type: "buy", configuredIndex: 925 },
        check: (result) => {
          assert.equal((result as { value: string }).value, "925");
        },
      },
      {
        caseId: "pure/market-math/round-rate/sell/0001",
        op: "market.roundRateForIndex",
        source: "test/rate-rounding.test.ts:9",
        input: { effectiveRate: 1.1249, type: "sell", configuredIndex: 1.12 },
        check: (result) => {
          assert.equal((result as { value: string }).value, "1.12");
        },
      },
      {
        caseId: "pure/market-math/round-rate/sell/0002",
        op: "market.roundRateForIndex",
        source: "test/rate-rounding.test.ts:10",
        input: { effectiveRate: 1025.99, type: "sell", configuredIndex: 1025 },
        check: (result) => {
          assert.equal((result as { value: string }).value, "1025");
        },
      },
      {
        caseId: "pure/market-math/round-qusd/0001",
        op: "market.roundQusd",
        source: "test/market-math.test.ts",
        input: { value: 1.234567891 },
        check: (result) => {
          assert.equal((result as { value: string }).value, "1.23456789");
        },
      },
      {
        caseId: "pure/market-math/round-qusd/0002",
        op: "market.roundQusd",
        source: "test/market-math.test.ts",
        input: { value: 1.234567895 },
        check: (result) => {
          assert.equal((result as { value: string }).value, "1.23456790");
        },
      },
    ],
  },
  {
    file: "risk-policy.json",
    module: "src/core/risk-policy.ts",
    sourceTests: ["test/risk-policy.test.ts"],
    notes:
      "Dominio de riesgo puro: decisión, cheques y razones. Importes QUSD como string decimal de escala 8; evidencia numérica de los checks normalizada a la misma escala.",
    cases: [
      {
        caseId: "pure/risk-policy/apply/0001",
        op: "risk.evaluate",
        source: "test/risk-policy.test.ts:42",
        input: riskContext(),
        check: (result) => {
          const decision = result as Record<string, unknown>;
          assert.equal(decision.kind, "apply");
          assert.equal(decision.requiredQusd, "20.00000000");
          assert.equal(decision.requiredFiat, "0.00000000");
          assert.equal(decision.projectedExposureQusd, "25.00000000");
          assert.equal(decision.projectedDailyAppliedQusd, "40.00000000");
          const checks = decision.checks as Array<{ status: string }>;
          assert.ok(checks.every((check) => check.status !== "fail"));
        },
      },
      {
        caseId: "pure/risk-policy/all-reasons/0001",
        op: "risk.evaluate",
        source: "test/risk-policy.test.ts:52",
        input: riskContext({
          emergencyStop: true,
          hasUnresolvedMutation: true,
          activeOperations: 2,
          dailyAppliedQusd: 95,
          concurrentQusdExposure: 45,
          qusdBalance: 25,
        }),
        check: (result) => {
          const decision = result as Record<string, unknown>;
          assert.equal(decision.kind, "blocked");
          assert.ok((decision.reasons as unknown[]).length >= 5);
          const checks = decision.checks as Array<{ code: string; status: string }>;
          assert.ok(checks.some((check) => check.code === "unresolved_mutation" && check.status === "fail"));
          assert.ok(checks.some((check) => check.code === "qusd_capital" && check.status === "fail"));
        },
      },
      {
        caseId: "pure/risk-policy/ignored/0001",
        op: "risk.evaluate",
        source: "test/risk-policy.test.ts:78",
        input: riskContext({
          priceDecision: "ignored",
          priceReason: "No alcanza el precio mínimo configurado.",
        }),
        check: (result) => {
          const decision = result as Record<string, unknown>;
          assert.equal(decision.kind, "ignored");
          assert.deepEqual(decision.reasons, ["No alcanza el precio mínimo configurado."]);
        },
      },
      {
        caseId: "pure/risk-policy/manual-review/0001",
        op: "risk.evaluate",
        source: "test/risk-policy.test.ts:92",
        input: riskContext({
          priceDecision: "manual_review",
          priceReason: "La referencia de mercado tiene pocas muestras.",
        }),
        check: (result) => {
          const decision = result as Record<string, unknown>;
          assert.equal(decision.kind, "manual_review");
          assert.equal((decision.checks as Array<{ code: string }>)[0]?.code, "price_policy");
        },
      },
      {
        caseId: "pure/risk-policy/stale-quote/0001",
        op: "risk.evaluate",
        source: "test/risk-policy.test.ts:104",
        input: riskContext({
          opportunity: { quotedRate: 1_030, observedAt: RISK_NOW - 60_000 },
          lastMarketOperationAt: RISK_NOW - 10_000,
          lastCounterpartyOperationAt: RISK_NOW - 60_000,
        }),
        check: (result) => {
          const decision = result as Record<string, unknown>;
          assert.equal(decision.kind, "blocked");
          const checks = decision.checks as Array<{ code: string; status: string }>;
          assert.ok(checks.some((check) => check.code === "quote_age" && check.status === "fail"));
          for (const code of ["slippage", "market_cooldown", "counterparty_cooldown"]) {
            assert.ok(checks.some((check) => check.code === code && check.status === "warning"));
          }
        },
      },
      {
        caseId: "pure/risk-policy/advisory-only/0001",
        op: "risk.evaluate",
        source: "test/risk-policy.test.ts:123",
        input: riskContext({
          opportunity: { quotedRate: 1_030, observedAt: RISK_NOW },
          lastMarketOperationAt: RISK_NOW - 10_000,
          lastCounterpartyOperationAt: RISK_NOW - 60_000,
        }),
        check: (result) => {
          const decision = result as Record<string, unknown>;
          assert.equal(decision.kind, "apply");
          const warnings = (decision.checks as Array<{ status: string }>).filter((check) => check.status === "warning");
          assert.equal(warnings.length, 3);
        },
      },
      {
        caseId: "pure/risk-policy/buy-qusd-fiat-capital/0001",
        op: "risk.evaluate",
        source: "test/risk-policy.test.ts:134",
        input: riskContext({
          opportunity: { side: "buy_qusd", requiredFiat: 20_000 },
          fiatAvailable: 19_999,
          qusdBalance: 0,
        }),
        check: (result) => {
          const decision = result as Record<string, unknown>;
          assert.equal(decision.kind, "blocked");
          assert.equal(decision.requiredQusd, "0.00000000");
          assert.equal(decision.requiredFiat, "20000.00000000");
          const checks = decision.checks as Array<{ code: string; status: string }>;
          assert.ok(checks.some((check) => check.code === "fiat_capital" && check.status === "fail"));
        },
      },
      {
        caseId: "pure/risk-policy/non-finite/0001",
        op: "risk.evaluate",
        source: "test/risk-policy.test.ts:158",
        input: riskContext({ dailyAppliedQusd: "NaN" }),
        expectError: { class: "validation", messageIncludes: "finitos y no negativos" },
      },
    ],
  },

  {
    file: "liquidity-plan.json",
    module: "src/core/liquidity-plan.ts",
    sourceTests: ["test/liquidity-plan.test.ts"],
    notes:
      "Plan de liquidez puro: selección determinista de ventas propias por rentabilidad y consumo/reposición de QUSD. Importes QUSD y rentabilidades como string decimal de escala 8.",
    cases: [
      {
        caseId: "pure/liquidity-plan/covered/0001",
        op: "liquidity.plan",
        source: "test/liquidity-plan.test.ts:33",
        input: { target: LIQUIDITY_TARGET, availableQusd: 50, reserveQusd: 10, ownOffers: [own("a", 20, 1_000)] },
        check: (result) => {
          const plan = result as Record<string, unknown>;
          assert.equal(plan.feasible, true);
          assert.deepEqual(plan.cancel, []);
        },
      },
      {
        caseId: "pure/liquidity-plan/range-not-capital/0001",
        op: "liquidity.plan",
        source: "test/liquidity-plan.test.ts:45",
        input: {
          target: LIQUIDITY_TARGET,
          availableQusd: 0,
          reserveQusd: 0,
          ownOffers: [
            own("range-own", 100, 1000, {
              offer_kind: "flexible",
              available_amount: 2,
              order_min: 5,
              order_max: 30,
            }),
            own("fixed-own", 5, 1000),
          ],
        },
        check: (result) => {
          const plan = result as Record<string, unknown>;
          assert.equal(plan.feasible, false);
          assert.equal(plan.potentialReleaseQusd, "5.00000000");
          assert.deepEqual(plan.cancel, []);
        },
      },
      {
        caseId: "pure/liquidity-plan/worst-first/0001",
        op: "liquidity.plan",
        source: "test/liquidity-plan.test.ts:54",
        input: {
          target: LIQUIDITY_TARGET,
          availableQusd: 15,
          reserveQusd: 10,
          ownOffers: [own("better", 20, 1_015), own("worst", 10, 990, { only_kyc: 1 }), own("middle", 20, 1_000)],
        },
        check: (result) => {
          const plan = result as Record<string, unknown>;
          assert.equal(plan.feasible, true);
          const cancel = plan.cancel as Array<{ uuid: string; details: unknown; onlyKyc: boolean }>;
          assert.deepEqual(cancel.map((offer) => offer.uuid), ["worst", "middle"]);
          assert.equal(plan.plannedReleaseQusd, "30.00000000");
          assert.deepEqual(cancel[0]?.details, [{ name: "cuenta", value: "ACC-worst" }]);
          assert.equal(cancel[0]?.onlyKyc, true);
        },
      },
      {
        caseId: "pure/liquidity-plan/equal-or-better/0001",
        op: "liquidity.plan",
        source: "test/liquidity-plan.test.ts:78",
        input: {
          target: LIQUIDITY_TARGET,
          availableQusd: 10,
          reserveQusd: 10,
          ownOffers: [own("equal", 30, 1_020), own("better", 30, 1_030)],
        },
        check: (result) => {
          const plan = result as Record<string, unknown>;
          assert.equal(plan.feasible, true);
          const cancel = plan.cancel as Array<{ uuid: string }>;
          assert.deepEqual(cancel.map((offer) => offer.uuid), ["equal"]);
        },
      },
      {
        caseId: "pure/liquidity-plan/locked-qusd/0001",
        op: "liquidity.plan",
        source: "test/liquidity-plan.test.ts:90",
        input: {
          target: { ...LIQUIDITY_TARGET, amount: 58.63, receive: 58.63 * 1_020 },
          availableQusd: 0,
          reserveQusd: 0,
          ownOffers: [own("locked-qusd", 100, 1_030)],
        },
        check: (result) => {
          const plan = result as Record<string, unknown>;
          assert.equal(plan.feasible, true);
          assert.equal(plan.plannedReleaseQusd, "100.00000000");
          const cancel = plan.cancel as Array<{ uuid: string; consumeQusd: string; restoreQusd: string }>;
          assert.equal(cancel[0]?.uuid, "locked-qusd");
          assert.equal(cancel[0]?.consumeQusd, "58.63000000");
          assert.equal(cancel[0]?.restoreQusd, "41.37000000");
        },
      },
      {
        caseId: "pure/liquidity-plan/partial-impossible/0001",
        op: "liquidity.plan",
        source: "test/liquidity-plan.test.ts:105",
        input: { target: LIQUIDITY_TARGET, availableQusd: 15, reserveQusd: 10, ownOffers: [own("small", 20, 1_000)] },
        check: (result) => {
          const plan = result as Record<string, unknown>;
          assert.equal(plan.requiredReleaseQusd, "25.00000000");
          assert.equal(plan.feasible, false);
          assert.equal(plan.plannedReleaseQusd, "0.00000000");
          assert.deepEqual(plan.cancel, []);
        },
      },
      {
        caseId: "pure/liquidity-plan/ignore-non-releasing/0001",
        op: "liquidity.plan",
        source: "test/liquidity-plan.test.ts:119",
        input: {
          target: LIQUIDITY_TARGET,
          availableQusd: 10,
          reserveQusd: 10,
          ownOffers: [
            own("other-market", 40, 900, { coin: "CLASICA" }),
            own("closed", 40, 900, { status: "processing" }),
            own("buy", 40, 900, { type: "buy" }),
          ],
        },
        check: (result) => {
          const plan = result as Record<string, unknown>;
          assert.equal(plan.feasible, false);
          assert.deepEqual(plan.cancel, []);
        },
      },
      {
        caseId: "pure/liquidity-plan/multi-market/0001",
        op: "liquidity.plan",
        source: "test/liquidity-plan.test.ts:135",
        input: {
          target: { ...LIQUIDITY_TARGET, amount: 73, receive: 72_400 },
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
        },
        check: (result) => {
          const plan = result as Record<string, unknown>;
          assert.equal(plan.feasible, true);
          const cancel = plan.cancel as Array<{ coin: string; consumeQusd: string; restoreQusd: string }>;
          assert.ok(cancel.some((offer) => offer.coin === "CLASICA"));
          assert.ok(Number(plan.plannedReleaseQusd) >= 73);
          const consumed = cancel.reduce((sum, offer) => sum + Number(offer.consumeQusd), 0);
          assert.equal(consumed, 73);
          const restored = cancel.reduce((sum, offer) => sum + Number(offer.restoreQusd), 0);
          assert.ok(Math.abs(restored - (Number(plan.plannedReleaseQusd) - 73)) < 0.000001);
        },
      },
      {
        caseId: "pure/liquidity-plan/partial-reserve/0001",
        op: "liquidity.plan",
        source: "test/liquidity-plan.test.ts:167",
        input: { target: LIQUIDITY_TARGET, availableQusd: 5, reserveQusd: 10, ownOffers: [own("enough", 40, 1_000)] },
        check: (result) => {
          const plan = result as Record<string, unknown>;
          assert.equal(plan.requiredReleaseQusd, "35.00000000");
          assert.equal(plan.feasible, true);
          const cancel = plan.cancel as Array<{ consumeQusd: string; restoreQusd: string }>;
          assert.equal(cancel[0]?.consumeQusd, "35.00000000");
          assert.equal(cancel[0]?.restoreQusd, "5.00000000");
        },
      },
    ],
  },

  {
    file: "budget.json",
    module: "src/budget.ts",
    sourceTests: ["test/budget.test.ts"],
    notes:
      "Plan presupuestario proporcional puro: recorte/cancelación determinista de compras propias. Importes fiat a escala de la moneda (CUP sin decimales, resto escala 8) y QUSD a escala 8.",
    cases: [
      {
        caseId: "pure/budget/proportional/0001",
        op: "budget.proportionalPlan",
        source: "test/budget.test.ts:23",
        input: { offers: BANK_CUP_OFFERS, coin: "BANK_CUP", available: 15_000, maximumRate: 1_010 },
        check: (result) => {
          const plan = result as Record<string, unknown>;
          assert.equal(plan.deficit, "15000.00000000");
          const adjustments = plan.adjustments as Array<{ uuid: string; proposedQusd: string; rate: string; proposedFiat: string }>;
          assert.deepEqual(
            adjustments.map((item) => [item.uuid, item.proposedQusd, item.rate]),
            [
              ["a", "5.00000000", "1000.00000000"],
              ["b", "10.00000000", "1000.00000000"],
            ],
          );
          const total = adjustments.reduce((sum, item) => sum + Number(item.proposedFiat), 0);
          assert.ok(total <= 15_000);
        },
      },
      {
        caseId: "pure/budget/invalid-rate/0001",
        op: "budget.proportionalPlan",
        source: "test/budget.test.ts:38",
        input: {
          offers: [...BANK_CUP_OFFERS, { uuid: "bad", coin: "BANK_CUP", type: "buy", status: "open", amount: 10, rate: 1e18 }],
          coin: "BANK_CUP",
          available: 30_000,
          maximumRate: 1_010,
        },
        check: (result) => {
          const plan = result as Record<string, unknown>;
          assert.equal(plan.deficit, "0.00000000");
          assert.deepEqual(plan.invalid, ["bad"]);
        },
      },
      {
        caseId: "pure/budget/fixed-fee/0001",
        op: "budget.proportionalPlan",
        source: "test/budget.test.ts:59",
        input: {
          offers: [
            { uuid: "a", coin: "CLASICA", type: "buy", status: "open", amount: 10, rate: 1.04 },
            { uuid: "b", coin: "CLASICA", type: "buy", status: "open", amount: 5, rate: 1.03 },
          ],
          coin: "CLASICA",
          available: 20,
          maximumRate: 1.1,
          outgoingTransferFee: 0.08,
        },
        check: (result) => {
          const plan = result as Record<string, unknown>;
          assert.ok(Math.abs(Number(plan.committed) - 15.71) < 0.000001);
          assert.equal(plan.available, "20.00000000");
        },
      },
      {
        caseId: "pure/budget/remote-total/0001",
        op: "budget.proportionalPlan",
        source: "test/budget.test.ts:74",
        input: {
          offers: [
            { uuid: "cup-rounded", coin: "BANK_CUP", type: "buy", status: "open", amount: 10, rate: 973.7, receive: 9_730 },
          ],
          coin: "BANK_CUP",
          available: 9_000,
          maximumRate: 980,
          outgoingTransferFee: 0,
          currency: "CUP",
        },
        check: (result) => {
          const plan = result as Record<string, unknown>;
          assert.equal(plan.committed, "9730");
          const adjustments = plan.adjustments as Array<{ proposedFiat: string; rate: string }>;
          assert.ok(Number(adjustments[0]?.proposedFiat) <= 9_000);
          assert.equal(adjustments[0]?.rate, "973.70000000");
        },
      },
      {
        caseId: "pure/budget/cup-underflow-cancel/0001",
        op: "budget.proportionalPlan",
        source: "test/budget.test.ts:97",
        input: {
          offers: [
            { uuid: "cup-underflow", coin: "BANK_CUP", type: "buy", status: "open", amount: 10, rate: 973.7, receive: 9_730 },
          ],
          coin: "BANK_CUP",
          available: 10,
          maximumRate: 980,
          outgoingTransferFee: 0,
          currency: "CUP",
        },
        check: (result) => {
          const plan = result as Record<string, unknown>;
          assert.deepEqual(plan.adjustments, [
            {
              uuid: "cup-underflow",
              coin: "BANK_CUP",
              rate: "973.70000000",
              currentQusd: "10.00000000",
              proposedQusd: "0.00000000",
              currentFiat: "9730",
              proposedFiat: "0",
              releasedFiat: "9730",
              action: "cancel",
            },
          ]);
        },
      },
      {
        caseId: "pure/budget/below-qvapay-minimum/0001",
        op: "budget.proportionalPlan",
        source: "test/budget.test.ts:128",
        input: {
          offers: [
            { uuid: "cup-below-qvapay-minimum", coin: "BANK_CUP", type: "buy", status: "open", amount: 1, rate: 1_000, receive: 1_000 },
          ],
          coin: "BANK_CUP",
          available: 90,
          maximumRate: 1_010,
          outgoingTransferFee: 0,
          currency: "CUP",
        },
        check: (result) => {
          const plan = result as Record<string, unknown>;
          const adjustments = plan.adjustments as Array<{ proposedQusd: string; action: string }>;
          assert.equal(adjustments[0]?.proposedQusd, "0.00000000");
          assert.equal(adjustments[0]?.action, "cancel");
        },
      },
    ],
  },

  {
    file: "flexible-order.json",
    module: "src/flexible-order.ts",
    sourceTests: ["test/flexible-order.test.ts"],
    notes:
      "Funciones puras de órdenes flexibles: dimensionado constante, proyección del estado de la orden hija y recuperación inequívoca. Deterministas (fechas ISO fijas, sin store ni fetch).",
    cases: [
      {
        caseId: "pure/flexible-order/size/capacity-cents/0001",
        op: "flexible.size",
        source: "test/flexible-order.test.ts:15",
        input: { offer: FLEXIBLE_OFFER, capacity: 10.129, limit: 25 },
        check: (result) => {
          const sized = result as Record<string, unknown> | null;
          assert.equal(sized?.amount, "10.12000000");
          assert.ok(Math.abs(Number(sized?.rate) - 900) < 1e-9);
          assert.ok(Number(sized?.amount) <= 10.129);
        },
      },
      {
        caseId: "pure/flexible-order/size/capacity-limit/0001",
        op: "flexible.size",
        source: "test/flexible-order.test.ts:15",
        input: { offer: FLEXIBLE_OFFER, capacity: 100, limit: 25 },
        check: (result) => {
          const sized = result as Record<string, unknown> | null;
          assert.equal(sized?.amount, "25.00000000");
          assert.ok(Math.abs(Number(sized?.rate) - 900) < 1e-9);
        },
      },
      {
        caseId: "pure/flexible-order/size/order-max/0001",
        op: "flexible.size",
        source: "test/flexible-order.test.ts:15",
        input: { offer: FLEXIBLE_OFFER, capacity: 100, limit: 100 },
        check: (result) => {
          const sized = result as Record<string, unknown> | null;
          assert.equal(sized?.amount, "30.00000000");
          assert.ok(Number(sized?.amount) <= 100);
        },
      },
      {
        caseId: "pure/flexible-order/size/available/0001",
        op: "flexible.size",
        source: "test/flexible-order.test.ts:21",
        input: { offer: { ...FLEXIBLE_OFFER, available_amount: 8 }, capacity: 20 },
        check: (result) => {
          const sized = result as Record<string, unknown> | null;
          assert.equal(sized?.amount, "8.00000000");
        },
      },
      {
        caseId: "pure/flexible-order/size/zero-capacity/0001",
        op: "flexible.size",
        source: "test/flexible-order.test.ts:22",
        input: { offer: FLEXIBLE_OFFER, capacity: 0 },
        check: (result) => assert.equal(result, null),
      },
      {
        caseId: "pure/flexible-order/size/below-order-min/0001",
        op: "flexible.size",
        source: "test/flexible-order.test.ts:22",
        input: { offer: FLEXIBLE_OFFER, capacity: 4.99 },
        check: (result) => assert.equal(result, null),
      },
      {
        caseId: "pure/flexible-order/size/negative-capacity/0001",
        op: "flexible.size",
        source: "test/flexible-order.test.ts:22",
        input: { offer: FLEXIBLE_OFFER, capacity: -1 },
        check: (result) => assert.equal(result, null),
      },
      {
        caseId: "pure/flexible-order/size/null-order-min/0001",
        op: "flexible.size",
        source: "test/flexible-order.test.ts:23",
        input: { offer: { ...FLEXIBLE_OFFER, order_min: null }, capacity: 20 },
        check: (result) => assert.equal(result, null),
      },
      {
        caseId: "pure/flexible-order/size/max-below-min/0001",
        op: "flexible.size",
        source: "test/flexible-order.test.ts:24",
        input: { offer: { ...FLEXIBLE_OFFER, order_max: 2 }, capacity: 20 },
        check: (result) => assert.equal(result, null),
      },
      {
        caseId: "pure/flexible-order/size/fixed-untouched/0001",
        op: "flexible.size",
        source: "test/flexible-order.test.ts:25",
        input: { offer: { ...FLEXIBLE_OFFER, offer_kind: "fixed" }, capacity: 1 },
        check: (result) => {
          const sized = result as Record<string, unknown> | null;
          assert.equal(sized?.amount, "100.00000000");
          assert.equal(sized?.offer_kind, "fixed");
        },
      },
      {
        caseId: "pure/flexible-order/order/status-from-child/0001",
        op: "flexible.orderForOperation",
        source: "test/flexible-order.test.ts:30",
        input: { offer: remoteWithOrders([flexibleChild()]), orderUuid: "child" },
        check: (result) => {
          const order = result as Record<string, unknown>;
          assert.equal(order.status, "paid");
          assert.equal(order.amount, "10.00000000");
        },
      },
      {
        caseId: "pure/flexible-order/order/requires-id/0001",
        op: "flexible.orderForOperation",
        source: "test/flexible-order.test.ts:32",
        input: { offer: remoteWithOrders([flexibleChild()]) },
        expectError: { class: "validation", messageIncludes: "requiere identificar su orden" },
      },
      {
        caseId: "pure/flexible-order/order/unknown-id/0001",
        op: "flexible.orderForOperation",
        source: "test/flexible-order.test.ts:33",
        input: { offer: remoteWithOrders([flexibleChild()]), orderUuid: "another" },
        expectError: { class: "error", messageIncludes: "no devolvió la orden" },
      },
      {
        caseId: "pure/flexible-order/recovery/unique-owner/0001",
        op: "flexible.matchingRecoveryOrder",
        source: "test/flexible-order.test.ts:34",
        input: { offer: remoteWithOrders([flexibleChild()]), amount: 10, since: 10_000, account: "me" },
        check: (result) => assert.equal((result as Record<string, unknown>)?.uuid, "child"),
      },
      {
        caseId: "pure/flexible-order/recovery/other-owner/0001",
        op: "flexible.matchingRecoveryOrder",
        source: "test/flexible-order.test.ts:35",
        input: { offer: remoteWithOrders([flexibleChild()]), amount: 10, since: 10_000, account: "other" },
        check: (result) => assert.equal(result, null),
      },
      {
        caseId: "pure/flexible-order/recovery/out-of-window/0001",
        op: "flexible.matchingRecoveryOrder",
        source: "test/flexible-order.test.ts:36",
        input: {
          offer: remoteWithOrders([{ ...flexibleChild(), created_at: new Date(200_000).toISOString() }]),
          amount: 10,
          since: 10_000,
          account: "me",
        },
        check: (result) => assert.equal(result, null),
      },
      {
        caseId: "pure/flexible-order/recovery/ambiguous/0001",
        op: "flexible.matchingRecoveryOrder",
        source: "test/flexible-order.test.ts:37",
        input: {
          offer: remoteWithOrders([flexibleChild(), flexibleChild()]),
          amount: 10,
          since: 10_000,
          account: "me",
        },
        check: (result) => assert.equal(result, null),
      },
      {
        caseId: "pure/flexible-order/financial-date/sell-paid/0001",
        op: "flexible.orderForOperation",
        source: "test/flexible-order.test.ts:76",
        input: {
          offer: remoteWithOrders([
            {
              uuid: "child",
              amount: 10,
              receive: 9_000,
              status: "completed",
              created_at: "2026-10-18T10:00:00Z",
              paid_at: "2026-10-19T10:00:00Z",
              released_at: "2026-10-19T10:05:00Z",
            },
          ], { updated_at: "2026-10-20T10:00:00Z" }),
          orderUuid: "child",
        },
        check: (result) => assert.equal((result as Record<string, unknown>).updated_at, "2026-10-19T10:00:00Z"),
      },
      {
        caseId: "pure/flexible-order/financial-date/buy-released/0001",
        op: "flexible.orderForOperation",
        source: "test/flexible-order.test.ts:77",
        input: {
          offer: remoteWithOrders([
            {
              uuid: "child",
              amount: 10,
              receive: 9_000,
              status: "completed",
              created_at: "2026-10-18T10:00:00Z",
              paid_at: "2026-10-19T10:00:00Z",
              released_at: "2026-10-19T10:05:00Z",
            },
          ], { type: "buy" }),
          orderUuid: "child",
        },
        check: (result) => assert.equal((result as Record<string, unknown>).updated_at, "2026-10-19T10:05:00Z"),
      },
      {
        caseId: "pure/flexible-order/financial-date/sell-released-fallback/0001",
        op: "flexible.orderForOperation",
        source: "test/flexible-order.test.ts:78",
        input: {
          offer: remoteWithOrders([
            {
              uuid: "child",
              amount: 10,
              receive: 9_000,
              status: "completed",
              created_at: "2026-10-18T10:00:00Z",
              paid_at: null,
              released_at: "2026-10-19T10:05:00Z",
            },
          ]),
          orderUuid: "child",
        },
        check: (result) => assert.equal((result as Record<string, unknown>).updated_at, "2026-10-19T10:05:00Z"),
      },
      {
        caseId: "pure/flexible-order/financial-date/created-fallback/0001",
        op: "flexible.orderForOperation",
        source: "test/flexible-order.test.ts:79",
        input: {
          offer: remoteWithOrders([
            {
              uuid: "child",
              amount: 10,
              receive: 9_000,
              status: "completed",
              created_at: "2026-10-18T10:00:00Z",
              paid_at: null,
              released_at: null,
            },
          ]),
          orderUuid: "child",
        },
        check: (result) => assert.equal((result as Record<string, unknown>).updated_at, "2026-10-18T10:00:00Z"),
      },
    ],
  },

  {
    file: "apply-budget.json",
    module: "src/core/apply-budget.ts",
    sourceTests: ["test/qvapay-gateway.test.ts", "test/manual-cancel-race.test.ts"],
    notes:
      "Presupuesto de aplicaciones (ventana de dos intentos + Retry-After). Estado inyectado por input; epoch ms como number, sin importes monetarios. Derivado de los escenarios de cuota del gateway.",
    cases: [
      {
        caseId: "pure/apply-budget/empty/0001",
        op: "apply.budget",
        source: "test/qvapay-gateway.test.ts:214",
        input: { now: 1_000 },
        check: (result) => {
          const budget = result as Record<string, unknown>;
          assert.deepEqual(budget.attempts, []);
          assert.equal(budget.readyAt, 1_000);
        },
      },
      {
        caseId: "pure/apply-budget/one-attempt/0001",
        op: "apply.budget",
        source: "test/qvapay-gateway.test.ts:218",
        input: { attempts: [1_000], now: 1_000 },
        check: (result) => {
          const budget = result as Record<string, unknown>;
          assert.deepEqual(budget.attempts, [1_000]);
          assert.equal(budget.readyAt, 1_000);
        },
      },
      {
        caseId: "pure/apply-budget/two-attempts/0001",
        op: "apply.budget",
        source: "test/qvapay-gateway.test.ts:219",
        input: { attempts: [1_000, 1_000], now: 1_000 },
        check: (result) => {
          const budget = result as Record<string, unknown>;
          assert.equal(budget.readyAt, 1_000 + 60_001);
          assert.ok(Number(budget.readyAt) - 1_000 >= 60_000);
        },
      },
      {
        caseId: "pure/apply-budget/window-open/0001",
        op: "apply.budget",
        source: "test/qvapay-gateway.test.ts:219",
        input: { attempts: [1_000, 1_000], now: 60_000 },
        check: (result) => assert.equal((result as Record<string, unknown>).readyAt, 61_001),
      },
      {
        caseId: "pure/apply-budget/window-last-ms/0001",
        op: "apply.budget",
        source: "test/qvapay-gateway.test.ts:220",
        input: { attempts: [1_000, 1_000], now: 61_000 },
        check: (result) => assert.equal((result as Record<string, unknown>).readyAt, 61_001),
      },
      {
        caseId: "pure/apply-budget/window-expired/0001",
        op: "apply.budget",
        source: "test/qvapay-gateway.test.ts:220",
        input: { attempts: [1_000, 1_000], now: 61_001 },
        check: (result) => {
          const budget = result as Record<string, unknown>;
          assert.deepEqual(budget.attempts, [1_000, 1_000]);
          assert.equal(budget.readyAt, 61_001);
        },
      },
      {
        caseId: "pure/apply-budget/reset/0001",
        op: "apply.budget",
        source: "test/manual-cancel-race.test.ts:30",
        input: { attempts: [], now: 5_000 },
        check: (result) => {
          const budget = result as Record<string, unknown>;
          assert.deepEqual(budget.attempts, []);
          assert.equal(budget.readyAt, 5_000);
        },
      },
      {
        caseId: "pure/apply-budget/retry-after/0001",
        op: "apply.budget",
        source: "test/qvapay-gateway.test.ts:246",
        input: { retryAt: 91_000, now: 1_000 },
        check: (result) => assert.equal((result as Record<string, unknown>).readyAt, 91_000),
      },
      {
        caseId: "pure/apply-budget/retry-after-dominates/0001",
        op: "apply.budget",
        source: "test/qvapay-gateway.test.ts:252",
        input: { attempts: [1_000, 1_000], retryAt: 91_000, now: 61_000 },
        check: (result) => assert.equal((result as Record<string, unknown>).readyAt, 91_000),
      },
    ],
  },

  {
    file: "hunting-requirements.json",
    module: "src/hunting-requirements.ts",
    sourceTests: ["test/hunting-requirements.test.ts"],
    notes:
      "Requisitos de cacería: hechos de elegibilidad frescos (60 s) sin inventar ceros. La secuencia de lecturas se inyecta por `actions`; solo viaja string|null como resultado.",
    cases: [
      {
        caseId: "pure/hunting-requirements/no-facts/0001",
        op: "hunt.requirements",
        source: "test/hunting-requirements.test.ts:8",
        input: { offer: HUNTING_OFFER, now: 1_000, actions: [] },
        check: (result) => assert.equal((result as Record<string, unknown>).reason, null),
      },
      {
        caseId: "pure/hunting-requirements/min-rating/0001",
        op: "hunt.requirements",
        source: "test/hunting-requirements.test.ts:9",
        input: {
          offer: HUNTING_OFFER,
          now: 1_000,
          actions: [
            { kind: "eligibility", value: { _count: { P2P: 10, P2P_Peer: 20 }, rating_avg: 3.8 }, at: 1_000 },
          ],
        },
        check: (result) => assert.match(String((result as Record<string, unknown>).reason), /min_rating/),
      },
      {
        caseId: "pure/hunting-requirements/stale-facts/0001",
        op: "hunt.requirements",
        source: "test/hunting-requirements.test.ts:11",
        input: {
          offer: HUNTING_OFFER,
          now: 62_000,
          actions: [
            { kind: "eligibility", value: { _count: { P2P: 10, P2P_Peer: 20 }, rating_avg: 3.8 }, at: 1_000 },
          ],
        },
        check: (result) => assert.equal((result as Record<string, unknown>).reason, null),
      },
      {
        caseId: "pure/hunting-requirements/refreshed-rating/0001",
        op: "hunt.requirements",
        source: "test/hunting-requirements.test.ts:12",
        input: {
          offer: HUNTING_OFFER,
          now: 62_000,
          actions: [
            { kind: "eligibility", value: { _count: { P2P: 10, P2P_Peer: 20 }, rating_avg: 3.8 }, at: 1_000 },
            { kind: "eligibility", value: { rating_avg: 4.5 }, at: 62_000 },
          ],
        },
        check: (result) => assert.equal((result as Record<string, unknown>).reason, null),
      },
      {
        caseId: "pure/hunting-requirements/missing-min-completed/0001",
        op: "hunt.requirements",
        source: "test/hunting-requirements.test.ts:14",
        input: {
          offer: HUNTING_OFFER,
          now: 62_000,
          actions: [
            { kind: "eligibility", value: { _count: { P2P: 10, P2P_Peer: 20 }, rating_avg: 3.8 }, at: 1_000 },
            { kind: "eligibility", value: { rating_avg: 4.5 }, at: 62_000 },
            { kind: "missing", value: [{ key: "min_completed", actual: 12, required: 25 }], at: 62_000 },
          ],
        },
        check: (result) => assert.match(String((result as Record<string, unknown>).reason), /min_completed/),
      },
      {
        caseId: "pure/hunting-requirements/incomplete-count/0001",
        op: "hunt.requirements",
        source: "test/hunting-requirements.test.ts:16",
        input: {
          offer: HUNTING_OFFER,
          now: 62_000,
          actions: [
            { kind: "eligibility", value: { _count: { P2P: 10, P2P_Peer: 20 }, rating_avg: 3.8 }, at: 1_000 },
            { kind: "eligibility", value: { rating_avg: 4.5 }, at: 62_000 },
            { kind: "missing", value: [{ key: "min_completed", actual: 12, required: 25 }], at: 62_000 },
            { kind: "eligibility", value: { _count: { P2P: 20 } }, at: 62_000 },
          ],
        },
        check: (result) => assert.match(String((result as Record<string, unknown>).reason), /min_completed/),
      },
    ],
  },

  {
    file: "reconciliation-scheduler.json",
    module: "src/reconciliation-scheduler.ts",
    sourceTests: ["test/reconciliation-scheduler.test.ts"],
    notes:
      "Backoff exponencial persistido por intención, acotado a 15 min. La secuencia de operaciones se inyecta por `steps`; epoch ms como number.",
    cases: [
      {
        caseId: "pure/reconciliation-scheduler/first-failure/0001",
        op: "reconciliation.sequence",
        source: "test/reconciliation-scheduler.test.ts:17",
        input: {
          steps: [
            { op: "canAttempt", intentId: "intent-a", at: RECON_START },
            { op: "recordFailure", intentId: "intent-a", at: RECON_START },
            { op: "canAttempt", intentId: "intent-a", at: RECON_START + 59_999 },
            { op: "canAttempt", intentId: "intent-a", at: RECON_START + 60_000 },
          ],
        },
        check: (result) => {
          const results = (result as Record<string, unknown>).results as Array<Record<string, unknown>>;
          assert.deepEqual(results[0], { can: true });
          assert.deepEqual(results[1], { attempts: 1, nextAttemptAt: RECON_START + 60_000 });
          assert.deepEqual(results[2], { can: false });
          assert.deepEqual(results[3], { can: true });
        },
      },
      {
        caseId: "pure/reconciliation-scheduler/exponential/0001",
        op: "reconciliation.sequence",
        source: "test/reconciliation-scheduler.test.ts:25",
        input: {
          steps: (() => {
            const steps: Array<Record<string, unknown>> = [];
            let next = RECON_START;
            for (let attempts = 1; attempts <= 12; attempts += 1) {
              steps.push({ op: "recordFailure", intentId: "intent-a", at: next });
              next += Math.min(15 * 60_000, 60_000 * 2 ** (attempts - 1));
            }
            return steps;
          })(),
        },
        check: (result) => {
          const results = (result as Record<string, unknown>).results as Array<Record<string, unknown>>;
          assert.equal(results.length, 12);
          let next = RECON_START;
          for (let attempts = 1; attempts <= 12; attempts += 1) {
            const record = results[attempts - 1]!;
            assert.equal(record.attempts, attempts);
            const delay = Math.min(15 * 60_000, 60_000 * 2 ** (attempts - 1));
            assert.equal(Number(record.nextAttemptAt) - next, delay);
            next = Number(record.nextAttemptAt);
          }
        },
      },
      {
        caseId: "pure/reconciliation-scheduler/isolation/0001",
        op: "reconciliation.sequence",
        source: "test/reconciliation-scheduler.test.ts:32",
        input: {
          steps: [
            { op: "recordFailure", intentId: "intent-a", at: RECON_START },
            { op: "canAttempt", intentId: "intent-b", at: RECON_START },
            { op: "canAttempt", intentId: "intent-a", at: RECON_START + 59_999 },
          ],
        },
        check: (result) => {
          const results = (result as Record<string, unknown>).results as Array<Record<string, unknown>>;
          assert.deepEqual(results[1], { can: true });
          assert.deepEqual(results[2], { can: false });
        },
      },
      {
        caseId: "pure/reconciliation-scheduler/clear/0001",
        op: "reconciliation.sequence",
        source: "test/reconciliation-scheduler.test.ts:36",
        input: {
          steps: [
            { op: "recordFailure", intentId: "intent-a", at: RECON_START },
            { op: "clear", intentId: "intent-a" },
            { op: "canAttempt", intentId: "intent-a", at: RECON_START + 1 },
          ],
        },
        check: (result) => {
          const results = (result as Record<string, unknown>).results as Array<Record<string, unknown>>;
          assert.equal(results[1], null);
          assert.deepEqual(results[2], { can: true });
        },
      },
    ],
  },
];

// ---------------------------------------------------------------------------
// Compilación y escritura
// ---------------------------------------------------------------------------

const ERROR_CLASS = /positiv|rango|válid|invalid|debe|requiere|rechaza/i;

function classify(message: string): "validation" | "error" {
  return ERROR_CLASS.test(message) ? "validation" : "error";
}

function compileCase(def: CaseDef): Record<string, unknown> {
  const handler = registry[def.op];
  if (!handler) throw new Error(`Operación sin adaptador: ${def.op}`);
  // Mismo transporte JSON que el runner: el input pasa por serialize/parse.
  const input = JSON.parse(JSON.stringify(def.input)) as Input;
  const base = { caseId: def.caseId, op: def.op, source: def.source, input };
  try {
    const result = handler(input);
    if (def.expectError) throw new Error(`${def.caseId}: se esperaba un error y el oráculo devolvió un resultado.`);
    def.check?.(result);
    // Mismo transporte JSON que el runner: JSON.stringify de la respuesta.
    const expect = JSON.parse(JSON.stringify(result ?? null)) as unknown;
    return { ...base, expect };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!def.expectError) throw error;
    const errorClass = classify(message);
    if (errorClass !== def.expectError.class) {
      throw new Error(
        `${def.caseId}: clase de error ${errorClass}, esperada ${def.expectError.class} (${message})`,
      );
    }
    if (!message.includes(def.expectError.messageIncludes)) {
      throw new Error(`${def.caseId}: el mensaje no incluye "${def.expectError.messageIncludes}" (${message})`);
    }
    return { ...base, expectError: { class: errorClass, messageIncludes: def.expectError.messageIncludes } };
  }
}

function buildFile(spec: ModuleSpec): { payload: Record<string, unknown>; hash: string } {
  const cases = spec.cases.map(compileCase);
  const hash = canonicalHash(cases);
  return {
    hash,
    payload: {
      schema: "qvaapply.parity/v1",
      suite: "pure",
      targetService: "money-core",
      module: spec.module,
      sourceTests: spec.sourceTests,
      generatedFrom: { impl: "typescript", commit: COMMIT, approvedBy: "f0-bootstrap" },
      notes: `${spec.notes} · goldenHash=${hash}`,
      cases,
    },
  };
}

function main(): void {
  const checkOnly = process.argv.includes("--check");
  let drift = false;
  let totalCases = 0;
  for (const spec of modules) {
    const { payload, hash } = buildFile(spec);
    totalCases += spec.cases.length;
    const path = join(goldenDir, spec.file);
    const serialized = `${JSON.stringify(payload, null, 2)}\n`;
    if (checkOnly) {
      const current = existsSync(path) ? readFileSync(path, "utf8") : "";
      if (current !== serialized) {
        drift = true;
        console.error(`✗ ${spec.file}: golden desactualizado (hash actual ${hash}).`);
      } else {
        console.log(`✓ ${spec.file} (${spec.cases.length} casos, goldenHash=${hash.slice(0, 12)}…)`);
      }
      continue;
    }
    writeFileSync(path, serialized);
    console.log(`→ ${spec.file}: ${spec.cases.length} casos, goldenHash=${hash}`);
  }
  console.log(`\n${modules.length} lotes, ${totalCases} casos${checkOnly ? " verificados" : " generados"}.`);
  if (checkOnly && drift) {
    console.error("Los goldens no coinciden con el oráculo; regenera con el script sin --check.");
    process.exit(1);
  }
}

main();
