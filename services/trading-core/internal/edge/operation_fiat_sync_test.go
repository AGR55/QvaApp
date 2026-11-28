package edge

import (
	"context"
	"testing"
	"time"
)

type fakeCooperativeSyncCounter struct {
	syncCapacities int
}

func (fake *fakeCooperativeSyncCounter) Enabled() bool { return true }
func (fake *fakeCooperativeSyncCounter) Publish(context.Context, string, float64, float64, float64) error {
	return nil
}
func (fake *fakeCooperativeSyncCounter) Withdraw(context.Context, string) error { return nil }
func (fake *fakeCooperativeSyncCounter) Refresh(context.Context) error          { return nil }
func (fake *fakeCooperativeSyncCounter) EnsureBaseline(context.Context, string) error {
	return nil
}
func (fake *fakeCooperativeSyncCounter) SyncCapacity(context.Context) error {
	fake.syncCapacities++
	return nil
}

func TestAfterOperationActionSincronizaCapacidadTrasCambioFiat(t *testing.T) {
	cases := []struct {
		name        string
		operation   OperationRecord
		action      string
		wantDebit   int
		wantCredit  int
		wantReverse int
		wantState   string
	}{
		{
			name:      "pago de compra debita",
			operation: OperationRecord{UUID: "offer-1", OfferType: "sell", Coin: "BANK_CUP", State: "applied", OrderUUID: "order-1"},
			action:    "paid", wantDebit: 1, wantState: "paid",
		},
		{
			name:      "liberación de venta acredita",
			operation: OperationRecord{UUID: "offer-2", OfferType: "buy", Coin: "BANK_CUP", State: "applied", OrderUUID: "order-2"},
			action:    "received", wantCredit: 1, wantState: "completed",
		},
		{
			name:      "cancelar tras pagar revierte",
			operation: OperationRecord{UUID: "offer-3", OfferType: "sell", Coin: "BANK_CUP", State: "paid", OrderUUID: "order-3"},
			action:    "cancel", wantReverse: 1, wantState: "cancelled",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			mover := &fakeFiatMover{}
			store := &fakeOperationStore{found: true, record: tc.operation}
			cooperative := &fakeCooperativeSyncCounter{}
			api := &MutationsAPI{
				Fiat: mover, Operations: store, Cooperative: cooperative,
				Now: func() time.Time { return time.Unix(1_700_000_000, 0) },
			}
			if err := api.afterOperationAction(context.Background(), tc.operation, tc.action, "test"); err != nil {
				t.Fatal(err)
			}
			if len(mover.debits) != tc.wantDebit || len(mover.credits) != tc.wantCredit || len(mover.reversals) != tc.wantReverse {
				t.Fatalf("movimientos = %+v", mover)
			}
			if store.state != tc.wantState {
				t.Fatalf("state = %q, quiero %q", store.state, tc.wantState)
			}
			if cooperative.syncCapacities != 1 {
				t.Fatalf("SyncCapacity = %d", cooperative.syncCapacities)
			}
		})
	}
}
