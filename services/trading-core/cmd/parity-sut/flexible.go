package main

import (
	"encoding/json"
	"fmt"
	"strings"

	"github.com/AGR55/QvaApp/services/shared/decimal"
	"github.com/AGR55/QvaApp/services/trading-core/internal/domain/flexible"
)

func nullableNumberField(fields map[string]any, key string) (*decimal.Value, *opError) {
	value, ok := fields[key]
	if !ok {
		return nil, nil
	}
	if value == nil {
		zero := decimal.Zero()
		return &zero, nil
	}
	switch typed := value.(type) {
	case json.Number:
		parsed, err := decimal.Parse(typed.String())
		if err != nil {
			return nil, nil
		}
		return &parsed, nil
	case string:
		parsed, err := decimal.Parse(typed)
		if err != nil {
			return nil, nil
		}
		return &parsed, nil
	case bool:
		parsed := decimal.FromInt(0)
		if typed {
			parsed = decimal.FromInt(1)
		}
		return &parsed, nil
	default:
		return nil, nil
	}
}

func nullableStringField(fields map[string]any, key string) (*string, *opError) {
	value, ok := fields[key]
	if !ok || value == nil {
		return nil, nil
	}
	text, ok := value.(string)
	if !ok {
		return nil, validation(fmt.Sprintf("El campo %s debe ser texto.", key))
	}
	return &text, nil
}

func parseFlexibleOffer(fields map[string]any) (flexible.Offer, *opError) {
	uuid, failure := stringField(fields, "uuid")
	if failure != nil {
		return flexible.Offer{}, failure
	}
	side, failure := stringField(fields, "type")
	if failure != nil {
		return flexible.Offer{}, failure
	}
	coin, failure := stringField(fields, "coin")
	if failure != nil {
		return flexible.Offer{}, failure
	}
	amount, _, failure := numberField(fields, "amount")
	if failure != nil {
		return flexible.Offer{}, failure
	}
	receive, _, failure := numberField(fields, "receive")
	if failure != nil {
		return flexible.Offer{}, failure
	}
	status, failure := stringField(fields, "status")
	if failure != nil {
		return flexible.Offer{}, failure
	}
	offerKind, failure := optionalStringField(fields, "offer_kind", "")
	if failure != nil {
		return flexible.Offer{}, failure
	}
	available, failure := nullableNumberField(fields, "available_amount")
	if failure != nil {
		return flexible.Offer{}, failure
	}
	orderMin, failure := nullableNumberField(fields, "order_min")
	if failure != nil {
		return flexible.Offer{}, failure
	}
	orderMax, failure := nullableNumberField(fields, "order_max")
	if failure != nil {
		return flexible.Offer{}, failure
	}
	updatedAt, failure := nullableStringField(fields, "updated_at")
	if failure != nil {
		return flexible.Offer{}, failure
	}

	orders := make([]flexible.Order, 0)
	if raw, ok := fields["Orders"].([]any); ok {
		orders = make([]flexible.Order, 0, len(raw))
		for _, item := range raw {
			object, ok := item.(map[string]any)
			if !ok {
				return flexible.Offer{}, validation("Cada orden debe ser un objeto.")
			}
			order, failure := parseFlexibleOrder(object)
			if failure != nil {
				return flexible.Offer{}, failure
			}
			orders = append(orders, order)
		}
	}
	return flexible.Offer{
		UUID:            uuid,
		Type:            side,
		Coin:            coin,
		Status:          status,
		OfferKind:       offerKind,
		Amount:          amount,
		Receive:         receive,
		AvailableAmount: available,
		OrderMin:        orderMin,
		OrderMax:        orderMax,
		UpdatedAt:       updatedAt,
		Orders:          orders,
	}, nil
}

func parseFlexibleOrder(fields map[string]any) (flexible.Order, *opError) {
	uuid, failure := stringField(fields, "uuid")
	if failure != nil {
		return flexible.Order{}, failure
	}
	amount, _, failure := numberField(fields, "amount")
	if failure != nil {
		return flexible.Order{}, failure
	}
	receive, _, failure := numberField(fields, "receive")
	if failure != nil {
		return flexible.Order{}, failure
	}
	status, failure := stringField(fields, "status")
	if failure != nil {
		return flexible.Order{}, failure
	}
	createdAt, failure := nullableStringField(fields, "created_at")
	if failure != nil {
		return flexible.Order{}, failure
	}
	updatedAt, failure := nullableStringField(fields, "updated_at")
	if failure != nil {
		return flexible.Order{}, failure
	}
	paidAt, failure := nullableStringField(fields, "paid_at")
	if failure != nil {
		return flexible.Order{}, failure
	}
	releasedAt, failure := nullableStringField(fields, "released_at")
	if failure != nil {
		return flexible.Order{}, failure
	}
	var takerUUID *string
	if taker, ok := fields["Taker"].(map[string]any); ok {
		if value, ok := taker["uuid"].(string); ok {
			takerUUID = &value
		}
	}
	return flexible.Order{
		UUID:       uuid,
		Amount:     amount,
		Receive:    receive,
		Status:     status,
		CreatedAt:  createdAt,
		UpdatedAt:  updatedAt,
		PaidAt:     paidAt,
		ReleasedAt: releasedAt,
		TakerUUID:  takerUUID,
	}, nil
}

func flexibleProjection(offer flexible.Offer) map[string]any {
	rate := decimal.Zero()
	if offer.Amount.Sign() != 0 {
		if computed, err := offer.Receive.Div(offer.Amount); err == nil {
			rate = computed
		}
	}
	var updatedAt any
	if offer.UpdatedAt != nil {
		updatedAt = *offer.UpdatedAt
	}
	return map[string]any{
		"uuid":       offer.UUID,
		"type":       offer.Type,
		"coin":       offer.Coin,
		"amount":     offer.Amount.Format(8),
		"receive":    offer.Receive.Format(8),
		"rate":       rate.Format(8),
		"status":     offer.Status,
		"updated_at": updatedAt,
	}
}

func flexibleSizeResult(offer flexible.Offer) map[string]any {
	rate := decimal.Zero()
	if offer.Amount.Sign() != 0 {
		if computed, err := offer.Receive.Div(offer.Amount); err == nil {
			rate = computed
		}
	}
	result := map[string]any{
		"uuid":    offer.UUID,
		"type":    offer.Type,
		"coin":    offer.Coin,
		"amount":  offer.Amount.Format(8),
		"receive": offer.Receive.Format(8),
		"rate":    rate.Format(8),
		"status":  offer.Status,
	}
	if offer.OfferKind == "" {
		result["offer_kind"] = nil
	} else {
		result["offer_kind"] = offer.OfferKind
	}
	return result
}

func flexibleOrderResult(order flexible.Order) map[string]any {
	var createdAt any
	if order.CreatedAt != nil {
		createdAt = *order.CreatedAt
	}
	return map[string]any{
		"uuid":       order.UUID,
		"status":     order.Status,
		"amount":     order.Amount.Format(8),
		"receive":    order.Receive.Format(8),
		"created_at": createdAt,
	}
}

func flexibleFailure(err error) *opError {
	message := err.Error()
	class := "error"
	if strings.Contains(message, "requiere") {
		class = "validation"
	}
	return &opError{Class: class, Message: message}
}
