package main

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"testing"
	"time"

	"github.com/AGR55/QvaApp/services/shared/decimal"
	"github.com/AGR55/QvaApp/services/trading-core/internal/core"
	"github.com/AGR55/QvaApp/services/trading-core/internal/runtimeconfig"
)

func runtimeConfigFixture() runtimeconfig.Config {
	return runtimeconfig.Config{
		Version: runtimeconfig.ConfigVersion,
		Risk: runtimeconfig.Risk{
			MaxQusdPerOperation:         25.5,
			MaxConcurrentQusdExposure:   150,
			MaxDailyAppliedQusd:         500,
			MaxConcurrentOperations:     4,
			MinQusdReserve:              10,
			MaxQuoteAgeSeconds:          45,
			MinExpectedMarginPercent:    1.25,
			MaxSlippagePercent:          2.5,
			MaxConsecutiveErrors:        3,
			MarketCooldownSeconds:       90,
			CounterpartyCooldownSeconds: 30,
		},
		Markets: []runtimeconfig.Market{
			{
				Code: "BANK_CUP", Active: true, HuntBuyEnabled: true,
				HuntSellEnabled: false, FiatBalance: 1000, BuyMaxRate: 1.076,
				SellMinRate: 1.15, PurchaseMaxQusd: 20, SellFeePercent: 3,
				OutgoingTransferFee: 0.25,
			},
			{
				Code: "BANK_MLC", Active: false, HuntBuyEnabled: false,
				HuntSellEnabled: true, FiatBalance: 25, BuyMaxRate: 1.2,
				SellMinRate: 1.3, PurchaseMaxQusd: 5, SellFeePercent: 1.5,
				OutgoingTransferFee: 0,
			},
		},
	}
}

func TestCoreConfigFromRuntime(t *testing.T) {
	config := coreConfigFromRuntime(runtimeConfigFixture())

	assertDecimal(t, "limits.max_qusd_per_operation", config.Limits.MaxQusdPerOperation, "25.5")
	assertDecimal(t, "limits.max_concurrent_qusd_exposure", config.Limits.MaxConcurrentQusdExposure, "150")
	assertDecimal(t, "limits.max_daily_applied_qusd", config.Limits.MaxDailyAppliedQusd, "500")
	assertDecimal(t, "limits.max_concurrent_operations", config.Limits.MaxConcurrentOperations, "4")
	assertDecimal(t, "limits.min_qusd_reserve", config.Limits.MinQusdReserve, "10")
	assertDecimal(t, "limits.max_quote_age_seconds", config.Limits.MaxQuoteAgeSeconds, "45")
	assertDecimal(t, "limits.min_expected_margin_percent", config.Limits.MinExpectedMarginPercent, "1.25")
	assertDecimal(t, "limits.max_slippage_percent", config.Limits.MaxSlippagePercent, "2.5")
	assertDecimal(t, "limits.max_consecutive_errors", config.Limits.MaxConsecutiveErrors, "3")
	assertDecimal(t, "limits.market_cooldown_seconds", config.Limits.MarketCooldownSeconds, "90")
	assertDecimal(t, "limits.counterparty_cooldown_seconds", config.Limits.CounterpartyCooldownSeconds, "30")

	if len(config.Markets) != 2 {
		t.Fatalf("se esperaban 2 mercados, hay %d", len(config.Markets))
	}
	market, ok := config.Markets["BANK_CUP"]
	if !ok {
		t.Fatal("falta el mercado BANK_CUP")
	}
	if market.Code != "BANK_CUP" {
		t.Fatalf("code = %q", market.Code)
	}
	if !market.Active || !market.HuntBuy || market.HuntSell {
		t.Fatalf("flags de BANK_CUP = active:%v buy:%v sell:%v",
			market.Active, market.HuntBuy, market.HuntSell)
	}
	assertDecimal(t, "BANK_CUP.buy_max_rate", market.BuyMaxRate, "1.076")
	assertDecimal(t, "BANK_CUP.sell_min_rate", market.SellMinRate, "1.15")
	assertDecimal(t, "BANK_CUP.purchase_max_qusd", market.PurchaseMaxQusd, "20")
	assertDecimal(t, "BANK_CUP.sell_fee_percent", market.SellFeePercent, "3")
	assertDecimal(t, "BANK_CUP.outgoing_fee", market.OutgoingFee, "0.25")
	assertDecimal(t, "fiat.BANK_CUP", config.Fiat["BANK_CUP"], "1000")

	second, ok := config.Markets["BANK_MLC"]
	if !ok {
		t.Fatal("falta el mercado BANK_MLC")
	}
	if second.Active || second.HuntBuy || !second.HuntSell {
		t.Fatalf("flags de BANK_MLC = active:%v buy:%v sell:%v",
			second.Active, second.HuntBuy, second.HuntSell)
	}
	assertDecimal(t, "BANK_MLC.outgoing_fee", second.OutgoingFee, "0")
	assertDecimal(t, "fiat.BANK_MLC", config.Fiat["BANK_MLC"], "25")
}

func TestCoreConfigFromRuntimeKeepsInactiveMarket(t *testing.T) {
	config := coreConfigFromRuntime(runtimeConfigFixture())

	inactive, ok := config.Markets["BANK_MLC"]
	if !ok {
		t.Fatal("el mercado inactivo debe permanecer en Markets")
	}
	if inactive.Active {
		t.Fatal("BANK_MLC debe quedar inactivo")
	}
	if _, ok := config.Fiat["BANK_MLC"]; !ok {
		t.Fatal("el fiat debe incluir mercados inactivos")
	}
	if len(config.Fiat) != 2 {
		t.Fatalf("se esperaban 2 saldos fiat, hay %d", len(config.Fiat))
	}
}

func TestCoreConfigFromRuntimeSkipsEmptyCode(t *testing.T) {
	fixture := runtimeConfigFixture()
	fixture.Markets = append(fixture.Markets, runtimeconfig.Market{
		Code: "   ", FiatBalance: 99, BuyMaxRate: 1,
	})

	config := coreConfigFromRuntime(fixture)

	if len(config.Markets) != 2 || len(config.Fiat) != 2 {
		t.Fatalf("mercado sin código no debe publicarse: markets=%d fiat=%d",
			len(config.Markets), len(config.Fiat))
	}
}

func TestDecimalValueFromFloatIsExact(t *testing.T) {
	value := decimalValueFromFloat(1.076)

	if value.Compact() != "1.076" {
		t.Fatalf("valor = %s, se esperaba 1.076", value.Compact())
	}
	if value.Format(8) != "1.07600000" {
		t.Fatalf("formato = %s, se esperaba 1.07600000", value.Format(8))
	}
	assertDecimal(t, "1.076", value, "1.076")
}

func TestApplyConfigPublishesSnapshotAndClearsFileError(t *testing.T) {
	consumer := &hunterConsumer{
		config:    core.Config{},
		configErr: errors.New("archivo no disponible"),
	}

	// Sin repositorio runtime se mantiene el snapshot del archivo.
	consumer.reloadRuntime(context.Background(), time.Now())
	if _, err := consumer.configSnapshot(); err == nil {
		t.Fatal("no debe limpiarse configErr sin configuración runtime")
	}

	consumer.applyConfig(coreConfigFromRuntime(runtimeConfigFixture()))

	if _, err := consumer.configSnapshot(); err != nil {
		t.Fatalf("applyConfig debe limpiar configErr: %v", err)
	}
	if _, ok := consumer.currentConfig().Markets["BANK_CUP"]; !ok {
		t.Fatal("currentConfig no devuelve el snapshot aplicado")
	}
}

func TestReloadRuntimeThrottlesWithoutDatabase(t *testing.T) {
	fileConfig := core.Config{Markets: map[string]core.Market{
		"FILE": {Code: "FILE", Active: true},
	}}
	consumer := &hunterConsumer{
		config:  fileConfig,
		runtime: &runtimeconfig.Repository{},
		logger:  slog.New(slog.NewTextHandler(io.Discard, nil)),
	}
	now := time.Unix(1700000000, 0)

	consumer.reloadRuntime(context.Background(), now)
	if consumer.currentConfig().Markets["FILE"].Code != "FILE" {
		t.Fatal("una carga fallida no debe reemplazar el snapshot del archivo")
	}
	if consumer.runtimeAt.Load() != now.UnixMilli() {
		t.Fatalf("runtimeAt = %d, se esperaba %d", consumer.runtimeAt.Load(), now.UnixMilli())
	}

	// Dentro de la ventana no se vuelve a consultar.
	consumer.reloadRuntime(context.Background(), now.Add(5*time.Second))
	if consumer.runtimeAt.Load() != now.UnixMilli() {
		t.Fatal("no debe reintentarse antes de 10s")
	}

	// Pasada la ventana se reintenta y se renueva la marca.
	later := now.Add(11 * time.Second)
	consumer.reloadRuntime(context.Background(), later)
	if consumer.runtimeAt.Load() != later.UnixMilli() {
		t.Fatalf("runtimeAt = %d, se esperaba %d", consumer.runtimeAt.Load(), later.UnixMilli())
	}
}

func TestCurrentConfigConcurrent(t *testing.T) {
	consumer := &hunterConsumer{}
	next := coreConfigFromRuntime(runtimeConfigFixture())
	done := make(chan struct{})

	go func() {
		defer close(done)
		for index := 0; index < 50; index++ {
			consumer.applyConfig(next)
		}
	}()

	for index := 0; index < 50; index++ {
		_ = consumer.currentConfig()
	}
	<-done
}

func assertDecimal(t *testing.T, name string, got decimal.Value, want string) {
	t.Helper()
	if got.Cmp(decimal.MustParse(want)) != 0 {
		t.Fatalf("%s = %s, se esperaba %s", name, got.Compact(), want)
	}
}
