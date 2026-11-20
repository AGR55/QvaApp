package core

import (
	"fmt"

	"github.com/AGR55/QvaApp/services/shared/decimal"
)

// TakeInput describe una toma potencial de una oferta por rango.
//
// Las ofertas flexibles publican un importe total y un rango [OrderMin,
// OrderMax]. El core no debe tomar el importe publicado a ciegas: lo acota por
// fondos fiat disponibles, límite del mercado y límites globales de riesgo.
type TakeInput struct {
	// AvailableQusd es lo que la oferta todavía permite tomar.
	AvailableQusd decimal.Value
	// OrderMin y OrderMax son el rango aceptado por la contraparte.
	OrderMin decimal.Value
	OrderMax decimal.Value
	// FiatAvailable es el saldo fiat del mercado y OutgoingFee la comisión de
	// transferencia que se suma al pago.
	FiatAvailable decimal.Value
	OutgoingFee   decimal.Value
	// Rate es el precio fiat por QUSD de la oferta.
	Rate decimal.Value
	// PerOperationMax y MarketMaxQusd son los topes configurados. Cero
	// significa sin tope.
	PerOperationMax decimal.Value
	MarketMaxQusd   decimal.Value
	// ExposureRemaining y DailyRemaining acotan la exposición simultánea y el
	// volumen diario restante. Cero significa sin tope.
	ExposureRemaining decimal.Value
	DailyRemaining    decimal.Value
}

// TakeSize es el resultado del dimensionado.
type TakeSize struct {
	Amount decimal.Value
	// Reason explica por qué se recortó el importe. Vacío si se toma todo lo
	// disponible dentro del rango.
	Reason string
}

// SizeTake calcula el importe QUSD exacto a aplicar sobre una oferta por
// rango. Toma el mayor importe posible que respete todos los límites y lo
// trunca a dos decimales para no exceder ningún tope. Si el resultado queda por
// debajo de OrderMin no se debe aplicar.
func SizeTake(input TakeInput) (TakeSize, error) {
	if input.Rate.Sign() <= 0 {
		return TakeSize{}, fmt.Errorf("tasa de la oferta inválida para dimensionar")
	}
	if input.AvailableQusd.Sign() <= 0 {
		return TakeSize{Reason: "la oferta no tiene importe disponible"}, nil
	}

	capacityFiat := input.FiatAvailable.Sub(input.OutgoingFee)
	if capacityFiat.Sign() <= 0 {
		return TakeSize{Reason: "sin fondos fiat suficientes para cubrir la comisión"}, nil
	}
	capacityQusd, err := capacityFiat.Div(input.Rate)
	if err != nil {
		return TakeSize{}, fmt.Errorf("no se pudo calcular la capacidad por fondos: %w", err)
	}

	limit := input.AvailableQusd
	reason := "toma completa de lo disponible"
	apply := func(candidate decimal.Value, label string) {
		if candidate.Sign() > 0 && candidate.Cmp(limit) < 0 {
			limit = candidate
			reason = label
		}
	}
	apply(input.OrderMax, "limitada por el máximo de la oferta")
	apply(input.PerOperationMax, "limitada por el máximo por operación")
	apply(input.MarketMaxQusd, "limitada por el máximo del mercado")
	apply(input.ExposureRemaining, "limitada por la exposición simultánea restante")
	apply(input.DailyRemaining, "limitada por el volumen diario restante")
	apply(capacityQusd, "limitada por los fondos fiat disponibles")

	amount := floorScale(limit, 2)
	if amount.Sign() <= 0 {
		return TakeSize{Reason: "el importe calculado es cero"}, nil
	}
	if input.OrderMin.Sign() > 0 && amount.Cmp(input.OrderMin) < 0 {
		return TakeSize{Reason: fmt.Sprintf(
			"el importe disponible (%s QUSD) queda por debajo del mínimo de la oferta (%s QUSD)",
			amount.Compact(), input.OrderMin.Compact(),
		)}, nil
	}
	if amount.Cmp(limit) < 0 {
		reason = reason + " (truncado a dos decimales)"
	}
	return TakeSize{Amount: amount, Reason: reason}, nil
}

// floorScale trunca hacia abajo a la escala dada. Se usa para importes
// monetarios donde redondear hacia arriba podría superar un límite.
func floorScale(value decimal.Value, scale int) decimal.Value {
	factor := decimal.FromInt(int64Pow10(scale))
	scaled := value.Mul(factor)
	floored := scaled.Floor()
	result, err := floored.Div(factor)
	if err != nil {
		return decimal.Zero()
	}
	return result
}

func int64Pow10(power int) int64 {
	result := int64(1)
	for index := 0; index < power; index++ {
		result *= 10
	}
	return result
}
