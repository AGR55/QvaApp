package decisionaudit

import (
	"encoding/json"
	"testing"
)

const capitalFailureReason = "El saldo QUSD disponible después de la reserva no cubre la operación."

func minimalChecks() []map[string]any {
	return []map[string]any{
		{"code": "price_policy", "label": "Política de precio", "status": "pass", "actual": "eligible", "limit": "eligible", "reason": "La tasa cumple."},
		{"code": "emergency_stop", "label": "Interruptor de emergencia", "status": "pass", "actual": false, "limit": false, "reason": "Interruptor de emergencia: correcto."},
		{"code": "automation_paused", "label": "Automatización activa", "status": "pass", "actual": false, "limit": false, "reason": "Automatización activa: correcto."},
		{"code": "unresolved_mutation", "label": "Sin mutaciones inciertas", "status": "pass", "actual": false, "limit": false, "reason": "Sin mutaciones inciertas: correcto."},
		{"code": "operation_amount", "label": "Importe por operación", "status": "pass", "actual": 20, "limit": 200, "reason": "Importe por operación: dentro del límite."},
		{"code": "concurrent_exposure", "label": "Exposición simultánea", "status": "pass", "actual": 20, "limit": 1000, "reason": "Exposición simultánea: dentro del límite."},
		{"code": "daily_volume", "label": "Volumen diario", "status": "pass", "actual": 20, "limit": 2000, "reason": "Volumen diario: dentro del límite."},
		{"code": "concurrent_operations", "label": "Operaciones simultáneas", "status": "pass", "actual": 1, "limit": 6, "reason": "Operaciones simultáneas: dentro del límite."},
		{"code": "quote_age", "label": "Antigüedad de la cotización", "status": "pass", "actual": 0, "limit": 90, "reason": "Antigüedad de la cotización: dentro del límite."},
		{"code": "expected_margin", "label": "Margen esperado", "status": "pass", "actual": 5, "limit": 0.5, "reason": "Margen esperado: suficiente."},
		{"code": "slippage", "label": "Deslizamiento frente a referencia", "status": "pass", "actual": 0, "limit": 25, "reason": "Deslizamiento frente a referencia: dentro del límite."},
		{"code": "consecutive_errors", "label": "Errores consecutivos", "status": "pass", "actual": 0, "limit": 2, "reason": "Errores consecutivos: dentro del límite."},
		{"code": "market_cooldown", "label": "Enfriamiento del mercado", "status": "not_applicable", "limit": 30, "reason": "Enfriamiento del mercado: sin actividad previa aplicable."},
		{"code": "counterparty_cooldown", "label": "Enfriamiento de contraparte", "status": "not_applicable", "limit": 300, "reason": "Enfriamiento de contraparte: sin actividad previa aplicable."},
		{"code": "qusd_capital", "label": "QUSD disponible después de reserva", "status": "fail", "actual": 5, "limit": 20, "reason": capitalFailureReason},
	}
}

func syntheticEvent() Event {
	payload, err := json.Marshal(minimalChecks())
	if err != nil {
		panic(err)
	}
	return Event{
		Version:    "event-1",
		Coin:       "BANDECPREPAGO",
		OfferType:  "buy",
		Amount:     20,
		Receive:    20000,
		Rate:       1000,
		Decision:   "blocked",
		Reason:     capitalFailureReason,
		ChecksJSON: string(payload),
	}
}

func TestAuditMatchesBlockedByQusdCapital(t *testing.T) {
	result, err := Audit(syntheticEvent())
	if err != nil {
		t.Fatal(err)
	}
	if !result.Comparable {
		t.Fatal("el evento debería ser comparable")
	}
	if !result.Matched {
		t.Fatalf("no coincidió: %+v", result.Differences)
	}
	if result.ExpectedKind != "blocked" || result.ActualKind != "blocked" {
		t.Fatalf("kinds = %s/%s", result.ExpectedKind, result.ActualKind)
	}
	if result.ExpectedJSON != result.ActualJSON {
		t.Fatalf("JSON distinto:\nesperado: %s\nactual:   %s", result.ExpectedJSON, result.ActualJSON)
	}
	if result.ExpectedDigest != result.ActualDigest {
		t.Fatalf("digests distintos: %s/%s", result.ExpectedDigest, result.ActualDigest)
	}
	if result.ExpectedDigest == "" || result.ActualDigest == "" {
		t.Fatal("digest vacío")
	}
}

func TestAuditSkipsEmptyChecks(t *testing.T) {
	event := syntheticEvent()
	event.ChecksJSON = "[]"
	result, err := Audit(event)
	if err != nil {
		t.Fatal(err)
	}
	if result.Comparable {
		t.Fatal("checks_json vacío no debe ser comparable")
	}
	if result.Matched {
		t.Fatal("un evento no comparable no puede coincidir")
	}
}

func TestAuditDetectsManipulatedDecision(t *testing.T) {
	event := syntheticEvent()
	event.Decision = "applied"
	event.Reason = "Aplicación automática confirmada."

	result, err := Audit(event)
	if err != nil {
		t.Fatal(err)
	}
	if !result.Comparable {
		t.Fatal("el evento debería ser comparable")
	}
	if result.Matched {
		t.Fatal("una decisión manipulada no puede coincidir")
	}
	if result.ExpectedKind != "applied" || result.ActualKind != "blocked" {
		t.Fatalf("kinds = %s/%s", result.ExpectedKind, result.ActualKind)
	}
	if len(result.Differences) == 0 {
		t.Fatal("se esperaban diferencias legibles")
	}
	if result.ExpectedJSON == result.ActualJSON {
		t.Fatal("los JSON canónigos no deberían ser iguales")
	}
}
