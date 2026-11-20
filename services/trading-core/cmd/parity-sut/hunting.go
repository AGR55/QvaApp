package main

import (
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/AGR55/QvaApp/services/shared/decimal"
	"github.com/AGR55/QvaApp/services/trading-core/internal/domain/hunting"
)

var huntingKeys = []string{"min_completed", "min_rating", "min_account_days", "min_trustscore"}

func optionalNumericAny(value any) (*decimal.Value, bool) {
	if value == nil {
		return nil, false
	}
	switch typed := value.(type) {
	case json.Number:
		parsed, err := decimal.Parse(typed.String())
		if err != nil || parsed.Sign() < 0 {
			return nil, false
		}
		return &parsed, true
	case string:
		if strings.TrimSpace(typed) == "" {
			return nil, false
		}
		parsed, err := decimal.Parse(typed)
		if err != nil || parsed.Sign() < 0 {
			return nil, false
		}
		return &parsed, true
	default:
		return nil, false
	}
}

func firstNonNullish(fields map[string]any, keys ...string) any {
	for _, key := range keys {
		if value, ok := fields[key]; ok && value != nil {
			return value
		}
	}
	return nil
}

func dateMilliseconds(value string) (decimal.Value, bool) {
	parsed, err := time.Parse(time.RFC3339, value)
	if err != nil {
		return decimal.Zero(), false
	}
	return decimal.FromInt(parsed.UnixMilli()), true
}

func parseHuntingEligibility(fields map[string]any, now decimal.Value) hunting.Eligibility {
	result := hunting.Eligibility{}
	if count, ok := fields["_count"].(map[string]any); ok {
		p2p, p2pOK := optionalNumericAny(count["P2P"])
		peer, peerOK := optionalNumericAny(count["P2P_Peer"])
		if p2pOK && peerOK {
			total := p2p.Add(*peer)
			result.Completed = &total
		}
	}
	if raw := firstNonNullish(fields, "rating_avg", "average_rating"); raw != nil {
		if value, ok := optionalNumericAny(raw); ok {
			result.Rating = value
		}
	}
	if raw := firstNonNullish(fields, "trustscore", "trust_score"); raw != nil {
		if value, ok := optionalNumericAny(raw); ok {
			result.TrustScore = value
		}
	}
	if createdAt, ok := fields["created_at"].(string); ok {
		if at, valid := dateMilliseconds(createdAt); valid && at.Cmp(now) <= 0 {
			if days, err := now.Sub(at).Div(decimal.FromInt(86_400_000)); err == nil {
				days = days.Floor()
				result.AccountDays = &days
			}
		}
	}
	if kyc, ok := fields["kyc"].(bool); ok {
		value := decimal.FromInt(0)
		if kyc {
			value = decimal.FromInt(1)
		}
		result.Kyc = &value
	} else if kyc, ok := fields["kyc"].(string); ok && kyc == "verified" {
		value := decimal.FromInt(1)
		result.Kyc = &value
	}
	return result
}

func parseHuntingOffer(fields map[string]any) (hunting.Offer, *opError) {
	uuid, failure := stringField(fields, "uuid")
	if failure != nil {
		return hunting.Offer{}, failure
	}
	if uuid == "" {
		return hunting.Offer{}, validation("La oferta debe tener uuid.")
	}
	for _, key := range []string{"type", "coin", "status"} {
		if _, failure := stringField(fields, key); failure != nil {
			return hunting.Offer{}, failure
		}
	}
	for _, key := range []string{"amount", "receive"} {
		if _, _, failure := numberField(fields, key); failure != nil {
			return hunting.Offer{}, failure
		}
	}

	offer := hunting.Offer{Requirements: map[string]decimal.Value{}}
	if raw, ok := fields["requirements"].(map[string]any); ok {
		offer.HasRequirements = true
		for _, key := range huntingKeys {
			if value, valid := optionalNumericAny(raw[key]); valid {
				offer.Requirements[key] = *value
			}
		}
	}
	if met, ok := fields["requirements_met"].(bool); ok {
		offer.RequirementsMet = &met
	}
	if only, ok := fields["only_kyc"].(bool); ok {
		offer.OnlyKyc = only
	} else if only, ok := fields["only_kyc"].(json.Number); ok {
		parsed, err := decimal.Parse(only.String())
		offer.OnlyKyc = err == nil && parsed.Cmp(decimal.FromInt(1)) == 0
	}
	return offer, nil
}

func huntingResult(reason string, ok bool) map[string]any {
	if !ok {
		return map[string]any{"reason": nil}
	}
	return map[string]any{"reason": reason}
}

func parseHuntingMissing(value any) []hunting.Missing {
	items, ok := value.([]any)
	if !ok {
		return []hunting.Missing{}
	}
	result := make([]hunting.Missing, 0, len(items))
	for _, item := range items {
		fields, ok := item.(map[string]any)
		if !ok {
			continue
		}
		key, ok := fields["key"].(string)
		if !ok {
			continue
		}
		actual, valid := optionalNumericAny(fields["actual"])
		if !valid {
			continue
		}
		result = append(result, hunting.Missing{Key: key, Actual: *actual})
	}
	return result
}

func huntingActionKind(fields map[string]any) (string, *opError) {
	kind, failure := stringField(fields, "kind")
	if failure != nil {
		return "", failure
	}
	if kind != "eligibility" && kind != "missing" {
		return "", validation(fmt.Sprintf("Acción de requisitos desconocida: %s.", kind))
	}
	return kind, nil
}
