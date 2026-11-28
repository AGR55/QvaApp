package postgres_test

import (
	"context"
	"os"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/AGR55/QvaApp/services/trading-core/internal/platform/postgres"
)

func TestHunterEventRepository(t *testing.T) {
	dsn := os.Getenv("TEST_POSTGRES_URL")
	if dsn == "" {
		t.Skip("TEST_POSTGRES_URL no configurado")
	}
	pool, err := pgxpool.New(context.Background(), dsn)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	ctx := context.Background()
	if _, err := pool.Exec(ctx, "TRUNCATE shadow.core_executions, shadow.core_decisions, shadow.hunter_events CASCADE"); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO shadow.hunter_events
			(event_id, offer_uuid, coin, side, decision, rate, payload_json,
			 state, available_at, created_at)
		VALUES ('e1', 'offer-1', 'BANK_CUP', 'buy', 'auto_buy', '1800',
		        '{"offerUuid":"offer-1","coin":"BANK_CUP","side":"buy","decision":"auto_buy","rate":"1800"}',
		        'pending', 1000, 1000)`); err != nil {
		t.Fatal(err)
	}
	repository := postgres.NewHunterEventRepository(pool)
	events, err := repository.Claim(ctx, "worker-a", 1000, 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(events) != 1 || events[0].EventID != "e1" {
		t.Fatalf("eventos = %+v", events)
	}
	if err := repository.Complete(ctx, "e1", 1100); err != nil {
		t.Fatal(err)
	}
	pending, err := repository.Pending(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if pending != 0 {
		t.Fatalf("pendientes = %d", pending)
	}
}
