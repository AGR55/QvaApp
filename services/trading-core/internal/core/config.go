// Package core contiene la evaluación de riesgo del core shadow sobre los
// eventos producidos por el hunter. No hace I/O ni muta dinero.
package core

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"strings"

	"github.com/AGR55/QvaApp/services/shared/decimal"
	"github.com/AGR55/QvaApp/services/trading-core/internal/domain/riskpolicy"
)

// Market es la configuración de un mercado fiat.
type Market struct {
	Code            string
	Active          bool
	BuyMaxRate      decimal.Value
	SellMinRate     decimal.Value
	PurchaseMaxQusd decimal.Value
	SellFeePercent  decimal.Value
	OutgoingFee     decimal.Value
	HuntBuy         bool
	HuntSell        bool
}

// Config es el snapshot usado por core; se genera desde producción.
type Config struct {
	Limits  riskpolicy.Limits
	Markets map[string]Market
	Fiat    map[string]decimal.Value
}

type rawRisk struct {
	MaxQusdPerOperation         any `json:"max_qusd_per_operation"`
	MaxConcurrentQusdExposure   any `json:"max_concurrent_qusd_exposure"`
	MaxDailyAppliedQusd         any `json:"max_daily_applied_qusd"`
	MaxConcurrentOperations     any `json:"max_concurrent_operations"`
	MinQusdReserve              any `json:"min_qusd_reserve"`
	MaxQuoteAgeSeconds          any `json:"max_quote_age_seconds"`
	MinExpectedMarginPercent    any `json:"min_expected_margin_percent"`
	MaxSlippagePercent          any `json:"max_slippage_percent"`
	MaxConsecutiveErrors        any `json:"max_consecutive_errors"`
	MarketCooldownSeconds       any `json:"market_cooldown_seconds"`
	CounterpartyCooldownSeconds any `json:"counterparty_cooldown_seconds"`
}

type rawMarket struct {
	Code            string `json:"code"`
	Active          any    `json:"active"`
	BuyMaxRate      any    `json:"buy_max_rate"`
	SellMinRate     any    `json:"sell_min_rate"`
	PurchaseMaxQusd any    `json:"purchase_max_qusd"`
	SellFeePercent  any    `json:"sell_fee_percent"`
	OutgoingFee     any    `json:"outgoing_transfer_fee"`
	HuntBuy         any    `json:"hunt_buy_enabled"`
	HuntSell        any    `json:"hunt_sell_enabled"`
}

type rawConfig struct {
	Risk    rawRisk     `json:"risk"`
	Markets []rawMarket `json:"markets"`
	Fiat    []struct {
		Key   string `json:"key"`
		Value any    `json:"value"`
	} `json:"fiat"`
}

// LoadConfig lee el snapshot generado por el deploy.
func LoadConfig(path string) (Config, error) {
	payload, err := os.ReadFile(path)
	if err != nil {
		return Config{}, err
	}
	decoder := json.NewDecoder(bytes.NewReader(payload))
	decoder.UseNumber()
	var raw rawConfig
	if err := decoder.Decode(&raw); err != nil {
		return Config{}, fmt.Errorf("configuración core inválida: %w", err)
	}
	config := Config{Markets: map[string]Market{}, Fiat: map[string]decimal.Value{}}
	config.Limits = riskpolicy.Limits{
		MaxQusdPerOperation:         mustNumber(raw.Risk.MaxQusdPerOperation),
		MaxConcurrentQusdExposure:   mustNumber(raw.Risk.MaxConcurrentQusdExposure),
		MaxDailyAppliedQusd:         mustNumber(raw.Risk.MaxDailyAppliedQusd),
		MaxConcurrentOperations:     mustNumber(raw.Risk.MaxConcurrentOperations),
		MinQusdReserve:              mustNumber(raw.Risk.MinQusdReserve),
		MaxQuoteAgeSeconds:          mustNumber(raw.Risk.MaxQuoteAgeSeconds),
		MinExpectedMarginPercent:    mustNumber(raw.Risk.MinExpectedMarginPercent),
		MaxSlippagePercent:          mustNumber(raw.Risk.MaxSlippagePercent),
		MaxConsecutiveErrors:        mustNumber(raw.Risk.MaxConsecutiveErrors),
		MarketCooldownSeconds:       mustNumber(raw.Risk.MarketCooldownSeconds),
		CounterpartyCooldownSeconds: mustNumber(raw.Risk.CounterpartyCooldownSeconds),
	}
	for _, item := range raw.Markets {
		code := strings.TrimSpace(item.Code)
		if code == "" {
			continue
		}
		config.Markets[code] = Market{
			Code: code, Active: boolValue(item.Active),
			BuyMaxRate: number(item.BuyMaxRate), SellMinRate: number(item.SellMinRate),
			PurchaseMaxQusd: number(item.PurchaseMaxQusd),
			SellFeePercent:  number(item.SellFeePercent), OutgoingFee: number(item.OutgoingFee),
			HuntBuy: boolValueDefault(item.HuntBuy, true), HuntSell: boolValueDefault(item.HuntSell, true),
		}
	}
	for _, item := range raw.Fiat {
		key := strings.TrimPrefix(item.Key, "fiat_balance:")
		if key == "" {
			continue
		}
		config.Fiat[key] = number(item.Value)
	}
	return config, nil
}

// Event es el candidato que llega desde hunter.
type Event struct {
	OfferUUID string
	Coin      string
	Side      string
	Decision  string
	Amount    decimal.Value
	Receive   decimal.Value
	Rate      decimal.Value
	// Uso ya consumido, leído de las operaciones persistidas. Si queda en cero
	// el riesgo solo aplica los límites por operación.
	Usage Usage
}

// Usage es el consumo vigente de los cortafuegos globales.
type Usage struct {
	ConcurrentQusdExposure decimal.Value
	DailyAppliedQusd       decimal.Value
	ActiveOperations       decimal.Value
}

// Result es la decisión del core shadow.
type Result struct {
	Kind    string
	Allowed bool
	Reasons []string
	Checks  []riskpolicy.Check
}

// Decide evalúa riesgo con el snapshot del core. No ejecuta mutaciones.
func Decide(event Event, config Config, qusdBalance decimal.Value, nowMS int64) (Result, error) {
	if event.Amount.Sign() <= 0 || event.Rate.Sign() <= 0 {
		return Result{}, fmt.Errorf("evento sin importe o tasa válidos")
	}
	market, ok := config.Markets[event.Coin]
	if !ok || !market.Active {
		return Result{Kind: "ignored", Reasons: []string{"Mercado inactivo"}}, nil
	}
	var side riskpolicy.Side
	var requiredFiat decimal.Value
	var priceDecision riskpolicy.PriceDecision
	switch event.Side {
	case "buy":
		if !market.HuntBuy {
			return Result{Kind: "blocked", Reasons: []string{"Cacería de compra detenida"}}, nil
		}
		side = riskpolicy.BuyQusd
		requiredFiat = event.Receive.Add(market.OutgoingFee)
		switch event.Decision {
		case "auto_buy":
			priceDecision = riskpolicy.Eligible
		case "manual_sell":
			priceDecision = riskpolicy.Eligible
		case "blocked":
			priceDecision = riskpolicy.PriceBlocked
		default:
			priceDecision = riskpolicy.PriceIgnored
		}
	case "sell":
		if !market.HuntSell {
			return Result{Kind: "blocked", Reasons: []string{"Cacería de venta detenida"}}, nil
		}
		side = riskpolicy.SellQusd
		requiredFiat = decimal.Zero()
		switch event.Decision {
		case "manual_sell":
			priceDecision = riskpolicy.Eligible
		case "blocked":
			priceDecision = riskpolicy.PriceBlocked
		default:
			priceDecision = riskpolicy.PriceIgnored
		}
	default:
		return Result{Kind: "ignored", Reasons: []string{"Lado desconocido"}}, nil
	}

	expectedMargin := decimal.FromInt(100)
	if side == riskpolicy.BuyQusd {
		target := market.SellMinRate.Mul(decimal.FromInt(1).Sub(mustDiv(market.SellFeePercent, decimal.FromInt(100))))
		delta := target.Sub(event.Rate)
		margin, err := delta.Div(event.Rate)
		if err != nil {
			return Result{}, err
		}
		expectedMargin = margin.Mul(decimal.FromInt(100))
	}
	now := decimal.FromInt(nowMS)
	context := riskpolicy.Context{
		Now: now,
		Opportunity: riskpolicy.Opportunity{
			UUID: event.OfferUUID, Market: event.Coin, Side: side,
			QusdAmount: event.Amount, RequiredFiat: requiredFiat,
			QuotedRate: event.Rate, ReferenceRate: event.Rate,
			ObservedAt: now,
		},
		Limits: config.Limits, PriceDecision: priceDecision,
		PriceReason:           "Decisión del hunter: " + event.Decision,
		ExpectedMarginPercent: expectedMargin,
		QusdBalance:           qusdBalance, FiatAvailable: config.Fiat[event.Coin],
		ConcurrentQusdExposure: event.Usage.ConcurrentQusdExposure,
		DailyAppliedQusd:       event.Usage.DailyAppliedQusd,
		ActiveOperations:       event.Usage.ActiveOperations,
		ConsecutiveErrors:      decimal.Zero(),
	}
	decision, err := riskpolicy.Evaluate(context)
	if err != nil {
		return Result{}, err
	}
	kind := string(decision.Kind)
	if decision.Kind == riskpolicy.Apply {
		kind = "apply"
	}
	return Result{Kind: kind, Allowed: decision.Kind == riskpolicy.Apply, Reasons: decision.Reasons, Checks: decision.Checks}, nil
}

func number(value any) decimal.Value {
	switch typed := value.(type) {
	case nil:
		return decimal.Zero()
	case json.Number:
		parsed, err := decimal.Parse(typed.String())
		if err == nil {
			return parsed
		}
	case string:
		parsed, err := decimal.Parse(strings.TrimSpace(typed))
		if err == nil {
			return parsed
		}
	case float64:
		parsed, err := decimal.Parse(fmt.Sprintf("%v", typed))
		if err == nil {
			return parsed
		}
	}
	return decimal.Zero()
}

func mustNumber(value any) decimal.Value { return number(value) }

func boolValue(value any) bool {
	switch typed := value.(type) {
	case bool:
		return typed
	case string:
		return typed == "1" || strings.EqualFold(typed, "true")
	case json.Number:
		return typed.String() == "1"
	case float64:
		return typed == 1
	}
	return false
}

func boolValueDefault(value any, fallback bool) bool {
	if value == nil {
		return fallback
	}
	return boolValue(value)
}

func mustDiv(left, right decimal.Value) decimal.Value {
	result, err := left.Div(right)
	if err != nil {
		panic(err)
	}
	return result
}
