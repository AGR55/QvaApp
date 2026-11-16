package main

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/AGR55/QvaApp/services/shared/decimal"
	"github.com/AGR55/QvaApp/services/trading-core/internal/core"
	"github.com/AGR55/QvaApp/services/trading-core/internal/domain/riskpolicy"
	"github.com/AGR55/QvaApp/services/trading-core/internal/platform/postgres"
	"github.com/AGR55/QvaApp/services/trading-core/internal/platform/qvapay"
)

type fakeOperationRepo struct {
	operation core.Operation
	orders    []string
}

func (repo *fakeOperationRepo) Get(context.Context, string) (core.Operation, error) {
	return repo.operation, nil
}

func (repo *fakeOperationRepo) SetOrder(_ context.Context, _ string, orderUUID string) error {
	repo.orders = append(repo.orders, orderUUID)
	repo.operation.OrderUUID = orderUUID
	return nil
}

func (repo *fakeOperationRepo) Transition(_ context.Context, _ string, state core.OperationState, now int64) (core.Operation, error) {
	next, err := repo.operation.Transition(state, now)
	if err == nil {
		repo.operation = next
	}
	return next, err
}

type fakeExecutor struct {
	calls int
	err   error
	order string
}

func (executor *fakeExecutor) Apply(context.Context, string, *decimal.Value) (string, error) {
	executor.calls++
	if executor.err != nil {
		return "", executor.err
	}
	return executor.order, nil
}

func reservedOperation(t *testing.T) core.Operation {
	t.Helper()
	operation, err := core.NewOperation("op-1", decimal.MustParse("10"), decimal.MustParse("11"), 1000)
	if err != nil {
		t.Fatal(err)
	}
	operation, err = operation.Transition(core.StateReserved, 2000)
	if err != nil {
		t.Fatal(err)
	}
	return operation
}

func TestAutoTraderDryRunDoesNotCallQvaPay(t *testing.T) {
	repo := &fakeOperationRepo{operation: reservedOperation(t)}
	executor := &fakeExecutor{}
	trader := &autoTrader{dryRun: true, executor: executor}
	state, err := trader.Execute(context.Background(), repo, "op-1", "offer-1", decimal.MustParse("10"), true)
	if err != nil || state != core.StateDryRun || executor.calls != 0 {
		t.Fatalf("state=%s err=%v calls=%d", state, err, executor.calls)
	}
}

func TestAutoTraderLiveOutcomes(t *testing.T) {
	cases := []struct {
		name  string
		err   error
		state core.OperationState
	}{
		{"success", nil, core.StateConfirmed},
		{"rejected", &qvapay.MutationError{Status: 409}, core.StateRejected},
		{"uncertain", errors.New("timeout"), core.StateUncertain},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			repo := &fakeOperationRepo{operation: reservedOperation(t)}
			executor := &fakeExecutor{err: tc.err, order: "order-1"}
			trader := &autoTrader{executor: executor}
			state, err := trader.Execute(context.Background(), repo, "op-1", "offer-1", decimal.MustParse("10"), true)
			if err != nil || state != tc.state || executor.calls != 1 {
				t.Fatalf("state=%s err=%v calls=%d", state, err, executor.calls)
			}
			if tc.state == core.StateConfirmed && len(repo.orders) != 1 {
				t.Fatalf("orden no persistida: %+v", repo.orders)
			}
		})
	}
}

type fakeOfferReader struct {
	offer qvapay.Offer
	user  qvapay.User
	err   error
}

func (reader *fakeOfferReader) Offer(context.Context, string) (qvapay.Offer, error) {
	return reader.offer, reader.err
}

func (reader *fakeOfferReader) User(context.Context) (qvapay.User, error) {
	return reader.user, reader.err
}

func TestAutoTraderSoloNotificaAplicacionesNuevas(t *testing.T) {
	cases := []struct {
		name         string
		dryRun       bool
		err          error
		preConfirmed bool
		want         int
	}{
		{"aplicada", false, nil, false, 1},
		{"rechazada", false, &qvapay.MutationError{Status: 409}, false, 0},
		{"incierta", false, errors.New("timeout"), false, 0},
		{"dry-run", true, nil, false, 0},
		{"ya confirmada", false, nil, true, 0},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			operation := reservedOperation(t)
			if tc.preConfirmed {
				operation, _ = operation.Transition(core.StateSubmitted, 3000)
				operation, _ = operation.Transition(core.StateConfirmed, 4000)
			}
			repo := &fakeOperationRepo{operation: operation}
			calls := 0
			order := ""
			trader := &autoTrader{
				dryRun: tc.dryRun, executor: &fakeExecutor{err: tc.err, order: "order-1"},
				onApplied: func(_ context.Context, _, _, orderUUID string) {
					calls++
					order = orderUUID
				},
			}
			if _, err := trader.Execute(context.Background(), repo, "op-1", "offer-1",
				decimal.MustParse("10"), true); err != nil {
				t.Fatalf("err = %v", err)
			}
			if calls != tc.want {
				t.Fatalf("onApplied calls = %d, quiero %d", calls, tc.want)
			}
			if tc.want > 0 && order != "order-1" {
				t.Fatalf("order = %q", order)
			}
		})
	}
}

func TestAutoTraderConfirmedIsIdempotent(t *testing.T) {
	operation := reservedOperation(t)
	operation, _ = operation.Transition(core.StateSubmitted, 3000)
	operation, _ = operation.Transition(core.StateConfirmed, 4000)
	repo := &fakeOperationRepo{operation: operation}
	executor := &fakeExecutor{order: "order-1"}
	trader := &autoTrader{executor: executor}
	state, err := trader.Execute(context.Background(), repo, "op-1", "offer-1", decimal.MustParse("10"), true)
	if err != nil || state != core.StateConfirmed || executor.calls != 0 {
		t.Fatalf("state=%s err=%v calls=%d", state, err, executor.calls)
	}
}

func TestReconcilerTransitionsUncertain(t *testing.T) {
	cases := []struct {
		name   string
		status string
		state  core.OperationState
	}{
		{"applied", "processing", core.StateReconciled},
		{"not applied", "open", core.StateRejected},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			operation := reservedOperation(t)
			operation, _ = operation.Transition(core.StateSubmitted, 3000)
			operation, _ = operation.Transition(core.StateUncertain, 4000)
			repo := &fakeOperationRepo{operation: operation}
			reconciler := &operationReconciler{
				reader: &fakeOfferReader{offer: qvapay.Offer{Status: tc.status}},
				repo:   repo, now: func() time.Time { return time.Unix(1_700_000_000, 0) },
			}
			reconciler.reconcileOne(context.Background(), "op-1", "offer-1", "", string(core.StateUncertain))
			if repo.operation.State != tc.state {
				t.Fatalf("state=%s, se esperaba %s", repo.operation.State, tc.state)
			}
		})
	}
}

func TestSizePayloadAmount(t *testing.T) {
	config := core.Config{
		Limits: riskpolicy.Limits{
			MaxQusdPerOperation:       decimal.MustParse("500"),
			MaxConcurrentQusdExposure: decimal.MustParse("1000"),
			MaxDailyAppliedQusd:       decimal.MustParse("1000"),
		},
		Markets: map[string]core.Market{
			"CLASICA": {Code: "CLASICA", Active: true, PurchaseMaxQusd: decimal.MustParse("1000")},
		},
		Fiat: map[string]decimal.Value{"CLASICA": decimal.MustParse("1000")},
	}
	payload := hunterPayload{
		OfferUUID: "offer-1", Coin: "CLASICA", Side: "buy", Decision: "auto_buy",
		Amount: "100", Receive: "133", Rate: "1.33",
		OfferKind: "flexible", Available: "100", OrderMin: "5", OrderMax: "100",
	}
	amount, receive, sized, _ := sizePayloadAmount(payload, config, core.Usage{}, decimal.MustParse("1.33"))
	if !sized || amount.Cmp(decimal.MustParse("100")) != 0 || receive.Cmp(decimal.MustParse("133")) != 0 {
		t.Fatalf("amount=%s receive=%s sized=%v", amount.Compact(), receive.Compact(), sized)
	}

	config.Fiat["CLASICA"] = decimal.MustParse("100")
	amount, receive, sized, reason := sizePayloadAmount(payload, config, core.Usage{}, decimal.MustParse("1.33"))
	if !sized || amount.Cmp(decimal.MustParse("75.18")) != 0 || reason == "" {
		t.Fatalf("fondos: amount=%s reason=%q", amount.Compact(), reason)
	}
	if receive.Cmp(decimal.MustParse("99.9894")) != 0 {
		t.Fatalf("receive = %s", receive.Compact())
	}

	config.Fiat["CLASICA"] = decimal.MustParse("1000")
	config.Markets["CLASICA"] = core.Market{Code: "CLASICA", Active: true, PurchaseMaxQusd: decimal.MustParse("4")}
	amount, _, _, _ = sizePayloadAmount(payload, config, core.Usage{}, decimal.MustParse("1.33"))
	if amount.Sign() != 0 {
		t.Fatalf("se esperaba rechazo por mínimo, amount=%s", amount.Compact())
	}
}

func TestSizePayloadAmountIgnoresFixedOffers(t *testing.T) {
	payload := hunterPayload{OfferUUID: "o", Coin: "CLASICA", Side: "buy", Amount: "10", Receive: "11", Rate: "1.1"}
	if _, _, sized, _ := sizePayloadAmount(payload, core.Config{}, core.Usage{}, decimal.MustParse("1.1")); sized {
		t.Fatal("una oferta fija no debe dimensionarse")
	}
}

func TestQvapayTradeExecutorValidatesResponse(t *testing.T) {
	const offerUUID = "a617538e-e8a0-4797-bafe-3e8c00aa5cda"
	const orderUUID = "9c190663-340f-4b39-b237-bf0365f5cfe7"

	cases := []struct {
		name    string
		body    string
		amount  string
		wantErr bool
	}{
		{"ok", `{"order":"` + orderUUID + `","amount":5,"receive":5.5}`, "5", false},
		{"sin orden", `{"amount":5,"receive":5.5}`, "5", true},
		{"importe distinto", `{"order":"` + orderUUID + `","amount":4,"receive":5.5}`, "5", true},
		{"recepción cero", `{"order":"` + orderUUID + `","amount":5,"receive":0}`, "5", true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				fmt.Fprint(w, tc.body)
			}))
			defer server.Close()
			client := qvapay.NewMutationClient(server.URL, "token")
			client.Enable()
			executor := &qvapayTradeExecutor{client: client}
			amount := decimal.MustParse(tc.amount)
			order, err := executor.Apply(context.Background(), offerUUID, &amount)
			if tc.wantErr {
				if err == nil {
					t.Fatalf("se esperaba error, order=%q", order)
				}
				return
			}
			if err != nil || order != orderUUID {
				t.Fatalf("order=%q err=%v", order, err)
			}
		})
	}
}

func TestAutoTraderFixedOfferNeedsNoOrder(t *testing.T) {
	repo := &fakeOperationRepo{operation: reservedOperation(t)}
	executor := &fakeExecutor{order: ""}
	trader := &autoTrader{executor: executor}
	state, err := trader.Execute(context.Background(), repo, "op-1", "offer-1", decimal.MustParse("10"), false)
	if err != nil || state != core.StateConfirmed || executor.calls != 1 {
		t.Fatalf("state=%s err=%v calls=%d", state, err, executor.calls)
	}
	if len(repo.orders) != 0 {
		t.Fatalf("una oferta fija no debe persistir orden: %+v", repo.orders)
	}
}

func TestLocalOperationStateMapping(t *testing.T) {
	cases := map[core.OperationState]string{
		core.StateConfirmed:  "applied",
		core.StateDryRun:     "dry_run",
		core.StateRejected:   "rejected",
		core.StateUncertain:  "uncertain",
		core.StateReconciled: "completed",
		core.StateReserved:   "",
	}
	for state, expected := range cases {
		if got := localOperationState(state); got != expected {
			t.Fatalf("%s -> %q, se esperaba %q", state, got, expected)
		}
	}
}

type fakeLocalOps struct {
	state  string
	calls  int
	record postgres.LocalOperation
	found  bool
}

func (fake *fakeLocalOps) Get(_ context.Context, _ string) (postgres.LocalOperation, bool, error) {
	return fake.record, fake.found, nil
}

func (fake *fakeLocalOps) SetState(_ context.Context, _ string, state string, _ int64) error {
	fake.state = state
	fake.calls++
	return nil
}

type fakeOperationFiat struct {
	debits    int
	credits   int
	reversals int
}

func (fake *fakeOperationFiat) RecordOperationFiat(
	_ context.Context, _, _, offerType string, _ float64, _, _ string, _ int64,
) (bool, error) {
	if offerType == "sell" {
		fake.debits++
	} else {
		fake.credits++
	}
	return true, nil
}

func (fake *fakeOperationFiat) ReverseOperationFiat(
	_ context.Context, _, _, _ string, _ float64, _ string, _ int64,
) (bool, error) {
	fake.reversals++
	return true, nil
}

func TestReconcilerRefreshesConfirmedLocalState(t *testing.T) {
	operation := reservedOperation(t)
	operation, _ = operation.Transition(core.StateSubmitted, 3000)
	operation, _ = operation.Transition(core.StateConfirmed, 4000)
	repo := &fakeOperationRepo{operation: operation}
	local := &fakeLocalOps{
		found: true,
		record: postgres.LocalOperation{
			UUID: "offer-1", OfferType: "sell", Coin: "CLASICA",
			State: "applied", Receive: 10.6,
		},
	}
	fiat := &fakeOperationFiat{}
	reconciler := &operationReconciler{
		reader: &fakeOfferReader{offer: qvapay.Offer{Status: "paid"}},
		repo:   repo, localOps: local, fiat: fiat,
		now: func() time.Time { return time.Unix(1_700_000_000, 0) },
	}
	reconciler.reconcileOne(context.Background(), "op-1", "offer-1", "", string(core.StateConfirmed))
	if local.state != "paid" || local.calls != 1 || fiat.debits != 1 {
		t.Fatalf("local = %+v fiat = %+v", local, fiat)
	}
	if repo.operation.State != core.StateConfirmed {
		t.Fatalf("no debía transicionar el core: %s", repo.operation.State)
	}
}
