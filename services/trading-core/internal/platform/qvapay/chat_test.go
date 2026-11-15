package qvapay

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

const chatOfferUUID = "7c9e6679-7425-40de-944b-e07fc1f90ae7"

func TestChatListAndSend(t *testing.T) {
	var lastMethod, lastQuery, lastBody string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		lastMethod = r.Method
		lastQuery = r.URL.RawQuery
		body, _ := io.ReadAll(r.Body)
		lastBody = string(body)
		if r.URL.Path != "/p2p/"+chatOfferUUID+"/chat" {
			t.Errorf("ruta = %q", r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		if r.Method == http.MethodGet {
			io.WriteString(w, `{"messages":[{"id":"m1","peer_id":"p1","message":"hola","created_at":1790000000000}]}`)
			return
		}
		io.WriteString(w, `{"message":{"id":"m2","created_at":"2026-11-15T10:00:00Z"}}`)
	}))
	defer server.Close()

	client, err := NewChatClient(server.URL, "token")
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	messages, err := client.Chat(context.Background(), chatOfferUUID, "")
	if err != nil || len(messages) != 1 || messages[0].Message != "hola" {
		t.Fatalf("Chat = %+v, %v", messages, err)
	}
	if lastMethod != http.MethodGet {
		t.Fatalf("método = %s", lastMethod)
	}

	sent, err := client.SendChat(context.Background(), chatOfferUUID, "", "respuesta")
	if err != nil || sent.ID != "m2" {
		t.Fatalf("SendChat = %+v, %v", sent, err)
	}
	if lastMethod != http.MethodPost || !strings.Contains(lastBody, `"message":"respuesta"`) {
		t.Fatalf("envío = %s %s", lastMethod, lastBody)
	}
	if lastQuery != "" {
		t.Fatalf("query = %q", lastQuery)
	}
}

func TestChatRejectsInvalidUUIDAndMessage(t *testing.T) {
	client, _ := NewChatClient("https://api.qvapay.test", "token")
	if _, err := client.Chat(context.Background(), "bad", ""); err == nil {
		t.Fatal("UUID inválido aceptado")
	}
	if _, err := client.SendChat(context.Background(), chatOfferUUID, "", ""); err == nil {
		t.Fatal("mensaje vacío aceptado")
	}
}
