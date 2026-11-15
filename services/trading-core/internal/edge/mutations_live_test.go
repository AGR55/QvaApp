package edge

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"testing"
)

type fakeLiveMutations struct {
	created  map[string]any
	edits    []map[string]any
	cancels  []string
	paids    []string
	received []string
	err      error
}

func (live *fakeLiveMutations) CreateOffer(_ context.Context, payload map[string]any) (map[string]any, error) {
	if live.err != nil {
		return nil, live.err
	}
	live.created = payload
	return map[string]any{"uuid": "remote-offer-1"}, nil
}

func (live *fakeLiveMutations) EditOffer(_ context.Context, _ string, payload map[string]any) error {
	live.edits = append(live.edits, payload)
	return live.err
}

func (live *fakeLiveMutations) CancelOffer(_ context.Context, uuid, _ string) error {
	live.cancels = append(live.cancels, uuid)
	return live.err
}

func (live *fakeLiveMutations) MarkPaid(_ context.Context, uuid, _, txID string) error {
	live.paids = append(live.paids, uuid+":"+txID)
	return live.err
}

func (live *fakeLiveMutations) ConfirmReceived(_ context.Context, uuid, _ string) error {
	live.received = append(live.received, uuid)
	return live.err
}

func TestMutationsAPILiveOfferAndOperation(t *testing.T) {
	api, store, cookie, csrf, _ := newMutationsTestAPI(t)
	live := &fakeLiveMutations{}
	api.Live = live

	create := mutationsTestDo(api, mutationsTestCall{
		method: http.MethodPost, target: "/api/offers",
		body: `{"coin":"CLASICA","type":"sell","amount":10,"rate":1.1}`, cookie: cookie,
		csrf: csrf, origin: "https://panel.example",
	})
	if create.Code != http.StatusCreated {
		t.Fatalf("create: %d %s", create.Code, create.Body.String())
	}
	if live.created == nil || live.created["idempotency_key"] == "" {
		t.Fatalf("payload live = %+v", live.created)
	}
	if len(store.records) == 0 || store.records[len(store.records)-1].action != "offer_created" {
		t.Fatalf("registros = %+v", store.records)
	}

	update := mutationsTestDo(api, mutationsTestCall{
		method: http.MethodPut, target: "/api/offers/offer-1",
		body: `{"amount":8}`, cookie: cookie, csrf: csrf, origin: "https://panel.example",
	})
	if update.Code != http.StatusNoContent || len(live.edits) != 1 {
		t.Fatalf("update: %d %+v", update.Code, live.edits)
	}

	cancel := mutationsTestDo(api, mutationsTestCall{
		method: http.MethodDelete, target: "/api/offers/offer-1", body: `{}`,
		cookie: cookie, csrf: csrf, origin: "https://panel.example",
	})
	if cancel.Code != http.StatusNoContent || len(live.cancels) != 1 {
		t.Fatalf("cancel: %d %+v", cancel.Code, live.cancels)
	}

	paid := mutationsTestDo(api, mutationsTestCall{
		method: http.MethodPost, target: "/api/operations/op-1/paid?order=order-1",
		body: `{"reference":"tx-1"}`, cookie: cookie, csrf: csrf, origin: "https://panel.example",
	})
	if paid.Code != http.StatusNoContent || len(live.paids) != 1 || live.paids[0] != "op-1:tx-1" {
		t.Fatalf("paid: %d %+v", paid.Code, live.paids)
	}

	received := mutationsTestDo(api, mutationsTestCall{
		method: http.MethodPost, target: "/api/operations/op-1/received",
		body: `{}`, cookie: cookie, csrf: csrf, origin: "https://panel.example",
	})
	if received.Code != http.StatusNoContent || len(live.received) != 1 {
		t.Fatalf("received: %d %+v", received.Code, live.received)
	}
}

func TestMutationsAPILiveFailure(t *testing.T) {
	api, store, cookie, csrf, _ := newMutationsTestAPI(t)
	api.Live = &fakeLiveMutations{err: errors.New("rechazada")}

	recorder := mutationsTestDo(api, mutationsTestCall{
		method: http.MethodPost, target: "/api/offers",
		body: `{"coin":"CLASICA","type":"sell","amount":10,"rate":1.1}`, cookie: cookie,
		csrf: csrf, origin: "https://panel.example",
	})
	if recorder.Code != http.StatusBadGateway {
		t.Fatalf("status = %d (cuerpo %q)", recorder.Code, recorder.Body.String())
	}
	found := false
	for _, record := range store.records {
		if record.action == "offer_create_failed" {
			found = true
		}
	}
	if !found {
		t.Fatal("no se registró el fallo de la mutación")
	}
}

type fakeLiveChat struct {
	sent []string
}

func (live *fakeLiveChat) ListChat(context.Context, string, string) ([]ChatMessage, error) {
	return []ChatMessage{{ID: "m1", Message: "hola", Direction: "in"}}, nil
}

func (live *fakeLiveChat) SendChat(_ context.Context, operationUUID, order, text string) (ChatMessage, error) {
	live.sent = append(live.sent, text)
	return ChatMessage{ID: "m2", OperationUUID: operationUUID, OrderUUID: order, Message: text, Direction: "out"}, nil
}

func TestMutationsAPILiveChat(t *testing.T) {
	api, _, cookie, csrf, _ := newMutationsTestAPI(t)
	chat := &fakeLiveChat{}
	api.Chat = chat

	get := mutationsTestDo(api, mutationsTestCall{method: http.MethodGet, target: "/api/operations/op-1/chat", cookie: cookie})
	if get.Code != http.StatusOK || !strings.Contains(get.Body.String(), "hola") {
		t.Fatalf("chat get: %d %s", get.Code, get.Body.String())
	}
	post := mutationsTestDo(api, mutationsTestCall{
		method: http.MethodPost, target: "/api/operations/op-1/chat",
		body: `{"message":"respuesta"}`, cookie: cookie, csrf: csrf, origin: "https://panel.example",
	})
	if post.Code != http.StatusCreated || len(chat.sent) != 1 || chat.sent[0] != "respuesta" {
		t.Fatalf("chat post: %d %+v %s", post.Code, chat.sent, post.Body.String())
	}
}
