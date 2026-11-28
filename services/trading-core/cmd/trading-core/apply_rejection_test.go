package main

import (
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/AGR55/QvaApp/services/trading-core/internal/platform/qvapay"
)

func TestDefinitiveApplyRejection(t *testing.T) {
	cases := []struct {
		status int
		want   bool
	}{
		{400, true},
		{403, true},
		{409, true},
		{422, true},
		{401, false},
		{429, false},
		{500, false},
		{502, false},
	}
	for _, tc := range cases {
		t.Run(fmt.Sprintf("status_%d", tc.status), func(t *testing.T) {
			err := fmt.Errorf("envoltorio: %w", &qvapay.MutationError{Status: tc.status})
			if got := definitiveApplyRejection(err); got != tc.want {
				t.Fatalf("definitiveApplyRejection = %v, quiero %v", got, tc.want)
			}
		})
	}
	if definitiveApplyRejection(errors.New("red")) {
		t.Fatal("un error de red no es un rechazo definitivo")
	}
	if definitiveApplyRejection(nil) {
		t.Fatal("nil no es un rechazo")
	}
}

func TestDefinitiveEligibilityReason(t *testing.T) {
	cases := []struct {
		reason string
		want   bool
	}{
		{"no cumple los requisitos del anunciante", true},
		{"la oferta remota es solo VIP", true},
		{"la oferta remota es propia", true},
		{"la tasa cambió (1.1 != 1.2)", false},
		{"disponible remoto 0.5 < 1", false},
		{"lectura remota falló: timeout", false},
	}
	for _, tc := range cases {
		if got := definitiveEligibilityReason(tc.reason); got != tc.want {
			t.Fatalf("definitiveEligibilityReason(%q) = %v, quiero %v", tc.reason, got, tc.want)
		}
	}
}

func TestRequirementsBlockedEvitaAplicarYRelectura(t *testing.T) {
	now := time.Now()
	consumer := &hunterConsumer{
		rejected:            map[string]time.Time{},
		requirementsBlocked: map[string]time.Time{},
	}
	payload := hunterPayload{OfferUUID: "offer-1", Source: "stream", ObservedAt: now.UnixMilli()}
	if consumer.offerRequirementsBlocked("offer-1", now) {
		t.Fatal("no debería estar bloqueada")
	}
	if !consumer.canSkipRemoteRead(payload, now, time.Minute) {
		t.Fatal("el evento fresco debería permitir el camino rápido")
	}
	consumer.markRequirementsBlocked("offer-1")
	if !consumer.offerRequirementsBlocked("offer-1", now) {
		t.Fatal("la oferta debería estar bloqueada por requisitos")
	}
	if consumer.canSkipRemoteRead(payload, now, time.Minute) {
		t.Fatal("una oferta bloqueada no debe usar el camino rápido")
	}
	consumer.rejectedMu.Lock()
	consumer.requirementsBlocked["offer-1"] = now.Add(-time.Second)
	consumer.rejectedMu.Unlock()
	if consumer.offerRequirementsBlocked("offer-1", now) {
		t.Fatal("el bloqueo debería haber caducado")
	}
}
