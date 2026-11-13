// Package budget contiene el plan presupuestario proporcional puro de
// `src/budget.ts`: recorta o cancela compras propias para no superar el fiat
// disponible. No hace I/O.
package budget

import (
	"strings"

	"github.com/AGR55/QvaApp/services/shared/decimal"
	"github.com/AGR55/QvaApp/services/trading-core/internal/domain/marketmath"
)

// MinOfferQusd es el mínimo que acepta QvaPay al crear o editar una oferta.
var MinOfferQusd = decimal.MustParse("0.1")

var (
	oneHundredth = decimal.MustParse("0.01")
	onePointFive = decimal.MustParse("1.5")
	oneMicro     = decimal.MustParse("0.000001")
	tenMinusTiny = decimal.MustParse("9.99999999")
)

// Offer es una oferta propia vista por el planificador.
type Offer struct {
	UUID    string
	Coin    string
	Type    string
	Status  string
	Amount  decimal.Value
	Rate    decimal.Value
	Receive *decimal.Value
}

// Adjustment es el cambio propuesto para una oferta.
type Adjustment struct {
	UUID         string
	Coin         string
	Rate         decimal.Value
	CurrentQusd  decimal.Value
	ProposedQusd decimal.Value
	CurrentFiat  decimal.Value
	ProposedFiat decimal.Value
	ReleasedFiat decimal.Value
	Action       string
}

// Plan es el resultado del presupuesto proporcional.
type Plan struct {
	Coin        string
	Available   decimal.Value
	Committed   decimal.Value
	Deficit     decimal.Value
	Adjustments []Adjustment
	Invalid     []string
}

// ProportionalPlan replica `proportionalBudgetPlan` con aritmética exacta.
func ProportionalPlan(
	offers []Offer,
	coin string,
	available decimal.Value,
	maximumRate decimal.Value,
	outgoingTransferFee decimal.Value,
	currency string,
) (Plan, error) {
	invalid := make([]string, 0)
	candidates := make([]Offer, 0, len(offers))
	rateLimit := maximumRate.Mul(onePointFive)

	for _, offer := range offers {
		valid := offer.Coin == coin &&
			offer.Type == "buy" &&
			offer.Status == "open" &&
			offer.Amount.Sign() > 0 &&
			offer.Rate.Sign() > 0 &&
			offer.Rate.Cmp(rateLimit) <= 0
		if offer.Coin == coin && offer.Type == "buy" && offer.Status == "open" && !valid {
			invalid = append(invalid, offer.UUID)
		}
		if valid {
			candidates = append(candidates, offer)
		}
	}

	safeAvailable := decimal.Zero()
	if available.Sign() > 0 {
		safeAvailable = available
	}
	safeFee := decimal.Zero()
	if outgoingTransferFee.Sign() > 0 {
		safeFee = outgoingTransferFee
	}

	committed := decimal.Zero()
	variableCommitted := decimal.Zero()
	for _, offer := range candidates {
		current, err := currentFiatTotal(offer, currency)
		if err != nil {
			return Plan{}, err
		}
		committed = committed.Add(current).Add(safeFee)
		variableCommitted = variableCommitted.Add(current)
	}

	if committed.Cmp(safeAvailable) <= 0 {
		return Plan{
			Coin:        coin,
			Available:   safeAvailable,
			Committed:   committed,
			Deficit:     decimal.Zero(),
			Adjustments: []Adjustment{},
			Invalid:     invalid,
		}, nil
	}

	factor := decimal.Zero()
	availableForVariable := safeAvailable.Sub(safeFee.Mul(decimal.FromInt(int64(len(candidates)))))
	if availableForVariable.Sign() < 0 {
		availableForVariable = decimal.Zero()
	}
	if variableCommitted.Sign() > 0 {
		quotient, err := availableForVariable.Div(variableCommitted)
		if err != nil {
			return Plan{}, err
		}
		factor = quotient
	}

	adjustments := make([]Adjustment, 0, len(candidates))
	for _, offer := range candidates {
		current, err := currentFiatTotal(offer, currency)
		if err != nil {
			return Plan{}, err
		}
		fiatLimit := current.Mul(factor)
		if fiatLimit.Sign() < 0 {
			fiatLimit = decimal.Zero()
		}
		proposedQusd, err := fitAmount(offer.Amount.Mul(factor), offer.Rate, currency, fiatLimit)
		if err != nil {
			return Plan{}, err
		}
		currentFiat := current.Add(safeFee)
		proposedFiat := decimal.Zero()
		action := "cancel"
		if proposedQusd.Sign() > 0 {
			ownTotal, err := marketmath.OwnOfferFiatTotal(proposedQusd, offer.Rate, marketmath.Buy, currency)
			if err != nil {
				return Plan{}, err
			}
			proposedFiat = ownTotal.Add(safeFee)
			action = "edit"
		}
		if proposedQusd.Cmp(offer.Amount) >= 0 {
			continue
		}
		adjustments = append(adjustments, Adjustment{
			UUID:         offer.UUID,
			Coin:         coin,
			Rate:         offer.Rate,
			CurrentQusd:  offer.Amount,
			ProposedQusd: proposedQusd,
			CurrentFiat:  currentFiat,
			ProposedFiat: proposedFiat,
			ReleasedFiat: currentFiat.Sub(proposedFiat),
			Action:       action,
		})
	}

	return Plan{
		Coin:        coin,
		Available:   safeAvailable,
		Committed:   committed,
		Deficit:     committed.Sub(safeAvailable),
		Adjustments: adjustments,
		Invalid:     invalid,
	}, nil
}

func currentFiatTotal(offer Offer, currency string) (decimal.Value, error) {
	if offer.Receive != nil && offer.Receive.Sign() >= 0 {
		return *offer.Receive, nil
	}
	return marketmath.OwnOfferFiatTotal(offer.Amount, offer.Rate, marketmath.Buy, currency)
}

func fitAmount(desired, rate decimal.Value, currency string, fiatLimit decimal.Value) (decimal.Value, error) {
	amount := precision(desired)
	for amount.Sign() > 0 {
		if amount.Cmp(MinOfferQusd) < 0 {
			return decimal.Zero(), nil
		}
		if strings.EqualFold(strings.TrimSpace(currency), "CUP") && amount.Mul(rate).Cmp(tenMinusTiny) < 0 {
			return decimal.Zero(), nil
		}
		total, err := marketmath.OwnOfferFiatTotal(amount, rate, marketmath.Buy, currency)
		if err != nil {
			return decimal.Value{}, err
		}
		if total.Cmp(fiatLimit.Add(oneMicro)) <= 0 {
			return amount, nil
		}
		amount = precision(amount.Sub(oneHundredth))
	}
	return decimal.Zero(), nil
}

func precision(value decimal.Value) decimal.Value {
	scaled := value.Mul(decimal.FromInt(100)).Floor()
	precision, err := scaled.Div(decimal.FromInt(100))
	if err != nil {
		panic(err)
	}
	return precision
}

// FiatScale devuelve la escala de la moneda de trabajo.
func FiatScale(currency string) int {
	if strings.EqualFold(strings.TrimSpace(currency), "CUP") {
		return 0
	}
	return 8
}
