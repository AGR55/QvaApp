// Package decisionaudit compara decisiones históricas de `decision_events`
// (SQLite) contra el dominio Go `riskpolicy`. No hace I/O: recibe un evento
// exportado como JSON y reconstruye el contexto de riesgo a partir de la
// evidencia (`checks_json`) que guardó la implementación TypeScript.
package decisionaudit

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"sort"
	"strconv"
	"strings"

	"github.com/AGR55/QvaApp/services/shared/decimal"
	"github.com/AGR55/QvaApp/services/trading-core/internal/domain/riskpolicy"
)

// Event es una fila de `decision_events` exportada con `sqlite3 -json`.
type Event struct {
	Version       string   `json:"version"`
	Coin          string   `json:"coin"`
	OfferType     string   `json:"offer_type"`
	Amount        float64  `json:"amount"`
	Receive       float64  `json:"receive"`
	Rate          float64  `json:"rate"`
	Decision      string   `json:"decision"`
	Reason        string   `json:"reason"`
	ChecksJSON    string   `json:"checks_json"`
	ReferenceRate *float64 `json:"reference_rate"`
	CreatedAt     int64    `json:"created_at"`
	UpdatedAt     int64    `json:"updated_at"`
}

// Result es el resultado canónico de comparar un evento.
type Result struct {
	Version        string   `json:"version"`
	Comparable     bool     `json:"comparable"`
	Matched        bool     `json:"matched"`
	ExpectedKind   string   `json:"expectedKind"`
	ActualKind     string   `json:"actualKind"`
	ExpectedReason string   `json:"expectedReason"`
	ActualReason   string   `json:"actualReason"`
	Differences    []string `json:"differences,omitempty"`
	ExpectedJSON   string   `json:"expectedJson"`
	ActualJSON     string   `json:"actualJson"`
	ExpectedDigest string   `json:"expectedDigest"`
	ActualDigest   string   `json:"actualDigest"`
}

type check struct {
	Code   string `json:"code"`
	Label  string `json:"label"`
	Status string `json:"status"`
	Actual any    `json:"actual"`
	Limit  any    `json:"limit"`
	Reason string `json:"reason"`
}

type canonicalDecision struct {
	Kind   string           `json:"kind"`
	Reason string           `json:"reason"`
	Checks []canonicalCheck `json:"checks"`
}

type canonicalCheck struct {
	Code   string `json:"code"`
	Status string `json:"status"`
}

// Audit reconstruye el contexto de riesgo y compara la decisión observada con
// la que produce `riskpolicy.Evaluate`. Si `checks_json` está vacío la fila no
// es comparable y se devuelve sin error.
func Audit(event Event) (Result, error) {
	result := Result{Version: event.Version}

	checksJSON := strings.TrimSpace(event.ChecksJSON)
	if checksJSON == "" || checksJSON == "[]" {
		return result, nil
	}

	var checks []check
	if err := json.Unmarshal([]byte(checksJSON), &checks); err != nil {
		return Result{}, fmt.Errorf("evento %s: checks_json inválido: %w", event.Version, err)
	}
	if len(checks) == 0 {
		return result, nil
	}

	context, err := reconstruct(event, checks)
	if err != nil {
		return Result{}, fmt.Errorf("evento %s: %w", event.Version, err)
	}

	decision, err := riskpolicy.Evaluate(context)
	if err != nil {
		return Result{}, fmt.Errorf("evento %s: evaluar riesgo: %w", event.Version, err)
	}

	actualKind := observedKind(decision.Kind)
	expectedReason := event.Reason
	actualReason := strings.Join(decision.Reasons, " · ")

	result.Comparable = true
	result.ExpectedKind = event.Decision
	result.ActualKind = actualKind
	result.ExpectedReason = expectedReason
	result.ActualReason = actualReason

	differences := make([]string, 0)
	if event.Decision != actualKind {
		differences = append(differences, fmt.Sprintf(
			"decisión esperada %q, obtenida %q", event.Decision, actualKind,
		))
	}

	expectedChecks, actualChecks := canonicalChecks(checks, decision.Checks)
	actualStatus := make(map[string]string, len(actualChecks))
	for _, item := range actualChecks {
		actualStatus[item.Code] = item.Status
	}
	expectedStatus := make(map[string]string, len(expectedChecks))
	for _, item := range expectedChecks {
		expectedStatus[item.Code] = item.Status
	}
	statusesEqual := len(expectedChecks) == len(actualChecks)
	for _, item := range expectedChecks {
		got, ok := actualStatus[item.Code]
		if !ok {
			statusesEqual = false
			differences = append(differences, fmt.Sprintf(
				"check %s: falta en la evaluación Go", item.Code,
			))
			continue
		}
		if got != item.Status {
			statusesEqual = false
			differences = append(differences, fmt.Sprintf(
				"check %s: esperado %s, obtenido %s", item.Code, item.Status, got,
			))
		}
	}
	if len(expectedChecks) != len(actualChecks) {
		extra := make([]string, 0)
		for _, item := range actualChecks {
			if _, ok := expectedStatus[item.Code]; !ok {
				extra = append(extra, item.Code)
			}
		}
		if len(extra) > 0 {
			sort.Strings(extra)
			differences = append(differences, fmt.Sprintf(
				"checks generados sin evidencia: %s", strings.Join(extra, ", "),
			))
		}
	}

	reasonMatches := true
	// TypeScript guarda "Aplicación automática confirmada." para `applied`; no
	// se compara texto y se deja vacío en ambos JSON canónigos.
	if event.Decision != "applied" {
		if expectedReason != actualReason {
			reasonMatches = false
			differences = append(differences, fmt.Sprintf(
				"razón esperada %q, obtenida %q", expectedReason, actualReason,
			))
		}
	}

	expectedCanonical := canonicalDecision{Kind: event.Decision, Checks: expectedChecks}
	actualCanonical := canonicalDecision{Kind: actualKind, Checks: actualChecks}
	if event.Decision != "applied" {
		expectedCanonical.Reason = expectedReason
		actualCanonical.Reason = actualReason
	}

	expectedPayload, err := json.Marshal(expectedCanonical)
	if err != nil {
		return Result{}, fmt.Errorf("evento %s: serializar esperado: %w", event.Version, err)
	}
	actualPayload, err := json.Marshal(actualCanonical)
	if err != nil {
		return Result{}, fmt.Errorf("evento %s: serializar actual: %w", event.Version, err)
	}

	result.ExpectedJSON = string(expectedPayload)
	result.ActualJSON = string(actualPayload)
	result.ExpectedDigest = digest(expectedPayload)
	result.ActualDigest = digest(actualPayload)
	result.Differences = differences
	result.Matched = event.Decision == actualKind && statusesEqual && reasonMatches

	return result, nil
}

func reconstruct(event Event, checks []check) (riskpolicy.Context, error) {
	byCode := make(map[string]check, len(checks))
	for _, item := range checks {
		byCode[item.Code] = item
	}

	operationAmount, ok := byCode["operation_amount"]
	if !ok {
		return riskpolicy.Context{}, fmt.Errorf("falta el check operation_amount")
	}
	qusdAmount, ok := number(operationAmount.Actual)
	if !ok {
		return riskpolicy.Context{}, fmt.Errorf("operation_amount.actual no es numérico")
	}
	maxQusdPerOperation, ok := number(operationAmount.Limit)
	if !ok {
		return riskpolicy.Context{}, fmt.Errorf("operation_amount.limit no es numérico")
	}

	context := riskpolicy.Context{
		Limits: riskpolicy.Limits{
			MaxQusdPerOperation: maxQusdPerOperation,
		},
	}
	context.Opportunity.QusdAmount = qusdAmount

	price, ok := byCode["price_policy"]
	if !ok {
		return riskpolicy.Context{}, fmt.Errorf("falta el check price_policy")
	}
	priceDecision, ok := price.Actual.(string)
	if !ok {
		return riskpolicy.Context{}, fmt.Errorf("price_policy.actual no es texto")
	}
	context.PriceDecision = riskpolicy.PriceDecision(priceDecision)
	context.PriceReason = price.Reason

	if item, ok := byCode["concurrent_exposure"]; ok {
		actual, ok := number(item.Actual)
		if !ok {
			return riskpolicy.Context{}, fmt.Errorf("concurrent_exposure.actual no es numérico")
		}
		limit, ok := number(item.Limit)
		if !ok {
			return riskpolicy.Context{}, fmt.Errorf("concurrent_exposure.limit no es numérico")
		}
		context.ConcurrentQusdExposure = actual.Sub(qusdAmount)
		context.Limits.MaxConcurrentQusdExposure = limit
	}
	if item, ok := byCode["daily_volume"]; ok {
		actual, ok := number(item.Actual)
		if !ok {
			return riskpolicy.Context{}, fmt.Errorf("daily_volume.actual no es numérico")
		}
		limit, ok := number(item.Limit)
		if !ok {
			return riskpolicy.Context{}, fmt.Errorf("daily_volume.limit no es numérico")
		}
		context.DailyAppliedQusd = actual.Sub(qusdAmount)
		context.Limits.MaxDailyAppliedQusd = limit
	}
	if item, ok := byCode["concurrent_operations"]; ok {
		actual, ok := number(item.Actual)
		if !ok {
			return riskpolicy.Context{}, fmt.Errorf("concurrent_operations.actual no es numérico")
		}
		limit, ok := number(item.Limit)
		if !ok {
			return riskpolicy.Context{}, fmt.Errorf("concurrent_operations.limit no es numérico")
		}
		context.ActiveOperations = actual.Sub(decimal.FromInt(1))
		context.Limits.MaxConcurrentOperations = limit
	}

	quoteAge := decimal.Zero()
	if item, ok := byCode["quote_age"]; ok {
		actual, ok := number(item.Actual)
		if !ok {
			return riskpolicy.Context{}, fmt.Errorf("quote_age.actual no es numérico")
		}
		limit, ok := number(item.Limit)
		if !ok {
			return riskpolicy.Context{}, fmt.Errorf("quote_age.limit no es numérico")
		}
		quoteAge = actual
		context.Limits.MaxQuoteAgeSeconds = limit
	}

	if item, ok := byCode["expected_margin"]; ok {
		actual, ok := number(item.Actual)
		if !ok {
			return riskpolicy.Context{}, fmt.Errorf("expected_margin.actual no es numérico")
		}
		limit, ok := number(item.Limit)
		if !ok {
			return riskpolicy.Context{}, fmt.Errorf("expected_margin.limit no es numérico")
		}
		context.ExpectedMarginPercent = actual
		context.Limits.MinExpectedMarginPercent = limit
	}

	if item, ok := byCode["slippage"]; ok {
		limit, ok := number(item.Limit)
		if !ok {
			return riskpolicy.Context{}, fmt.Errorf("slippage.limit no es numérico")
		}
		context.Limits.MaxSlippagePercent = limit
		if actual, ok := number(item.Actual); ok {
			fraction, err := actual.Div(decimal.FromInt(100))
			if err != nil {
				return riskpolicy.Context{}, fmt.Errorf("slippage.actual inválido: %w", err)
			}
			context.Opportunity.ReferenceRate = decimal.FromInt(1)
			context.Opportunity.QuotedRate = decimal.FromInt(1).Add(fraction)
		} else {
			// TypeScript expresa la referencia ausente como "Infinity".
			context.Opportunity.ReferenceRate = decimal.Zero()
			context.Opportunity.QuotedRate = decimal.FromInt(1)
		}
	} else {
		context.Opportunity.ReferenceRate = decimal.FromInt(1)
		context.Opportunity.QuotedRate = decimal.FromInt(1)
	}

	if item, ok := byCode["consecutive_errors"]; ok {
		actual, ok := number(item.Actual)
		if !ok {
			return riskpolicy.Context{}, fmt.Errorf("consecutive_errors.actual no es numérico")
		}
		limit, ok := number(item.Limit)
		if !ok {
			return riskpolicy.Context{}, fmt.Errorf("consecutive_errors.limit no es numérico")
		}
		context.ConsecutiveErrors = actual
		// El check Go compara contra max-1.
		context.Limits.MaxConsecutiveErrors = limit.Add(decimal.FromInt(1))
	}

	marketCooldown := decimal.Zero()
	marketActive := false
	if item, ok := byCode["market_cooldown"]; ok {
		limit, ok := number(item.Limit)
		if !ok {
			return riskpolicy.Context{}, fmt.Errorf("market_cooldown.limit no es numérico")
		}
		context.Limits.MarketCooldownSeconds = limit
		if actual, ok := number(item.Actual); ok {
			marketCooldown = actual
			marketActive = item.Status != "not_applicable"
		}
	}

	counterpartyCooldown := decimal.Zero()
	counterpartyActive := false
	if item, ok := byCode["counterparty_cooldown"]; ok {
		limit, ok := number(item.Limit)
		if !ok {
			return riskpolicy.Context{}, fmt.Errorf("counterparty_cooldown.limit no es numérico")
		}
		context.Limits.CounterpartyCooldownSeconds = limit
		if actual, ok := number(item.Actual); ok {
			counterpartyCooldown = actual
			counterpartyActive = item.Status != "not_applicable"
		}
	}

	now := maxDecimal(quoteAge, marketCooldown, counterpartyCooldown, decimal.Zero()).
		Mul(decimal.FromInt(1000)).
		Add(decimal.FromInt(1000))
	if marketActive {
		value := now.Sub(marketCooldown.Mul(decimal.FromInt(1000)))
		context.LastMarketOperationAt = &value
	}
	if counterpartyActive {
		value := now.Sub(counterpartyCooldown.Mul(decimal.FromInt(1000)))
		context.LastCounterpartyOperationAt = &value
	}
	context.Now = now
	context.Opportunity.ObservedAt = now.Sub(quoteAge.Mul(decimal.FromInt(1000)))

	context.EmergencyStop = boolean(byCode["emergency_stop"].Actual)
	context.Paused = boolean(byCode["automation_paused"].Actual)
	context.HasUnresolvedMutation = boolean(byCode["unresolved_mutation"].Actual)

	fiatCapital, hasFiat := byCode["fiat_capital"]
	qusdCapital, hasQusd := byCode["qusd_capital"]
	switch {
	case hasFiat:
		actual, ok := number(fiatCapital.Actual)
		if !ok {
			return riskpolicy.Context{}, fmt.Errorf("fiat_capital.actual no es numérico")
		}
		limit, ok := number(fiatCapital.Limit)
		if !ok {
			return riskpolicy.Context{}, fmt.Errorf("fiat_capital.limit no es numérico")
		}
		context.Opportunity.Side = riskpolicy.BuyQusd
		context.Opportunity.RequiredFiat = limit
		context.FiatAvailable = actual
	case hasQusd:
		actual, ok := number(qusdCapital.Actual)
		if !ok {
			return riskpolicy.Context{}, fmt.Errorf("qusd_capital.actual no es numérico")
		}
		context.Opportunity.Side = riskpolicy.SellQusd
		context.Opportunity.RequiredFiat = decimal.Zero()
		context.QusdBalance = actual
		context.Limits.MinQusdReserve = decimal.Zero()
	default:
		return riskpolicy.Context{}, fmt.Errorf("falta el check de capital (fiat_capital o qusd_capital)")
	}

	context.Opportunity.UUID = event.Version
	context.Opportunity.Market = event.Coin

	return context, nil
}

func canonicalChecks(
	expected []check,
	actual []riskpolicy.Check,
) ([]canonicalCheck, []canonicalCheck) {
	actualByCode := make(map[string]riskpolicy.Check, len(actual))
	for _, item := range actual {
		actualByCode[item.Code] = item
	}
	expectedByCode := make(map[string]struct{}, len(expected))

	expectedCanonical := make([]canonicalCheck, 0, len(expected))
	actualCanonical := make([]canonicalCheck, 0, len(expected))
	for _, item := range expected {
		expectedByCode[item.Code] = struct{}{}
		expectedCanonical = append(expectedCanonical, canonicalCheck{
			Code:   item.Code,
			Status: item.Status,
		})
		status := ""
		if generated, ok := actualByCode[item.Code]; ok {
			status = string(generated.Status)
		}
		actualCanonical = append(actualCanonical, canonicalCheck{
			Code:   item.Code,
			Status: status,
		})
	}
	for _, item := range actual {
		if _, ok := expectedByCode[item.Code]; ok {
			continue
		}
		actualCanonical = append(actualCanonical, canonicalCheck{
			Code:   item.Code,
			Status: string(item.Status),
		})
	}
	return expectedCanonical, actualCanonical
}

func observedKind(kind riskpolicy.Kind) string {
	if kind == riskpolicy.Apply {
		return "applied"
	}
	return string(kind)
}

func number(value any) (decimal.Value, bool) {
	switch typed := value.(type) {
	case float64:
		parsed, err := decimal.Parse(strconv.FormatFloat(typed, 'f', -1, 64))
		if err != nil {
			return decimal.Zero(), false
		}
		return parsed, true
	case string:
		parsed, err := decimal.Parse(typed)
		if err != nil {
			return decimal.Zero(), false
		}
		return parsed, true
	case json.Number:
		parsed, err := decimal.Parse(typed.String())
		if err != nil {
			return decimal.Zero(), false
		}
		return parsed, true
	case int64:
		return decimal.FromInt(typed), true
	default:
		return decimal.Zero(), false
	}
}

func boolean(value any) bool {
	typed, ok := value.(bool)
	return ok && typed
}

func maxDecimal(values ...decimal.Value) decimal.Value {
	maximum := values[0]
	for _, value := range values[1:] {
		if value.Cmp(maximum) > 0 {
			maximum = value
		}
	}
	return maximum
}

func digest(payload []byte) string {
	sum := sha256.Sum256(payload)
	return hex.EncodeToString(sum[:])
}
