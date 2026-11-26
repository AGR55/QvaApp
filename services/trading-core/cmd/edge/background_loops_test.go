package main

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/AGR55/QvaApp/services/trading-core/internal/edge"
	"github.com/AGR55/QvaApp/services/trading-core/internal/platform/qvapay"
)

type fakeAutoCancelReader struct {
	offer qvapay.Offer
	err   error
}

func (reader fakeAutoCancelReader) Offer(context.Context, string) (qvapay.Offer, error) {
	return reader.offer, reader.err
}

type fakeAutoCancelMutator struct {
	events *[]string
	err    error
}

func (mutator fakeAutoCancelMutator) Cancel(context.Context, string, string) (qvapay.MutationResult, error) {
	if mutator.events != nil {
		*mutator.events = append(*mutator.events, "cancel")
	}
	return qvapay.MutationResult{}, mutator.err
}

type fakeAutoCancelLocal struct {
	state string
	err   error
}

func (local *fakeAutoCancelLocal) SetState(_ context.Context, _, state string, _ int64) error {
	local.state = state
	return local.err
}

type fakeAutoCancelExclusion struct {
	events *[]string
	err    error
}

func (store fakeAutoCancelExclusion) ExcludeOffer(_ context.Context, uuid, source string, _ int64) error {
	if store.events != nil {
		*store.events = append(*store.events, "exclude:"+source+":"+uuid)
	}
	return store.err
}

func TestCancelExpiredOperationExcluyeAntesDeCancelar(t *testing.T) {
	events := []string{}
	local := &fakeAutoCancelLocal{}
	err := cancelExpiredOperation(
		context.Background(), nil,
		fakeAutoCancelReader{offer: qvapay.Offer{Status: "processing"}},
		fakeAutoCancelMutator{events: &events},
		local,
		fakeAutoCancelExclusion{events: &events},
		edge.PendingOperation{UUID: "offer-1", State: "applied", CreatedAt: 1},
		time.Unix(2, 0),
	)
	if err != nil {
		t.Fatalf("cancelExpiredOperation: %v", err)
	}
	if local.state != "cancelled" {
		t.Fatalf("state = %q", local.state)
	}
	if len(events) != 2 || events[0] != "exclude:auto_cancel:offer-1" || events[1] != "cancel" {
		t.Fatalf("orden de eventos = %v", events)
	}
}

func TestCancelExpiredOperationNoCancelaSiNoPuedeExcluir(t *testing.T) {
	events := []string{}
	local := &fakeAutoCancelLocal{}
	err := cancelExpiredOperation(
		context.Background(), nil,
		fakeAutoCancelReader{offer: qvapay.Offer{Status: "processing"}},
		fakeAutoCancelMutator{events: &events},
		local,
		fakeAutoCancelExclusion{events: &events, err: errors.New("sin base")},
		edge.PendingOperation{UUID: "offer-1", State: "applied", CreatedAt: 1},
		time.Unix(2, 0),
	)
	if err == nil {
		t.Fatal("se esperaba error de exclusión")
	}
	for _, event := range events {
		if event == "cancel" {
			t.Fatalf("no debía cancelar: events=%v", events)
		}
	}
	if local.state != "" {
		t.Fatalf("no debía persistir estado: %q", local.state)
	}
}

func TestCancelExpiredOperationExcluyeOfertaInexistente(t *testing.T) {
	events := []string{}
	local := &fakeAutoCancelLocal{}
	err := cancelExpiredOperation(
		context.Background(), nil,
		fakeAutoCancelReader{err: &qvapay.APIError{Status: 404, Body: "No tienes permisos para ver esta oferta"}},
		fakeAutoCancelMutator{events: &events},
		local,
		fakeAutoCancelExclusion{events: &events},
		edge.PendingOperation{UUID: "offer-gone", State: "applied", CreatedAt: 1},
		time.Unix(2, 0),
	)
	if err != nil {
		t.Fatalf("cancelExpiredOperation: %v", err)
	}
	if len(events) != 1 || events[0] != "exclude:offer_not_found:offer-gone" {
		t.Fatalf("eventos = %v", events)
	}
	if local.state != "cancelled" {
		t.Fatalf("state = %q", local.state)
	}
}
