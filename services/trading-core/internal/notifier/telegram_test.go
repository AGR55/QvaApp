package notifier

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestSendMessage(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/bottoken-secreto/sendMessage" {
			http.NotFound(w, r)
			return
		}
		if r.Header.Get("Content-Type") != "application/json" {
			t.Fatal("Content-Type inesperado")
		}
		var body map[string]any
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Fatal(err)
		}
		if body["chat_id"] != "123" || body["text"] != "hola" {
			t.Fatalf("body inesperado: %+v", body)
		}
		fmt.Fprint(w, `{"ok":true}`)
	}))
	t.Cleanup(server.Close)
	client := NewClient("token-secreto", server.URL)
	if err := client.SendMessage(context.Background(), "123", "hola"); err != nil {
		t.Fatal(err)
	}
}

func TestSendMessageAPIErrorDoesNotLeakToken(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
		fmt.Fprint(w, `{"ok":false,"description":"Unauthorized"}`)
	}))
	t.Cleanup(server.Close)
	client := NewClient("token-secreto", server.URL)
	err := client.SendMessage(context.Background(), "123", "hola")
	if err == nil {
		t.Fatal("se esperaba error")
	}
	if strings.Contains(err.Error(), "token-secreto") {
		t.Fatalf("el error filtra el token: %v", err)
	}
}

func TestDeduper(t *testing.T) {
	deduper := NewDeduper(time.Minute)
	now := time.Unix(100, 0)
	deduper.now = func() time.Time { return now }
	if deduper.Seen("a") {
		t.Fatal("primera notificación duplicada")
	}
	if !deduper.Seen("a") {
		t.Fatal("segunda notificación no deduplicada")
	}
	now = now.Add(2 * time.Minute)
	if deduper.Seen("a") {
		t.Fatal("TTL no expiró")
	}
}
