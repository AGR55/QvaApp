package moneycore

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"sort"
	"strconv"

	"github.com/AGR55/QvaApp/services/shared/decimal"
)

// Target es la oferta externa que se evalúa.
type Target struct {
	UUID    string
	Coin    string
	Type    string
	Amount  decimal.Value
	Receive decimal.Value
}

type gatewayOutcome struct {
	okValue    any
	hasOK      bool
	errKind    string
	errStatus  int
	errMessage string
}

func (outcome gatewayOutcome) ok() any {
	if outcome.errKind != "" {
		return nil
	}
	return outcome.okValue
}

type gateway struct {
	balanceValues []any
	balanceIndex  int
	listOffers    []any
	listIndex     int
	getOffers     map[string]gatewayOutcome
	queues        map[string][]gatewayOutcome
	indexes       map[string]int
}

func parseGateway(raw any) (*gateway, error) {
	result := &gateway{
		getOffers: map[string]gatewayOutcome{},
		queues:    map[string][]gatewayOutcome{},
		indexes:   map[string]int{},
	}
	if raw == nil {
		return result, nil
	}
	fields, ok := raw.(map[string]any)
	if !ok {
		return nil, fmt.Errorf("gateway inválido")
	}
	if values, ok := fields["qusdBalance"].([]any); ok {
		result.balanceValues = values
	}
	if values, ok := fields["listOffers"].([]any); ok {
		result.listOffers = values
	}
	if values, ok := fields["getOffer"].(map[string]any); ok {
		for uuid, value := range values {
			outcome, err := outcomeOf(value)
			if err != nil {
				return nil, err
			}
			result.getOffers[uuid] = outcome
		}
	}
	for _, method := range []string{"apply", "cancel", "createOffer"} {
		if values, ok := fields[method].([]any); ok {
			queue := make([]gatewayOutcome, 0, len(values))
			for _, value := range values {
				outcome, err := outcomeOf(value)
				if err != nil {
					return nil, err
				}
				queue = append(queue, outcome)
			}
			result.queues[method] = queue
		}
	}
	return result, nil
}

func outcomeOf(value any) (gatewayOutcome, error) {
	fields, ok := value.(map[string]any)
	if !ok {
		return gatewayOutcome{}, fmt.Errorf("outcome inválido")
	}
	if errValue, ok := fields["error"].(map[string]any); ok {
		return gatewayOutcome{
			errKind:    stringValue(errValue["kind"], "generic"),
			errStatus:  int(numberValue(errValue["status"])),
			errMessage: stringValue(errValue["message"], ""),
		}, nil
	}
	okValue, hasOK := fields["ok"]
	return gatewayOutcome{okValue: okValue, hasOK: hasOK}, nil
}

func (gateway *gateway) balance() (decimal.Value, bool) {
	if gateway.balanceIndex >= len(gateway.balanceValues) {
		return decimal.Zero(), false
	}
	value := gateway.balanceValues[gateway.balanceIndex]
	gateway.balanceIndex++
	parsed, err := decimalValue(value)
	if err != nil {
		return decimal.Zero(), false
	}
	return parsed, true
}

func (gateway *gateway) next(method string) gatewayOutcome {
	queue := gateway.queues[method]
	index := gateway.indexes[method]
	if index >= len(queue) {
		return gatewayOutcome{}
	}
	gateway.indexes[method] = index + 1
	return queue[index]
}

func (gateway *gateway) nextListOffer() (any, bool) {
	if gateway.listIndex >= len(gateway.listOffers) {
		return nil, false
	}
	value := gateway.listOffers[gateway.listIndex]
	gateway.listIndex++
	if items, ok := value.([]any); ok && len(items) > 0 {
		return items[0], true
	}
	return value, true
}

func (gateway *gateway) nextGetOffer(uuid string) (gatewayOutcome, bool) {
	outcome, ok := gateway.getOffers[uuid]
	return outcome, ok
}

func (gateway *gateway) getOffer(uuid string) (gatewayOutcome, bool) {
	return gateway.nextGetOffer(uuid)
}

func targetOf(input map[string]any) (Target, error) {
	raw, ok := input["target"].(map[string]any)
	if !ok {
		return Target{}, fmt.Errorf("target obligatorio")
	}
	amount, err := decimalValue(raw["amount"])
	if err != nil {
		return Target{}, err
	}
	receive, err := decimalValue(raw["receive"])
	if err != nil {
		return Target{}, err
	}
	return Target{
		UUID:    stringValue(raw["uuid"], ""),
		Coin:    stringValue(raw["coin"], ""),
		Type:    stringValue(raw["type"], ""),
		Amount:  amount,
		Receive: receive,
	}, nil
}

func decimalField(input map[string]any, key string) (decimal.Value, error) {
	value, ok := input[key]
	if !ok {
		return decimal.Value{}, fmt.Errorf("falta %s", key)
	}
	return decimalValue(value)
}

func decimalValue(value any) (decimal.Value, error) {
	switch typed := value.(type) {
	case string:
		return decimal.Parse(typed)
	case float64:
		return decimal.Parse(strconv.FormatFloat(typed, 'f', -1, 64))
	case json.Number:
		return decimal.Parse(typed.String())
	case int:
		return decimal.FromInt(int64(typed)), nil
	case int64:
		return decimal.FromInt(typed), nil
	default:
		return decimal.Value{}, fmt.Errorf("decimal inválido: %v", value)
	}
}

func numberValue(value any) float64 {
	switch typed := value.(type) {
	case float64:
		return typed
	case int:
		return float64(typed)
	case json.Number:
		parsed, _ := typed.Float64()
		return parsed
	default:
		return 0
	}
}

func stringValue(value any, fallback string) string {
	if text, ok := value.(string); ok {
		return text
	}
	return fallback
}

func mustDiv(left, right decimal.Value) decimal.Value {
	value, err := left.Div(right)
	if err != nil {
		panic(err)
	}
	return value
}

func canonicalBytes(value any) []byte {
	var buffer bytes.Buffer
	encoder := json.NewEncoder(&buffer)
	encoder.SetEscapeHTML(false)
	_ = encoder.Encode(value)
	return bytes.TrimSuffix(buffer.Bytes(), []byte("\n"))
}

func hashValue(value any) string {
	sum := sha256.Sum256(canonicalBytes(value))
	return hex.EncodeToString(sum[:])
}

func (session *Session) restoreOwn(gateway *gateway) (bool, []map[string]any) {
	if session.ownSnapshot == nil {
		return false, nil
	}
	outcome := gateway.next("createOffer")
	response, _ := outcome.ok().(map[string]any)
	restoredUUID := stringValue(response["uuid"], "")
	body := map[string]any{
		"type":           "sell",
		"coin":           stringValue(session.ownSnapshot["coin"], ""),
		"amount":         numericForHash(session.ownSnapshot["amount"]),
		"receive":        numericForHash(session.ownSnapshot["receive"]),
		"details":        detailsForHash(session.ownSnapshot["details"]),
		"message":        session.ownSnapshot["message"],
		"onlyKyc":        session.ownSnapshot["onlyKyc"],
		"onlyVip":        session.ownSnapshot["onlyVip"],
		"private":        session.ownSnapshot["private"],
		"tags":           session.ownSnapshot["tags"],
		"idempotencyKey": "<sha256>",
	}
	upstream := []map[string]any{{
		"method":       "createOffer",
		"amount":       decimalFormat(session.ownSnapshot["amount"]),
		"receive":      decimalFormat(session.ownSnapshot["receive"]),
		"requestHash":  hashValue(body),
		"responseHash": hashValue(response),
	}}
	session.newIntent("cancel_own_for_liquidity", "confirmed", session.ownUUID, nil)
	session.newIntent("restore_own_offer", "confirmed", session.ownUUID, nil)
	session.ownOffers = append(session.ownOffers, ownOfferState{
		Workflow: "wf-1", OriginalUUID: session.ownUUID,
		State: "restored", RestoredUUID: restoredUUID,
	})
	return true, upstream
}

func detailsForHash(value any) any {
	if fields, ok := value.(map[string]any); ok {
		names := make([]string, 0, len(fields))
		for name := range fields {
			names = append(names, name)
		}
		sort.Strings(names)
		result := make([]any, 0, len(names))
		for _, name := range names {
			result = append(result, map[string]any{"name": name, "value": fields[name]})
		}
		return result
	}
	return value
}

func numericForHash(value any) any {
	parsed, err := decimalValue(value)
	if err != nil {
		return value
	}
	if integer, ok := parsed.Int64(); ok {
		return integer
	}
	float, _ := strconv.ParseFloat(parsed.Format(8), 64)
	return float
}

func decimalFormat(value any) string {
	parsed, err := decimalValue(value)
	if err != nil {
		return ""
	}
	return parsed.Format(8)
}
