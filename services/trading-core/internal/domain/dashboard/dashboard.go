// Package dashboard contiene las funciones puras de cálculo del panel de
// `src/dashboard.ts`: margen, reparto de presupuesto y compactación del
// histórico. No hace I/O.
package dashboard

import (
	"fmt"
	"sort"

	"github.com/AGR55/QvaApp/services/shared/decimal"
)

var (
	hundred = decimal.FromInt(100)
	one     = decimal.FromInt(1)
)

// Margin es el desglose de una operación de compra/venta.
type Margin struct {
	Cost          decimal.Value
	GrossRevenue  decimal.Value
	NetRevenue    decimal.Value
	NetProfit     decimal.Value
	MarginPercent decimal.Value
	BreakEvenRate decimal.Value
}

// CalculateMargin replica `marginCalculation`.
func CalculateMargin(buyRate, sellRate, amount, sellFeePercent, outgoingTransferFee decimal.Value) Margin {
	cost := buyRate.Mul(amount).Add(outgoingTransferFee)
	grossRevenue := sellRate.Mul(amount)
	feeFactor := one.Sub(mustDiv(sellFeePercent, hundred))
	netRevenue := grossRevenue.Mul(feeFactor)
	netProfit := netRevenue.Sub(cost)
	marginPercent := decimal.Zero()
	if cost.Sign() != 0 {
		marginPercent = mustDiv(netProfit, cost).Mul(hundred)
	}
	breakEvenRate := decimal.Zero()
	if amount.Sign() > 0 && feeFactor.Sign() > 0 {
		breakEvenRate = mustDiv(mustDiv(cost, amount), feeFactor)
	}
	return Margin{
		Cost:          cost,
		GrossRevenue:  grossRevenue,
		NetRevenue:    netRevenue,
		NetProfit:     netProfit,
		MarginPercent: marginPercent,
		BreakEvenRate: breakEvenRate,
	}
}

// Opportunity es una oportunidad de reparto.
type Opportunity struct {
	Rate   decimal.Value
	Amount decimal.Value
}

// Allocation es la parte asignada a una oportunidad.
type Allocation struct {
	Rate decimal.Value
	Fiat decimal.Value
	Qusd decimal.Value
}

// AllocateBudget replica `allocateBudget`.
func AllocateBudget(budget, reserve, maximumPerOffer decimal.Value, opportunities []Opportunity) []Allocation {
	remaining := nonNegative(budget.Sub(reserve))
	sorted := make([]Opportunity, len(opportunities))
	copy(sorted, opportunities)
	sort.SliceStable(sorted, func(left, right int) bool {
		return sorted[left].Rate.Cmp(sorted[right].Rate) < 0
	})
	allocations := make([]Allocation, 0, len(sorted))
	for _, opportunity := range sorted {
		amount := opportunity.Amount
		if amount.Cmp(maximumPerOffer) > 0 {
			amount = maximumPerOffer
		}
		fiat := remaining
		offered := opportunity.Rate.Mul(amount)
		if offered.Cmp(fiat) < 0 {
			fiat = offered
		}
		if fiat.Sign() <= 0 {
			continue
		}
		remaining = remaining.Sub(fiat)
		allocations = append(allocations, Allocation{
			Rate: opportunity.Rate,
			Fiat: fiat,
			Qusd: mustDiv(fiat, opportunity.Rate),
		})
	}
	return allocations
}

// HistoryPoint es un punto de histórico con su índice original.
type HistoryPoint struct {
	Coin      string
	CreatedAt int64
	Index     int
}

// CompactHistory replica `compactMarketHistory` conservando los índices para
// que el CLI pueda devolver el objeto original sin perder campos.
func CompactHistory(history []HistoryPoint, maxPerMarket int) ([]HistoryPoint, error) {
	if maxPerMarket < 2 {
		return nil, fmt.Errorf("el histórico compacto requiere al menos dos puntos por mercado")
	}
	groups := map[string][]HistoryPoint{}
	order := make([]string, 0)
	for _, point := range history {
		if _, ok := groups[point.Coin]; !ok {
			order = append(order, point.Coin)
		}
		groups[point.Coin] = append(groups[point.Coin], point)
	}
	compact := make([]HistoryPoint, 0, len(history))
	for _, coin := range order {
		group := groups[coin]
		if len(group) <= maxPerMarket {
			compact = append(compact, group...)
			continue
		}
		for index := 0; index < maxPerMarket; index++ {
			numerator := index * (len(group) - 1)
			denominator := maxPerMarket - 1
			position := (numerator + denominator/2) / denominator
			if position < 0 {
				position = 0
			}
			if position >= len(group) {
				position = len(group) - 1
			}
			compact = append(compact, group[position])
		}
	}
	sort.SliceStable(compact, func(left, right int) bool {
		return compact[left].CreatedAt < compact[right].CreatedAt
	})
	return compact, nil
}

func mustDiv(left, right decimal.Value) decimal.Value {
	value, err := left.Div(right)
	if err != nil {
		panic(err)
	}
	return value
}

func nonNegative(value decimal.Value) decimal.Value {
	if value.Sign() < 0 {
		return decimal.Zero()
	}
	return value
}
