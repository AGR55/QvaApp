package main

import (
	"encoding/json"
	"fmt"

	"github.com/AGR55/QvaApp/services/shared/decimal"
	"github.com/AGR55/QvaApp/services/trading-core/internal/domain/riskpolicy"
)

type riskDecoder struct {
	failure *opError
	finite  bool
}

func (decoder *riskDecoder) text(fields map[string]any, key string) string {
	if decoder.failure != nil {
		return ""
	}
	value, failure := stringField(fields, key)
	if failure != nil {
		decoder.failure = failure
	}
	return value
}

func (decoder *riskDecoder) optionalText(fields map[string]any, key string) string {
	if fields[key] == nil {
		return ""
	}
	return decoder.text(fields, key)
}

func (decoder *riskDecoder) boolean(fields map[string]any, key string) bool {
	if decoder.failure != nil {
		return false
	}
	value, failure := boolField(fields, key)
	if failure != nil {
		decoder.failure = failure
	}
	return value
}

func (decoder *riskDecoder) number(fields map[string]any, key string) decimal.Value {
	if decoder.failure != nil {
		return decimal.Zero()
	}
	value, ok := fields[key]
	if !ok {
		decoder.failure = validation(fmt.Sprintf("El campo %s debe ser un número.", key))
		return decimal.Zero()
	}
	switch typed := value.(type) {
	case json.Number:
		parsed, err := decimal.Parse(typed.String())
		if err != nil {
			decoder.failure = validation(fmt.Sprintf("El campo %s debe ser un número.", key))
			return decimal.Zero()
		}
		return parsed
	case string:
		if typed == "NaN" || typed == "Infinity" || typed == "-Infinity" {
			decoder.finite = false
			return decimal.Zero()
		}
	}
	decoder.failure = validation(fmt.Sprintf("El campo %s debe ser un número.", key))
	return decimal.Zero()
}

func (decoder *riskDecoder) optionalNumber(fields map[string]any, key string) *decimal.Value {
	if fields[key] == nil {
		return nil
	}
	value := decoder.number(fields, key)
	if decoder.failure != nil {
		return nil
	}
	return &value
}

func (decoder *riskDecoder) object(fields map[string]any, key string) map[string]any {
	if decoder.failure != nil {
		return map[string]any{}
	}
	value, failure := objectField(fields, key)
	if failure != nil {
		decoder.failure = failure
		return map[string]any{}
	}
	return value
}

func (decoder *riskDecoder) side(fields map[string]any) riskpolicy.Side {
	value := decoder.text(fields, "side")
	switch riskpolicy.Side(value) {
	case riskpolicy.BuyQusd, riskpolicy.SellQusd:
		return riskpolicy.Side(value)
	default:
		if decoder.failure == nil {
			decoder.failure = validation("El lado debe ser buy_qusd o sell_qusd.")
		}
		return ""
	}
}

func (decoder *riskDecoder) priceDecision(fields map[string]any) riskpolicy.PriceDecision {
	value := decoder.text(fields, "priceDecision")
	switch riskpolicy.PriceDecision(value) {
	case riskpolicy.Eligible, riskpolicy.PriceManual, riskpolicy.PriceBlocked, riskpolicy.PriceIgnored:
		return riskpolicy.PriceDecision(value)
	default:
		if decoder.failure == nil {
			decoder.failure = validation("La decisión de precio no es válida.")
		}
		return ""
	}
}

func decodeRiskContext(fields map[string]any) (riskpolicy.Context, *opError) {
	decoder := &riskDecoder{finite: true}
	opportunityFields := decoder.object(fields, "opportunity")
	limitsFields := decoder.object(fields, "limits")

	context := riskpolicy.Context{
		Now: decoder.number(fields, "now"),
		Opportunity: riskpolicy.Opportunity{
			UUID:           decoder.text(opportunityFields, "uuid"),
			Market:         decoder.text(opportunityFields, "market"),
			Side:           decoder.side(opportunityFields),
			QusdAmount:     decoder.number(opportunityFields, "qusdAmount"),
			RequiredFiat:   decoder.number(opportunityFields, "requiredFiat"),
			QuotedRate:     decoder.number(opportunityFields, "quotedRate"),
			ReferenceRate:  decoder.number(opportunityFields, "referenceRate"),
			ObservedAt:     decoder.number(opportunityFields, "observedAt"),
			CounterpartyID: decoder.optionalText(opportunityFields, "counterpartyId"),
		},
		Limits: riskpolicy.Limits{
			MaxQusdPerOperation:         decoder.number(limitsFields, "maxQusdPerOperation"),
			MaxConcurrentQusdExposure:   decoder.number(limitsFields, "maxConcurrentQusdExposure"),
			MaxDailyAppliedQusd:         decoder.number(limitsFields, "maxDailyAppliedQusd"),
			MaxConcurrentOperations:     decoder.number(limitsFields, "maxConcurrentOperations"),
			MinQusdReserve:              decoder.number(limitsFields, "minQusdReserve"),
			MaxQuoteAgeSeconds:          decoder.number(limitsFields, "maxQuoteAgeSeconds"),
			MinExpectedMarginPercent:    decoder.number(limitsFields, "minExpectedMarginPercent"),
			MaxSlippagePercent:          decoder.number(limitsFields, "maxSlippagePercent"),
			MaxConsecutiveErrors:        decoder.number(limitsFields, "maxConsecutiveErrors"),
			MarketCooldownSeconds:       decoder.number(limitsFields, "marketCooldownSeconds"),
			CounterpartyCooldownSeconds: decoder.number(limitsFields, "counterpartyCooldownSeconds"),
		},
		PriceDecision:               decoder.priceDecision(fields),
		PriceReason:                 decoder.text(fields, "priceReason"),
		ExpectedMarginPercent:       decoder.number(fields, "expectedMarginPercent"),
		QusdBalance:                 decoder.number(fields, "qusdBalance"),
		FiatAvailable:               decoder.number(fields, "fiatAvailable"),
		ConcurrentQusdExposure:      decoder.number(fields, "concurrentQusdExposure"),
		DailyAppliedQusd:            decoder.number(fields, "dailyAppliedQusd"),
		ActiveOperations:            decoder.number(fields, "activeOperations"),
		ConsecutiveErrors:           decoder.number(fields, "consecutiveErrors"),
		Paused:                      decoder.boolean(fields, "paused"),
		EmergencyStop:               decoder.boolean(fields, "emergencyStop"),
		HasUnresolvedMutation:       decoder.boolean(fields, "hasUnresolvedMutation"),
		LastMarketOperationAt:       decoder.optionalNumber(fields, "lastMarketOperationAt"),
		LastCounterpartyOperationAt: decoder.optionalNumber(fields, "lastCounterpartyOperationAt"),
	}
	if decoder.failure != nil {
		return riskpolicy.Context{}, decoder.failure
	}
	if !decoder.finite {
		return riskpolicy.Context{}, validation("El contexto y los límites de riesgo deben ser finitos y no negativos.")
	}
	return context, nil
}

func riskResult(decision riskpolicy.Decision) map[string]any {
	checks := make([]any, 0, len(decision.Checks))
	for _, check := range decision.Checks {
		item := map[string]any{
			"code":   check.Code,
			"label":  check.Label,
			"status": string(check.Status),
			"reason": check.Reason,
		}
		if check.Actual != nil {
			item["actual"] = riskEvidence(check.Actual)
		}
		if check.Limit != nil {
			item["limit"] = riskEvidence(check.Limit)
		}
		checks = append(checks, item)
	}
	return map[string]any{
		"kind":                      string(decision.Kind),
		"opportunityUuid":           decision.OpportunityUUID,
		"evaluatedAt":               json.Number(decision.EvaluatedAt.Format(0)),
		"requiredQusd":              decision.RequiredQusd.Format(8),
		"requiredFiat":              decision.RequiredFiat.Format(8),
		"projectedExposureQusd":     decision.ProjectedExposureQusd.Format(8),
		"projectedDailyAppliedQusd": decision.ProjectedDailyAppliedQusd.Format(8),
		"checks":                    checks,
		"reasons":                   decision.Reasons,
	}
}

func riskEvidence(value any) any {
	if decimalValue, ok := value.(decimal.Value); ok {
		return decimalValue.Format(8)
	}
	return value
}
