package runtimeconfig

import "testing"

func TestAdjustFiatBalance(t *testing.T) {
	config := Config{Markets: []Market{
		{Code: "CLASICA", FiatBalance: 100},
		{Code: "BANK_CUP", FiatBalance: 1000},
	}}
	if err := AdjustFiatBalance(&config, "CLASICA", "debit", 10.7); err != nil {
		t.Fatalf("debit: %v", err)
	}
	if config.Markets[0].FiatBalance != 89.3 {
		t.Fatalf("debit balance = %v", config.Markets[0].FiatBalance)
	}
	if err := AdjustFiatBalance(&config, "CLASICA", "credit", 5); err != nil {
		t.Fatalf("credit: %v", err)
	}
	if config.Markets[0].FiatBalance != 94.3 {
		t.Fatalf("credit balance = %v", config.Markets[0].FiatBalance)
	}
	if err := AdjustFiatBalance(&config, "NOPE", "debit", 1); err == nil {
		t.Fatal("se esperaba error para mercado desconocido")
	}
}

func TestValidateFiatMovement(t *testing.T) {
	valid := FiatMovement{Key: "order-1", Coin: "CLASICA", Direction: "debit", Amount: 1, At: 1}
	if err := validateFiatMovement(valid); err != nil {
		t.Fatalf("válido: %v", err)
	}
	cases := []FiatMovement{
		{Key: "", Coin: "CLASICA", Direction: "debit", Amount: 1, At: 1},
		{Key: "k", Coin: "", Direction: "debit", Amount: 1, At: 1},
		{Key: "k", Coin: "CLASICA", Direction: "sideways", Amount: 1, At: 1},
		{Key: "k", Coin: "CLASICA", Direction: "debit", Amount: 0, At: 1},
		{Key: "k", Coin: "CLASICA", Direction: "debit", Amount: 1, At: 0},
	}
	for index, movement := range cases {
		if err := validateFiatMovement(movement); err == nil {
			t.Fatalf("caso %d debería fallar", index)
		}
	}
}
