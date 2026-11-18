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

	"github.com/AGR55/QvaApp/services/trading-core/internal/notifier"
)

func newRateTestRuntime(t *testing.T) (*telegramRuntime, *[]map[string]any, *[]map[string]any) {
	t.Helper()
	var mu sync.Mutex
	huntingBodies := []map[string]any{}
	telegramBodies := []map[string]any{}
	edgeServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/session":
			writeTestJSON(w, map[string]any{"data": map[string]any{"csrfToken": "csrf"}})
		case "/api/dashboard":
			writeTestJSON(w, map[string]any{"data": map[string]any{"averages": map[string]any{}}})
		case "/api/config":
			writeTestJSON(w, map[string]any{"data": map[string]any{
				"hunting": map[string]any{"buyRunning": true, "sellRunning": true},
				"markets": []any{map[string]any{
					"code": "CLASICA", "label": "Clásica", "currency": "USD",
					"active": true, "huntBuyEnabled": true, "huntSellEnabled": true,
					"buyMaxRate": 1.07, "sellMinRate": 1.09, "fiatBalance": 100.0,
					"purchaseMaxQusd": 50.0, "sellFeePercent": 0.0,
				}},
			}})
		case "/api/hunting":
			var body map[string]any
			_ = json.NewDecoder(r.Body).Decode(&body)
			mu.Lock()
			huntingBodies = append(huntingBodies, body)
			mu.Unlock()
			w.WriteHeader(http.StatusNoContent)
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	t.Cleanup(edgeServer.Close)
	telegramServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		mu.Lock()
		telegramBodies = append(telegramBodies, body)
		mu.Unlock()
		writeTestJSON(w, map[string]any{"ok": true, "result": map[string]any{}})
	}))
	t.Cleanup(telegramServer.Close)
	runtime := &telegramRuntime{
		edge:        newEdgeClient(edgeServer.URL, "https://panel.example", "secret"),
		client:      notifier.NewClient("token", telegramServer.URL),
		adminChatID: 123,
		logger:      slog.New(slog.NewTextHandler(io.Discard, nil)),
	}
	return runtime, &huntingBodies, &telegramBodies
}

func TestRateEditFlowUsesSameMessageAndUpdatesHunting(t *testing.T) {
	runtime, huntingBodies, telegramBodies := newRateTestRuntime(t)
	ctx := context.Background()

	prompt, handled := runtime.handle(ctx, notifier.Update{
		ChatID: 123, MessageID: 77, CallbackData: "hunt:e:buy:CLASICA",
	})
	if !handled || !strings.Contains(prompt, "Valor actual: 1.07") {
		t.Fatalf("prompt inesperado: %q handled=%v", prompt, handled)
	}
	if !strings.Contains(string(mustJSON(t, runtime.rateMessageIDs)), "123") {
		t.Fatal("no se guardó el mensaje del panel")
	}

	handled, confirmation := runtime.handleRateText(ctx, "123", "1,25")
	if !handled || !strings.Contains(confirmation, "Nueva: 1.25") {
		t.Fatalf("confirmación = %q handled=%v", confirmation, handled)
	}
	runtime.rateMu.Lock()
	session, ok := runtime.rates.Current("123")
	runtime.rateMu.Unlock()
	if !ok || session.Token == "" {
		t.Fatal("no hay sesión de tasa pendiente")
	}
	panel, _ := runtime.confirmRate(ctx, "123", session.Token)
	if !strings.Contains(panel, "✅ Máximo de compra actualizada a 1.25.") {
		t.Fatalf("panel final = %q", panel)
	}
	if len(*huntingBodies) != 1 {
		t.Fatalf("actualizaciones = %d", len(*huntingBodies))
	}
	market := (*huntingBodies)[0]["market"].(map[string]any)
	if market["code"] != "CLASICA" || market["buyMaxRate"] != 1.25 {
		t.Fatalf("market = %#v", market)
	}
	if len(*telegramBodies) != 2 {
		t.Fatalf("mensajes Telegram = %d", len(*telegramBodies))
	}
	for _, body := range *telegramBodies {
		if body["message_id"] != float64(77) {
			t.Fatalf("no se editó el mensaje original: %#v", body)
		}
	}
}

func TestCallbackNavEditaElMensajeActual(t *testing.T) {
	runtime, _, telegramBodies := newRateTestRuntime(t)
	reply, handled := runtime.handle(context.Background(), notifier.Update{
		ChatID: 123, MessageID: 77, CallbackData: "nav:hunting",
	})
	if !handled || !strings.Contains(reply, "Cacerías automáticas") {
		t.Fatalf("reply=%q handled=%v", reply, handled)
	}
	if len(*telegramBodies) != 1 {
		t.Fatalf("mensajes Telegram = %d", len(*telegramBodies))
	}
	body := (*telegramBodies)[0]
	if body["message_id"] != float64(77) || body["text"] == "" {
		t.Fatalf("edit inesperado: %#v", body)
	}
}

func mustJSON(t *testing.T, value any) []byte {
	t.Helper()
	payload, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return payload
}
