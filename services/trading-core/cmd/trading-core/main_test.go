package main

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/AGR55/QvaApp/services/trading-core/internal/platform/shadow"
)

func testConfig() config {
	return config{
		Port:        "8090",
		ShadowMode:  true,
		ServiceName: "trading-core",
	}
}

func TestHealthz(t *testing.T) {
	handler := newHandler(testConfig(), nil, nil)
	recorder := httptest.NewRecorder()

	handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/healthz", nil))

	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, quiero %d", recorder.Code, http.StatusOK)
	}
	if got := recorder.Header().Get("Content-Type"); !strings.HasPrefix(got, "application/json") {
		t.Fatalf("Content-Type = %q", got)
	}

	var body map[string]string
	if err := json.Unmarshal(recorder.Body.Bytes(), &body); err != nil {
		t.Fatalf("JSON inválido: %v", err)
	}
	if body["status"] != "ok" {
		t.Fatalf("status = %q, quiero ok", body["status"])
	}
}

func TestReadyzSinBaseDeDatos(t *testing.T) {
	handler := newHandler(testConfig(), nil, nil)
	recorder := httptest.NewRecorder()

	handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/readyz", nil))

	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, quiero %d", recorder.Code, http.StatusOK)
	}

	var body map[string]string
	if err := json.Unmarshal(recorder.Body.Bytes(), &body); err != nil {
		t.Fatalf("JSON inválido: %v", err)
	}
	if body["status"] != "ok" {
		t.Fatalf("status = %q, quiero ok", body["status"])
	}
}

func TestReadyzConFalloDeBaseDeDatos(t *testing.T) {
	readyCheck := func(context.Context) error {
		return errors.New("ping fallido")
	}
	handler := newHandler(testConfig(), readyCheck, nil)
	recorder := httptest.NewRecorder()

	handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/readyz", nil))

	if recorder.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, quiero %d", recorder.Code, http.StatusServiceUnavailable)
	}

	var body map[string]string
	if err := json.Unmarshal(recorder.Body.Bytes(), &body); err != nil {
		t.Fatalf("JSON inválido: %v", err)
	}
	if body["status"] != "not_ready" {
		t.Fatalf("status = %q, quiero not_ready", body["status"])
	}
	if body["error"] != "ping fallido" {
		t.Fatalf("error = %q", body["error"])
	}
}

func TestMetrics(t *testing.T) {
	tests := []struct {
		name       string
		shadowMode bool
		want       string
	}{
		{name: "shadow activo", shadowMode: true, want: "trading_core_shadow_mode 1\n"},
		{name: "shadow inactivo", shadowMode: false, want: "trading_core_shadow_mode 0\n"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			cfg := testConfig()
			cfg.ShadowMode = tt.shadowMode
			handler := newHandler(cfg, nil, nil)
			recorder := httptest.NewRecorder()

			handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/metrics", nil))

			if recorder.Code != http.StatusOK {
				t.Fatalf("status = %d, quiero %d", recorder.Code, http.StatusOK)
			}
			if got := recorder.Header().Get("Content-Type"); !strings.HasPrefix(got, "text/plain") {
				t.Fatalf("Content-Type = %q", got)
			}

			body := recorder.Body.String()
			for _, want := range []string{
				"trading_core_up 1\n",
				tt.want,
				"trading_core_http_requests_total 1\n",
			} {
				if !strings.Contains(body, want) {
					t.Fatalf("métrica ausente %q en:\n%s", want, body)
				}
			}
		})
	}
}

func TestNotFound(t *testing.T) {
	handler := newHandler(testConfig(), nil, nil)

	for _, path := range []string{"/", "/desconocido"} {
		t.Run(path, func(t *testing.T) {
			recorder := httptest.NewRecorder()
			handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, path, nil))

			if recorder.Code != http.StatusNotFound {
				t.Fatalf("status = %d, quiero %d", recorder.Code, http.StatusNotFound)
			}
			if got := recorder.Header().Get("Content-Type"); !strings.HasPrefix(got, "application/json") {
				t.Fatalf("Content-Type = %q", got)
			}

			var body map[string]string
			if err := json.Unmarshal(recorder.Body.Bytes(), &body); err != nil {
				t.Fatalf("JSON inválido: %v", err)
			}
			if body["status"] != "not_found" {
				t.Fatalf("status = %q, quiero not_found", body["status"])
			}
		})
	}
}

func TestMetricsShadowStats(t *testing.T) {
	stats := func(context.Context) (shadow.Stats, error) {
		return shadow.Stats{
			Runs: 3, Decisions: 19, Mismatches: 2, LastRunAt: 1234,
			InvariantViolations: 1, LastInvariantAt: 5678, LastQvaPayAt: 9012,
		}, nil
	}
	handler := newHandler(testConfig(), nil, stats)
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/metrics", nil))
	body := recorder.Body.String()
	for _, expected := range []string{
		"trading_core_shadow_runs_total 3",
		"trading_core_shadow_decisions_total 19",
		"trading_core_shadow_mismatches_total 2",
		"trading_core_shadow_last_run_timestamp_seconds 1234",
		"trading_core_shadow_invariant_violations_total 1",
		"trading_core_shadow_last_invariant_timestamp_seconds 5678",
		"trading_core_shadow_last_qvapay_timestamp_seconds 9012",
		"trading_core_shadow_stats_error 0",
	} {
		if !strings.Contains(body, expected) {
			t.Fatalf("métricas sin %q:\n%s", expected, body)
		}
	}
}

func TestMetricsShadowStatsError(t *testing.T) {
	stats := func(context.Context) (shadow.Stats, error) {
		return shadow.Stats{}, errors.New("db caída")
	}
	handler := newHandler(testConfig(), nil, stats)
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/metrics", nil))
	if !strings.Contains(recorder.Body.String(), "trading_core_shadow_stats_error 1") {
		t.Fatalf("no se expuso el error de métricas: %s", recorder.Body.String())
	}
}
