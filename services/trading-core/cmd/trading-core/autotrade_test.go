package main

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/AGR55/QvaApp/services/shared/decimal"
	"github.com/AGR55/QvaApp/services/trading-core/internal/core"
	"github.com/AGR55/QvaApp/services/trading-core/internal/domain/riskpolicy"
	"github.com/AGR55/QvaApp/services/trading-core/internal/platform/qvapay"
)

type fakeOperationRepo struct {
	operation core.Operation
}

func (repo *fakeOperationRepo) Get(context.Context, string) (core.Operation, error) {
	return repo.operation, nil
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
}

func (executor *fakeExecutor) Apply(context.Context, string, *decimal.Value) error {
	executor.calls++
	return executor.err
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
	state, err := trader.Execute(context.Background(), repo, "op-1", "offer-1", decimal.MustParse("10"))
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
			executor := &fakeExecutor{err: tc.err}
			trader := &autoTrader{executor: executor}
			state, err := trader.Execute(context.Background(), repo, "op-1", "offer-1", decimal.MustParse("10"))
			if err != nil || state != tc.state || executor.calls != 1 {
				t.Fatalf("state=%s err=%v calls=%d", state, err, executor.calls)
			}
		})
	}
}

type fakeOfferReader struct {
	offer qvapay.Offer
	err   error
}

func (reader *fakeOfferReader) Offer(context.Context, string) (qvapay.Offer, error) {
	return reader.offer, reader.err
}

func TestAutoTraderConfirmedIsIdempotent(t *testing.T) {
	operation := reservedOperation(t)
	operation, _ = operation.Transition(core.StateSubmitted, 3000)
	operation, _ = operation.Transition(core.StateConfirmed, 4000)
	repo := &fakeOperationRepo{operation: operation}
	executor := &fakeExecutor{}
	trader := &autoTrader{executor: executor}
	state, err := trader.Execute(context.Background(), repo, "op-1", "offer-1", decimal.MustParse("10"))
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
			reconciler.reconcileOne(context.Background(), "op-1", "offer-1")
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
