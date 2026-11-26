package main

import (
	"testing"
	"time"
)

func TestCanSkipRemoteReadSoloParaEventosFrescos(t *testing.T) {
	now := time.Now()
	window := 2 * time.Second
	cases := []struct {
		name     string
		source   string
		observed int64
		window   time.Duration
		want     bool
	}{
		{"evento de stream reciente", "stream", now.Add(-300 * time.Millisecond).UnixMilli(), window, true},
		{"evento de webhook reciente", "webhook", now.Add(-1900 * time.Millisecond).UnixMilli(), window, true},
		{"evento en cola", "stream", now.Add(-3 * time.Second).UnixMilli(), window, false},
		{"evento de polling", "poll", now.UnixMilli(), window, false},
		{"sin observedAt", "stream", 0, window, false},
		{"ventana desactivada", "stream", now.UnixMilli(), 0, false},
		{"reloj adelantado", "stream", now.Add(time.Second).UnixMilli(), window, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			payload := hunterPayload{Source: tc.source, ObservedAt: tc.observed}
			if got := canSkipRemoteRead(payload, now, tc.window); got != tc.want {
				t.Fatalf("canSkipRemoteRead = %v, quiero %v", got, tc.want)
			}
		})
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
