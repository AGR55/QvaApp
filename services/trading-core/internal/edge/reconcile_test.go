package edge

import (
	"context"
	"testing"
	"time"

	"github.com/AGR55/QvaApp/services/shared/decimal"
	"github.com/AGR55/QvaApp/services/trading-core/internal/platform/qvapay"
)

type fakeReconcileReader struct {
	offer qvapay.Offer
}

func (fake *fakeReconcileReader) Offer(context.Context, string) (qvapay.Offer, error) {
	return fake.offer, nil
}

func TestReconcilerApplied(t *testing.T) {
	store := newMutationsTestStore()
	reconciler := &Reconciler{
		Reader: &fakeReconcileReader{offer: qvapay.Offer{
			UUID: "op-1", Status: "processing",
			Amount: decimal.MustParse("10"), Receive: decimal.MustParse("11"),
		}},
		Store: store,
		Now:   func() time.Time { return time.Unix(1_700_000_000, 0) },
	}
	report, err := reconciler.Check(context.Background(), "op-1", "")
	if err != nil {
		t.Fatalf("Check: %v", err)
	}
	if !report.Applied || report.Status != "processing" || report.Amount != "10.00000000" {
		t.Fatalf("report = %+v", report)
	}
	if len(store.records) != 1 || store.records[0].action != "reconciliation_checked" {
		t.Fatalf("registros = %+v", store.records)
	}
}
