package core

import (
	"os"
	"testing"

	"github.com/AGR55/QvaApp/services/shared/decimal"
)

func configForTest(t *testing.T) Config {
	t.Helper()
	path := t.TempDir() + "/core.json"
	payload := `{
		"risk":{"max_qusd_per_operation":25,"max_concurrent_qusd_exposure":50,"max_daily_applied_qusd":100,"max_concurrent_operations":2,"min_qusd_reserve":10,"max_quote_age_seconds":45,"min_expected_margin_percent":0.5,"max_slippage_percent":1,"max_consecutive_errors":3,"market_cooldown_seconds":30,"counterparty_cooldown_seconds":300},
		"markets":[{"code":"BANK_CUP","active":1,"buy_max_rate":1200,"sell_min_rate":1500,"purchase_max_qusd":50,"sell_fee_percent":0,"outgoing_transfer_fee":0,"hunt_buy_enabled":1,"hunt_sell_enabled":1}],
		"fiat":[{"key":"fiat_balance:BANK_CUP","value":"100000"}]
	}`
	if err := os.WriteFile(path, []byte(payload), 0o600); err != nil {
		t.Fatal(err)
	}
	config, err := LoadConfig(path)
	if err != nil {
		t.Fatal(err)
	}
	return config
}

func TestDecideBuy(t *testing.T) {
	config := configForTest(t)
	result, err := Decide(Event{
		OfferUUID: "offer-1", Coin: "BANK_CUP", Side: "buy", Decision: "auto_buy",
		Amount: decimal.MustParse("20"), Receive: decimal.MustParse("24000"), Rate: decimal.MustParse("1200"),
	}, config, decimal.MustParse("100"), 1000)
	if err != nil {
		t.Fatal(err)
	}
	if !result.Allowed || result.Kind != "apply" {
		t.Fatalf("resultado inesperado: %+v", result)
	}
}

func TestDecideTooLarge(t *testing.T) {
	config := configForTest(t)
	result, err := Decide(Event{
		OfferUUID: "offer-2", Coin: "BANK_CUP", Side: "buy", Decision: "auto_buy",
		Amount: decimal.MustParse("30"), Receive: decimal.MustParse("36000"), Rate: decimal.MustParse("1200"),
	}, config, decimal.MustParse("100"), 1000)
	if err != nil {
		t.Fatal(err)
	}
	if result.Allowed || result.Kind != "blocked" {
		t.Fatalf("resultado inesperado: %+v", result)
	}
}

func TestDecideInactiveMarket(t *testing.T) {
	config := configForTest(t)
	item := config.Markets["BANK_CUP"]
	item.Active = false
	config.Markets["BANK_CUP"] = item
	result, err := Decide(Event{Coin: "BANK_CUP", Side: "buy", Decision: "auto_buy", Amount: decimal.FromInt(1), Rate: decimal.FromInt(1)}, config, decimal.Zero(), 1)
	if err != nil {
		t.Fatal(err)
	}
	if result.Kind != "ignored" {
		t.Fatalf("resultado inesperado: %+v", result)
	}
}
