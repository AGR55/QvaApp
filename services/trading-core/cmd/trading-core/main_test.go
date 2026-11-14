package main

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func testConfig() config {
	return config{
		Port:        "8090",
		ShadowMode:  true,
		ServiceName: "trading-core",
	}
}

func TestHealthz(t *testing.T) {
	handler := newHandler(testConfig(), nil)
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
	handler := newHandler(testConfig(), nil)
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
	handler := newHandler(testConfig(), readyCheck)
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
			handler := newHandler(cfg, nil)
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
	handler := newHandler(testConfig(), nil)

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
