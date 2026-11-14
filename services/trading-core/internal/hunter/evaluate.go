// Package hunter evalúa ofertas P2P para el servicio de cacerías. Es puro: no
// hace I/O y no muta nada. El core sigue siendo el único escritor de dinero.
package hunter

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"strings"

	"github.com/AGR55/QvaApp/services/shared/decimal"
	"github.com/AGR55/QvaApp/services/trading-core/internal/platform/qvapay"
)

// Market son los límites de un mercado.
type Market struct {
	Active          bool
	BuyMaxRate      decimal.Value
	SellMinRate     decimal.Value
	PurchaseMaxQusd decimal.Value
	OutgoingFee     decimal.Value
	HuntBuy         bool
	HuntSell        bool
}

// Config es la configuración del hunter.
type Config struct {
	PriceGuardPercent decimal.Value
	Markets           map[string]Market
}

type rawMarket struct {
	Code            string `json:"code"`
	Active          any    `json:"active"`
	BuyMaxRate      any    `json:"buy_max_rate"`
	SellMinRate     any    `json:"sell_min_rate"`
	PurchaseMaxQusd any    `json:"purchase_max_qusd"`
	OutgoingFee     any    `json:"outgoing_transfer_fee"`
	HuntBuyEnabled  any    `json:"hunt_buy_enabled"`
	HuntSellEnabled any    `json:"hunt_sell_enabled"`
}

type rawConfig struct {
	PriceGuardPercent any         `json:"price_guard_percent"`
	Markets           []rawMarket `json:"markets"`
}

// LoadConfig lee el JSON generado desde market_config. Si el archivo no
// existe, devuelve una configuración vacía para que el servicio siga vivo.
func LoadConfig(path string) (Config, error) {
	config := Config{PriceGuardPercent: decimal.FromInt(15), Markets: map[string]Market{}}
	if strings.TrimSpace(path) == "" {
		return config, nil
	}
	payload, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		return config, nil
	}
	if err != nil {
		return Config{}, err
	}
	decoder := json.NewDecoder(bytes.NewReader(payload))
	decoder.UseNumber()
	var raw rawConfig
	if err := decoder.Decode(&raw); err != nil {
		return Config{}, fmt.Errorf("configuración hunter inválida: %w", err)
	}
	if guard, ok := number(raw.PriceGuardPercent); ok && guard.Sign() > 0 {
		config.PriceGuardPercent = guard
	}
	for _, item := range raw.Markets {
		code := strings.TrimSpace(item.Code)
		if code == "" {
			continue
		}
		buyMax, _ := number(item.BuyMaxRate)
		sellMin, _ := number(item.SellMinRate)
		purchaseMax, _ := number(item.PurchaseMaxQusd)
		fee, _ := number(item.OutgoingFee)
		config.Markets[code] = Market{
			Active: boolean(item.Active, false), BuyMaxRate: buyMax, SellMinRate: sellMin,
			PurchaseMaxQusd: purchaseMax, OutgoingFee: fee,
			HuntBuy: boolean(item.HuntBuyEnabled, true), HuntSell: boolean(item.HuntSellEnabled, true),
		}
	}
	return config, nil
}

// Evaluation es la decisión de una oferta.
type Evaluation struct {
	OfferUUID string
	Coin      string
	Side      string
	Rate      decimal.Value
	Median    decimal.Value
	Decision  string
	Reason    string
}

// MarshalJSON expone tasas como texto decimal estable, sin serializar big.Rat.
func (e Evaluation) MarshalJSON() ([]byte, error) {
	return json.Marshal(struct {
		OfferUUID string `json:"offerUuid"`
		Coin      string `json:"coin"`
		Side      string `json:"side"`
		Rate      string `json:"rate"`
		Median    string `json:"median"`
		Decision  string `json:"decision"`
		Reason    string `json:"reason"`
	}{
		OfferUUID: e.OfferUUID, Coin: e.Coin, Side: e.Side,
		Rate: e.Rate.Format(8), Median: e.Median.Format(8),
		Decision: e.Decision, Reason: e.Reason,
	})
}

// Evaluate clasifica una oferta P2P. decision puede ser auto_buy,
// manual_sell, blocked o ignored.
func Evaluate(offer qvapay.Offer, average qvapay.Average, market Market, guard decimal.Value) Evaluation {
	evaluation := Evaluation{
		OfferUUID: offer.UUID,
		Coin:      offer.Coin,
		Rate:      decimal.Zero(),
		Median:    decimal.Zero(),
		Decision:  "ignored",
	}
	if offer.Status != "open" || offer.Amount.Sign() <= 0 || offer.Receive.Sign() <= 0 {
		evaluation.Reason = "Oferta no abierta o importes no positivos"
		return evaluation
	}
	rate, err := offer.Receive.Div(offer.Amount)
	if err != nil {
		evaluation.Reason = "No se pudo calcular la tasa"
		return evaluation
	}
	evaluation.Rate = rate
	guardFraction, err := guard.Div(decimal.FromInt(100))
	if err != nil {
		evaluation.Reason = "Guardián de precio inválido"
		return evaluation
	}
	if !market.Active {
		evaluation.Reason = "Mercado inactivo"
		return evaluation
	}

	switch offer.Type {
	case "sell":
		evaluation.Side = "buy"
		if !market.HuntBuy {
			evaluation.Reason = "Cacería de compra detenida"
			return evaluation
		}
		if market.PurchaseMaxQusd.Sign() > 0 && offer.Amount.Cmp(market.PurchaseMaxQusd) > 0 {
			evaluation.Reason = fmt.Sprintf("Supera límite de %s QUSD por compra", market.PurchaseMaxQusd.Compact())
			return evaluation
		}
		if market.BuyMaxRate.Sign() > 0 && rate.Cmp(market.BuyMaxRate) > 0 {
			evaluation.Reason = fmt.Sprintf("Supera máximo de compra (%s)", market.BuyMaxRate.Compact())
			return evaluation
		}
		median := average.MedianSell
		if median.Sign() <= 0 {
			evaluation.Decision = "blocked"
			evaluation.Reason = "Mediana P2P no disponible; compra automática bloqueada"
			return evaluation
		}
		evaluation.Median = median
		floor := median.Mul(decimal.FromInt(1).Sub(guardFraction))
		if rate.Cmp(floor) < 0 {
			evaluation.Decision = "blocked"
			evaluation.Reason = fmt.Sprintf("%s%% por debajo de la mediana de venta (%s)", guard.Compact(), median.Compact())
			return evaluation
		}
		evaluation.Decision = "auto_buy"
		evaluation.Reason = "Compra automática elegible"
		return evaluation

	case "buy":
		evaluation.Side = "sell"
		if !market.HuntSell {
			evaluation.Reason = "Cacería de venta detenida"
			return evaluation
		}
		if market.SellMinRate.Sign() > 0 && rate.Cmp(market.SellMinRate) < 0 {
			evaluation.Reason = fmt.Sprintf("No alcanza mínimo de venta (%s)", market.SellMinRate.Compact())
			return evaluation
		}
		median := average.MedianBuy
		if median.Sign() <= 0 {
			evaluation.Decision = "blocked"
			evaluation.Reason = "Mediana P2P no disponible; venta bloqueada"
			return evaluation
		}
		evaluation.Median = median
		ceiling := median.Mul(decimal.FromInt(1).Add(guardFraction))
		if rate.Cmp(ceiling) > 0 {
			evaluation.Decision = "blocked"
			evaluation.Reason = fmt.Sprintf("%s%% por encima de la mediana de compra (%s)", guard.Compact(), median.Compact())
			return evaluation
		}
		evaluation.Decision = "manual_sell"
		evaluation.Reason = "Venta elegible con aplicación manual"
		return evaluation
	default:
		evaluation.Reason = "Tipo de oferta desconocido"
		return evaluation
	}
}

func boolean(value any, fallback bool) bool {
	switch typed := value.(type) {
	case nil:
		return fallback
	case bool:
		return typed
	case string:
		switch strings.ToLower(strings.TrimSpace(typed)) {
		case "1", "true":
			return true
		case "0", "false":
			return false
		}
	case json.Number:
		return typed.String() == "1"
	case float64:
		return typed == 1
	}
	return fallback
}

func number(value any) (decimal.Value, bool) {
	switch typed := value.(type) {
	case nil:
		return decimal.Zero(), false
	case json.Number:
		parsed, err := decimal.Parse(typed.String())
		return parsed, err == nil
	case float64:
		parsed, err := decimal.Parse(fmt.Sprintf("%v", typed))
		return parsed, err == nil
	case string:
		parsed, err := decimal.Parse(strings.TrimSpace(typed))
		return parsed, err == nil
	default:
		return decimal.Zero(), false
	}
}
