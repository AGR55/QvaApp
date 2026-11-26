package main

import "testing"

func TestRecoveryPayloadReconstruyeDesdeEvento(t *testing.T) {
	raw := `{"offerUuid":"offer-1","coin":"BANK_CUP","side":"buy","decision":"auto_buy","amount":"5","receive":"6000","rate":"1200","offerKind":"flexible","observedAt":1000}`
	payload, ok := recoveryPayload(raw, "offer-1", "BANK_CUP", "buy", "auto_buy", "5", "6000", "1200", 1000)
	if !ok {
		t.Fatal("payload no reconstruido")
	}
	if payload.OfferKind != "flexible" || payload.Source != "recovery" || payload.Amount != "5" {
		t.Fatalf("payload = %+v", payload)
	}
}

func TestRecoveryPayloadFabricaMinimoSinEvento(t *testing.T) {
	payload, ok := recoveryPayload("", "offer-2", "CLASICA", "sell", "manual_sell", "10", "11", "1.1", 2000)
	if !ok {
		t.Fatal("payload mínimo no reconstruido")
	}
	if payload.OfferUUID != "offer-2" || payload.Coin != "CLASICA" || payload.Side != "sell" ||
		payload.Amount != "10" || payload.Receive != "11" || payload.Source != "recovery" {
		t.Fatalf("payload = %+v", payload)
	}
}

func TestRecoveryPayloadRechazaDatosIncompletos(t *testing.T) {
	if _, ok := recoveryPayload("", "", "BANK_CUP", "buy", "auto_buy", "5", "6", "1", 0); ok {
		t.Fatal("no debería reconstruir sin oferta")
	}
}
