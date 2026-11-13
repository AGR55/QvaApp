// Package flexible contiene las reglas puras de ofertas flexibles de
// `src/flexible-order.ts`: dimensionado, proyección de la orden hija y
// recuperación inequívoca. No hace I/O.
package flexible

import (
	"errors"
	"time"

	"github.com/AGR55/QvaApp/services/shared/decimal"
)

var (
	hundred = decimal.FromInt(100)
	five    = decimal.FromInt(5_000)
	twoMin  = decimal.FromInt(120_000)
)

// Offer es una oferta P2P con sus órdenes hijas.
type Offer struct {
	UUID            string
	Type            string
	Coin            string
	Status          string
	OfferKind       string
	Amount          decimal.Value
	Receive         decimal.Value
	AvailableAmount *decimal.Value
	OrderMin        *decimal.Value
	OrderMax        *decimal.Value
	UpdatedAt       *string
	Orders          []Order
}

// Order es una orden hija de una oferta flexible.
type Order struct {
	UUID       string
	Amount     decimal.Value
	Receive    decimal.Value
	Status     string
	CreatedAt  *string
	UpdatedAt  *string
	PaidAt     *string
	ReleasedAt *string
	TakerUUID  *string
}

// Size replica `sizeFlexibleOffer`. Devuelve nil si no se puede dimensionar.
func Size(offer Offer, capacity decimal.Value, limit *decimal.Value) *Offer {
	if offer.OfferKind != "flexible" {
		copy := offer
		return &copy
	}
	if offer.AvailableAmount == nil || offer.OrderMin == nil || offer.OrderMax == nil {
		return nil
	}
	available := *offer.AvailableAmount
	min := *offer.OrderMin
	max := *offer.OrderMax
	if offer.Amount.Sign() <= 0 {
		return nil
	}
	quote, err := offer.Receive.Div(offer.Amount)
	if err != nil || quote.Sign() <= 0 {
		return nil
	}
	if min.Sign() <= 0 || max.Cmp(min) < 0 || available.Sign() <= 0 || capacity.Sign() <= 0 {
		return nil
	}
	selected := minDecimal(available, max, capacity)
	if limit != nil {
		selected = minDecimal(selected, *limit)
	}
	amount, err := selected.Mul(hundred).Floor().Div(hundred)
	if err != nil {
		return nil
	}
	if amount.Cmp(min) < 0 || amount.Sign() <= 0 {
		return nil
	}
	result := offer
	result.Amount = amount
	result.Receive = amount.Mul(quote)
	return &result
}

// OrderForOperation replica `orderForOperation`.
func OrderForOperation(offer Offer, orderUUID *string) (Offer, error) {
	if orderUUID == nil || *orderUUID == "" {
		if offer.OfferKind == "flexible" {
			return Offer{}, errors.New("La operación flexible requiere identificar su orden.")
		}
		return offer, nil
	}
	var order *Order
	for index := range offer.Orders {
		if offer.Orders[index].UUID == *orderUUID {
			order = &offer.Orders[index]
			break
		}
	}
	if order == nil {
		return Offer{}, errors.New("QvaPay no devolvió la orden de esta operación; se conserva el estado local.")
	}
	var updatedAt *string
	if offer.Type == "sell" {
		updatedAt = firstNonNil(order.PaidAt, order.ReleasedAt)
	} else {
		updatedAt = order.ReleasedAt
	}
	if updatedAt == nil {
		updatedAt = firstNonNil(order.UpdatedAt, order.CreatedAt)
	}
	result := offer
	result.UpdatedAt = nil
	result.Amount = order.Amount
	result.Receive = order.Receive
	result.Status = order.Status
	if updatedAt != nil && *updatedAt != "" {
		result.UpdatedAt = updatedAt
	}
	return result, nil
}

// MatchingRecoveryOrder replica `matchingRecoveryOrder`.
func MatchingRecoveryOrder(offer Offer, amount, since decimal.Value, account *string) *Order {
	if account == nil || *account == "" || amount.Sign() < 0 {
		return nil
	}
	lower := since.Sub(five)
	upper := since.Add(twoMin)
	matches := make([]*Order, 0)
	for index := range offer.Orders {
		order := &offer.Orders[index]
		if order.TakerUUID == nil || *order.TakerUUID != *account {
			continue
		}
		if order.Amount.Cmp(amount) != 0 {
			continue
		}
		if order.CreatedAt == nil || *order.CreatedAt == "" {
			continue
		}
		at, ok := dateMilliseconds(*order.CreatedAt)
		if !ok {
			continue
		}
		if at.Cmp(lower) >= 0 && at.Cmp(upper) <= 0 {
			matches = append(matches, order)
		}
	}
	if len(matches) != 1 {
		return nil
	}
	return matches[0]
}

func firstNonNil(values ...*string) *string {
	for _, value := range values {
		if value != nil {
			return value
		}
	}
	return nil
}

func minDecimal(values ...decimal.Value) decimal.Value {
	result := values[0]
	for _, value := range values[1:] {
		if value.Cmp(result) < 0 {
			result = value
		}
	}
	return result
}

func dateMilliseconds(value string) (decimal.Value, bool) {
	parsed, err := time.Parse(time.RFC3339, value)
	if err != nil {
		return decimal.Zero(), false
	}
	return decimal.FromInt(parsed.UnixMilli()), true
}
