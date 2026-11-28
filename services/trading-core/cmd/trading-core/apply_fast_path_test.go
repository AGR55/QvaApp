package main

import (
	"context"
	"testing"
	"time"
)

func TestCanSkipRemoteReadSoloParaEventosFrescos(t *testing.T) {
	now := time.Now()
	window := 2 * time.Second
	consumer := &hunterConsumer{rejected: map[string]time.Time{}}
	cases := []struct {
		name     string
		source   string
		observed int64
		window   time.Duration
		want     bool
	}{
		{"evento de stream reciente", "stream", now.Add(-300 * time.Millisecond).UnixMilli(), window, true},
		{"evento de webhook reciente", "webhook", now.Add(-1900 * time.Millisecond).UnixMilli(), window, true},
		{"evento de polling reciente", "poll", now.Add(-200 * time.Millisecond).UnixMilli(), window, true},
		{"evento en cola", "stream", now.Add(-3 * time.Second).UnixMilli(), window, false},
		{"sin observedAt", "stream", 0, window, false},
		{"ventana desactivada", "stream", now.UnixMilli(), 0, false},
		{"reloj adelantado", "stream", now.Add(time.Second).UnixMilli(), window, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			payload := hunterPayload{OfferUUID: "offer-1", Source: tc.source, ObservedAt: tc.observed}
			if got := consumer.canSkipRemoteRead(payload, now, tc.window); got != tc.want {
				t.Fatalf("canSkipRemoteRead = %v, quiero %v", got, tc.want)
			}
		})
	}
}

func TestOfferRechazadaRecientementeFuerzaRelectura(t *testing.T) {
	now := time.Now()
	consumer := &hunterConsumer{rejected: map[string]time.Time{}}
	payload := hunterPayload{OfferUUID: "offer-1", Source: "stream", ObservedAt: now.UnixMilli()}
	if consumer.offerRecentlyRejected("offer-1", now) {
		t.Fatal("no debería estar rechazada todavía")
	}
	consumer.markOfferRejected("offer-1")
	if !consumer.offerRecentlyRejected("offer-1", now) {
		t.Fatal("la oferta debería estar en la caché de rechazos")
	}
	if consumer.canSkipRemoteRead(payload, now, time.Minute) {
		t.Fatal("una oferta rechazada no debe saltarse la relectura")
	}
	consumer.rejectedMu.Lock()
	consumer.rejected["offer-1"] = now.Add(-time.Second)
	consumer.rejectedMu.Unlock()
	if consumer.offerRecentlyRejected("offer-1", now) {
		t.Fatal("la caché debería haber caducado")
	}
}

func TestFastApplyWindowValidatesEnvironment(t *testing.T) {
	t.Setenv("CORE_FAST_APPLY_MS", "1500")
	if got := fastApplyWindow(); got != 1500*time.Millisecond {
		t.Fatalf("ventana = %s", got)
	}
	t.Setenv("CORE_FAST_APPLY_MS", "0")
	if got := fastApplyWindow(); got != 0 {
		t.Fatalf("ventana desactivada = %s", got)
	}
	t.Setenv("CORE_FAST_APPLY_MS", "invalido")
	if got := fastApplyWindow(); got != defaultFastApplyMS*time.Millisecond {
		t.Fatalf("ventana por defecto = %s", got)
	}
}

func TestControlFlagsCacheYLecturaFresca(t *testing.T) {
	consumer := &hunterConsumer{controlPaused: true, controlAt: time.Now()}
	paused, emergency, err := consumer.controlFlags(context.Background(), false)
	if err != nil || !paused || emergency {
		t.Fatalf("la copia cacheada debe usarse sin tocar la base: paused=%v emergency=%v err=%v", paused, emergency, err)
	}
}
