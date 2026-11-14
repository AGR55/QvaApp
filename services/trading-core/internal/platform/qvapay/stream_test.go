package qvapay

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestStreamReceivesEvents(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v2/p2p/stream" {
			http.NotFound(w, r)
			return
		}
		if r.Header.Get("app-id") != "app" || r.Header.Get("app-secret") != "secret" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		if r.Header.Get("Accept") != "text/event-stream" {
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		w.Header().Set("Content-Type", "text/event-stream")
		flusher, ok := w.(http.Flusher)
		if !ok {
			t.Fatal("servidor sin flusher")
		}
		fmt.Fprint(w, "event: init\ndata: {\"expires_at\":\"2026-11-15T00:00:00Z\"}\n\n")
		fmt.Fprint(w, "event: p2p.created\ndata: {\"event\":\"p2p.created\",\"data\":{\"uuid\":\"offer-1\"}}\n\n")
		flusher.Flush()
		<-r.Context().Done()
	}))
	t.Cleanup(server.Close)

	stream := NewStream()
	stream.URL = server.URL + "/v2/p2p/stream"
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	events := make(chan StreamEvent, 1)
	err := stream.Run(ctx, StreamCredentials{AppID: "app", AppSecret: "secret"}, func(event StreamEvent) {
		events <- event
		cancel()
	}, nil)
	if err == nil {
		t.Fatal("Run debía terminar al cancelar")
	}
	select {
	case event := <-events:
		if event.Event != "p2p.created" || !strings.Contains(string(event.Data), "offer-1") {
			t.Fatalf("evento inesperado: %+v", event)
		}
	case <-time.After(time.Second):
		t.Fatal("no llegó el evento SSE")
	}
}

func TestStreamRejectsUnauthorized(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
		fmt.Fprint(w, "no autorizado")
	}))
	t.Cleanup(server.Close)

	stream := NewStream()
	stream.URL = server.URL
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	err := stream.Run(ctx, StreamCredentials{AppID: "app", AppSecret: "secret"}, nil, nil)
	if err == nil {
		t.Fatal("se esperaba error")
	}
}

func TestParseSSEMultiline(t *testing.T) {
	event, data, retry := parseSSEBlock("event: p2p.created\ndata: {\"a\":\ndata: 1}\nretry: 1500\n")
	if event != "p2p.created" || string(data) != "{\"a\":\n1}" || retry != 1500 {
		t.Fatalf("parse inesperado: %q %q %d", event, data, retry)
	}
}
