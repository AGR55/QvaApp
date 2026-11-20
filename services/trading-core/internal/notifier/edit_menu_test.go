package notifier

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestEditMenuReemplazaMensajeYQuitaTeclado(t *testing.T) {
	var payload map[string]json.RawMessage
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/bottoken-secreto/editMessageText" {
			t.Errorf("path = %q", r.URL.Path)
		}
		body, _ := io.ReadAll(r.Body)
		if err := json.Unmarshal(body, &payload); err != nil {
			t.Fatal(err)
		}
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	t.Cleanup(server.Close)
	client := NewClient("token-secreto", server.URL)
	if err := client.EditMenu(context.Background(), "123", 77, "hola", nil); err != nil {
		t.Fatalf("EditMenu: %v", err)
	}
	if string(payload["message_id"]) != "77" || string(payload["text"]) != `"hola"` {
		t.Fatalf("payload = %s", mustMarshal(t, payload))
	}
	if string(payload["reply_markup"]) != `{"inline_keyboard":[]}` {
		t.Fatalf("reply_markup = %s", payload["reply_markup"])
	}
}

func TestEditMenuIgnoraMensajeSinCambios(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadRequest)
		_, _ = w.Write([]byte(`{"ok":false,"description":"Bad Request: message is not modified"}`))
	}))
	t.Cleanup(server.Close)
	client := NewClient("token", server.URL)
	if err := client.EditMenu(context.Background(), "123", 77, "hola", nil); err != nil {
		t.Fatalf("un mensaje sin cambios debe ser inocuo: %v", err)
	}
}

func TestParseUpdateConservaMessageID(t *testing.T) {
	raw := []byte(`{"update_id":1,"callback_query":{"id":"cb","from":{"id":7,"is_bot":false},"message":{"message_id":77,"chat":{"id":42}},"data":"nav:hunting"}}`)
	update, ok := ParseUpdate(raw)
	if !ok || update.MessageID != 77 || update.ChatID != 42 {
		t.Fatalf("update = %+v ok=%v", update, ok)
	}
}

func mustMarshal(t *testing.T, value any) []byte {
	t.Helper()
	payload, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return payload
}
