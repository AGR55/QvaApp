package main

import "testing"

func TestIsOfferExcluded(t *testing.T) {
	service := &service{excluded: map[string]struct{}{"offer-1": {}}, excludedSeen: 1}
	if !service.isOfferExcluded("offer-1") {
		t.Fatal("la oferta excluida debe ser rechazada")
	}
	if service.isOfferExcluded("offer-2") {
		t.Fatal("una oferta no excluida no debe bloquearse")
	}
	if service.excludedCount() != 1 {
		t.Fatalf("excludedCount = %d", service.excludedCount())
	}
}
