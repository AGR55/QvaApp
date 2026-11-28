package core

import (
	"strings"
	"testing"

	"github.com/AGR55/QvaApp/services/shared/decimal"
)

func takeInput() TakeInput {
	return TakeInput{
		AvailableQusd:   decimal.MustParse("100"),
		OrderMin:        decimal.MustParse("5"),
		OrderMax:        decimal.MustParse("100"),
		FiatAvailable:   decimal.MustParse("1000"),
		OutgoingFee:     decimal.MustParse("0"),
		Rate:            decimal.MustParse("1.33"),
		PerOperationMax: decimal.MustParse("500"),
		MarketMaxQusd:   decimal.MustParse("1000"),
	}
}

func TestSizeTakeFullOfferWhenFundsAllow(t *testing.T) {
	size, err := SizeTake(takeInput())
	if err != nil {
		t.Fatalf("SizeTake: %v", err)
	}
	if size.Amount.Cmp(decimal.MustParse("100")) != 0 {
		t.Fatalf("amount = %s, se esperaba 100", size.Amount.Compact())
	}
}

func TestSizeTakeLimitedByFunds(t *testing.T) {
	input := takeInput()
	input.FiatAvailable = decimal.MustParse("100")
	size, err := SizeTake(input)
	if err != nil {
		t.Fatalf("SizeTake: %v", err)
	}
	// 100 / 1.33 = 75.1879... -> 75.18 truncado.
	if size.Amount.Cmp(decimal.MustParse("75.18")) != 0 {
		t.Fatalf("amount = %s, se esperaba 75.18", size.Amount.Compact())
	}
	if size.Reason == "" {
		t.Fatal("se esperaba una razón de recorte")
	}
}

func TestSizeTakeHonorsMarketAndOrderLimits(t *testing.T) {
	cases := []struct {
		name     string
		mutate   func(*TakeInput)
		expected string
	}{
		{"market max", func(in *TakeInput) { in.MarketMaxQusd = decimal.MustParse("40") }, "40"},
		{"order max", func(in *TakeInput) { in.OrderMax = decimal.MustParse("60") }, "60"},
		{"per operation", func(in *TakeInput) { in.PerOperationMax = decimal.MustParse("25") }, "25"},
		{"exposure", func(in *TakeInput) { in.ExposureRemaining = decimal.MustParse("10") }, "10"},
		{"daily", func(in *TakeInput) { in.DailyRemaining = decimal.MustParse("12.5") }, "12.5"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			input := takeInput()
			tc.mutate(&input)
			size, err := SizeTake(input)
			if err != nil {
				t.Fatalf("SizeTake: %v", err)
			}
			if size.Amount.Cmp(decimal.MustParse(tc.expected)) != 0 {
				t.Fatalf("amount = %s, se esperaba %s", size.Amount.Compact(), tc.expected)
			}
		})
	}
}

func TestSizeTakeRejectsBelowOrderMin(t *testing.T) {
	input := takeInput()
	input.MarketMaxQusd = decimal.MustParse("4")
	size, err := SizeTake(input)
	if err != nil {
		t.Fatalf("SizeTake: %v", err)
	}
	if size.Amount.Sign() != 0 || size.Reason == "" {
		t.Fatalf("size = %+v, se esperaba rechazo por mínimo", size)
	}
}

func TestSizeTakeNoFundsAfterFee(t *testing.T) {
	input := takeInput()
	input.FiatAvailable = decimal.MustParse("2")
	input.OutgoingFee = decimal.MustParse("2")
	size, err := SizeTake(input)
	if err != nil {
		t.Fatalf("SizeTake: %v", err)
	}
	if size.Amount.Sign() != 0 {
		t.Fatalf("amount = %s, se esperaba 0", size.Amount.Compact())
	}
}

func TestSizeTakeRejectsInvalidRate(t *testing.T) {
	input := takeInput()
	input.Rate = decimal.Zero()
	if _, err := SizeTake(input); err == nil {
		t.Fatal("se esperaba error con tasa cero")
	}
}

func TestSizeTakeRejectsBelowMarketMinimum(t *testing.T) {
	input := takeInput()
	input.MarketMaxQusd = decimal.MustParse("0.5")
	input.MarketMinQusd = decimal.MustParse("1")
	size, err := SizeTake(input)
	if err != nil {
		t.Fatalf("SizeTake: %v", err)
	}
	if size.Amount.Sign() != 0 || !strings.Contains(size.Reason, "mínimo del mercado") {
		t.Fatalf("size = %+v, se esperaba rechazo por mínimo del mercado", size)
	}
}

func TestSizeTakeAcceptsAtMarketMinimum(t *testing.T) {
	input := takeInput()
	input.MarketMaxQusd = decimal.MustParse("1")
	input.MarketMinQusd = decimal.MustParse("1")
	input.OrderMin = decimal.Zero()
	size, err := SizeTake(input)
	if err != nil {
		t.Fatalf("SizeTake: %v", err)
	}
	if size.Amount.Cmp(decimal.MustParse("1")) != 0 {
		t.Fatalf("amount = %s, quiero 1", size.Amount.Compact())
	}
}
