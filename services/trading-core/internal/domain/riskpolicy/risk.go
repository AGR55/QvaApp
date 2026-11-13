// Package riskpolicy contiene la evaluación pura de riesgo de
// `src/core/risk-policy.ts`. No hace I/O y es la única fuente de verdad para
// decidir si una oportunidad puede aplicarse automáticamente.
package riskpolicy

import (
	"fmt"

	"github.com/AGR55/QvaApp/services/shared/decimal"
)

// Kind es el resultado global de la evaluación.
type Kind string

const (
	Apply        Kind = "apply"
	ManualReview Kind = "manual_review"
	Blocked      Kind = "blocked"
	Ignored      Kind = "ignored"
)

// CheckStatus es el estado de una comprobación.
type CheckStatus string

const (
	Pass          CheckStatus = "pass"
	Fail          CheckStatus = "fail"
	Warning       CheckStatus = "warning"
	NotApplicable CheckStatus = "not_applicable"
)

// Side es el lado de la oportunidad.
type Side string

const (
	BuyQusd  Side = "buy_qusd"
	SellQusd Side = "sell_qusd"
)

// PriceDecision es la decisión de la política de precio.
type PriceDecision string

const (
	Eligible     PriceDecision = "eligible"
	PriceManual  PriceDecision = "manual_review"
	PriceBlocked PriceDecision = "blocked"
	PriceIgnored PriceDecision = "ignored"
)

// Check es una comprobación con su evidencia.
type Check struct {
	Code   string
	Label  string
	Status CheckStatus
	Actual any
	Limit  any
	Reason string
}

// Limits son los límites configurados.
type Limits struct {
	MaxQusdPerOperation         decimal.Value
	MaxConcurrentQusdExposure   decimal.Value
	MaxDailyAppliedQusd         decimal.Value
	MaxConcurrentOperations     decimal.Value
	MinQusdReserve              decimal.Value
	MaxQuoteAgeSeconds          decimal.Value
	MinExpectedMarginPercent    decimal.Value
	MaxSlippagePercent          decimal.Value
	MaxConsecutiveErrors        decimal.Value
	MarketCooldownSeconds       decimal.Value
	CounterpartyCooldownSeconds decimal.Value
}

// Opportunity es la oportunidad evaluada.
type Opportunity struct {
	UUID           string
	Market         string
	Side           Side
	QusdAmount     decimal.Value
	RequiredFiat   decimal.Value
	QuotedRate     decimal.Value
	ReferenceRate  decimal.Value
	ObservedAt     decimal.Value
	CounterpartyID string
}

// Context es la entrada completa de la evaluación.
type Context struct {
	Now                         decimal.Value
	Opportunity                 Opportunity
	Limits                      Limits
	PriceDecision               PriceDecision
	PriceReason                 string
	ExpectedMarginPercent       decimal.Value
	QusdBalance                 decimal.Value
	FiatAvailable               decimal.Value
	ConcurrentQusdExposure      decimal.Value
	DailyAppliedQusd            decimal.Value
	ActiveOperations            decimal.Value
	ConsecutiveErrors           decimal.Value
	Paused                      bool
	EmergencyStop               bool
	HasUnresolvedMutation       bool
	LastMarketOperationAt       *decimal.Value
	LastCounterpartyOperationAt *decimal.Value
}

// Decision es el resultado canónico.
type Decision struct {
	Kind                      Kind
	OpportunityUUID           string
	EvaluatedAt               decimal.Value
	RequiredQusd              decimal.Value
	RequiredFiat              decimal.Value
	ProjectedExposureQusd     decimal.Value
	ProjectedDailyAppliedQusd decimal.Value
	Checks                    []Check
	Reasons                   []string
}

var (
	thousand = decimal.FromInt(1_000)
	hundred  = decimal.FromInt(100)
	one      = decimal.FromInt(1)
)

// Evaluate replica `evaluateRisk`.
func Evaluate(context Context) (Decision, error) {
	if err := validate(context); err != nil {
		return Decision{}, err
	}
	opportunity := context.Opportunity
	limits := context.Limits

	slippageCheck := advisoryMaximumCheck(
		"slippage",
		"Deslizamiento frente a referencia",
		decimal.Zero(),
		limits.MaxSlippagePercent,
		"El precio se aleja demasiado de la referencia.",
	)
	if opportunity.ReferenceRate.Sign() <= 0 {
		slippageCheck = Check{
			Code:   "slippage",
			Label:  "Deslizamiento frente a referencia",
			Status: Warning,
			Actual: "Infinity",
			Limit:  limits.MaxSlippagePercent,
			Reason: "El precio se aleja demasiado de la referencia.",
		}
	} else {
		ratio, err := opportunity.QuotedRate.Sub(opportunity.ReferenceRate).Abs().Div(opportunity.ReferenceRate)
		if err != nil {
			return Decision{}, err
		}
		slippageCheck = advisoryMaximumCheck(
			"slippage",
			"Deslizamiento frente a referencia",
			ratio.Mul(hundred),
			limits.MaxSlippagePercent,
			"El precio se aleja demasiado de la referencia.",
		)
	}

	checks := []Check{
		booleanCheck("emergency_stop", "Interruptor de emergencia", !context.EmergencyStop, context.EmergencyStop, false, "El interruptor de emergencia está activo."),
		booleanCheck("automation_paused", "Automatización activa", !context.Paused, context.Paused, false, "La automatización está pausada."),
		booleanCheck("unresolved_mutation", "Sin mutaciones inciertas", !context.HasUnresolvedMutation, context.HasUnresolvedMutation, false, "Existe una mutación incierta pendiente de conciliación."),
		maximumCheck("operation_amount", "Importe por operación", opportunity.QusdAmount, limits.MaxQusdPerOperation, "La operación supera el máximo QUSD permitido."),
		maximumCheck("concurrent_exposure", "Exposición simultánea", context.ConcurrentQusdExposure.Add(opportunity.QusdAmount), limits.MaxConcurrentQusdExposure, "La exposición proyectada supera el límite simultáneo."),
		maximumCheck("daily_volume", "Volumen diario", context.DailyAppliedQusd.Add(opportunity.QusdAmount), limits.MaxDailyAppliedQusd, "El volumen diario proyectado supera el límite."),
		maximumCheck("concurrent_operations", "Operaciones simultáneas", context.ActiveOperations.Add(one), limits.MaxConcurrentOperations, "Se alcanzó el máximo de operaciones simultáneas."),
		maximumCheck("quote_age", "Antigüedad de la cotización", secondsBetween(context.Now, opportunity.ObservedAt), limits.MaxQuoteAgeSeconds, "La cotización es demasiado antigua para operar."),
		minimumCheck("expected_margin", "Margen esperado", context.ExpectedMarginPercent, limits.MinExpectedMarginPercent, "El margen esperado no alcanza el mínimo configurado."),
		slippageCheck,
		advisoryMaximumCheck("consecutive_errors", "Errores consecutivos", context.ConsecutiveErrors, nonNegative(limits.MaxConsecutiveErrors.Sub(one)), "El sistema alcanzó el umbral de errores consecutivos."),
		cooldownCheck("market_cooldown", "Enfriamiento del mercado", context.Now, context.LastMarketOperationAt, limits.MarketCooldownSeconds, "El mercado todavía está en periodo de enfriamiento."),
		cooldownCheck("counterparty_cooldown", "Enfriamiento de contraparte", context.Now, context.LastCounterpartyOperationAt, limits.CounterpartyCooldownSeconds, "La contraparte todavía está en periodo de enfriamiento."),
		capitalCheck(context),
	}

	priceStatus := Pass
	switch context.PriceDecision {
	case Eligible:
		priceStatus = Pass
	case PriceIgnored:
		priceStatus = NotApplicable
	default:
		priceStatus = Fail
	}
	priceCheck := Check{
		Code:   "price_policy",
		Label:  "Política de precio",
		Status: priceStatus,
		Actual: string(context.PriceDecision),
		Limit:  string(Eligible),
		Reason: context.PriceReason,
	}
	checks = append([]Check{priceCheck}, checks...)

	hasFailure := false
	for _, check := range checks {
		if check.Status == Fail {
			hasFailure = true
			break
		}
	}
	kind := Apply
	switch {
	case context.PriceDecision == PriceIgnored:
		kind = Ignored
	case context.PriceDecision == PriceManual:
		kind = ManualReview
	case hasFailure:
		kind = Blocked
	}

	reasons := make([]string, 0)
	switch kind {
	case Apply:
		reasons = append(reasons, "La oportunidad cumple la política de precio y todos los límites.")
	case Ignored:
		reasons = append(reasons, context.PriceReason)
	default:
		for _, check := range checks {
			if check.Status == Fail {
				reasons = append(reasons, check.Reason)
			}
		}
	}

	return Decision{
		Kind:                      kind,
		OpportunityUUID:           opportunity.UUID,
		EvaluatedAt:               context.Now,
		RequiredQusd:              choose(opportunity.Side == SellQusd, opportunity.QusdAmount, decimal.Zero()),
		RequiredFiat:              choose(opportunity.Side == BuyQusd, opportunity.RequiredFiat, decimal.Zero()),
		ProjectedExposureQusd:     context.ConcurrentQusdExposure.Add(opportunity.QusdAmount),
		ProjectedDailyAppliedQusd: context.DailyAppliedQusd.Add(opportunity.QusdAmount),
		Checks:                    checks,
		Reasons:                   reasons,
	}, nil
}

func validate(context Context) error {
	nonNegative := []decimal.Value{
		context.Now,
		context.Opportunity.QusdAmount,
		context.Opportunity.RequiredFiat,
		context.Opportunity.QuotedRate,
		context.Opportunity.ReferenceRate,
		context.Opportunity.ObservedAt,
		context.QusdBalance,
		context.FiatAvailable,
		context.ConcurrentQusdExposure,
		context.DailyAppliedQusd,
		context.ActiveOperations,
		context.ConsecutiveErrors,
		context.Limits.MaxQusdPerOperation,
		context.Limits.MaxConcurrentQusdExposure,
		context.Limits.MaxDailyAppliedQusd,
		context.Limits.MaxConcurrentOperations,
		context.Limits.MinQusdReserve,
		context.Limits.MaxQuoteAgeSeconds,
		context.Limits.MinExpectedMarginPercent,
		context.Limits.MaxSlippagePercent,
		context.Limits.MaxConsecutiveErrors,
		context.Limits.MarketCooldownSeconds,
		context.Limits.CounterpartyCooldownSeconds,
	}
	for _, value := range nonNegative {
		if value.Sign() < 0 {
			return fmt.Errorf("el contexto y los límites de riesgo deben ser finitos y no negativos")
		}
	}
	if context.Opportunity.QusdAmount.Sign() == 0 {
		return fmt.Errorf("la oportunidad debe tener un importe QUSD positivo")
	}
	if context.Opportunity.QuotedRate.Sign() == 0 {
		return fmt.Errorf("la oportunidad debe tener una tasa positiva")
	}
	return nil
}

func capitalCheck(context Context) Check {
	if context.Opportunity.Side == BuyQusd {
		return minimumCheck(
			"fiat_capital",
			"Capital fiat disponible",
			context.FiatAvailable,
			context.Opportunity.RequiredFiat,
			"El capital fiat disponible no cubre la operación.",
		)
	}
	available := nonNegative(context.QusdBalance.Sub(context.Limits.MinQusdReserve))
	return minimumCheck(
		"qusd_capital",
		"QUSD disponible después de reserva",
		available,
		context.Opportunity.QusdAmount,
		"El saldo QUSD disponible después de la reserva no cubre la operación.",
	)
}

func booleanCheck(code, label string, passes, actual, limit bool, failureReason string) Check {
	status := Pass
	reason := label + ": correcto."
	if !passes {
		status = Fail
		reason = failureReason
	}
	return Check{Code: code, Label: label, Status: status, Actual: actual, Limit: limit, Reason: reason}
}

func maximumCheck(code, label string, actual, limit decimal.Value, failureReason string) Check {
	status := Pass
	reason := label + ": dentro del límite."
	if actual.Cmp(limit) > 0 {
		status = Fail
		reason = failureReason
	}
	return Check{Code: code, Label: label, Status: status, Actual: actual, Limit: limit, Reason: reason}
}

func minimumCheck(code, label string, actual, limit decimal.Value, failureReason string) Check {
	status := Pass
	reason := label + ": suficiente."
	if actual.Cmp(limit) < 0 {
		status = Fail
		reason = failureReason
	}
	return Check{Code: code, Label: label, Status: status, Actual: actual, Limit: limit, Reason: reason}
}

func advisoryMaximumCheck(code, label string, actual, limit decimal.Value, warningReason string) Check {
	status := Pass
	reason := label + ": dentro del límite."
	if actual.Cmp(limit) > 0 {
		status = Warning
		reason = warningReason
	}
	return Check{Code: code, Label: label, Status: status, Actual: actual, Limit: limit, Reason: reason}
}

func cooldownCheck(code, label string, now decimal.Value, lastOperationAt *decimal.Value, cooldown decimal.Value, failureReason string) Check {
	if lastOperationAt == nil || cooldown.Sign() == 0 {
		return Check{
			Code:   code,
			Label:  label,
			Status: NotApplicable,
			Limit:  cooldown,
			Reason: label + ": sin actividad previa aplicable.",
		}
	}
	elapsed := secondsBetween(now, *lastOperationAt)
	status := Pass
	reason := label + ": completado."
	if elapsed.Cmp(cooldown) < 0 {
		status = Warning
		reason = failureReason
	}
	return Check{Code: code, Label: label, Status: status, Actual: elapsed, Limit: cooldown, Reason: reason}
}

func secondsBetween(now, then decimal.Value) decimal.Value {
	elapsed := now.Sub(then)
	if elapsed.Sign() < 0 {
		elapsed = decimal.Zero()
	}
	seconds, err := elapsed.Div(thousand)
	if err != nil {
		panic(err)
	}
	return seconds
}

func nonNegative(value decimal.Value) decimal.Value {
	if value.Sign() < 0 {
		return decimal.Zero()
	}
	return value
}

func choose(condition bool, yes, no decimal.Value) decimal.Value {
	if condition {
		return yes
	}
	return no
}
