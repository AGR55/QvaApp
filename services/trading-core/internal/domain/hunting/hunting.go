// Package hunting contiene el registro y la evaluación de requisitos de
// cacería de `src/hunting-requirements.ts`. Los hechos se inyectan con su
// timestamp; no hay reloj real ni red.
package hunting

import (
	"fmt"

	"github.com/AGR55/QvaApp/services/shared/decimal"
)

const freshnessMs = 60_000

var keys = []string{"min_completed", "min_rating", "min_account_days", "min_trustscore"}

// Fact es un requisito observado y el instante de la observación.
type Fact struct {
	Value decimal.Value
	At    decimal.Value
}

// Eligibility son los hechos derivados de una lectura de elegibilidad.
type Eligibility struct {
	Completed   *decimal.Value
	Rating      *decimal.Value
	TrustScore  *decimal.Value
	AccountDays *decimal.Value
	Kyc         *decimal.Value
}

// Missing es una carencia reportada por QvaPay.
type Missing struct {
	Key    string
	Actual decimal.Value
}

// Offer es la oferta que se quiere aplicar.
type Offer struct {
	RequirementsMet *bool
	HasRequirements bool
	Requirements    map[string]decimal.Value
	OnlyKyc         bool
}

// State guarda los hechos por proceso.
type State struct {
	facts map[string]Fact
}

// NewState crea un estado vacío.
func NewState() *State {
	return &State{facts: map[string]Fact{}}
}

// RecordEligibility replica `recordHuntingEligibility`.
func (state *State) RecordEligibility(value Eligibility, now decimal.Value) {
	if state == nil {
		return
	}
	put := func(key string, candidate *decimal.Value) {
		if candidate == nil || candidate.Sign() < 0 {
			return
		}
		state.facts[key] = Fact{Value: *candidate, At: now}
	}
	put("min_completed", value.Completed)
	put("min_rating", value.Rating)
	put("min_trustscore", value.TrustScore)
	put("min_account_days", value.AccountDays)
	put("kyc", value.Kyc)
}

// RecordMissing replica `recordMissingRequirements`.
func (state *State) RecordMissing(items []Missing, now decimal.Value) {
	if state == nil {
		return
	}
	allowed := map[string]bool{}
	for _, key := range keys {
		allowed[key] = true
	}
	for _, item := range items {
		if !allowed[item.Key] || item.Actual.Sign() < 0 {
			continue
		}
		state.facts[item.Key] = Fact{Value: item.Actual, At: now}
	}
}

// Reason replica `huntingRequirementReason`. Devuelve el motivo y si existe.
func (state *State) Reason(offer Offer, now decimal.Value) (string, bool) {
	if offer.RequirementsMet != nil && !*offer.RequirementsMet {
		return "No cumple los requisitos del anunciante", true
	}
	if !offer.HasRequirements && !offer.OnlyKyc {
		return "", false
	}
	fresh := func(key string) (decimal.Value, bool) {
		fact, ok := state.facts[key]
		if !ok || fact.Value.Sign() < 0 || fact.At.Sign() < 0 {
			return decimal.Zero(), false
		}
		if now.Cmp(fact.At) < 0 {
			return decimal.Zero(), false
		}
		if now.Sub(fact.At).Cmp(decimal.FromInt(freshnessMs)) > 0 {
			return decimal.Zero(), false
		}
		return fact.Value, true
	}
	if offer.OnlyKyc {
		if kyc, ok := fresh("kyc"); ok && kyc.Sign() == 0 {
			return "KYC requerido por el anunciante", true
		}
	}
	for _, key := range keys {
		required, hasRequired := offer.Requirements[key]
		actual, hasActual := fresh(key)
		if !hasRequired || !hasActual {
			continue
		}
		if actual.Cmp(required) < 0 {
			return fmt.Sprintf("Requisito %s: %s disponible; exige %s", key, actual.Compact(), required.Compact()), true
		}
	}
	return "", false
}
