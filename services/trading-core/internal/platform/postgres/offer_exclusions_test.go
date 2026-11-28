package postgres_test

import (
	"context"
	"testing"

	"github.com/AGR55/QvaApp/services/trading-core/internal/platform/postgres"
)

func TestBackfillCancelledExcluyeOperacionesCanceladas(t *testing.T) {
	pool := setup(t)
	ctx := context.Background()
	offer := "cancelled-backfill-test"
	if _, err := pool.Exec(ctx, `
		INSERT INTO shadow.local_operations
			(uuid, offer_type, coin, amount, receive, rate, state, auto_applied,
			 order_uuid, created_at, updated_at)
		VALUES ($1, 'sell', 'BANK_CUP', 10, 11, 1.1, 'cancelled', true, '', 100, 100)`,
		offer); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `DELETE FROM shadow.local_operations WHERE uuid = $1`, offer)
		_, _ = pool.Exec(context.Background(), `DELETE FROM shadow.runtime_settings WHERE key = $1`, "excluded_offer:"+offer)
	})
	repository := postgres.NewOfferExclusionRepository(pool)
	if _, err := repository.BackfillCancelled(ctx, 200); err != nil {
		t.Fatal(err)
	}
	excluded, err := repository.IsOfferExcluded(ctx, offer)
	if err != nil || !excluded {
		t.Fatalf("excluded=%v err=%v", excluded, err)
	}
}
