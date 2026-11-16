package main

import (
	"testing"

	"github.com/AGR55/QvaApp/services/trading-core/internal/hunter"
)

func TestOfferTargetsPriorizaCompraYExcluyeMercadosInactivos(t *testing.T) {
	service := &service{config: hunter.Config{Markets: map[string]hunter.Market{
		"CLASICA": {Active: true, HuntBuy: true, HuntSell: true},
		"BANK_CUP": {Active: true, HuntBuy: true, HuntSell: false},
		"ZELLE":   {Active: false, HuntBuy: true, HuntSell: true},
	}}}
	targets := service.offerTargets()
	want := []offerTarget{
		{Coin: "BANK_CUP", Side: "sell"},
		{Coin: "CLASICA", Side: "sell"},
		{Coin: "CLASICA", Side: "buy"},
	}
	if len(targets) != len(want) {
		t.Fatalf("targets = %+v", targets)
	}
	for index := range want {
		if targets[index] != want[index] {
			t.Fatalf("targets[%d] = %+v, quiero %+v", index, targets[index], want[index])
		}
	}
}

func TestNextTargetRotaSinSaltarseMercados(t *testing.T) {
	source := &qvapaySource{targets: func() []offerTarget {
		return []offerTarget{{Coin: "A", Side: "sell"}, {Coin: "B", Side: "buy"}}
	}}
	for index, want := range []offerTarget{
		{Coin: "A", Side: "sell"}, {Coin: "B", Side: "buy"},
		{Coin: "A", Side: "sell"}, {Coin: "B", Side: "buy"},
	} {
		if got := source.nextTarget(); got != want {
			t.Fatalf("vuelta %d = %+v, quiero %+v", index, got, want)
		}
	}
}

func TestNextTargetSinConfiguracionUsaListadoGlobal(t *testing.T) {
	source := &qvapaySource{}
	if got := source.nextTarget(); got != (offerTarget{Side: "sell"}) {
		t.Fatalf("target = %+v", got)
	}
}
