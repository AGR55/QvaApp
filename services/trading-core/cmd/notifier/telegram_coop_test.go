package main

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/AGR55/QvaApp/services/trading-core/internal/notifier"
)

func TestTelegramCooperativePublishFlow(t *testing.T) {
	var mu sync.Mutex
	var published map[string]any
	var deleted string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/api/session":
			writeTestJSON(w, map[string]any{"data": map[string]any{"csrfToken": "csrf-token"}})
		case r.URL.Path == "/api/dashboard":
			mu.Lock()
			contributions := map[string]any{}
			if published != nil {
				contributions["CLASICA"] = map[string]any{
					"coin": "CLASICA", "minimal": published["minimal"], "price": 1.1,
				}
			}
			mu.Unlock()
			writeTestJSON(w, map[string]any{"data": map[string]any{
				"cooperativeNetwork": map[string]any{
					"enabled": true, "httpConnected": true, "natsConnected": false,
					"snapshot": map[string]any{}, "contributions": contributions,
				},
			}})
		case r.URL.Path == "/api/config":
			writeTestJSON(w, map[string]any{"data": map[string]any{
				"markets": []any{map[string]any{
					"code": "CLASICA", "label": "Clásica", "currency": "CUP",
					"active": true, "buyMaxRate": 1.1, "fiatBalance": 50.0,
				}},
			}})
		case r.URL.Path == "/api/cooperative-network/contributions" && r.Method == http.MethodPut:
			body, _ := io.ReadAll(r.Body)
			mu.Lock()
			published = map[string]any{}
			_ = json.Unmarshal(body, &published)
			mu.Unlock()
			w.WriteHeader(http.StatusNoContent)
		case strings.HasPrefix(r.URL.Path, "/api/cooperative-network/contributions/") && r.Method == http.MethodDelete:
			mu.Lock()
			deleted = strings.TrimPrefix(r.URL.Path, "/api/cooperative-network/contributions/")
			mu.Unlock()
			w.WriteHeader(http.StatusNoContent)
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer server.Close()

	runtime := &telegramRuntime{
		edge:   newEdgeClient(server.URL, "https://panel.example", "secret"),
		logger: slog.New(slog.NewTextHandler(io.Discard, nil)),
	}
	ctx := context.Background()

	panel, panelKeyboard := runtime.cooperativePanel(ctx)
	if !strings.Contains(panel, "Cacerías conjuntas") || !strings.Contains(panel, "Precio de compra") ||
		!strings.Contains(panel, "Fiat disponible") {
		t.Fatalf("panel cooperativo incompleto: %q", panel)
	}
	if !hasCallback(panelKeyboard, "coop:publish:CLASICA") {
		t.Fatalf("panel sin botón de publicar: %#v", panelKeyboard)
	}

	reply, keyboard := runtime.handleCallback(ctx, "123", "coop:publish:CLASICA", 10)
	if !strings.Contains(reply, "Escribe solo la cantidad mínima") {
		t.Fatalf("respuesta de publicar = %q", reply)
	}
	if len(keyboard) == 0 {
		t.Fatal("faltó el botón de cancelar")
	}

	reply, _, handled := runtime.consumePendingMinimal(ctx, "5")
	if !handled {
		t.Fatal("el mínimo no se procesó")
	}
	if !strings.Contains(reply, "✅ Publicado") {
		t.Fatalf("respuesta tras mínimo = %q", reply)
	}
	mu.Lock()
	body := published
	mu.Unlock()
	if body["coin"] != "CLASICA" || body["minimal"] != float64(5) {
		t.Fatalf("publicación = %#v", body)
	}
	if _, ok := body["price"]; ok {
		t.Fatalf("la web no debe enviar precio: %#v", body)
	}
	panel, panelKeyboard = runtime.cooperativePanel(ctx)
	if !hasCallback(panelKeyboard, "coop:withdraw:CLASICA") {
		t.Fatalf("panel sin botón de retirar: %#v", panelKeyboard)
	}
	if !strings.Contains(panel, "Publicado desde") {
		t.Fatalf("el panel no refleja la publicación: %q", panel)
	}

	reply, _ = runtime.handleCallback(ctx, "123", "coop:withdraw:CLASICA", 10)
	if !strings.Contains(reply, "✅ Retirado") {
		t.Fatalf("respuesta de retirar = %q", reply)
	}
	mu.Lock()
	got := deleted
	mu.Unlock()
	if got != "CLASICA" {
		t.Fatalf("retirada = %q", got)
	}
}

func TestTelegramCooperativeRejectsInvalidMinimum(t *testing.T) {
	runtime := &telegramRuntime{logger: slog.New(slog.NewTextHandler(io.Discard, nil))}
	runtime.pendingCoin = "CLASICA"
	runtime.pendingAt = time.Now()
	reply, _, handled := runtime.consumePendingMinimal(context.Background(), "abc")
	if !handled || !strings.Contains(reply, "inválida") {
		t.Fatalf("respuesta = %q handled=%v", reply, handled)
	}
	if runtime.pendingCoin != "CLASICA" {
		t.Fatal("el mínimo pendiente no debe borrarse con un valor inválido")
	}
}

func writeTestJSON(w http.ResponseWriter, value any) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(value)
}

func hasCallback(keyboard notifier.InlineKeyboard, data string) bool {
	for _, row := range keyboard {
		for _, button := range row {
			if button.CallbackData == data {
				return true
			}
		}
	}
	return false
}
