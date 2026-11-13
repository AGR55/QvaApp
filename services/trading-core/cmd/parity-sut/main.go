// Comando de conformidad v1 para el runner de paridad.
//
// Protocolo NDJSON por stdin/stdout, una petición y una respuesta por línea:
//
//	-> {"id":"case-1","op":"market.roundQusd","input":{"value":1.234567891}}
//	<- {"id":"case-1","result":{"value":"1.23456789"}}
//
// No usa red, reloj ni estado entre peticiones. Los importes viajan como
// strings decimales de escala fija; el CLI no expone float64.
package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strings"

	"github.com/AGR55/QvaApp/services/shared/decimal"
	"github.com/AGR55/QvaApp/services/trading-core/internal/domain/applybudget"
	"github.com/AGR55/QvaApp/services/trading-core/internal/domain/budget"
	"github.com/AGR55/QvaApp/services/trading-core/internal/domain/chatstream"
	"github.com/AGR55/QvaApp/services/trading-core/internal/domain/coop"
	"github.com/AGR55/QvaApp/services/trading-core/internal/domain/dashboard"
	"github.com/AGR55/QvaApp/services/trading-core/internal/domain/flexible"
	"github.com/AGR55/QvaApp/services/trading-core/internal/domain/hunting"
	"github.com/AGR55/QvaApp/services/trading-core/internal/domain/liquidity"
	"github.com/AGR55/QvaApp/services/trading-core/internal/domain/marketmath"
	"github.com/AGR55/QvaApp/services/trading-core/internal/domain/monetary"
	"github.com/AGR55/QvaApp/services/trading-core/internal/domain/reconciliation"
	"github.com/AGR55/QvaApp/services/trading-core/internal/domain/riskpolicy"
	"github.com/AGR55/QvaApp/services/trading-core/internal/domain/telegrammenu"
)

type request struct {
	ID    string          `json:"id"`
	Op    string          `json:"op"`
	Input json.RawMessage `json:"input"`
}

type opError struct {
	Class   string `json:"class"`
	Code    string `json:"code,omitempty"`
	Message string `json:"message"`
}

type response struct {
	ID     string   `json:"id"`
	Result any      `json:"result,omitempty"`
	Error  *opError `json:"error,omitempty"`
}

func main() {
	scanner := bufio.NewScanner(os.Stdin)
	scanner.Buffer(make([]byte, 64*1024), 4*1024*1024)
	encoder := json.NewEncoder(os.Stdout)
	encoder.SetEscapeHTML(false)

	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}
		var req request
		if err := json.Unmarshal([]byte(line), &req); err != nil {
			_ = encoder.Encode(response{
				ID:    "<unparsed>",
				Error: &opError{Class: "protocol", Message: err.Error()},
			})
			continue
		}
		result, failure := dispatch(req)
		if failure != nil {
			_ = encoder.Encode(response{ID: req.ID, Error: failure})
			continue
		}
		_ = encoder.Encode(response{ID: req.ID, Result: result})
	}
	if err := scanner.Err(); err != nil {
		fmt.Fprintf(os.Stderr, "parity-sut: %v\n", err)
		os.Exit(2)
	}
}

func dispatch(req request) (any, *opError) {
	switch req.Op {
	case "market.roundQusd":
		fields, failure := object(req.Input)
		if failure != nil {
			return nil, failure
		}
		value, _, failure := numberField(fields, "value")
		if failure != nil {
			return nil, failure
		}
		return map[string]any{"value": marketmath.RoundQusd(value).Format(8)}, nil

	case "market.median":
		fields, failure := object(req.Input)
		if failure != nil {
			return nil, failure
		}
		values, failure := numberArrayField(fields, "values")
		if failure != nil {
			return nil, failure
		}
		median, ok := marketmath.Median(values)
		if !ok {
			return map[string]any{"value": nil}, nil
		}
		return map[string]any{"value": median.Format(8)}, nil

	case "market.outgoingFiatCost":
		fields, failure := object(req.Input)
		if failure != nil {
			return nil, failure
		}
		qusdAmount, _, failure := numberField(fields, "qusdAmount")
		if failure != nil {
			return nil, failure
		}
		fiatPerQusd, _, failure := numberField(fields, "fiatPerQusd")
		if failure != nil {
			return nil, failure
		}
		fixedFee, _, failure := numberField(fields, "fixedFee")
		if failure != nil {
			return nil, failure
		}
		cost := marketmath.OutgoingFiatCost(qusdAmount, fiatPerQusd, fixedFee)
		return map[string]any{
			"nominal":       cost.Nominal.Format(8),
			"fee":           cost.Fee.Format(8),
			"total":         cost.Total.Format(8),
			"effectiveRate": cost.EffectiveRate.Format(8),
		}, nil

	case "market.ownOfferFiatTotal":
		fields, failure := object(req.Input)
		if failure != nil {
			return nil, failure
		}
		qusdAmount, _, failure := numberField(fields, "qusdAmount")
		if failure != nil {
			return nil, failure
		}
		fiatPerQusd, _, failure := numberField(fields, "fiatPerQusd")
		if failure != nil {
			return nil, failure
		}
		side, failure := offerTypeField(fields, "type")
		if failure != nil {
			return nil, failure
		}
		currency, failure := stringField(fields, "currency")
		if failure != nil {
			return nil, failure
		}
		value, err := marketmath.OwnOfferFiatTotal(qusdAmount, fiatPerQusd, side, currency)
		if err != nil {
			return nil, validation(err.Error())
		}
		scale := 8
		if strings.EqualFold(strings.TrimSpace(currency), "CUP") {
			scale = 0
		}
		return map[string]any{"value": value.Format(scale)}, nil

	case "market.roundRateForIndex":
		fields, failure := object(req.Input)
		if failure != nil {
			return nil, failure
		}
		effectiveRate, _, failure := numberField(fields, "effectiveRate")
		if failure != nil {
			return nil, failure
		}
		side, failure := offerTypeField(fields, "type")
		if failure != nil {
			return nil, failure
		}
		configuredIndex, indexText, failure := numberField(fields, "configuredIndex")
		if failure != nil {
			return nil, failure
		}
		places, err := decimal.Places(indexText)
		if err != nil {
			return nil, validation(err.Error())
		}
		value, err := marketmath.RoundRateForIndex(effectiveRate, side, configuredIndex, places)
		if err != nil {
			return nil, validation(err.Error())
		}
		return map[string]any{"value": value.Format(places)}, nil

	case "budget.proportionalPlan":
		fields, failure := object(req.Input)
		if failure != nil {
			return nil, failure
		}
		rawOffers, failure := objectArrayField(fields, "offers")
		if failure != nil {
			return nil, failure
		}
		offers := make([]budget.Offer, 0, len(rawOffers))
		for _, raw := range rawOffers {
			uuid, failure := stringField(raw, "uuid")
			if failure != nil {
				return nil, failure
			}
			coin, failure := stringField(raw, "coin")
			if failure != nil {
				return nil, failure
			}
			side, failure := stringField(raw, "type")
			if failure != nil {
				return nil, failure
			}
			status, failure := stringField(raw, "status")
			if failure != nil {
				return nil, failure
			}
			amount, _, failure := numberField(raw, "amount")
			if failure != nil {
				return nil, failure
			}
			rate, _, failure := numberField(raw, "rate")
			if failure != nil {
				return nil, failure
			}
			var receive *decimal.Value
			if raw["receive"] != nil {
				value, _, failure := numberField(raw, "receive")
				if failure != nil {
					return nil, failure
				}
				receive = &value
			}
			offers = append(offers, budget.Offer{
				UUID:    uuid,
				Coin:    coin,
				Type:    side,
				Status:  status,
				Amount:  amount,
				Rate:    rate,
				Receive: receive,
			})
		}
		coin, failure := stringField(fields, "coin")
		if failure != nil {
			return nil, failure
		}
		available, _, failure := numberField(fields, "available")
		if failure != nil {
			return nil, failure
		}
		maximumRate, _, failure := numberField(fields, "maximumRate")
		if failure != nil {
			return nil, failure
		}
		outgoingTransferFee, failure := optionalNumberField(fields, "outgoingTransferFee", decimal.Zero())
		if failure != nil {
			return nil, failure
		}
		currency, failure := optionalStringField(fields, "currency", "")
		if failure != nil {
			return nil, failure
		}
		plan, err := budget.ProportionalPlan(
			offers,
			coin,
			available,
			maximumRate,
			outgoingTransferFee,
			currency,
		)
		if err != nil {
			return nil, validation(err.Error())
		}
		scale := budget.FiatScale(currency)
		adjustments := make([]any, 0, len(plan.Adjustments))
		for _, adjustment := range plan.Adjustments {
			adjustments = append(adjustments, map[string]any{
				"uuid":         adjustment.UUID,
				"coin":         adjustment.Coin,
				"rate":         adjustment.Rate.Format(8),
				"currentQusd":  adjustment.CurrentQusd.Format(8),
				"proposedQusd": adjustment.ProposedQusd.Format(8),
				"currentFiat":  adjustment.CurrentFiat.Format(scale),
				"proposedFiat": adjustment.ProposedFiat.Format(scale),
				"releasedFiat": adjustment.ReleasedFiat.Format(scale),
				"action":       adjustment.Action,
			})
		}
		return map[string]any{
			"coin":        plan.Coin,
			"available":   plan.Available.Format(scale),
			"committed":   plan.Committed.Format(scale),
			"deficit":     plan.Deficit.Format(scale),
			"invalid":     plan.Invalid,
			"adjustments": adjustments,
		}, nil

	case "risk.evaluate":
		fields, failure := object(req.Input)
		if failure != nil {
			return nil, failure
		}
		context, failure := decodeRiskContext(fields)
		if failure != nil {
			return nil, failure
		}
		decision, err := riskpolicy.Evaluate(context)
		if err != nil {
			return nil, validation(err.Error())
		}
		return riskResult(decision), nil

	case "liquidity.plan":
		fields, failure := object(req.Input)
		if failure != nil {
			return nil, failure
		}
		targetFields, failure := objectField(fields, "target")
		if failure != nil {
			return nil, failure
		}
		targetUUID, failure := optionalStringField(targetFields, "uuid", "")
		if failure != nil {
			return nil, failure
		}
		targetCoin, failure := stringField(targetFields, "coin")
		if failure != nil {
			return nil, failure
		}
		targetType, failure := stringField(targetFields, "type")
		if failure != nil {
			return nil, failure
		}
		targetAmount, _, failure := numberField(targetFields, "amount")
		if failure != nil {
			return nil, failure
		}
		targetReceive, _, failure := numberField(targetFields, "receive")
		if failure != nil {
			return nil, failure
		}
		availableQusd, _, failure := numberField(fields, "availableQusd")
		if failure != nil {
			return nil, failure
		}
		reserveQusd, _, failure := numberField(fields, "reserveQusd")
		if failure != nil {
			return nil, failure
		}
		rawOffers, failure := objectArrayField(fields, "ownOffers")
		if failure != nil {
			return nil, failure
		}
		offers := make([]liquidity.Offer, 0, len(rawOffers))
		for _, raw := range rawOffers {
			offer, failure := parseLiquidityOffer(raw)
			if failure != nil {
				return nil, failure
			}
			offers = append(offers, offer)
		}
		economics, failure := parseMarketEconomics(fields)
		if failure != nil {
			return nil, failure
		}
		plan, err := liquidity.PlanLiquidity(liquidity.Input{
			Target: liquidity.Target{
				UUID:    targetUUID,
				Coin:    targetCoin,
				Type:    targetType,
				Amount:  targetAmount,
				Receive: targetReceive,
			},
			AvailableQusd: availableQusd,
			ReserveQusd:   reserveQusd,
			OwnOffers:     offers,
			Economics:     economics,
		})
		if err != nil {
			return nil, validation(err.Error())
		}
		return liquidityResult(plan), nil

	case "apply.budget":
		fields, failure := object(req.Input)
		if failure != nil {
			return nil, failure
		}
		now, failure := integerField(fields, "now")
		if failure != nil {
			return nil, failure
		}
		var attempts []int64
		if fields["attempts"] != nil {
			attempts, failure = integerArrayField(fields, "attempts")
			if failure != nil {
				return nil, failure
			}
		}
		legacyApplyAt, failure := optionalIntegerField(fields, "legacyApplyAt")
		if failure != nil {
			return nil, failure
		}
		retryAt, failure := optionalIntegerField(fields, "retryAt")
		if failure != nil {
			return nil, failure
		}
		normalized := applybudget.Attempts(attempts, legacyApplyAt)
		return map[string]any{
			"attempts": normalized,
			"readyAt":  applybudget.ReadyAt(normalized, retryAt, now),
		}, nil

	case "hunt.requirements":
		fields, failure := object(req.Input)
		if failure != nil {
			return nil, failure
		}
		offerFields, failure := objectField(fields, "offer")
		if failure != nil {
			return nil, failure
		}
		offer, failure := parseHuntingOffer(offerFields)
		if failure != nil {
			return nil, failure
		}
		now, _, failure := numberField(fields, "now")
		if failure != nil {
			return nil, failure
		}
		actions := []any{}
		if fields["actions"] != nil {
			list, ok := fields["actions"].([]any)
			if !ok {
				return nil, validation("El campo actions debe ser un array.")
			}
			actions = list
		}
		state := hunting.NewState()
		for _, item := range actions {
			action, ok := item.(map[string]any)
			if !ok {
				return nil, validation("Cada acción debe ser un objeto.")
			}
			kind, failure := huntingActionKind(action)
			if failure != nil {
				return nil, failure
			}
			at, _, failure := numberField(action, "at")
			if failure != nil {
				return nil, failure
			}
			switch kind {
			case "eligibility":
				value, ok := action["value"].(map[string]any)
				if !ok {
					return nil, validation("El campo value debe ser un objeto.")
				}
				state.RecordEligibility(parseHuntingEligibility(value, at), at)
			case "missing":
				state.RecordMissing(parseHuntingMissing(action["value"]), at)
			}
		}
		reason, found := state.Reason(offer, now)
		return huntingResult(reason, found), nil

	case "flexible.size":
		fields, failure := object(req.Input)
		if failure != nil {
			return nil, failure
		}
		offerFields, failure := objectField(fields, "offer")
		if failure != nil {
			return nil, failure
		}
		offer, failure := parseFlexibleOffer(offerFields)
		if failure != nil {
			return nil, failure
		}
		capacity, _, failure := numberField(fields, "capacity")
		if failure != nil {
			return nil, failure
		}
		var limit *decimal.Value
		if fields["limit"] != nil {
			value, _, failure := numberField(fields, "limit")
			if failure != nil {
				return nil, failure
			}
			limit = &value
		}
		sized := flexible.Size(offer, capacity, limit)
		if sized == nil {
			return json.RawMessage("null"), nil
		}
		return flexibleSizeResult(*sized), nil

	case "flexible.orderForOperation":
		fields, failure := object(req.Input)
		if failure != nil {
			return nil, failure
		}
		offerFields, failure := objectField(fields, "offer")
		if failure != nil {
			return nil, failure
		}
		offer, failure := parseFlexibleOffer(offerFields)
		if failure != nil {
			return nil, failure
		}
		var orderUUID *string
		if fields["orderUuid"] != nil {
			value, failure := stringField(fields, "orderUuid")
			if failure != nil {
				return nil, failure
			}
			orderUUID = &value
		}
		result, err := flexible.OrderForOperation(offer, orderUUID)
		if err != nil {
			return nil, flexibleFailure(err)
		}
		return flexibleProjection(result), nil

	case "flexible.matchingRecoveryOrder":
		fields, failure := object(req.Input)
		if failure != nil {
			return nil, failure
		}
		offerFields, failure := objectField(fields, "offer")
		if failure != nil {
			return nil, failure
		}
		offer, failure := parseFlexibleOffer(offerFields)
		if failure != nil {
			return nil, failure
		}
		amount, _, failure := numberField(fields, "amount")
		if failure != nil {
			return nil, failure
		}
		since, _, failure := numberField(fields, "since")
		if failure != nil {
			return nil, failure
		}
		var account *string
		if fields["account"] != nil {
			value, failure := stringField(fields, "account")
			if failure != nil {
				return nil, failure
			}
			account = &value
		}
		order := flexible.MatchingRecoveryOrder(offer, amount, since, account)
		if order == nil {
			return json.RawMessage("null"), nil
		}
		return flexibleOrderResult(*order), nil

	case "dashboard.margin":
		fields, failure := object(req.Input)
		if failure != nil {
			return nil, failure
		}
		buyRate, _, failure := numberField(fields, "buyRate")
		if failure != nil {
			return nil, failure
		}
		sellRate, _, failure := numberField(fields, "sellRate")
		if failure != nil {
			return nil, failure
		}
		amount, _, failure := numberField(fields, "amount")
		if failure != nil {
			return nil, failure
		}
		sellFeePercent, _, failure := numberField(fields, "sellFeePercent")
		if failure != nil {
			return nil, failure
		}
		outgoingTransferFee, failure := optionalNumberField(fields, "outgoingTransferFee", decimal.Zero())
		if failure != nil {
			return nil, failure
		}
		margin := dashboard.CalculateMargin(buyRate, sellRate, amount, sellFeePercent, outgoingTransferFee)
		return dashboardMarginResult(margin), nil

	case "dashboard.allocate":
		fields, failure := object(req.Input)
		if failure != nil {
			return nil, failure
		}
		budgetAmount, _, failure := numberField(fields, "budget")
		if failure != nil {
			return nil, failure
		}
		reserve, _, failure := numberField(fields, "reserve")
		if failure != nil {
			return nil, failure
		}
		maximumPerOffer, _, failure := numberField(fields, "maximumPerOffer")
		if failure != nil {
			return nil, failure
		}
		rawOpportunities, ok := fields["opportunities"].([]any)
		if !ok {
			return nil, validation("El campo opportunities debe ser un array.")
		}
		opportunities := make([]dashboard.Opportunity, 0, len(rawOpportunities))
		for _, item := range rawOpportunities {
			object, ok := item.(map[string]any)
			if !ok {
				return nil, validation("Cada oportunidad debe ser un objeto.")
			}
			rate, _, failure := numberField(object, "rate")
			if failure != nil {
				return nil, failure
			}
			amount, _, failure := numberField(object, "amount")
			if failure != nil {
				return nil, failure
			}
			opportunities = append(opportunities, dashboard.Opportunity{Rate: rate, Amount: amount})
		}
		return dashboardAllocationResult(dashboard.AllocateBudget(budgetAmount, reserve, maximumPerOffer, opportunities)), nil

	case "dashboard.compact-history":
		fields, failure := object(req.Input)
		if failure != nil {
			return nil, failure
		}
		rawHistory, ok := fields["history"].([]any)
		if !ok {
			return nil, validation("El campo history debe ser un array.")
		}
		points, originals, failure := dashboardHistoryPoints(rawHistory)
		if failure != nil {
			return nil, failure
		}
		maxPerMarket, failure := integerField(fields, "maxPerMarket")
		if failure != nil {
			return nil, failure
		}
		selected, err := dashboard.CompactHistory(points, int(maxPerMarket))
		if err != nil {
			return nil, validation(err.Error())
		}
		return dashboardHistoryResult(selected, originals), nil

	case "reconciliation.sequence":
		fields, failure := object(req.Input)
		if failure != nil {
			return nil, failure
		}
		rawSteps, ok := fields["steps"].([]any)
		if !ok {
			return nil, validation("El campo steps debe ser un array.")
		}
		state := mapState{}
		scheduler := reconciliation.New(state)
		results := make([]any, 0, len(rawSteps))
		for _, item := range rawSteps {
			step, ok := item.(map[string]any)
			if !ok {
				return nil, validation("Cada paso debe ser un objeto.")
			}
			operation, failure := stringField(step, "op")
			if failure != nil {
				return nil, failure
			}
			intentID, failure := stringField(step, "intentId")
			if failure != nil {
				return nil, failure
			}
			switch operation {
			case "canAttempt":
				at, failure := integerField(step, "at")
				if failure != nil {
					return nil, failure
				}
				can, err := scheduler.CanAttempt(intentID, at)
				if err != nil {
					return nil, validation(err.Error())
				}
				results = append(results, map[string]any{"can": can})
			case "recordFailure":
				at, failure := integerField(step, "at")
				if failure != nil {
					return nil, failure
				}
				record, err := scheduler.RecordFailure(intentID, at)
				if err != nil {
					return nil, validation(err.Error())
				}
				results = append(results, reconciliationResult(record))
			case "clear":
				if err := scheduler.Clear(intentID); err != nil {
					return nil, validation(err.Error())
				}
				results = append(results, nil)
			default:
				return nil, validation(fmt.Sprintf("Operación de conciliación desconocida: %s.", operation))
			}
		}
		return map[string]any{"results": results}, nil

	case "monetary.timing":
		repository := newMemoryRepository()
		phases := make([]string, 0, 3)
		durations := make([]float64, 0, 3)
		_, err := monetary.Execute(repository, func() string { return "timed" }, monetary.Mutation{
			Kind:    "received",
			Request: map[string]any{},
			Action:  func(string) (any, error) { return nil, nil },
			OnTiming: func(phase string, milliseconds float64) {
				durations = append(durations, milliseconds)
				phases = append(phases, phase)
				panic("observer failed")
			},
		})
		if err != nil {
			return nil, validation(err.Error())
		}
		finite := true
		for _, milliseconds := range durations {
			if milliseconds < 0 {
				finite = false
			}
		}
		return map[string]any{
			"phases":          phases,
			"durationsFinite": finite,
			"state":           repository.intents["timed"].state,
		}, nil

	case "monetary.persist-before-dispatch":
		repository := newMemoryRepository()
		result, err := monetary.Execute(repository, func() string { return "intent-1" }, monetary.Mutation{
			Kind:          "apply",
			OperationUUID: "offer-1",
			Request:       map[string]any{"uuid": "offer-1"},
			Action: func(string) (any, error) {
				intent := repository.intents["intent-1"]
				if intent == nil || intent.state != "submitted" {
					return nil, errors.New("la intención no estaba submitted")
				}
				repository.events = append(repository.events, "remote:apply")
				return map[string]any{"ok": true}, nil
			},
		})
		if err != nil {
			return nil, validation(err.Error())
		}
		return map[string]any{
			"result": result,
			"state":  repository.intents["intent-1"].state,
			"events": repository.events,
		}, nil

	case "monetary.persist-failure":
		repository := newMemoryRepository()
		repository.failCreate = true
		dispatched := false
		_, err := monetary.Execute(repository, func() string { return "intent-2" }, monetary.Mutation{
			Kind:    "cancel",
			Request: map[string]any{},
			Action: func(string) (any, error) {
				dispatched = true
				return nil, nil
			},
		})
		message := ""
		if err != nil {
			message = err.Error()
		}
		return map[string]any{"dispatched": dispatched, "message": message}, nil

	case "monetary.failure-classification":
		fields, _ := object(req.Input)
		kind := "unknown"
		if fields != nil {
			if value, ok := fields["kind"].(string); ok {
				kind = value
			}
		}
		results := monetaryClassification([]string{kind})
		return results[0], nil

	case "monetary.failure-classification-all":
		fields, failure := object(req.Input)
		if failure != nil {
			return nil, failure
		}
		kinds := []string{}
		if fields["kinds"] != nil {
			kinds, failure = stringArrayField(fields, "kinds")
			if failure != nil {
				return nil, failure
			}
		}
		return map[string]any{"results": monetaryClassification(kinds)}, nil

	case "monetary.outcome":
		fields, _ := object(req.Input)
		kind := "unknown"
		if fields != nil {
			if value, ok := fields["kind"].(string); ok {
				kind = value
			}
		}
		return map[string]any{"outcome": monetary.Outcome(monetaryError(kind))}, nil

	case "monetary.outcome-all":
		fields, failure := object(req.Input)
		if failure != nil {
			return nil, failure
		}
		kinds := []string{}
		if fields["kinds"] != nil {
			kinds, failure = stringArrayField(fields, "kinds")
			if failure != nil {
				return nil, failure
			}
		}
		return map[string]any{"results": monetaryOutcomes(kinds)}, nil

	case "market-list-budget.sequence":
		fields, failure := object(req.Input)
		if failure != nil {
			return nil, failure
		}
		return budgetSequence(fields)

	case "chat.consume":
		fields, failure := object(req.Input)
		if failure != nil {
			return nil, failure
		}
		chunks, failure := stringArrayField(fields, "chunks")
		if failure != nil {
			return nil, failure
		}
		changes := 0
		if err := chatstream.Consume(chunks, func() { changes++ }); err != nil {
			return nil, chatFailure(err)
		}
		return map[string]any{"changes": changes}, nil

	case "chat.order-read":
		return chatOrderRead(), nil

	case "coop.encode":
		fields, failure := object(req.Input)
		if failure != nil {
			return nil, failure
		}
		rawAction, ok := fields["action"].(map[string]any)
		if !ok {
			return nil, validation("El campo action debe ser un objeto.")
		}
		action, failure := coopAction(rawAction)
		if failure != nil {
			return nil, failure
		}
		encoded, err := coop.Encode(action)
		if err != nil {
			return nil, coopFailure(err)
		}
		return map[string]any{"encoded": encoded, "bytes": len([]byte(encoded)), "prefix": coop.CallbackPrefix}, nil

	case "coop.decode":
		fields, failure := object(req.Input)
		if failure != nil {
			return nil, failure
		}
		data, failure := stringField(fields, "data")
		if failure != nil {
			return nil, failure
		}
		action, err := coop.Decode(data)
		if err != nil {
			return nil, coopFailure(err)
		}
		return map[string]any{"action": coopActionView(action)}, nil

	case "coop.roundtrip":
		fields, failure := object(req.Input)
		if failure != nil {
			return nil, failure
		}
		rawActions, ok := fields["actions"].([]any)
		if !ok {
			return nil, validation("El campo actions debe ser un array.")
		}
		results := make([]any, 0, len(rawActions))
		for _, item := range rawActions {
			object, ok := item.(map[string]any)
			if !ok {
				return nil, validation("Cada acción debe ser un objeto.")
			}
			action, failure := coopAction(object)
			if failure != nil {
				return nil, failure
			}
			encoded, err := coop.Encode(action)
			if err != nil {
				return nil, coopFailure(err)
			}
			decoded, err := coop.Decode(encoded)
			if err != nil {
				return nil, coopFailure(err)
			}
			results = append(results, map[string]any{
				"encoded": encoded,
				"bytes":   len([]byte(encoded)),
				"decoded": coopActionView(decoded),
			})
		}
		return map[string]any{"results": results}, nil

	case "coop.sessions":
		fields, failure := object(req.Input)
		if failure != nil {
			return nil, failure
		}
		return coopSessions(fields)

	case "telegram.commands":
		commands := make([]string, 0, len(telegrammenu.Commands))
		descriptions := make([]string, 0, len(telegrammenu.Commands))
		unique := map[string]bool{}
		allDescribed := true
		for _, command := range telegrammenu.Commands {
			commands = append(commands, command.Command)
			descriptions = append(descriptions, command.Description)
			unique[command.Command] = true
			if command.Description == "" {
				allDescribed = false
			}
		}
		return map[string]any{
			"commands":     commands,
			"descriptions": descriptions,
			"unique":       len(unique) == len(commands),
			"allDescribed": allDescribed,
		}, nil

	case "telegram.encode":
		fields, failure := object(req.Input)
		if failure != nil {
			return nil, failure
		}
		rawAction, ok := fields["action"].(map[string]any)
		if !ok {
			return nil, validation("El campo action debe ser un objeto.")
		}
		action, failure := telegramAction(rawAction)
		if failure != nil {
			return nil, failure
		}
		encoded, err := telegrammenu.Encode(action)
		if err != nil {
			return nil, telegramFailure(err)
		}
		return map[string]any{"encoded": encoded, "bytes": len([]byte(encoded)), "prefix": telegrammenu.CallbackPrefix}, nil

	case "telegram.decode":
		fields, failure := object(req.Input)
		if failure != nil {
			return nil, failure
		}
		data, failure := stringField(fields, "data")
		if failure != nil {
			return nil, failure
		}
		action, err := telegrammenu.Decode(data)
		if err != nil {
			return nil, telegramFailure(err)
		}
		return map[string]any{"action": telegramActionView(action)}, nil

	case "telegram.roundtrip":
		fields, failure := object(req.Input)
		if failure != nil {
			return nil, failure
		}
		rawActions, ok := fields["actions"].([]any)
		if !ok {
			return nil, validation("El campo actions debe ser un array.")
		}
		results := make([]any, 0, len(rawActions))
		for _, item := range rawActions {
			object, ok := item.(map[string]any)
			if !ok {
				return nil, validation("Cada acción debe ser un objeto.")
			}
			action, failure := telegramAction(object)
			if failure != nil {
				return nil, failure
			}
			encoded, err := telegrammenu.Encode(action)
			if err != nil {
				return nil, telegramFailure(err)
			}
			decoded, err := telegrammenu.Decode(encoded)
			if err != nil {
				return nil, telegramFailure(err)
			}
			results = append(results, map[string]any{
				"encoded": encoded,
				"bytes":   len([]byte(encoded)),
				"decoded": telegramActionView(decoded),
			})
		}
		return map[string]any{"results": results}, nil

	case "telegram.parse-rates":
		fields, failure := object(req.Input)
		if failure != nil {
			return nil, failure
		}
		texts, failure := stringArrayField(fields, "texts")
		if failure != nil {
			return nil, failure
		}
		results := make([]any, 0, len(texts))
		for _, text := range texts {
			value, err := telegrammenu.ParseExactRate(text)
			if err != nil {
				results = append(results, map[string]any{"error": err.Error()})
			} else {
				results = append(results, map[string]any{"value": json.Number(value.Compact())})
			}
		}
		return map[string]any{"results": results}, nil

	case "telegram.parse-rate":
		fields, failure := object(req.Input)
		if failure != nil {
			return nil, failure
		}
		text, failure := stringField(fields, "text")
		if failure != nil {
			return nil, failure
		}
		value, err := telegrammenu.ParseExactRate(text)
		if err != nil {
			return nil, telegramFailure(err)
		}
		return map[string]any{"value": json.Number(value.Compact())}, nil

	case "telegram.rate-sessions":
		fields, failure := object(req.Input)
		if failure != nil {
			return nil, failure
		}
		return telegramRateSessions(fields)

	case "qusd.sequence":
		fields, failure := object(req.Input)
		if failure != nil {
			return nil, failure
		}
		return qusdSequence(fields)

	case "telegram.answer-callback":
		fields, failure := object(req.Input)
		if failure != nil {
			return nil, failure
		}
		return telegramRuntimeAnswer(fields)

	case "telegram.split-callback":
		fields, failure := object(req.Input)
		if failure != nil {
			return nil, failure
		}
		data, failure := stringField(fields, "data")
		if failure != nil {
			return nil, failure
		}
		return telegramRuntimeSplit(data), nil

	case "telegram.render-guard":
		fields, failure := object(req.Input)
		if failure != nil {
			return nil, failure
		}
		return telegramRuntimeRenderGuard(fields)

	case "telegram.not-modified":
		fields, failure := object(req.Input)
		if failure != nil {
			return nil, failure
		}
		message, failure := stringField(fields, "message")
		if failure != nil {
			return nil, failure
		}
		return telegramRuntimeNotModified(message), nil

	case "scheduler.sequence":
		fields, failure := object(req.Input)
		if failure != nil {
			return nil, failure
		}
		return schedulerSequence(fields)

	default:
		return nil, &opError{
			Class:   "protocol",
			Code:    "unknown-op",
			Message: fmt.Sprintf("Operación desconocida: %s", req.Op),
		}
	}
}

func object(raw json.RawMessage) (map[string]any, *opError) {
	value, err := decode(raw)
	if err != nil {
		return nil, protocol(err.Error())
	}
	fields, ok := value.(map[string]any)
	if !ok {
		return nil, validation("El input debe ser un objeto.")
	}
	return fields, nil
}

func numberField(fields map[string]any, key string) (decimal.Value, string, *opError) {
	value, ok := fields[key]
	if !ok {
		return decimal.Value{}, "", validation(fmt.Sprintf("El campo %s debe ser un número finito.", key))
	}
	number, ok := value.(json.Number)
	if !ok {
		return decimal.Value{}, "", validation(fmt.Sprintf("El campo %s debe ser un número finito.", key))
	}
	parsed, err := decimal.Parse(number.String())
	if err != nil {
		return decimal.Value{}, "", validation(fmt.Sprintf("El campo %s debe ser un número finito.", key))
	}
	return parsed, number.String(), nil
}

func numberArrayField(fields map[string]any, key string) ([]decimal.Value, *opError) {
	value, ok := fields[key]
	if !ok {
		return nil, validation(fmt.Sprintf("El campo %s debe ser un array.", key))
	}
	items, ok := value.([]any)
	if !ok {
		return nil, validation(fmt.Sprintf("El campo %s debe ser un array.", key))
	}
	values := make([]decimal.Value, 0, len(items))
	for _, item := range items {
		number, ok := item.(json.Number)
		if !ok {
			return nil, validation(fmt.Sprintf("El campo %s debe ser un array de números.", key))
		}
		parsed, err := decimal.Parse(number.String())
		if err != nil {
			return nil, validation(fmt.Sprintf("El campo %s debe ser un array de números.", key))
		}
		values = append(values, parsed)
	}
	return values, nil
}

const maxSafeInteger = int64(1<<53 - 1)

func integerField(fields map[string]any, key string) (int64, *opError) {
	value, ok := fields[key]
	if !ok {
		return 0, validation(fmt.Sprintf("El campo %s debe ser un entero.", key))
	}
	number, ok := value.(json.Number)
	if !ok {
		return 0, validation(fmt.Sprintf("El campo %s debe ser un entero.", key))
	}
	parsed, err := decimal.Parse(number.String())
	if err != nil {
		return 0, validation(fmt.Sprintf("El campo %s debe ser un entero.", key))
	}
	integer, ok := parsed.Int64()
	if !ok || integer < -maxSafeInteger || integer > maxSafeInteger {
		return 0, validation(fmt.Sprintf("El campo %s debe ser un entero.", key))
	}
	return integer, nil
}

func optionalIntegerField(fields map[string]any, key string) (*int64, *opError) {
	if fields[key] == nil {
		return nil, nil
	}
	value, failure := integerField(fields, key)
	if failure != nil {
		return nil, failure
	}
	return &value, nil
}

func integerArrayField(fields map[string]any, key string) ([]int64, *opError) {
	value, ok := fields[key]
	if !ok {
		return nil, validation(fmt.Sprintf("El campo %s debe ser un array.", key))
	}
	items, ok := value.([]any)
	if !ok {
		return nil, validation(fmt.Sprintf("El campo %s debe ser un array.", key))
	}
	values := make([]int64, 0, len(items))
	for _, item := range items {
		number, ok := item.(json.Number)
		if !ok {
			return nil, validation(fmt.Sprintf("El campo %s debe ser un array de enteros.", key))
		}
		parsed, err := decimal.Parse(number.String())
		if err != nil {
			return nil, validation(fmt.Sprintf("El campo %s debe ser un array de enteros.", key))
		}
		integer, ok := parsed.Int64()
		if !ok || integer < -maxSafeInteger || integer > maxSafeInteger {
			return nil, validation(fmt.Sprintf("El campo %s debe ser un array de enteros.", key))
		}
		values = append(values, integer)
	}
	return values, nil
}

func stringField(fields map[string]any, key string) (string, *opError) {
	value, ok := fields[key]
	if !ok {
		return "", validation(fmt.Sprintf("El campo %s debe ser texto.", key))
	}
	text, ok := value.(string)
	if !ok {
		return "", validation(fmt.Sprintf("El campo %s debe ser texto.", key))
	}
	return text, nil
}

func optionalNumberField(fields map[string]any, key string, fallback decimal.Value) (decimal.Value, *opError) {
	if fields[key] == nil {
		return fallback, nil
	}
	value, _, failure := numberField(fields, key)
	return value, failure
}

func optionalStringField(fields map[string]any, key string, fallback string) (string, *opError) {
	if fields[key] == nil {
		return fallback, nil
	}
	return stringField(fields, key)
}

func boolField(fields map[string]any, key string) (bool, *opError) {
	value, ok := fields[key]
	if !ok {
		return false, validation(fmt.Sprintf("El campo %s debe ser booleano.", key))
	}
	boolean, ok := value.(bool)
	if !ok {
		return false, validation(fmt.Sprintf("El campo %s debe ser booleano.", key))
	}
	return boolean, nil
}

func objectField(fields map[string]any, key string) (map[string]any, *opError) {
	value, ok := fields[key]
	if !ok {
		return nil, validation(fmt.Sprintf("El campo %s debe ser un objeto.", key))
	}
	object, ok := value.(map[string]any)
	if !ok {
		return nil, validation(fmt.Sprintf("El campo %s debe ser un objeto.", key))
	}
	return object, nil
}

func objectArrayField(fields map[string]any, key string) ([]map[string]any, *opError) {
	value, ok := fields[key]
	if !ok {
		return nil, validation(fmt.Sprintf("El campo %s debe ser un array.", key))
	}
	items, ok := value.([]any)
	if !ok {
		return nil, validation(fmt.Sprintf("El campo %s debe ser un array.", key))
	}
	objects := make([]map[string]any, 0, len(items))
	for _, item := range items {
		object, ok := item.(map[string]any)
		if !ok {
			return nil, validation(fmt.Sprintf("El campo %s debe ser un array de objetos.", key))
		}
		objects = append(objects, object)
	}
	return objects, nil
}

func offerTypeField(fields map[string]any, key string) (marketmath.OfferType, *opError) {
	text, failure := stringField(fields, key)
	if failure != nil {
		return "", failure
	}
	side, err := marketmath.ParseOfferType(text)
	if err != nil {
		return "", validation("El tipo debe ser buy o sell.")
	}
	return side, nil
}

func decode(raw json.RawMessage) (any, error) {
	if len(bytes.TrimSpace(raw)) == 0 {
		return nil, fmt.Errorf("input vacío")
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	var value any
	if err := decoder.Decode(&value); err != nil {
		return nil, err
	}
	return value, nil
}

func validation(message string) *opError {
	return &opError{Class: "validation", Message: message}
}

func protocol(message string) *opError {
	return &opError{Class: "protocol", Message: message}
}
