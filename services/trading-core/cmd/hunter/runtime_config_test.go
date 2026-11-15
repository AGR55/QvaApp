package main

import (
	"context"
	"math"
	"testing"

	"github.com/AGR55/QvaApp/services/trading-core/internal/platform/qvapay"
	"github.com/AGR55/QvaApp/services/trading-core/internal/runtimeconfig"
)

func TestHunterConfigFromRuntime(t *testing.T) {
	config := runtimeconfig.Config{
		Automation: runtimeconfig.Automation{PriceGuardPercent: 12.5},
		Markets: []runtimeconfig.Market{
			{
				Code:                "USDT",
				Active:              true,
				HuntBuyEnabled:      true,
				HuntSellEnabled:     false,
				BuyMaxRate:          1.25,
				SellMinRate:         0.95,
				PurchaseMaxQusd:     50,
				OutgoingTransferFee: 0.5,
			},
			{Code: "   ", Active: true},
		},
	}

	mapped := hunterConfigFromRuntime(config)

	if got := mapped.PriceGuardPercent.Compact(); got != "12.5" {
		t.Fatalf("PriceGuardPercent = %q, se esperaba 12.5", got)
	}
	if len(mapped.Markets) != 1 {
		t.Fatalf("mercados = %d, se esperaba 1 (el código vacío se ignora)", len(mapped.Markets))
	}
	market, ok := mapped.Markets["USDT"]
	if !ok {
		t.Fatal("falta el mercado USDT")
	}
	if !market.Active || !market.HuntBuy || market.HuntSell {
		t.Fatalf(
			"flags del mercado = active:%v huntBuy:%v huntSell:%v",
			market.Active, market.HuntBuy, market.HuntSell,
		)
	}
	for name, pair := range map[string][2]string{
		"BuyMaxRate":      {market.BuyMaxRate.Compact(), "1.25"},
		"SellMinRate":     {market.SellMinRate.Compact(), "0.95"},
		"PurchaseMaxQusd": {market.PurchaseMaxQusd.Compact(), "50"},
		"OutgoingFee":     {market.OutgoingFee.Compact(), "0.5"},
	} {
		if pair[0] != pair[1] {
			t.Errorf("%s = %q, se esperaba %q", name, pair[0], pair[1])
		}
	}
}

func TestHunterConfigFromRuntimeHandlesInvalidNumbers(t *testing.T) {
	config := runtimeconfig.Config{
		Automation: runtimeconfig.Automation{PriceGuardPercent: math.NaN()},
		Markets: []runtimeconfig.Market{
			{Code: "BTC", BuyMaxRate: math.Inf(1), SellMinRate: math.Inf(-1)},
		},
	}
	mapped := hunterConfigFromRuntime(config)
	if !mapped.PriceGuardPercent.IsZero() {
		t.Fatalf("PriceGuardPercent no finito debería quedar en cero")
	}
	market := mapped.Markets["BTC"]
	if !market.BuyMaxRate.IsZero() || !market.SellMinRate.IsZero() {
		t.Fatal("tasas no finitas deberían quedar en cero")
	}
}

func TestRuntimePollIntervalMS(t *testing.T) {
	cases := []struct {
		name       string
		seconds    float64
		mode       string
		fallbackMS int
		want       int
	}{
		{"polling usa el panel", 10, "polling", 0, 10_000},
		{"polling redondea", 3.2, "polling", 0, 3_200},
		{"polling aplica mínimo", 1, "polling", 0, 3_000},
		{"polling mínimo en cero", 0, "polling", 0, 3_000},
		{"polling normaliza mayúsculas", 5, "POLLING", 0, 5_000},
		{"polling acota máximo", 999_999, "polling", 0, 3_600_000},
		{"híbrido usa fallback cero", 10, "hybrid", 0, 0},
		{"híbrido usa fallback", 10, "hybrid", 5_000, 5_000},
		{"modo desconocido usa fallback", 10, "webhook", 1_500, 1_500},
		{"modo vacío usa fallback", 10, "", 2_000, 2_000},
	}

	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			config := runtimeconfig.Config{
				Automation: runtimeconfig.Automation{ScanIntervalSeconds: test.seconds},
			}
			if got := runtimePollIntervalMS(config, test.mode, test.fallbackMS); got != test.want {
				t.Fatalf("intervalo = %d, se esperaba %d", got, test.want)
			}
		})
	}
}

func TestNormalizeRuntimeSettings(t *testing.T) {
	cases := []struct {
		name      string
		values    map[string][]byte
		wantMode  string
		wantPause bool
		wantEmerg bool
	}{
		{
			name:     "sin claves usa defaults",
			values:   nil,
			wantMode: "hybrid",
		},
		{
			name: "lee JSON normal",
			values: map[string][]byte{
				settingMarketSourceMode:     []byte(`"polling"`),
				settingControlPaused:        []byte(`true`),
				settingControlEmergencyStop: []byte(`false`),
			},
			wantMode:  "polling",
			wantPause: true,
		},
		{
			name: "tolera texto plano y números",
			values: map[string][]byte{
				settingMarketSourceMode:     []byte(`polling`),
				settingControlPaused:        []byte(`"true"`),
				settingControlEmergencyStop: []byte(`1`),
			},
			wantMode:  "polling",
			wantPause: true,
			wantEmerg: true,
		},
		{
			name: "modo inválido cae en híbrido",
			values: map[string][]byte{
				settingMarketSourceMode: []byte(`"webhook"`),
			},
			wantMode: "hybrid",
		},
		{
			name: "JSON inválido usa defaults",
			values: map[string][]byte{
				settingMarketSourceMode:     []byte(`[1,2]`),
				settingControlPaused:        []byte(`nope`),
				settingControlEmergencyStop: []byte(`{}`),
			},
			wantMode: "hybrid",
		},
		{
			name: "emergencia detiene",
			values: map[string][]byte{
				settingControlEmergencyStop: []byte(`true`),
			},
			wantMode:  "hybrid",
			wantEmerg: true,
		},
	}

	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			mode, paused, emergency := normalizeRuntimeSettings(test.values)
			if mode != test.wantMode {
				t.Errorf("mode = %q, se esperaba %q", mode, test.wantMode)
			}
			if paused != test.wantPause {
				t.Errorf("paused = %v, se esperaba %v", paused, test.wantPause)
			}
			if emergency != test.wantEmerg {
				t.Errorf("emergency = %v, se esperaba %v", emergency, test.wantEmerg)
			}
		})
	}
}

func TestSelectReaderClientRotation(t *testing.T) {
	clients := []*qvapay.Client{
		{Token: "a"},
		{Token: "b"},
		{Token: "c"},
	}
	want := []string{"a", "b", "c", "a", "b", "c"}
	for position := uint64(0); position < uint64(len(want)); position++ {
		selected := selectReaderClient(clients, position)
		if selected == nil {
			t.Fatalf("posición %d: cliente nil", position)
		}
		if selected.Token != want[position] {
			t.Fatalf("posición %d: token = %q, se esperaba %q", position, selected.Token, want[position])
		}
	}
	if selected := selectReaderClient(nil, 0); selected != nil {
		t.Fatal("sin clientes la selección debe ser nil")
	}
}

func TestQvapaySourceRotationFallsBackToPrimary(t *testing.T) {
	primary := &qvapay.Client{Token: "primary"}

	fallback := &qvapaySource{
		client: primary,
		readers: func(context.Context) []*qvapay.Client {
			return nil
		},
	}
	for attempt := 0; attempt < 2; attempt++ {
		if got := fallback.nextClient(context.Background()); got != primary {
			t.Fatalf("intento %d: sin lectores se esperaba el cliente primario", attempt)
		}
	}

	readers := []*qvapay.Client{
		{Token: "a"},
		{Token: "b"},
		{Token: "c"},
	}
	source := &qvapaySource{
		client: primary,
		readers: func(context.Context) []*qvapay.Client {
			return readers
		},
	}
	want := []string{"a", "b", "c", "a"}
	for index, expected := range want {
		if got := source.nextClient(context.Background()); got.Token != expected {
			t.Fatalf("llamada %d: token = %q, se esperaba %q", index, got.Token, expected)
		}
	}
}
