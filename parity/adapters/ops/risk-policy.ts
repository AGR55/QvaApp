/**
 * Operaciones de conformidad para `src/core/risk-policy.ts`.
 *
 * Contrato `risk.evaluate`:
 *   input  = RiskContext serializado (ver `src/core/risk-policy.ts:44-62`).
 *   output = decisión canónica con importes/epoch como string decimal de
 *            escala fija 8 (los epoch ms `evaluatedAt` sí viajan como number).
 *
 * Reglas de frontera:
 *  - `requiredQusd`, `requiredFiat`, `projectedExposureQusd` y
 *    `projectedDailyAppliedQusd` salen SIEMPRE como string decimal ("20.00000000").
 *  - `checks[].actual`/`checks[].limit` se normalizan a string decimal de escala
 *    8 cuando son numéricos, para que la comparación cross-language no dependa
 *    de la representación de coma flotante. Booleanos y textos se conservan.
 *  - JSON no puede expresar NaN/Infinity: los vectores negativos usan los
 *    centinelas "NaN"/"Infinity"/"-Infinity", que este adaptador convierte a
 *    números no finitos antes de llamar al oráculo (solo para probar la
 *    validación de entrada).
 */
import {
  evaluateRisk,
  type RiskContext,
  type RiskLimits,
} from "../../../src/core/risk-policy.js";

type Input = Record<string, unknown>;

function num(input: Input, key: string): number {
  const value = input[key];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    if (value === "NaN") return Number.NaN;
    if (value === "Infinity") return Number.POSITIVE_INFINITY;
    if (value === "-Infinity") return Number.NEGATIVE_INFINITY;
  }
  throw new Error(`El campo ${key} debe ser un número.`);
}

function optionalNum(input: Input, key: string): number | undefined {
  return input[key] === undefined ? undefined : num(input, key);
}

function text(input: Input, key: string): string {
  const value = input[key];
  if (typeof value !== "string") throw new Error(`El campo ${key} debe ser texto.`);
  return value;
}

function optionalText(input: Input, key: string): string | undefined {
  return input[key] === undefined ? undefined : text(input, key);
}

function bool(input: Input, key: string): boolean {
  const value = input[key];
  if (typeof value !== "boolean") throw new Error(`El campo ${key} debe ser booleano.`);
  return value;
}

function obj(input: Input, key: string): Input {
  const value = input[key];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`El campo ${key} debe ser un objeto.`);
  }
  return value as Input;
}

function side(input: Input): "buy_qusd" | "sell_qusd" {
  const value = text(input, "side");
  if (value !== "buy_qusd" && value !== "sell_qusd") {
    throw new Error("El lado debe ser buy_qusd o sell_qusd.");
  }
  return value;
}

function priceDecision(input: Input): RiskContext["priceDecision"] {
  const value = text(input, "priceDecision");
  if (value !== "eligible" && value !== "manual_review" && value !== "blocked" && value !== "ignored") {
    throw new Error("La decisión de precio no es válida.");
  }
  return value;
}

/** Fixed-scale decimal string; never goes through a locale/float formatter. */
function dec(value: number, scale = 8): string {
  if (!Number.isFinite(value)) return String(value);
  if (scale < 0 || scale > 12) throw new Error("Escala no soportada.");
  return Number(value.toFixed(scale)).toFixed(scale);
}

/** Numeric evidence is normalised to the canonical decimal scale. */
function evidence(value: number | string | boolean | undefined): number | string | boolean | undefined {
  return typeof value === "number" ? dec(value) : value;
}

function limitsOf(raw: Input): RiskLimits {
  return {
    maxQusdPerOperation: num(raw, "maxQusdPerOperation"),
    maxConcurrentQusdExposure: num(raw, "maxConcurrentQusdExposure"),
    maxDailyAppliedQusd: num(raw, "maxDailyAppliedQusd"),
    maxConcurrentOperations: num(raw, "maxConcurrentOperations"),
    minQusdReserve: num(raw, "minQusdReserve"),
    maxQuoteAgeSeconds: num(raw, "maxQuoteAgeSeconds"),
    minExpectedMarginPercent: num(raw, "minExpectedMarginPercent"),
    maxSlippagePercent: num(raw, "maxSlippagePercent"),
    maxConsecutiveErrors: num(raw, "maxConsecutiveErrors"),
    marketCooldownSeconds: num(raw, "marketCooldownSeconds"),
    counterpartyCooldownSeconds: num(raw, "counterpartyCooldownSeconds"),
  };
}

function contextOf(input: Input): RiskContext {
  const opportunityRaw = obj(input, "opportunity");
  const counterpartyId = optionalText(opportunityRaw, "counterpartyId");
  const lastMarketOperationAt = optionalNum(input, "lastMarketOperationAt");
  const lastCounterpartyOperationAt = optionalNum(input, "lastCounterpartyOperationAt");
  return {
    now: num(input, "now"),
    opportunity: {
      uuid: text(opportunityRaw, "uuid"),
      market: text(opportunityRaw, "market"),
      side: side(opportunityRaw),
      qusdAmount: num(opportunityRaw, "qusdAmount"),
      requiredFiat: num(opportunityRaw, "requiredFiat"),
      quotedRate: num(opportunityRaw, "quotedRate"),
      referenceRate: num(opportunityRaw, "referenceRate"),
      observedAt: num(opportunityRaw, "observedAt"),
      ...(counterpartyId === undefined ? {} : { counterpartyId }),
    },
    limits: limitsOf(obj(input, "limits")),
    priceDecision: priceDecision(input),
    priceReason: text(input, "priceReason"),
    expectedMarginPercent: num(input, "expectedMarginPercent"),
    qusdBalance: num(input, "qusdBalance"),
    fiatAvailable: num(input, "fiatAvailable"),
    concurrentQusdExposure: num(input, "concurrentQusdExposure"),
    dailyAppliedQusd: num(input, "dailyAppliedQusd"),
    activeOperations: num(input, "activeOperations"),
    consecutiveErrors: num(input, "consecutiveErrors"),
    paused: bool(input, "paused"),
    emergencyStop: bool(input, "emergencyStop"),
    hasUnresolvedMutation: bool(input, "hasUnresolvedMutation"),
    ...(lastMarketOperationAt === undefined ? {} : { lastMarketOperationAt }),
    ...(lastCounterpartyOperationAt === undefined ? {} : { lastCounterpartyOperationAt }),
  };
}

export const ops = {
  "risk.evaluate": (input: Input) => {
    const decision = evaluateRisk(contextOf(input));
    return {
      kind: decision.kind,
      opportunityUuid: decision.opportunityUuid,
      evaluatedAt: decision.evaluatedAt,
      requiredQusd: dec(decision.requiredQusd),
      requiredFiat: dec(decision.requiredFiat),
      projectedExposureQusd: dec(decision.projectedExposureQusd),
      projectedDailyAppliedQusd: dec(decision.projectedDailyAppliedQusd),
      checks: decision.checks.map((check) => ({
        code: check.code,
        label: check.label,
        status: check.status,
        ...(check.actual === undefined ? {} : { actual: evidence(check.actual) }),
        ...(check.limit === undefined ? {} : { limit: evidence(check.limit) }),
        reason: check.reason,
      })),
      reasons: decision.reasons,
    };
  },
};
