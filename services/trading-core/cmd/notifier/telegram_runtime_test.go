package main

import "testing"

func TestTelegramHelpers(t *testing.T) {
	config := map[string]any{"markets": []any{
		map[string]any{"code": "CLASICA", "label": "Clásica", "buyMaxRate": 1.071},
	}}
	market := findMarket(config, "clasica")
	if market == nil || asFloat(market["buyMaxRate"]) != 1.071 {
		t.Fatalf("market = %+v", market)
	}
	if findMarket(config, "NOPE") != nil {
		t.Fatal("no debía encontrar el mercado")
	}
	if money(1.5) != "1.50" || truncate("abcdef", 3) != "abc…" {
		t.Fatal("formato inesperado")
	}
	if helpText() == "" {
		t.Fatal("ayuda vacía")
	}
}
