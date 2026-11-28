// Package marketmath contiene las reglas puras de redondeo y coste fiat de
// `src/market-math.ts`. Es determinista y no hace I/O.
package marketmath

import (
	"fmt"
	"sort"
	"strings"

	"github.com/AGR55/QvaApp/services/shared/decimal"
)

// OfferType es el lado de una oferta P2P.
type OfferType string

const (
	Buy  OfferType = "buy"
	Sell OfferType = "sell"
)

// ParseOfferType valida el lado de la oferta.
func ParseOfferType(value string) (OfferType, error) {
	switch OfferType(value) {
	case Buy, Sell:
		return OfferType(value), nil
	default:
		return "", fmt.Errorf("el tipo debe ser buy o sell")
	}
}

// Median devuelve la mediana de los valores positivos. Ignora ceros y
// negativos; el segundo resultado indica si existe referencia.
func Median(values []decimal.Value) (decimal.Value, bool) {
	positive := make([]decimal.Value, 0, len(values))
	for _, value := range values {
		if value.Sign() > 0 {
			positive = append(positive, value)
		}
	}
	if len(positive) == 0 {
		return decimal.Zero(), false
	}
	sort.Slice(positive, func(left, right int) bool {
		return positive[left].Cmp(positive[right]) < 0
	})
	middle := len(positive) / 2
	if len(positive)%2 == 1 {
		return positive[middle], true
	}
	sum := positive[middle-1].Add(positive[middle])
	median, err := sum.Div(decimal.FromInt(2))
	if err != nil {
		panic(err)
	}
	return median, true
}

// FiatCost es el coste nominal, comisión y tasa efectiva de una salida.
type FiatCost struct {
	Nominal       decimal.Value
	Fee           decimal.Value
	Total         decimal.Value
	EffectiveRate decimal.Value
}

// OutgoingFiatCost replica el cálculo de `outgoingFiatCost`.
func OutgoingFiatCost(qusdAmount, fiatPerQusd, fixedFee decimal.Value) FiatCost {
	nominal := qusdAmount.Mul(fiatPerQusd)
	fee := decimal.Zero()
	if fixedFee.Sign() > 0 {
		fee = fixedFee
	}
	total := nominal.Add(fee)
	effectiveRate := decimal.Zero()
	if qusdAmount.Sign() > 0 {
		rate, err := total.Div(qusdAmount)
		if err != nil {
			panic(err)
		}
		effectiveRate = rate
	}
	return FiatCost{
		Nominal:       nominal,
		Fee:           fee,
		Total:         total,
		EffectiveRate: effectiveRate,
	}
}

// OwnOfferFiatTotal replica `ownOfferFiatTotal`: para CUP redondea a múltiplos
// de 10 (compra hacia abajo, venta hacia arriba); para el resto usa 8 dp.
func OwnOfferFiatTotal(qusdAmount, fiatPerQusd decimal.Value, offerType OfferType, currency string) (decimal.Value, error) {
	if qusdAmount.Sign() <= 0 || fiatPerQusd.Sign() <= 0 {
		return decimal.Value{}, fmt.Errorf("el importe y la tasa deben ser positivos")
	}
	nominal := qusdAmount.Mul(fiatPerQusd)
	if !strings.EqualFold(strings.TrimSpace(currency), "CUP") {
		return nominal.Round(8), nil
	}

	tens, err := nominal.Div(decimal.FromInt(10))
	if err != nil {
		panic(err)
	}
	nearest := tens.Round(0)
	tolerance := decimal.MustParse("0.000000001")
	stable := tens
	if tens.Sub(nearest).Abs().Cmp(tolerance) <= 0 {
		stable = nearest
	}

	var whole decimal.Value
	if offerType == Buy {
		whole = stable.Floor()
	} else {
		whole = stable.Ceil()
	}
	rounded := whole.Mul(decimal.FromInt(10))
	if rounded.Cmp(decimal.MustParse("0.1")) < 0 {
		return decimal.Value{}, fmt.Errorf("la tasa no permite obtener un total fiat válido terminado en cero")
	}
	return rounded, nil
}

// RoundRateForIndex replica `roundRateForIndex`: compras hacia arriba y ventas
// hacia abajo, con la precisión del índice configurado.
func RoundRateForIndex(effectiveRate decimal.Value, offerType OfferType, configuredIndex decimal.Value, indexPlaces int) (decimal.Value, error) {
	if effectiveRate.Sign() < 0 {
		return decimal.Value{}, fmt.Errorf("la tasa efectiva debe ser un número positivo")
	}
	if configuredIndex.Sign() <= 0 {
		return decimal.Value{}, fmt.Errorf("el índice configurado debe ser positivo")
	}
	if indexPlaces < 0 {
		return decimal.Value{}, fmt.Errorf("la precisión del índice no puede ser negativa")
	}

	factor := decimal.FromInt(1)
	for step := 0; step < indexPlaces; step++ {
		factor = factor.Mul(decimal.FromInt(10))
	}
	scaled := effectiveRate.Mul(factor)
	var rounded decimal.Value
	if offerType == Buy {
		rounded = scaled.Ceil()
	} else {
		rounded = scaled.Floor()
	}
	return rounded.Div(factor)
}

// RoundQusd redondea a la escala canónica de QUSD (8 decimales).
func RoundQusd(value decimal.Value) decimal.Value {
	return value.Round(8)
}
