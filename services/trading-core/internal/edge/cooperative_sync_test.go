package edge

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
)

func TestCooperativeSyncRefreshPublishWithdraw(t *testing.T) {
	var mu sync.Mutex
	var published map[string]any
	var deleted string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		defer mu.Unlock()
		switch {
		case r.URL.Path == "/auth/login":
			writeJSON(w, http.StatusOK, map[string]any{"api_key": "csk_test"})
		case r.URL.Path == "/hunts/sync":
			writeJSON(w, http.StatusOK, map[string]any{"data": map[string]any{
				"CLASICA": map[string]any{"coin": "CLASICA", "fiat": 11.42, "price": 1.07, "minimal": 5, "offers_count": 1},
			}})
		case r.URL.Path == "/hunts" && r.Method == http.MethodGet:
			writeJSON(w, http.StatusOK, map[string]any{"data": []any{}})
		case r.URL.Path == "/hunts" && r.Method == http.MethodPost:
			body, _ := io.ReadAll(r.Body)
			if err := json.Unmarshal(body, &published); err != nil {
				t.Errorf("body de publicación inválido: %v", err)
			}
			w.WriteHeader(http.StatusNoContent)
		case r.URL.Path == "/hunts/CLASICA" && r.Method == http.MethodDelete:
			deleted = r.URL.Path
			w.WriteHeader(http.StatusNoContent)
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer server.Close()

	client := NewCooperativeSync(server.URL, "", "sync@example.com", "secret", true, nil)
	if err := client.Refresh(context.Background()); err != nil {
		t.Fatalf("Refresh: %v", err)
	}
	state := client.State()
	if state["httpConnected"] != true {
		t.Fatalf("httpConnected = %v", state["httpConnected"])
	}
	snapshot, _ := state["snapshot"].(map[string]any)
	if snapshot["CLASICA"] == nil {
		t.Fatalf("snapshot sin CLASICA: %#v", snapshot)
	}

	if err := client.Publish(context.Background(), "CLASICA", 11.426, 5, 1.07); err != nil {
		t.Fatalf("Publish: %v", err)
	}
	mu.Lock()
	body := published
	mu.Unlock()
	if body["coin"] != "CLASICA" || body["minimal"] != float64(5) || body["price"] != 1.07 {
		t.Fatalf("publicación = %#v", body)
	}
	if body["fiat"] != 11.42 {
		t.Fatalf("fiat = %v, quiero 11.42 (redondeo a la baja)", body["fiat"])
	}
	if err := client.Withdraw(context.Background(), "CLASICA"); err != nil {
		t.Fatalf("Withdraw: %v", err)
	}
	mu.Lock()
	path := deleted
	mu.Unlock()
	if path != "/hunts/CLASICA" {
		t.Fatalf("retirada = %q", path)
	}
}

func TestCooperativeSyncRejectsSmallCapacity(t *testing.T) {
	client := NewCooperativeSync("http://127.0.0.1:1", "", "sync@example.com", "secret", true, nil)
	if err := client.Publish(context.Background(), "CLASICA", 5, 5, 1.1); err == nil {
		t.Fatal("se esperaba error cuando el fiat equivale a menos de 5 QUSD")
	}
}
