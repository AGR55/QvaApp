package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestEdgeClientLoginCookieAndCSRF(t *testing.T) {
	var sawCookie, sawCSRF, sawOrigin bool
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Origin") == "https://panel.example" {
			sawOrigin = true
		}
		switch r.URL.Path {
		case "/api/session":
			http.SetCookie(w, &http.Cookie{Name: "edge_session", Value: "cookie-1", Path: "/"})
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{"data": map[string]string{"csrfToken": "csrf-1"}})
		case "/api/config":
			if cookie, err := r.Cookie("edge_session"); err == nil && cookie.Value == "cookie-1" {
				sawCookie = true
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"data": map[string]any{"markets": []any{}}})
		case "/api/control":
			if r.Header.Get("X-CSRF-Token") == "csrf-1" {
				sawCSRF = true
			}
			w.WriteHeader(http.StatusNoContent)
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	client := newEdgeClient(server.URL, "https://panel.example", "pw")
	config, err := client.config(context.Background())
	if err != nil {
		t.Fatalf("config: %v", err)
	}
	if config["markets"] == nil {
		t.Fatalf("config = %+v", config)
	}
	if err := client.send(context.Background(), http.MethodPut, "/api/control", map[string]any{"paused": true}); err != nil {
		t.Fatalf("send: %v", err)
	}
	if !sawCookie || !sawCSRF || !sawOrigin {
		t.Fatalf("cookie=%v csrf=%v origin=%v", sawCookie, sawCSRF, sawOrigin)
	}
}
