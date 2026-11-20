// Package runtimeconfig implementa la configuración operativa editable desde
// el panel web. Es la representación en Go del contrato de src/market-config.ts
// y la comparten edge, hunter y core.
package runtimeconfig

import (
	"errors"
	"fmt"
	"regexp"
	"sort"
	"strings"
	"time"
)

const (
	// ConfigVersion es la única versión de esquema que este paquete acepta.
	ConfigVersion = 3

	// MaxMarkets acota el número de mercados que puede declarar el panel.
	MaxMarkets = 50

	// MinScanIntervalSeconds y MaxScanIntervalSeconds acotan el ciclo del
	// hunter.
	MinScanIntervalSeconds = 3
	MaxScanIntervalSeconds = 3600

	// MaxReasonLength y MaxActorLength acotan los metadatos de auditoría.
	MaxReasonLength = 500
	MaxActorLength  = 120

	// DefaultRevisionLimit se usa cuando no se pide un límite explícito.
	DefaultRevisionLimit = 20

	// MaxRevisionLimit es el mayor número de revisiones devuelto de una vez.
	MaxRevisionLimit = 100
)

var (
	// ErrNotFound indica que todavía no existe configuración persistida.
	ErrNotFound = errors.New("runtimeconfig: configuración no encontrada")

	// ErrInvalidConfig envuelve cualquier fallo de validación. El detalle se
	// añade con %w para que errors.Is siga funcionando.
	ErrInvalidConfig = errors.New("runtimeconfig: configuración inválida")

	marketCodePattern = regexp.MustCompile(`^[A-Z0-9_]{2,40}$`)
)

// Config es la configuración completa del panel. Los nombres JSON son
// camelCase para coincidir con src/market-config.ts.
type Config struct {
	Version       int        `json:"version"`
	QusdReserve   float64    `json:"qusdReserve"`
	MaxOpenOffers int        `json:"maxOpenOffers"`
	Hunting       Hunting    `json:"hunting"`
	Automation    Automation `json:"automation"`
	Risk          Risk       `json:"risk"`
	Markets       []Market   `json:"markets"`
}

// Hunting indica si el hunter puede abrir ofertas de compra o de venta.
type Hunting struct {
	BuyRunning  bool `json:"buyRunning"`
	SellRunning bool `json:"sellRunning"`
}

// Automation agrupa los temporizadores y el guardián de precios.
type Automation struct {
	ScanIntervalSeconds         float64 `json:"scanIntervalSeconds"`
	AutoCancelMinutes           float64 `json:"autoCancelMinutes"`
	OfferRefreshIntervalMinutes float64 `json:"offerRefreshIntervalMinutes"`
	OfferRefreshSpacingSeconds  float64 `json:"offerRefreshSpacingSeconds"`
	PriceGuardPercent           float64 `json:"priceGuardPercent"`
	WelcomeMessage              string  `json:"welcomeMessage"`
}

// Risk contiene los cortafuegos globales de operación.
type Risk struct {
	MaxQusdPerOperation         float64 `json:"maxQusdPerOperation"`
	MaxConcurrentQusdExposure   float64 `json:"maxConcurrentQusdExposure"`
	MaxDailyAppliedQusd         float64 `json:"maxDailyAppliedQusd"`
	MaxConcurrentOperations     int     `json:"maxConcurrentOperations"`
	MinQusdReserve              float64 `json:"minQusdReserve"`
	MaxQuoteAgeSeconds          float64 `json:"maxQuoteAgeSeconds"`
	MinExpectedMarginPercent    float64 `json:"minExpectedMarginPercent"`
	MaxSlippagePercent          float64 `json:"maxSlippagePercent"`
	MaxConsecutiveErrors        int     `json:"maxConsecutiveErrors"`
	MarketCooldownSeconds       float64 `json:"marketCooldownSeconds"`
	CounterpartyCooldownSeconds float64 `json:"counterpartyCooldownSeconds"`
	ReviewedAt                  *int64  `json:"reviewedAt"`
}

// Market describe un mercado comerciable y su configuración local.
type Market struct {
	Code                string          `json:"code"`
	Label               string          `json:"label"`
	Currency            string          `json:"currency"`
	IconURL             string          `json:"iconUrl,omitempty"`
	Color               string          `json:"color,omitempty"`
	Active              bool            `json:"active"`
	HuntBuyEnabled      bool            `json:"huntBuyEnabled"`
	HuntSellEnabled     bool            `json:"huntSellEnabled"`
	FiatBalance         float64         `json:"fiatBalance"`
	BuyMaxRate          float64         `json:"buyMaxRate"`
	SellMinRate         float64         `json:"sellMinRate"`
	PurchaseMaxQusd     float64         `json:"purchaseMaxQusd"`
	SellFeePercent      float64         `json:"sellFeePercent"`
	OutgoingTransferFee float64         `json:"outgoingTransferFee"`
	PaymentDetails      []PaymentDetail `json:"paymentDetails"`
}

// PaymentDetail es una cuenta o dato de cobro mostrado a la contraparte.
type PaymentDetail struct {
	Name  string `json:"name"`
	Value string `json:"value"`
}

// Validate comprueba los invariantes que debe cumplir la configuración antes
// de persistirse. Los mensajes están en español y nunca incluyen datos de
// cobro ni valores sensibles.
func Validate(config Config) error {
	if config.Version != ConfigVersion {
		return invalidConfig("la versión debe ser %d", ConfigVersion)
	}

	if config.MaxOpenOffers < 0 {
		return invalidConfig("maxOpenOffers no puede ser negativo")
	}

	automation := config.Automation
	if automation.ScanIntervalSeconds < MinScanIntervalSeconds ||
		automation.ScanIntervalSeconds > MaxScanIntervalSeconds {
		return invalidConfig(
			"scanIntervalSeconds debe estar entre %d y %d",
			MinScanIntervalSeconds, MaxScanIntervalSeconds,
		)
	}
	if automation.AutoCancelMinutes < 1 {
		return invalidConfig("autoCancelMinutes debe ser al menos 1")
	}
	if automation.OfferRefreshIntervalMinutes < 1 {
		return invalidConfig("offerRefreshIntervalMinutes debe ser al menos 1")
	}
	if automation.OfferRefreshSpacingSeconds < 1 {
		return invalidConfig("offerRefreshSpacingSeconds debe ser al menos 1")
	}
	if automation.PriceGuardPercent <= 0 {
		return invalidConfig("priceGuardPercent debe ser mayor que 0")
	}

	if err := validateRisk(config.Risk); err != nil {
		return err
	}

	return validateMarkets(config.Markets)
}

func validateRisk(risk Risk) error {
	for _, limit := range []struct {
		name  string
		value float64
	}{
		{"maxQusdPerOperation", risk.MaxQusdPerOperation},
		{"maxConcurrentQusdExposure", risk.MaxConcurrentQusdExposure},
		{"maxDailyAppliedQusd", risk.MaxDailyAppliedQusd},
		{"minQusdReserve", risk.MinQusdReserve},
		{"minExpectedMarginPercent", risk.MinExpectedMarginPercent},
		{"maxSlippagePercent", risk.MaxSlippagePercent},
		{"marketCooldownSeconds", risk.MarketCooldownSeconds},
		{"counterpartyCooldownSeconds", risk.CounterpartyCooldownSeconds},
	} {
		if limit.value < 0 {
			return invalidConfig("risk.%s no puede ser negativo", limit.name)
		}
	}

	if risk.MaxConcurrentOperations < 1 || risk.MaxConcurrentOperations > 1000 {
		return invalidConfig("risk.maxConcurrentOperations debe estar entre 1 y 1000")
	}
	if risk.MaxQuoteAgeSeconds < 5 {
		return invalidConfig("risk.maxQuoteAgeSeconds debe ser al menos 5")
	}
	if risk.MaxConsecutiveErrors < 1 {
		return invalidConfig("risk.maxConsecutiveErrors debe ser al menos 1")
	}
	return nil
}

func validateMarkets(markets []Market) error {
	if len(markets) > MaxMarkets {
		return invalidConfig("no se permiten más de %d mercados", MaxMarkets)
	}

	seen := make(map[string]struct{}, len(markets))
	for _, market := range markets {
		if !marketCodePattern.MatchString(market.Code) {
			return invalidConfig(
				"mercado %q: el código debe tener de 2 a 40 caracteres en mayúsculas, números o guion bajo",
				market.Code,
			)
		}
		if _, duplicate := seen[market.Code]; duplicate {
			return invalidConfig("mercado %s: código duplicado", market.Code)
		}
		seen[market.Code] = struct{}{}

		if strings.TrimSpace(market.Label) == "" {
			return invalidConfig("mercado %s: la etiqueta no puede estar vacía", market.Code)
		}
		if strings.TrimSpace(market.Currency) == "" {
			return invalidConfig("mercado %s: la moneda no puede estar vacía", market.Code)
		}
		if market.BuyMaxRate <= 0 {
			return invalidConfig("mercado %s: buyMaxRate debe ser mayor que 0", market.Code)
		}
		if market.SellMinRate <= 0 {
			return invalidConfig("mercado %s: sellMinRate debe ser mayor que 0", market.Code)
		}
		if market.PurchaseMaxQusd < 0 {
			return invalidConfig("mercado %s: purchaseMaxQusd no puede ser negativo", market.Code)
		}
		if market.SellFeePercent < 0 {
			return invalidConfig("mercado %s: sellFeePercent no puede ser negativo", market.Code)
		}
		if market.OutgoingTransferFee < 0 {
			return invalidConfig("mercado %s: outgoingTransferFee no puede ser negativo", market.Code)
		}
	}
	return nil
}

// Normalize devuelve una copia ordenada y sin espacios sobrantes. No rellena
// ReviewedAt: eso lo decide el caller que revisa los límites de riesgo.
func Normalize(config Config, now time.Time) Config {
	_ = now // reservado para futuras normalizaciones dependientes del reloj

	config.Automation.WelcomeMessage = strings.TrimSpace(config.Automation.WelcomeMessage)

	markets := make([]Market, len(config.Markets))
	copy(markets, config.Markets)
	for index := range markets {
		markets[index].Label = strings.TrimSpace(markets[index].Label)
		markets[index].Currency = strings.TrimSpace(markets[index].Currency)
		if markets[index].PaymentDetails == nil {
			markets[index].PaymentDetails = []PaymentDetail{}
		}
	}
	sort.SliceStable(markets, func(left, right int) bool {
		return markets[left].Code < markets[right].Code
	})
	config.Markets = markets
	return config
}

func invalidConfig(format string, arguments ...any) error {
	return fmt.Errorf("%w: %s", ErrInvalidConfig, fmt.Sprintf(format, arguments...))
}
