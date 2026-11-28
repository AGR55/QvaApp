// Package liquidity contiene el plan de liberación de QUSD de
// `src/core/liquidity-plan.ts`. Elige las ventas propias menos rentables y no
// propone cancelaciones parciales: o financia el objetivo o no cancela nada.
package liquidity

import (
	"fmt"
	"math"
	"sort"
	"time"

	"github.com/AGR55/QvaApp/services/shared/decimal"
	"github.com/AGR55/QvaApp/services/trading-core/internal/domain/marketmath"
)

var (
	tiny    = decimal.MustParse("0.0000001")
	hundred = decimal.FromInt(100)
	one     = decimal.FromInt(1)
)

// Detail es un dato de pago ordenado.
type Detail struct {
	Name  string
	Value string
}

// Offer es una oferta propia con los campos necesarios para el snapshot.
type Offer struct {
	UUID      string
	Coin      string
	Type      string
	Status    string
	OfferKind string
	Amount    decimal.Value
	Receive   decimal.Value
	Details   []Detail
	Message   string
	Tags      []string
	OnlyKyc   bool
	OnlyVip   bool
	Private   bool
	Webhook   string
	CreatedAt string
}

// Target es la oportunidad externa que se quiere financiar.
type Target struct {
	UUID    string
	Coin    string
	Type    string
	Amount  decimal.Value
	Receive decimal.Value
}

// MarketEconomics es la economía de un mercado.
type MarketEconomics struct {
	BuyMaxRate          decimal.Value
	SellFeePercent      decimal.Value
	OutgoingTransferFee decimal.Value
}

// Input es la entrada del plan.
type Input struct {
	Target        Target
	AvailableQusd decimal.Value
	ReserveQusd   decimal.Value
	OwnOffers     []Offer
	Economics     map[string]MarketEconomics
}

// PlannedOffer es una oferta seleccionada y su consumo.
type PlannedOffer struct {
	Offer
	ProfitabilityPercent decimal.Value
	ConsumeQusd          decimal.Value
	RestoreQusd          decimal.Value
}

// Plan es el resultado canónico.
type Plan struct {
	Feasible                 bool
	TargetQusd               decimal.Value
	ImmediatelyAvailableQusd decimal.Value
	RequiredReleaseQusd      decimal.Value
	PlannedReleaseQusd       decimal.Value
	PotentialReleaseQusd     decimal.Value
	Cancel                   []PlannedOffer
	Reason                   string
}

type candidate struct {
	offer         Offer
	profitability decimal.Value
}

// PlanLiquidity replica `planLiquidity`.
func PlanLiquidity(input Input) (Plan, error) {
	if err := validate(input); err != nil {
		return Plan{}, err
	}
	if input.Target.Type != "buy" {
		return infeasible(input, "Solo una oferta externa de compra requiere liberar QUSD."), nil
	}

	immediatelyAvailable := nonNegative(input.AvailableQusd.Sub(input.ReserveQusd))
	requiredRelease := nonNegative(input.Target.Amount.Add(input.ReserveQusd).Sub(input.AvailableQusd))
	if requiredRelease.Sign() == 0 {
		return Plan{
			Feasible:                 true,
			TargetQusd:               input.Target.Amount,
			ImmediatelyAvailableQusd: immediatelyAvailable,
			RequiredReleaseQusd:      decimal.Zero(),
			PlannedReleaseQusd:       decimal.Zero(),
			PotentialReleaseQusd:     decimal.Zero(),
			Cancel:                   []PlannedOffer{},
			Reason:                   "El saldo QUSD disponible cubre la oportunidad sin cancelar ofertas propias.",
		}, nil
	}

	_, targetHasProfitability := profitability(
		input.Target.Amount,
		input.Target.Receive,
		economicsFor(input.Economics, input.Target.Coin),
	)

	candidates := make([]candidate, 0, len(input.OwnOffers))
	for _, offer := range input.OwnOffers {
		if offer.Type != "sell" ||
			offer.OfferKind == "flexible" ||
			offer.Status != "open" ||
			offer.Amount.Sign() <= 0 ||
			offer.Receive.Sign() <= 0 {
			continue
		}
		ownProfitability, ownHasProfitability := profitability(
			offer.Amount,
			offer.Receive,
			economicsFor(input.Economics, offer.Coin),
		)
		if offer.Coin != input.Target.Coin && !(targetHasProfitability && ownHasProfitability) {
			continue
		}
		profit := ownProfitability
		if !ownHasProfitability {
			rate, err := offer.Receive.Div(offer.Amount)
			if err != nil {
				return Plan{}, err
			}
			profit = rate
		}
		candidates = append(candidates, candidate{offer: offer, profitability: profit})
	}

	sort.SliceStable(candidates, func(left, right int) bool {
		if comparison := candidates[left].profitability.Cmp(candidates[right].profitability); comparison != 0 {
			return comparison < 0
		}
		if comparison := candidates[right].offer.Amount.Cmp(candidates[left].offer.Amount); comparison != 0 {
			return comparison < 0
		}
		leftAt := timestamp(candidates[left].offer.CreatedAt)
		rightAt := timestamp(candidates[right].offer.CreatedAt)
		if leftAt != rightAt {
			return leftAt < rightAt
		}
		return candidates[left].offer.UUID < candidates[right].offer.UUID
	})

	selected := make([]candidate, 0, len(candidates))
	plannedRelease := decimal.Zero()
	for _, candidate := range candidates {
		selected = append(selected, candidate)
		plannedRelease = plannedRelease.Add(candidate.offer.Amount)
		if plannedRelease.Add(tiny).Cmp(requiredRelease) >= 0 {
			break
		}
	}

	if plannedRelease.Add(tiny).Cmp(requiredRelease) < 0 {
		return Plan{
			Feasible:                 false,
			TargetQusd:               input.Target.Amount,
			ImmediatelyAvailableQusd: immediatelyAvailable,
			RequiredReleaseQusd:      requiredRelease,
			PlannedReleaseQusd:       decimal.Zero(),
			PotentialReleaseQusd:     plannedRelease,
			Cancel:                   []PlannedOffer{},
			Reason: fmt.Sprintf(
				"Las ventas propias disponibles liberarían %s QUSD, pero se requieren %s; no se cancelará ninguna.",
				plannedRelease.Compact(),
				requiredRelease.Compact(),
			),
		}, nil
	}

	remainingConsumption := requiredRelease
	cancel := make([]PlannedOffer, 0, len(selected))
	for _, candidate := range selected {
		consume := minValue(candidate.offer.Amount, remainingConsumption)
		remainingConsumption = nonNegative(remainingConsumption.Sub(consume))
		restore := candidate.offer.Amount.Sub(consume)
		cancel = append(cancel, PlannedOffer{
			Offer:                candidate.offer,
			ProfitabilityPercent: candidate.profitability,
			ConsumeQusd:          consume.Round(8),
			RestoreQusd:          restore.Round(8),
		})
	}

	return Plan{
		Feasible:                 true,
		TargetQusd:               input.Target.Amount,
		ImmediatelyAvailableQusd: immediatelyAvailable,
		RequiredReleaseQusd:      requiredRelease,
		PlannedReleaseQusd:       plannedRelease,
		PotentialReleaseQusd:     plannedRelease,
		Cancel:                   cancel,
		Reason: fmt.Sprintf(
			"Se liberarán %s QUSD de %d oferta(s) propia(s); %s QUSD se repondrán después de aplicar.",
			plannedRelease.Compact(),
			len(selected),
			plannedRelease.Sub(requiredRelease).Compact(),
		),
	}, nil
}

func validate(input Input) error {
	values := []decimal.Value{
		input.Target.Amount,
		input.Target.Receive,
		input.AvailableQusd,
		input.ReserveQusd,
	}
	for _, value := range values {
		if value.Sign() < 0 {
			return fmt.Errorf("los importes del plan de liquidez deben ser finitos y no negativos")
		}
	}
	if input.Target.Amount.Sign() == 0 || input.Target.Receive.Sign() == 0 {
		return fmt.Errorf("la oportunidad objetivo debe tener importe y recepción positivos")
	}
	return nil
}

func infeasible(input Input, reason string) Plan {
	return Plan{
		Feasible:                 false,
		TargetQusd:               input.Target.Amount,
		ImmediatelyAvailableQusd: nonNegative(input.AvailableQusd.Sub(input.ReserveQusd)),
		RequiredReleaseQusd:      decimal.Zero(),
		PlannedReleaseQusd:       decimal.Zero(),
		PotentialReleaseQusd:     decimal.Zero(),
		Cancel:                   []PlannedOffer{},
		Reason:                   reason,
	}
}

func profitability(amount, receive decimal.Value, economics *MarketEconomics) (decimal.Value, bool) {
	if economics == nil || economics.BuyMaxRate.Sign() <= 0 {
		return decimal.Zero(), false
	}
	acquisition := marketmath.OutgoingFiatCost(amount, economics.BuyMaxRate, economics.OutgoingTransferFee).Total
	if acquisition.Sign() <= 0 {
		return decimal.Zero(), false
	}
	feeFactor, err := economics.SellFeePercent.Div(hundred)
	if err != nil {
		return decimal.Zero(), false
	}
	netRevenue := receive.Mul(one.Sub(feeFactor))
	margin, err := netRevenue.Sub(acquisition).Div(acquisition)
	if err != nil {
		return decimal.Zero(), false
	}
	return margin.Mul(hundred), true
}

func economicsFor(economics map[string]MarketEconomics, coin string) *MarketEconomics {
	if economics == nil {
		return nil
	}
	value, ok := economics[coin]
	if !ok {
		return nil
	}
	return &value
}

func timestamp(value string) int64 {
	if value == "" {
		return math.MaxInt64
	}
	for _, layout := range []string{time.RFC3339, "2006-01-02"} {
		parsed, err := time.Parse(layout, value)
		if err == nil {
			return parsed.UnixNano()
		}
	}
	return math.MaxInt64
}

func nonNegative(value decimal.Value) decimal.Value {
	if value.Sign() < 0 {
		return decimal.Zero()
	}
	return value
}

func minValue(left, right decimal.Value) decimal.Value {
	if left.Cmp(right) <= 0 {
		return left
	}
	return right
}
