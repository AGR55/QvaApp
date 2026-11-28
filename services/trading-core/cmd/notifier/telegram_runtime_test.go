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

func TestOfferStatsSeparaCompraVentaYCalculaMediana(t *testing.T) {
	dashboard := map[string]any{"market": map[string]any{"CLASICA": map[string]any{
		"offers": []any{
			map[string]any{"type": "buy", "rate": 1.10, "status": "open"},
			map[string]any{"type": "buy", "rate": 1.20, "status": "open"},
			map[string]any{"type": "sell", "rate": 1.30, "status": "open"},
			map[string]any{"type": "sell", "rate": 1.40, "status": "open"},
			map[string]any{"type": "sell", "rate": 1.50, "status": "paused"},
		},
	}}}
	buyCount, sellCount, buyMedian, sellMedian := offerStats(dashboard, "CLASICA")
	if buyCount != 2 || sellCount != 2 {
		t.Fatalf("counts buy=%d sell=%d", buyCount, sellCount)
	}
	if buyMedian != 1.15 || sellMedian != 1.35 {
		t.Fatalf("medians buy=%v sell=%v", buyMedian, sellMedian)
	}
}

func TestOfferSideStatsUsaConteoPorLadoCuandoNoHayOfertas(t *testing.T) {
	average := map[string]any{"countBuy": 79.0, "countSell": 363.0, "medianBuy": 1.06, "medianSell": 1.07}
	buyMedian, buyLabel := offerSideStats(average, "buy", 0, 0)
	sellMedian, sellLabel := offerSideStats(average, "sell", 0, 0)
	if buyMedian != 1.06 || buyLabel != "79 ops" || sellMedian != 1.07 || sellLabel != "363 ops" {
		t.Fatalf("buy=%v/%s sell=%v/%s", buyMedian, buyLabel, sellMedian, sellLabel)
	}
}
