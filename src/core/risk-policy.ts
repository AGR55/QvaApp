export type RiskDecisionKind =
  | "apply"
  | "manual_review"
  | "blocked"
  | "ignored";

type RiskCheckStatus = "pass" | "fail" | "warning" | "not_applicable";

interface RiskCheck {
  code: string;
  label: string;
  status: RiskCheckStatus;
  actual?: number | string | boolean;
  limit?: number | string | boolean;
  reason: string;
}

export interface RiskLimits {
  maxQusdPerOperation: number;
  maxConcurrentQusdExposure: number;
  maxDailyAppliedQusd: number;
  maxConcurrentOperations: number;
  minQusdReserve: number;
  maxQuoteAgeSeconds: number;
  minExpectedMarginPercent: number;
  maxSlippagePercent: number;
  maxConsecutiveErrors: number;
  marketCooldownSeconds: number;
  counterpartyCooldownSeconds: number;
}

interface RiskOpportunity {
  uuid: string;
  market: string;
  side: "buy_qusd" | "sell_qusd";
  qusdAmount: number;
  requiredFiat: number;
  quotedRate: number;
  referenceRate: number;
  observedAt: number;
  counterpartyId?: string;
}

export interface RiskContext {
  now: number;
  opportunity: RiskOpportunity;
  limits: RiskLimits;
  priceDecision: "eligible" | "manual_review" | "blocked" | "ignored";
  priceReason: string;
  expectedMarginPercent: number;
  qusdBalance: number;
  fiatAvailable: number;
  concurrentQusdExposure: number;
  dailyAppliedQusd: number;
  activeOperations: number;
  consecutiveErrors: number;
  paused: boolean;
  emergencyStop: boolean;
  hasUnresolvedMutation: boolean;
  lastMarketOperationAt?: number;
  lastCounterpartyOperationAt?: number;
}

export interface RiskDecision {
  kind: RiskDecisionKind;
  opportunityUuid: string;
  evaluatedAt: number;
  requiredQusd: number;
  requiredFiat: number;
  projectedExposureQusd: number;
  projectedDailyAppliedQusd: number;
  checks: RiskCheck[];
  reasons: string[];
}

export const conservativeRiskLimits: RiskLimits = Object.freeze({
  maxQusdPerOperation: 25,
  maxConcurrentQusdExposure: 50,
  maxDailyAppliedQusd: 100,
  maxConcurrentOperations: 2,
  minQusdReserve: 10,
  maxQuoteAgeSeconds: 45,
  minExpectedMarginPercent: 0.5,
  maxSlippagePercent: 1,
  maxConsecutiveErrors: 3,
  marketCooldownSeconds: 30,
  counterpartyCooldownSeconds: 300,
});

/**
 * Evaluates every global risk invariant and returns evidence for the panel.
 * It has no I/O and must remain the single source of truth for automatic work.
 */
export function evaluateRisk(context: RiskContext): RiskDecision {
  validateRiskContext(context);
  const { limits, opportunity } = context;
  const checks: RiskCheck[] = [
    booleanCheck(
      "emergency_stop",
      "Interruptor de emergencia",
      !context.emergencyStop,
      context.emergencyStop,
      false,
      "El interruptor de emergencia está activo.",
    ),
    booleanCheck(
      "automation_paused",
      "Automatización activa",
      !context.paused,
      context.paused,
      false,
      "La automatización está pausada.",
    ),
    booleanCheck(
      "unresolved_mutation",
      "Sin mutaciones inciertas",
      !context.hasUnresolvedMutation,
      context.hasUnresolvedMutation,
      false,
      "Existe una mutación incierta pendiente de conciliación.",
    ),
    maximumCheck(
      "operation_amount",
      "Importe por operación",
      opportunity.qusdAmount,
      limits.maxQusdPerOperation,
      "La operación supera el máximo QUSD permitido.",
    ),
    maximumCheck(
      "concurrent_exposure",
      "Exposición simultánea",
      context.concurrentQusdExposure + opportunity.qusdAmount,
      limits.maxConcurrentQusdExposure,
      "La exposición proyectada supera el límite simultáneo.",
    ),
    maximumCheck(
      "daily_volume",
      "Volumen diario",
      context.dailyAppliedQusd + opportunity.qusdAmount,
      limits.maxDailyAppliedQusd,
      "El volumen diario proyectado supera el límite.",
    ),
    maximumCheck(
      "concurrent_operations",
      "Operaciones simultáneas",
      context.activeOperations + 1,
      limits.maxConcurrentOperations,
      "Se alcanzó el máximo de operaciones simultáneas.",
    ),
    maximumCheck(
      "quote_age",
      "Antigüedad de la cotización",
      Math.max(0, (context.now - opportunity.observedAt) / 1_000),
      limits.maxQuoteAgeSeconds,
      "La cotización es demasiado antigua para operar.",
    ),
    minimumCheck(
      "expected_margin",
      "Margen esperado",
      context.expectedMarginPercent,
      limits.minExpectedMarginPercent,
      "El margen esperado no alcanza el mínimo configurado.",
    ),
    advisoryMaximumCheck(
      "slippage",
      "Deslizamiento frente a referencia",
      slippagePercent(opportunity.quotedRate, opportunity.referenceRate),
      limits.maxSlippagePercent,
      "El precio se aleja demasiado de la referencia.",
    ),
    advisoryMaximumCheck(
      "consecutive_errors",
      "Errores consecutivos",
      context.consecutiveErrors,
      Math.max(0, limits.maxConsecutiveErrors - 1),
      "El sistema alcanzó el umbral de errores consecutivos.",
    ),
    advisoryCooldownCheck(
      "market_cooldown",
      "Enfriamiento del mercado",
      context.now,
      context.lastMarketOperationAt,
      limits.marketCooldownSeconds,
      "El mercado todavía está en periodo de enfriamiento.",
    ),
    advisoryCooldownCheck(
      "counterparty_cooldown",
      "Enfriamiento de contraparte",
      context.now,
      context.lastCounterpartyOperationAt,
      limits.counterpartyCooldownSeconds,
      "La contraparte todavía está en periodo de enfriamiento.",
    ),
    capitalCheck(context),
  ];

  const priceCheck: RiskCheck = {
    code: "price_policy",
    label: "Política de precio",
    status:
      context.priceDecision === "eligible"
        ? "pass"
        : context.priceDecision === "ignored"
          ? "not_applicable"
          : "fail",
    actual: context.priceDecision,
    limit: "eligible",
    reason: context.priceReason,
  };
  checks.unshift(priceCheck);

  const failed = checks.filter((check) => check.status === "fail");
  const kind: RiskDecisionKind =
    context.priceDecision === "ignored"
      ? "ignored"
      : context.priceDecision === "manual_review"
        ? "manual_review"
        : failed.length
          ? "blocked"
          : "apply";

  return {
    kind,
    opportunityUuid: opportunity.uuid,
    evaluatedAt: context.now,
    requiredQusd: opportunity.side === "sell_qusd" ? opportunity.qusdAmount : 0,
    requiredFiat:
      opportunity.side === "buy_qusd" ? opportunity.requiredFiat : 0,
    projectedExposureQusd:
      context.concurrentQusdExposure + opportunity.qusdAmount,
    projectedDailyAppliedQusd:
      context.dailyAppliedQusd + opportunity.qusdAmount,
    checks,
    reasons:
      kind === "apply"
        ? ["La oportunidad cumple la política de precio y todos los límites."]
        : kind === "ignored"
          ? [context.priceReason]
          : failed.map((check) => check.reason),
  };
}

function capitalCheck(context: RiskContext): RiskCheck {
  const { opportunity, limits } = context;
  if (opportunity.side === "buy_qusd")
    return minimumCheck(
      "fiat_capital",
      "Capital fiat disponible",
      context.fiatAvailable,
      opportunity.requiredFiat,
      "El capital fiat disponible no cubre la operación.",
    );
  return minimumCheck(
    "qusd_capital",
    "QUSD disponible después de reserva",
    Math.max(0, context.qusdBalance - limits.minQusdReserve),
    opportunity.qusdAmount,
    "El saldo QUSD disponible después de la reserva no cubre la operación.",
  );
}

function booleanCheck(
  code: string,
  label: string,
  passes: boolean,
  actual: boolean,
  limit: boolean,
  failureReason: string,
): RiskCheck {
  return {
    code,
    label,
    status: passes ? "pass" : "fail",
    actual,
    limit,
    reason: passes ? `${label}: correcto.` : failureReason,
  };
}

function maximumCheck(
  code: string,
  label: string,
  actual: number,
  limit: number,
  failureReason: string,
): RiskCheck {
  const passes = actual <= limit;
  return {
    code,
    label,
    status: passes ? "pass" : "fail",
    actual,
    limit,
    reason: passes ? `${label}: dentro del límite.` : failureReason,
  };
}

function minimumCheck(
  code: string,
  label: string,
  actual: number,
  limit: number,
  failureReason: string,
): RiskCheck {
  const passes = actual >= limit;
  return {
    code,
    label,
    status: passes ? "pass" : "fail",
    actual,
    limit,
    reason: passes ? `${label}: suficiente.` : failureReason,
  };
}

function advisoryMaximumCheck(
  code: string,
  label: string,
  actual: number,
  limit: number,
  warningReason: string,
): RiskCheck {
  const passes = actual <= limit;
  return {
    code,
    label,
    status: passes ? "pass" : "warning",
    actual,
    limit,
    reason: passes ? `${label}: dentro del límite.` : warningReason,
  };
}

function advisoryCooldownCheck(
  code: string,
  label: string,
  now: number,
  lastOperationAt: number | undefined,
  cooldownSeconds: number,
  failureReason: string,
): RiskCheck {
  if (lastOperationAt === undefined || cooldownSeconds === 0)
    return {
      code,
      label,
      status: "not_applicable",
      limit: cooldownSeconds,
      reason: `${label}: sin actividad previa aplicable.`,
    };
  const elapsedSeconds = Math.max(0, (now - lastOperationAt) / 1_000);
  const passes = elapsedSeconds >= cooldownSeconds;
  return {
    code,
    label,
    status: passes ? "pass" : "warning",
    actual: elapsedSeconds,
    limit: cooldownSeconds,
    reason: passes ? `${label}: completado.` : failureReason,
  };
}

function slippagePercent(quotedRate: number, referenceRate: number): number {
  if (referenceRate <= 0) return Number.POSITIVE_INFINITY;
  return (Math.abs(quotedRate - referenceRate) / referenceRate) * 100;
}

function validateRiskContext(context: RiskContext): void {
  const nonNegative = [
    context.now,
    context.opportunity.qusdAmount,
    context.opportunity.requiredFiat,
    context.opportunity.quotedRate,
    context.opportunity.referenceRate,
    context.opportunity.observedAt,
    context.qusdBalance,
    context.fiatAvailable,
    context.concurrentQusdExposure,
    context.dailyAppliedQusd,
    context.activeOperations,
    context.consecutiveErrors,
    context.limits.maxQusdPerOperation,
    context.limits.maxConcurrentQusdExposure,
    context.limits.maxDailyAppliedQusd,
    context.limits.maxConcurrentOperations,
    context.limits.minQusdReserve,
    context.limits.maxQuoteAgeSeconds,
    context.limits.minExpectedMarginPercent,
    context.limits.maxSlippagePercent,
    context.limits.maxConsecutiveErrors,
    context.limits.marketCooldownSeconds,
    context.limits.counterpartyCooldownSeconds,
  ];
  if (nonNegative.some((value) => !Number.isFinite(value) || value < 0))
    throw new Error(
      "El contexto y los límites de riesgo deben ser finitos y no negativos.",
    );
  if (context.opportunity.qusdAmount === 0)
    throw new Error("La oportunidad debe tener un importe QUSD positivo.");
  if (context.opportunity.quotedRate === 0)
    throw new Error("La oportunidad debe tener una tasa positiva.");
}
