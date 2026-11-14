package hunter

import (
	"testing"

	"github.com/AGR55/QvaApp/services/shared/decimal"
	"github.com/AGR55/QvaApp/services/trading-core/internal/platform/qvapay"
)

func market() Market {
	return Market{
		Active: true, BuyMaxRate: decimal.MustParse("2000"),
		SellMinRate: decimal.MustParse("500"), PurchaseMaxQusd: decimal.MustParse("50"),
		HuntBuy: true, HuntSell: true,
	}
}

func offer(offerType, amount, receive string) qvapay.Offer {
	return qvapay.Offer{
		UUID: "offer-1", Coin: "BANK_CUP", Type: offerType, Status: "open",
		Amount: decimal.MustParse(amount), Receive: decimal.MustParse(receive),
	}
}

func TestEvaluateBuyEligible(t *testing.T) {
	result := Evaluate(offer("sell", "10", "18000"), qvapay.Average{MedianSell: decimal.MustParse("2000")}, market(), decimal.FromInt(15))
	if result.Decision != "auto_buy" || result.Side != "buy" || result.Rate.Format(8) != "1800.00000000" {
		t.Fatalf("resultado inesperado: %+v", result)
	}
}

func TestEvaluateBuyBelowFloorBlocked(t *testing.T) {
	result := Evaluate(offer("sell", "10", "10000"), qvapay.Average{MedianSell: decimal.MustParse("2000")}, market(), decimal.FromInt(15))
	if result.Decision != "blocked" {
		t.Fatalf("decisión = %s, quiero blocked", result.Decision)
	}
}

func TestEvaluateBuyAboveMaxIgnored(t *testing.T) {
	result := Evaluate(offer("sell", "10", "30000"), qvapay.Average{MedianSell: decimal.MustParse("2000")}, market(), decimal.FromInt(15))
	if result.Decision != "ignored" {
		t.Fatalf("decisión = %s, quiero ignored", result.Decision)
	}
}

func TestEvaluateSellEligible(t *testing.T) {
	result := Evaluate(offer("buy", "10", "11000"), qvapay.Average{MedianBuy: decimal.MustParse("1000")}, market(), decimal.FromInt(15))
	if result.Decision != "manual_sell" || result.Side != "sell" {
		t.Fatalf("resultado inesperado: %+v", result)
	}
}

func TestEvaluateSellAboveCeilingBlocked(t *testing.T) {
	result := Evaluate(offer("buy", "10", "20000"), qvapay.Average{MedianBuy: decimal.MustParse("1000")}, market(), decimal.FromInt(15))
	if result.Decision != "blocked" {
		t.Fatalf("decisión = %s, quiero blocked", result.Decision)
	}
}

func TestEvaluateMissingMedian(t *testing.T) {
	result := Evaluate(offer("sell", "10", "18000"), qvapay.Average{}, market(), decimal.FromInt(15))
	if result.Decision != "blocked" {
		t.Fatalf("decisión = %s, quiero blocked", result.Decision)
	}
}

func TestLoadConfig(t *testing.T) {
	path := t.TempDir() + "/config.json"
	if err := writeFile(path, `{"price_guard_percent":12,"markets":[{"code":"BANK_CUP","active":true,"buy_max_rate":2000,"sell_min_rate":500,"purchase_max_qusd":50,"outgoing_transfer_fee":5,"hunt_buy_enabled":true,"hunt_sell_enabled":false}]}`); err != nil {
		t.Fatal(err)
	}
	config, err := LoadConfig(path)
	if err != nil {
		t.Fatal(err)
	}
	if config.PriceGuardPercent.Format(0) != "12" {
		t.Fatalf("guard = %s", config.PriceGuardPercent.Format(0))
	}
	item := config.Markets["BANK_CUP"]
	if !item.Active || !item.HuntBuy || item.HuntSell || item.BuyMaxRate.Format(0) != "2000" {
		t.Fatalf("mercado inesperado: %+v", item)
	}
}
