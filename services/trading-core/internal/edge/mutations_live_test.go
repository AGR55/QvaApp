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

type fakeOperationStore struct {
	record OperationRecord
	found  bool
	state  string
}

func (store *fakeOperationStore) Get(context.Context, string) (OperationRecord, bool, error) {
	if !store.found {
		return OperationRecord{}, false, nil
	}
	return store.record, true, nil
}

func (store *fakeOperationStore) SetState(_ context.Context, _ string, state string, _ int64) error {
	store.state = state
	return nil
}

type fakeFiatMover struct {
	debits    []string
	credits   []string
	reversals []string
}

func (mover *fakeFiatMover) DebitOperation(_ context.Context, operation OperationRecord, key, _ string, _ int64) error {
	mover.debits = append(mover.debits, operation.UUID+":"+key)
	return nil
}

func (mover *fakeFiatMover) CreditOperation(_ context.Context, operation OperationRecord, key, _ string, _ int64) error {
	mover.credits = append(mover.credits, operation.UUID+":"+key)
	return nil
}

func (mover *fakeFiatMover) ReverseOperation(_ context.Context, operation OperationRecord, key, _ string, _ int64) error {
	mover.reversals = append(mover.reversals, operation.UUID+":"+key)
	return nil
}

func TestMutationsAPIPaidRecordsFiat(t *testing.T) {
	api, _, cookie, csrf, _ := newMutationsTestAPI(t)
	live := &fakeLiveMutations{}
	operations := &fakeOperationStore{found: true, record: OperationRecord{
		UUID: "op-1", OfferType: "sell", Coin: "CLASICA", State: "applied",
		OrderUUID: "order-1", Amount: 10, Receive: 10.6,
	}}
	fiat := &fakeFiatMover{}
	api.Live, api.Operations, api.Fiat = live, operations, fiat

	recorder := mutationsTestDo(api, mutationsTestCall{
		method: http.MethodPost, target: "/api/operations/op-1/paid?order=order-1",
		body: `{"reference":"tx-1"}`, cookie: cookie, csrf: csrf, origin: "https://panel.example",
	})
	if recorder.Code != http.StatusNoContent {
		t.Fatalf("paid: %d %s", recorder.Code, recorder.Body.String())
	}
	if operations.state != "paid" || len(fiat.debits) != 1 || fiat.debits[0] != "op-1:order-1" {
		t.Fatalf("state=%q debits=%+v", operations.state, fiat.debits)
	}
}

func TestMutationsAPIReceivedRecordsCredit(t *testing.T) {
	api, _, cookie, csrf, _ := newMutationsTestAPI(t)
	api.Live = &fakeLiveMutations{}
	operations := &fakeOperationStore{found: true, record: OperationRecord{
		UUID: "op-1", OfferType: "buy", Coin: "CLASICA", State: "applied",
		OrderUUID: "order-1", Amount: 10, Receive: 11,
	}}
	fiat := &fakeFiatMover{}
	api.Operations, api.Fiat = operations, fiat

	recorder := mutationsTestDo(api, mutationsTestCall{
		method: http.MethodPost, target: "/api/operations/op-1/received",
		body: `{}`, cookie: cookie, csrf: csrf, origin: "https://panel.example",
	})
	if recorder.Code != http.StatusNoContent {
		t.Fatalf("received: %d %s", recorder.Code, recorder.Body.String())
	}
	if operations.state != "completed" || len(fiat.credits) != 1 {
		t.Fatalf("state=%q credits=%+v", operations.state, fiat.credits)
	}
}

func TestMutationsAPICancelAfterPaidReverses(t *testing.T) {
	api, _, cookie, csrf, _ := newMutationsTestAPI(t)
	api.Live = &fakeLiveMutations{}
	operations := &fakeOperationStore{found: true, record: OperationRecord{
		UUID: "op-1", OfferType: "sell", Coin: "CLASICA", State: "paid",
		OrderUUID: "order-1", Amount: 10, Receive: 10.6,
	}}
	fiat := &fakeFiatMover{}
	api.Operations, api.Fiat = operations, fiat

	recorder := mutationsTestDo(api, mutationsTestCall{
		method: http.MethodPost, target: "/api/operations/op-1/cancel",
		body: `{}`, cookie: cookie, csrf: csrf, origin: "https://panel.example",
	})
	if recorder.Code != http.StatusNoContent {
		t.Fatalf("cancel: %d %s", recorder.Code, recorder.Body.String())
	}
	if operations.state != "cancelled" || len(fiat.reversals) != 1 {
		t.Fatalf("state=%q reversals=%+v", operations.state, fiat.reversals)
	}
}

func TestMutationsAPIPaidRejectsBuyOperation(t *testing.T) {
	api, _, cookie, csrf, _ := newMutationsTestAPI(t)
	live := &fakeLiveMutations{}
	operations := &fakeOperationStore{found: true, record: OperationRecord{
		UUID: "op-1", OfferType: "buy", Coin: "CLASICA", State: "applied",
	}}
	api.Live, api.Operations = live, operations

	recorder := mutationsTestDo(api, mutationsTestCall{
		method: http.MethodPost, target: "/api/operations/op-1/paid",
		body: `{"reference":"tx-1"}`, cookie: cookie, csrf: csrf, origin: "https://panel.example",
	})
	if recorder.Code != http.StatusConflict {
		t.Fatalf("paid buy: %d", recorder.Code)
	}
	if len(live.paids) != 0 {
		t.Fatalf("no debía llamar a QvaPay: %+v", live.paids)
	}
}

type fakeExclusionStore struct {
	excluded []string
	err      error
}

func (store *fakeExclusionStore) ExcludeOffer(_ context.Context, offerUUID, _ string, _ int64) error {
	if store.err != nil {
		return store.err
	}
	store.excluded = append(store.excluded, offerUUID)
	return nil
}

func TestMutationsAPIManualCancelExcluyeLaOferta(t *testing.T) {
	api, _, cookie, csrf, _ := newMutationsTestAPI(t)
	live := &fakeLiveMutations{}
	exclusions := &fakeExclusionStore{}
	api.Live = live
	api.Exclusions = exclusions

	recorder := mutationsTestDo(api, mutationsTestCall{
		method: http.MethodPost, target: "/api/operations/op-1/cancel",
		body: `{}`, cookie: cookie, csrf: csrf, origin: "https://panel.example",
	})
	if recorder.Code != http.StatusNoContent {
		t.Fatalf("status = %d %s", recorder.Code, recorder.Body.String())
	}
	if len(exclusions.excluded) != 1 || exclusions.excluded[0] != "op-1" {
		t.Fatalf("exclusiones = %+v", exclusions.excluded)
	}
	if len(live.cancels) != 1 {
		t.Fatalf("cancelaciones = %+v", live.cancels)
	}
}

func TestMutationsAPINoCancelaSiNoPuedeExcluir(t *testing.T) {
	api, _, cookie, csrf, _ := newMutationsTestAPI(t)
	live := &fakeLiveMutations{}
	api.Live = live
	api.Exclusions = &fakeExclusionStore{err: errors.New("sin base")}

	recorder := mutationsTestDo(api, mutationsTestCall{
		method: http.MethodPost, target: "/api/operations/op-1/cancel",
		body: `{}`, cookie: cookie, csrf: csrf, origin: "https://panel.example",
	})
	if recorder.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d", recorder.Code)
	}
	if len(live.cancels) != 0 {
		t.Fatalf("no debía cancelar sin exclusión: %+v", live.cancels)
	}
}
