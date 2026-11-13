package main

import (
	"encoding/json"
	"fmt"
	"sort"
	"strings"

	"github.com/AGR55/QvaApp/services/shared/decimal"
	"github.com/AGR55/QvaApp/services/trading-core/internal/domain/liquidity"
)

func liquidityResult(plan liquidity.Plan) map[string]any {
	cancel := make([]any, 0, len(plan.Cancel))
	for _, item := range plan.Cancel {
		rate, err := item.Receive.Div(item.Amount)
		if err != nil {
			rate = decimal.Zero()
		}
		details := make([]any, 0, len(item.Details))
		for _, detail := range item.Details {
			details = append(details, map[string]any{"name": detail.Name, "value": detail.Value})
		}
		tags := item.Tags
		if tags == nil {
			tags = []string{}
		}
		snapshot := map[string]any{
			"uuid":                 item.UUID,
			"coin":                 item.Coin,
			"amount":               item.Amount.Format(8),
			"receive":              item.Receive.Format(8),
			"rate":                 rate.Format(8),
			"details":              details,
			"tags":                 tags,
			"onlyKyc":              item.OnlyKyc,
			"onlyVip":              item.OnlyVip,
			"private":              item.Private,
			"profitabilityPercent": item.ProfitabilityPercent.Format(8),
			"consumeQusd":          item.ConsumeQusd.Format(8),
			"restoreQusd":          item.RestoreQusd.Format(8),
		}
		if item.Message != "" {
			snapshot["message"] = item.Message
		}
		if item.Webhook != "" {
			snapshot["webhook"] = item.Webhook
		}
		if item.CreatedAt != "" {
			snapshot["createdAt"] = item.CreatedAt
		}
		cancel = append(cancel, snapshot)
	}
	return map[string]any{
		"feasible":                 plan.Feasible,
		"targetQusd":               plan.TargetQusd.Format(8),
		"immediatelyAvailableQusd": plan.ImmediatelyAvailableQusd.Format(8),
		"requiredReleaseQusd":      plan.RequiredReleaseQusd.Format(8),
		"plannedReleaseQusd":       plan.PlannedReleaseQusd.Format(8),
		"potentialReleaseQusd":     plan.PotentialReleaseQusd.Format(8),
		"cancel":                   cancel,
		"reason":                   plan.Reason,
	}
}

func parseLiquidityOffer(raw map[string]any) (liquidity.Offer, *opError) {
	uuid, failure := stringField(raw, "uuid")
	if failure != nil {
		return liquidity.Offer{}, failure
	}
	coin, failure := stringField(raw, "coin")
	if failure != nil {
		return liquidity.Offer{}, failure
	}
	side, failure := stringField(raw, "type")
	if failure != nil {
		return liquidity.Offer{}, failure
	}
	status, failure := stringField(raw, "status")
	if failure != nil {
		return liquidity.Offer{}, failure
	}
	amount, _, failure := numberField(raw, "amount")
	if failure != nil {
		return liquidity.Offer{}, failure
	}
	receive, _, failure := numberField(raw, "receive")
	if failure != nil {
		return liquidity.Offer{}, failure
	}
	offerKind, failure := optionalStringField(raw, "offer_kind", "")
	if failure != nil {
		return liquidity.Offer{}, failure
	}
	message, failure := optionalStringField(raw, "message", "")
	if failure != nil {
		return liquidity.Offer{}, failure
	}
	webhook, failure := optionalStringField(raw, "webhook", "")
	if failure != nil {
		return liquidity.Offer{}, failure
	}
	createdAt, failure := optionalStringField(raw, "created_at", "")
	if failure != nil {
		return liquidity.Offer{}, failure
	}
	tags, failure := stringArrayField(raw, "tags")
	if failure != nil {
		return liquidity.Offer{}, failure
	}
	details, failure := detailsField(raw)
	if failure != nil {
		return liquidity.Offer{}, failure
	}
	onlyKyc, failure := truthyField(raw, "only_kyc")
	if failure != nil {
		return liquidity.Offer{}, failure
	}
	onlyVip, failure := truthyField(raw, "only_vip")
	if failure != nil {
		return liquidity.Offer{}, failure
	}
	private, failure := truthyField(raw, "private")
	if failure != nil {
		return liquidity.Offer{}, failure
	}
	return liquidity.Offer{
		UUID:      uuid,
		Coin:      coin,
		Type:      side,
		Status:    status,
		OfferKind: offerKind,
		Amount:    amount,
		Receive:   receive,
		Details:   details,
		Message:   message,
		Tags:      tags,
		OnlyKyc:   onlyKyc,
		OnlyVip:   onlyVip,
		Private:   private,
		Webhook:   webhook,
		CreatedAt: createdAt,
	}, nil
}

func stringArrayField(fields map[string]any, key string) ([]string, *opError) {
	value, ok := fields[key]
	if !ok || value == nil {
		return []string{}, nil
	}
	items, ok := value.([]any)
	if !ok {
		return nil, validation(fmt.Sprintf("El campo %s debe ser un array de textos.", key))
	}
	result := make([]string, 0, len(items))
	for _, item := range items {
		text, ok := item.(string)
		if !ok {
			return nil, validation(fmt.Sprintf("El campo %s debe ser un array de textos.", key))
		}
		result = append(result, text)
	}
	return result, nil
}

func detailsField(fields map[string]any) ([]liquidity.Detail, *opError) {
	value, ok := fields["details"]
	if !ok || value == nil {
		return []liquidity.Detail{}, nil
	}
	object, ok := value.(map[string]any)
	if !ok {
		return nil, validation("El campo details debe ser un objeto.")
	}
	names := make([]string, 0, len(object))
	for name := range object {
		names = append(names, name)
	}
	sort.Strings(names)
	details := make([]liquidity.Detail, 0, len(names))
	for _, name := range names {
		text, ok := object[name].(string)
		if !ok {
			return nil, validation("El campo details debe mapear textos.")
		}
		details = append(details, liquidity.Detail{Name: name, Value: text})
	}
	return details, nil
}

func truthyField(fields map[string]any, key string) (bool, *opError) {
	value, ok := fields[key]
	if !ok || value == nil {
		return false, nil
	}
	switch typed := value.(type) {
	case bool:
		return typed, nil
	case json.Number:
		parsed, err := decimal.Parse(typed.String())
		if err != nil {
			return false, validation(fmt.Sprintf("El campo %s debe ser booleano.", key))
		}
		return parsed.Sign() != 0, nil
	case string:
		return strings.TrimSpace(typed) != "", nil
	default:
		return false, validation(fmt.Sprintf("El campo %s debe ser booleano.", key))
	}
}

func parseMarketEconomics(fields map[string]any) (map[string]liquidity.MarketEconomics, *opError) {
	result := map[string]liquidity.MarketEconomics{}
	value, ok := fields["marketEconomics"]
	if !ok || value == nil {
		return result, nil
	}
	raw, ok := value.(map[string]any)
	if !ok {
		return nil, validation("El campo marketEconomics debe ser un objeto.")
	}
	for coin, entry := range raw {
		object, ok := entry.(map[string]any)
		if !ok {
			return nil, validation("Cada mercado debe ser un objeto.")
		}
		buyMaxRate, _, failure := numberField(object, "buyMaxRate")
		if failure != nil {
			return nil, failure
		}
		sellFeePercent, _, failure := numberField(object, "sellFeePercent")
		if failure != nil {
			return nil, failure
		}
		outgoingTransferFee, _, failure := numberField(object, "outgoingTransferFee")
		if failure != nil {
			return nil, failure
		}
		result[coin] = liquidity.MarketEconomics{
			BuyMaxRate:          buyMaxRate,
			SellFeePercent:      sellFeePercent,
			OutgoingTransferFee: outgoingTransferFee,
		}
	}
	return result, nil
}
