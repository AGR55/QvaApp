// Package hunter evalúa ofertas P2P para el servicio de cacerías. Es puro: no
// hace I/O y no muta nada. El core sigue siendo el único escritor de dinero.
package hunter

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"time"

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
	Amount    decimal.Value
	Receive   decimal.Value
	Rate      decimal.Value
	Median    decimal.Value
	Decision  string
	Reason    string
	// OfferKind y el rango permiten que el core dimensione ofertas flexibles
	// en vez de rechazarlas por superar el máximo del mercado.
	OfferKind        string
	Available        decimal.Value
	OrderMin         decimal.Value
	OrderMax         decimal.Value
	OfferType        string
	CounterpartyID   string
	CounterpartyName string
	ObservedAt       int64
}

func offerObservedAt(value string) int64 {
	parsed, err := time.Parse(time.RFC3339Nano, strings.TrimSpace(value))
	if err != nil {
		return 0
	}
	return parsed.UnixMilli()
}

// MarshalJSON expone tasas como texto decimal estable, sin serializar big.Rat.
func (e Evaluation) MarshalJSON() ([]byte, error) {
	return json.Marshal(struct {
		OfferUUID        string `json:"offerUuid"`
		Coin             string `json:"coin"`
		Side             string `json:"side"`
		Amount           string `json:"amount"`
		Receive          string `json:"receive"`
		Rate             string `json:"rate"`
		Median           string `json:"median"`
		Decision         string `json:"decision"`
		Reason           string `json:"reason"`
		OfferKind        string `json:"offerKind,omitempty"`
		Available        string `json:"available,omitempty"`
		OrderMin         string `json:"orderMin,omitempty"`
		OrderMax         string `json:"orderMax,omitempty"`
		OfferType        string `json:"offerType,omitempty"`
		CounterpartyID   string `json:"counterpartyId,omitempty"`
		CounterpartyName string `json:"counterpartyName,omitempty"`
		ObservedAt       int64  `json:"observedAt"`
	}{
		OfferUUID: e.OfferUUID, Coin: e.Coin, Side: e.Side,
		Amount: e.Amount.Format(8), Receive: e.Receive.Format(8),
		Rate: e.Rate.Format(8), Median: e.Median.Format(8),
		Decision: e.Decision, Reason: e.Reason,
		OfferKind: e.OfferKind, Available: e.Available.Format(8),
		OrderMin: e.OrderMin.Format(8), OrderMax: e.OrderMax.Format(8),
		OfferType: e.OfferType, CounterpartyID: e.CounterpartyID,
		CounterpartyName: e.CounterpartyName,
		ObservedAt:       e.ObservedAt,
	})
}

// Evaluate clasifica una oferta P2P. decision puede ser auto_buy,
// manual_sell, blocked o ignored.
func Evaluate(offer qvapay.Offer, average qvapay.Average, market Market, guard decimal.Value) Evaluation {
	available := offer.AvailableAmount
	if available.Sign() <= 0 {
		available = offer.Amount
	}
	evaluation := Evaluation{
		OfferUUID:        offer.UUID,
		Coin:             offer.Coin,
		Amount:           offer.Amount,
		Receive:          offer.Receive,
		Rate:             decimal.Zero(),
		Median:           decimal.Zero(),
		Decision:         "ignored",
		OfferKind:        offer.OfferKind,
		Available:        available,
		OrderMin:         offer.OrderMin,
		OrderMax:         offer.OrderMax,
		OfferType:        offer.Type,
		CounterpartyID:   offerCounterparty(offer),
		CounterpartyName: offerCounterpartyName(offer),
		ObservedAt:       offerObservedAt(offer.UpdatedAt),
	}
	if offer.Status != "open" || offer.Amount.Sign() <= 0 || offer.Receive.Sign() <= 0 {
		evaluation.Reason = "Oferta no abierta o importes no positivos"
		return evaluation
	}
	if offer.OnlyVIP == nil || *offer.OnlyVIP {
		evaluation.Reason = "Restricción VIP o indicador no disponible"
		return evaluation
	}
	if offer.Pause != nil || offer.RequirementsMet != nil && !*offer.RequirementsMet {
		evaluation.Reason = "Oferta pausada o no cumple los requisitos del anunciante"
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
		// Una oferta flexible puede publicar más QUSD de los que el mercado
		// permite por operación: el core la dimensiona en vez de descartarla.
		if offer.OfferKind != "flexible" && market.PurchaseMaxQusd.Sign() > 0 &&
			offer.Amount.Cmp(market.PurchaseMaxQusd) > 0 {
			evaluation.Reason = fmt.Sprintf("Supera límite de %s QUSD por compra", market.PurchaseMaxQusd.Compact())
			return evaluation
		}
		if market.BuyMaxRate.Sign() > 0 && rate.Cmp(market.BuyMaxRate) > 0 {
			evaluation.Reason = fmt.Sprintf("Supera máximo de compra (%s)", market.BuyMaxRate.Compact())
			return evaluation
		}
		if market.OutgoingFee.Sign() > 0 {
			effectiveRate, err := offer.Receive.Add(market.OutgoingFee).Div(offer.Amount)
			if err != nil || market.BuyMaxRate.Sign() > 0 && effectiveRate.Cmp(market.BuyMaxRate) > 0 {
				evaluation.Decision = "blocked"
				evaluation.Reason = fmt.Sprintf("La tasa efectiva %s supera el máximo de compra (%s)", effectiveRate.Compact(), market.BuyMaxRate.Compact())
				return evaluation
			}
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

// offerCounterparty devuelve el creador de la oferta, que es la contraparte de
// la operación. Si no viene en User, usa Peer.
func offerCounterpartyName(offer qvapay.Offer) string {
	for _, raw := range []json.RawMessage{offer.User, offer.Peer} {
		if len(raw) == 0 {
			continue
		}
		var object map[string]any
		if json.Unmarshal(raw, &object) != nil {
			continue
		}
		for _, key := range []string{"username", "name"} {
			if name, ok := object[key].(string); ok && strings.TrimSpace(name) != "" {
				return strings.TrimPrefix(strings.TrimSpace(name), "@")
			}
		}
	}
	return ""
}

func offerCounterparty(offer qvapay.Offer) string {
	for _, raw := range []json.RawMessage{offer.User, offer.Peer} {
		if len(raw) == 0 {
			continue
		}
		var object map[string]any
		if json.Unmarshal(raw, &object) != nil {
			continue
		}
		if uuid, ok := object["uuid"].(string); ok && strings.TrimSpace(uuid) != "" {
			return strings.TrimSpace(uuid)
		}
	}
	return ""
}
