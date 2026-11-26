package runtimeconfig_test

import (
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/AGR55/QvaApp/services/trading-core/internal/runtimeconfig"
)

func int64Pointer(value int64) *int64 {
	return &value
}

func validConfig() runtimeconfig.Config {
	return runtimeconfig.Config{
		Version:       runtimeconfig.ConfigVersion,
		QusdReserve:   10,
		MaxOpenOffers: 5,
		Hunting: runtimeconfig.Hunting{
			BuyRunning:  true,
			SellRunning: false,
		},
		Automation: runtimeconfig.Automation{
			ScanIntervalSeconds:         15,
			AutoCancelMinutes:           10,
			OfferRefreshIntervalMinutes: 30,
			OfferRefreshSpacingSeconds:  5,
			PriceGuardPercent:           2.5,
			WelcomeMessage:              "Bienvenido",
		},
		Risk: runtimeconfig.Risk{
			MaxQusdPerOperation:         25,
			MaxConcurrentQusdExposure:   50,
			MaxDailyAppliedQusd:         100,
			MaxConcurrentOperations:     2,
			MinQusdReserve:              5,
			MaxQuoteAgeSeconds:          30,
			MinExpectedMarginPercent:    1,
			MaxSlippagePercent:          1,
			MaxConsecutiveErrors:        3,
			MarketCooldownSeconds:       60,
			CounterpartyCooldownSeconds: 60,
			ReviewedAt:                  int64Pointer(1_700_000_000_000),
		},
		Markets: []runtimeconfig.Market{{
			Code:                "BTC_USD",
			Label:               "Bitcoin",
			Currency:            "USD",
			Active:              true,
			HuntBuyEnabled:      true,
			HuntSellEnabled:     true,
			FiatBalance:         100,
			BuyMaxRate:          70000,
			SellMinRate:         69000,
			PurchaseMaxQusd:     50,
			PurchaseMinQusd:     1,
			SellFeePercent:      1,
			OutgoingTransferFee: 0.5,
			PaymentDetails: []runtimeconfig.PaymentDetail{{
				Name:  "Transferencia",
				Value: "cuenta-de-prueba",
			}},
		}},
	}
}

func TestValidateAcceptsValidConfig(t *testing.T) {
	if err := runtimeconfig.Validate(validConfig()); err != nil {
		t.Fatalf("Validate rechazó una configuración válida: %v", err)
	}

	withoutMarkets := validConfig()
	withoutMarkets.Markets = nil
	if err := runtimeconfig.Validate(withoutMarkets); err != nil {
		t.Fatalf("Validate rechazó una configuración sin mercados: %v", err)
	}

	withoutDetails := validConfig()
	withoutDetails.Markets[0].PaymentDetails = nil
	if err := runtimeconfig.Validate(withoutDetails); err != nil {
		t.Fatalf("Validate rechazó paymentDetails nulo: %v", err)
	}

	boundaries := validConfig()
	boundaries.Automation.ScanIntervalSeconds = runtimeconfig.MinScanIntervalSeconds
	boundaries.Risk.MaxConcurrentOperations = 1000
	boundaries.Risk.MaxQuoteAgeSeconds = 5
	boundaries.Risk.MaxConsecutiveErrors = 1
	boundaries.Markets = makeMarkets(runtimeconfig.MaxMarkets)
	if err := runtimeconfig.Validate(boundaries); err != nil {
		t.Fatalf("Validate rechazó los límites permitidos: %v", err)
	}
}

func TestValidateRejectsInvalidConfig(t *testing.T) {
	tests := []struct {
		name   string
		mutate func(*runtimeconfig.Config)
	}{
		{"versión anterior", func(config *runtimeconfig.Config) {
			config.Version = 2
		}},
		{"versión futura", func(config *runtimeconfig.Config) {
			config.Version = 4
		}},
		{"maxOpenOffers negativo", func(config *runtimeconfig.Config) {
			config.MaxOpenOffers = -1
		}},
		{"scanIntervalSeconds demasiado corto", func(config *runtimeconfig.Config) {
			config.Automation.ScanIntervalSeconds = 2.99
		}},
		{"scanIntervalSeconds demasiado largo", func(config *runtimeconfig.Config) {
			config.Automation.ScanIntervalSeconds = 3600.01
		}},
		{"autoCancelMinutes menor que uno", func(config *runtimeconfig.Config) {
			config.Automation.AutoCancelMinutes = 0.99
		}},
		{"offerRefreshIntervalMinutes menor que uno", func(config *runtimeconfig.Config) {
			config.Automation.OfferRefreshIntervalMinutes = 0.99
		}},
		{"offerRefreshSpacingSeconds menor que uno", func(config *runtimeconfig.Config) {
			config.Automation.OfferRefreshSpacingSeconds = 0.99
		}},
		{"priceGuardPercent cero", func(config *runtimeconfig.Config) {
			config.Automation.PriceGuardPercent = 0
		}},
		{"priceGuardPercent negativo", func(config *runtimeconfig.Config) {
			config.Automation.PriceGuardPercent = -1
		}},
		{"maxQusdPerOperation negativo", func(config *runtimeconfig.Config) {
			config.Risk.MaxQusdPerOperation = -1
		}},
		{"maxConcurrentQusdExposure negativo", func(config *runtimeconfig.Config) {
			config.Risk.MaxConcurrentQusdExposure = -1
		}},
		{"maxDailyAppliedQusd negativo", func(config *runtimeconfig.Config) {
			config.Risk.MaxDailyAppliedQusd = -1
		}},
		{"minQusdReserve negativo", func(config *runtimeconfig.Config) {
			config.Risk.MinQusdReserve = -1
		}},
		{"minExpectedMarginPercent negativo", func(config *runtimeconfig.Config) {
			config.Risk.MinExpectedMarginPercent = -1
		}},
		{"maxSlippagePercent negativo", func(config *runtimeconfig.Config) {
			config.Risk.MaxSlippagePercent = -1
		}},
		{"marketCooldownSeconds negativo", func(config *runtimeconfig.Config) {
			config.Risk.MarketCooldownSeconds = -1
		}},
		{"counterpartyCooldownSeconds negativo", func(config *runtimeconfig.Config) {
			config.Risk.CounterpartyCooldownSeconds = -1
		}},
		{"maxConcurrentOperations cero", func(config *runtimeconfig.Config) {
			config.Risk.MaxConcurrentOperations = 0
		}},
		{"maxConcurrentOperations excesivo", func(config *runtimeconfig.Config) {
			config.Risk.MaxConcurrentOperations = 1001
		}},
		{"maxQuoteAgeSeconds corto", func(config *runtimeconfig.Config) {
			config.Risk.MaxQuoteAgeSeconds = 4.99
		}},
		{"maxConsecutiveErrors cero", func(config *runtimeconfig.Config) {
			config.Risk.MaxConsecutiveErrors = 0
		}},
		{"código de mercado en minúsculas", func(config *runtimeconfig.Config) {
			config.Markets[0].Code = "btc_usd"
		}},
		{"código de mercado demasiado corto", func(config *runtimeconfig.Config) {
			config.Markets[0].Code = "B"
		}},
		{"código de mercado con guion", func(config *runtimeconfig.Config) {
			config.Markets[0].Code = "BTC-USD"
		}},
		{"código de mercado demasiado largo", func(config *runtimeconfig.Config) {
			config.Markets[0].Code = strings.Repeat("A", 41)
		}},
		{"mercado duplicado", func(config *runtimeconfig.Config) {
			config.Markets = append(config.Markets, config.Markets[0])
		}},
		{"etiqueta vacía", func(config *runtimeconfig.Config) {
			config.Markets[0].Label = "   "
		}},
		{"moneda vacía", func(config *runtimeconfig.Config) {
			config.Markets[0].Currency = ""
		}},
		{"buyMaxRate cero", func(config *runtimeconfig.Config) {
			config.Markets[0].BuyMaxRate = 0
		}},
		{"sellMinRate cero", func(config *runtimeconfig.Config) {
			config.Markets[0].SellMinRate = 0
		}},
		{"purchaseMaxQusd negativo", func(config *runtimeconfig.Config) {
			config.Markets[0].PurchaseMaxQusd = -0.01
		}},
		{"purchaseMinQusd negativo", func(config *runtimeconfig.Config) {
			config.Markets[0].PurchaseMinQusd = -0.01
		}},
		{"purchaseMinQusd mayor que el máximo", func(config *runtimeconfig.Config) {
			config.Markets[0].PurchaseMaxQusd = 1
			config.Markets[0].PurchaseMinQusd = 2
		}},
		{"sellFeePercent negativo", func(config *runtimeconfig.Config) {
			config.Markets[0].SellFeePercent = -0.01
		}},
		{"outgoingTransferFee negativo", func(config *runtimeconfig.Config) {
			config.Markets[0].OutgoingTransferFee = -0.01
		}},
		{"demasiados mercados", func(config *runtimeconfig.Config) {
			config.Markets = makeMarkets(runtimeconfig.MaxMarkets + 1)
		}},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			config := validConfig()
			test.mutate(&config)

			err := runtimeconfig.Validate(config)
			if err == nil {
				t.Fatal("Validate aceptó una configuración inválida")
			}
			if !errors.Is(err, runtimeconfig.ErrInvalidConfig) {
				t.Fatalf("Validate no envolvió ErrInvalidConfig: %v", err)
			}
			if strings.TrimSpace(err.Error()) == "" {
				t.Fatal("Validate devolvió un error sin detalle")
			}
		})
	}
}

func TestValidateErrorDoesNotLeakPaymentDetails(t *testing.T) {
	config := validConfig()
	config.Markets[0].Code = "CODIGO INVALIDO"
	config.Markets[0].PaymentDetails = []runtimeconfig.PaymentDetail{{
		Name:  "Cuenta",
		Value: "dato-sensible-123",
	}}

	err := runtimeconfig.Validate(config)
	if err == nil {
		t.Fatal("Validate aceptó un código de mercado inválido")
	}
	if strings.Contains(err.Error(), "dato-sensible-123") {
		t.Fatalf("el error filtró un dato de pago: %v", err)
	}
}

func TestNormalize(t *testing.T) {
	config := validConfig()
	config.Markets = []runtimeconfig.Market{
		{
			Code:           "ZEC_USD",
			Label:          "  Zcash  ",
			Currency:       " USD ",
			BuyMaxRate:     30,
			SellMinRate:    29,
			PaymentDetails: nil,
		},
		{
			Code:       "BTC_USD",
			Label:      " Bitcoin ",
			Currency:   "USD  ",
			BuyMaxRate: 70000, SellMinRate: 69000,
			PaymentDetails: []runtimeconfig.PaymentDetail{{
				Name:  "Transferencia",
				Value: "datos",
			}},
		},
	}
	config.Automation.WelcomeMessage = "  Hola, bienvenido  "
	config.Risk.ReviewedAt = nil

	normalized := runtimeconfig.Normalize(config, time.UnixMilli(1_700_000_000_000))

	if len(normalized.Markets) != 2 {
		t.Fatalf("mercados = %d, quiero 2", len(normalized.Markets))
	}
	if normalized.Markets[0].Code != "BTC_USD" || normalized.Markets[1].Code != "ZEC_USD" {
		t.Fatalf("orden de mercados = %q, %q",
			normalized.Markets[0].Code, normalized.Markets[1].Code)
	}
	if normalized.Markets[0].Label != "Bitcoin" {
		t.Fatalf("label sin recortar = %q", normalized.Markets[0].Label)
	}
	if normalized.Markets[0].Currency != "USD" {
		t.Fatalf("currency sin recortar = %q", normalized.Markets[0].Currency)
	}
	if normalized.Markets[1].PaymentDetails == nil {
		t.Fatal("Normalize dejó paymentDetails nulo")
	}
	if len(normalized.Markets[1].PaymentDetails) != 0 {
		t.Fatalf("paymentDetails = %v, quiero vacío", normalized.Markets[1].PaymentDetails)
	}
	if normalized.Automation.WelcomeMessage != "Hola, bienvenido" {
		t.Fatalf("welcomeMessage sin recortar = %q", normalized.Automation.WelcomeMessage)
	}
	if normalized.Risk.ReviewedAt != nil {
		t.Fatalf("Normalize rellenó reviewedAt: %v", *normalized.Risk.ReviewedAt)
	}

	// Normalize no debe reordenar ni recortar el valor original del caller.
	if config.Markets[0].Code != "ZEC_USD" || config.Markets[0].Label != "  Zcash  " {
		t.Fatalf("Normalize mutó la entrada: %+v", config.Markets[0])
	}

	idempotent := runtimeconfig.Normalize(normalized, time.UnixMilli(1_800_000_000_000))
	if idempotent.Markets[0].Code != normalized.Markets[0].Code ||
		idempotent.Automation.WelcomeMessage != normalized.Automation.WelcomeMessage {
		t.Fatalf("Normalize no es idempotente: %+v", idempotent)
	}

	reviewed := int64(42)
	second := validConfig()
	second.Risk.ReviewedAt = &reviewed
	normalized = runtimeconfig.Normalize(second, time.UnixMilli(1_900_000_000_000))
	if normalized.Risk.ReviewedAt == nil || *normalized.Risk.ReviewedAt != reviewed {
		t.Fatalf("reviewedAt = %v, quiero %d", normalized.Risk.ReviewedAt, reviewed)
	}
}

func makeMarkets(count int) []runtimeconfig.Market {
	markets := make([]runtimeconfig.Market, count)
	for index := range markets {
		markets[index] = runtimeconfig.Market{
			Code:            fmt.Sprintf("M%02d", index),
			Label:           fmt.Sprintf("Mercado %d", index),
			Currency:        "USD",
			Active:          true,
			BuyMaxRate:      10,
			SellMinRate:     9,
			PurchaseMaxQusd: 10,
			PaymentDetails:  []runtimeconfig.PaymentDetail{},
		}
	}
	return markets
}
