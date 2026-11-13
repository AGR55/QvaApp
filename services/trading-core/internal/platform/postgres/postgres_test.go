package postgres_test

import (
	"context"
	"os"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/AGR55/QvaApp/services/trading-core/internal/platform/idempotency"
	"github.com/AGR55/QvaApp/services/trading-core/internal/platform/inbox"
	"github.com/AGR55/QvaApp/services/trading-core/internal/platform/outbox"
	"github.com/AGR55/QvaApp/services/trading-core/internal/platform/postgres"
)

func setup(t *testing.T) *pgxpool.Pool {
	t.Helper()
	dsn := os.Getenv("TEST_POSTGRES_URL")
	if dsn == "" {
		t.Skip("TEST_POSTGRES_URL no configurado")
	}
	pool, err := pgxpool.New(context.Background(), dsn)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(context.Background(), "TRUNCATE core.outbox, core.inbox, core.idempotency_keys, core.audit_log"); err != nil {
		pool.Close()
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	return pool
}

func TestOutboxRepository(t *testing.T) {
	pool := setup(t)
	repository := postgres.NewOutboxRepository(pool)
	ctx := context.Background()

	first, _ := outbox.New("m1", "core.events", `{"n":1}`, "key-1", 100)
	inserted, err := repository.Insert(ctx, first)
	if err != nil || !inserted {
		t.Fatalf("insert = %v, %v", inserted, err)
	}
	duplicate, _ := outbox.New("m2", "core.events", `{"n":2}`, "key-1", 100)
	inserted, err = repository.Insert(ctx, duplicate)
	if err != nil || inserted {
		t.Fatalf("duplicado insertado: %v, %v", inserted, err)
	}

	second, _ := outbox.New("m2", "core.events", `{"n":2}`, "key-2", 100)
	if inserted, err := repository.Insert(ctx, second); err != nil || !inserted {
		t.Fatalf("insert 2 = %v, %v", inserted, err)
	}

	claimed, err := repository.ClaimDue(ctx, "worker-1", 100, 1000, 10)
	if err != nil || len(claimed) != 2 {
		t.Fatalf("claim = %v, %v", claimed, err)
	}
	if claimed[0].State != outbox.InFlight || claimed[0].Attempts != 1 {
		t.Fatalf("claim inesperado: %+v", claimed[0])
	}
	if again, err := repository.ClaimDue(ctx, "worker-2", 100, 1000, 10); err != nil || len(again) != 0 {
		t.Fatalf("segundo claim = %v, %v", again, err)
	}
	if updated, err := repository.Complete(ctx, "m1", "worker-1", 200); err != nil || !updated {
		t.Fatalf("complete = %v, %v", updated, err)
	}

	expired, err := repository.ClaimDue(ctx, "worker-2", 1101, 1000, 10)
	if err != nil || len(expired) != 1 || expired[0].ID != "m2" {
		t.Fatalf("claim de lease vencido = %v, %v", expired, err)
	}
	state, err := repository.Fail(ctx, "m2", "worker-2", "network", 1200, 1500, 3)
	if err != nil || state != outbox.Pending {
		t.Fatalf("fail = %s, %v", state, err)
	}
	claimed, _ = repository.ClaimDue(ctx, "worker-3", 1500, 1000, 10)
	if len(claimed) != 1 {
		t.Fatalf("claim tras retry = %v", claimed)
	}
	state, err = repository.Fail(ctx, "m2", "worker-3", "network", 1600, 0, 3)
	if err != nil || state != outbox.Failed {
		t.Fatalf("fail final = %s, %v", state, err)
	}
}

func TestInboxRepository(t *testing.T) {
	pool := setup(t)
	repository := postgres.NewInboxRepository(pool)
	ctx := context.Background()

	record, accepted, err := repository.Accept(ctx, "consumer", "message-1", 100)
	if err != nil || !accepted || record.State != inbox.Received {
		t.Fatalf("accept = %+v, %v, %v", record, accepted, err)
	}
	duplicate, accepted, err := repository.Accept(ctx, "consumer", "message-1", 200)
	if err != nil || accepted || duplicate.ReceivedAt != 100 {
		t.Fatalf("duplicate = %+v, %v, %v", duplicate, accepted, err)
	}
	if updated, err := repository.Complete(ctx, "consumer", "message-1", 300); err != nil || !updated {
		t.Fatalf("complete = %v, %v", updated, err)
	}
	record, accepted, err = repository.Accept(ctx, "consumer", "message-1", 400)
	if err != nil || accepted || record.State != inbox.Processed {
		t.Fatalf("processed = %+v, %v, %v", record, accepted, err)
	}
	if _, accepted, _ := repository.Accept(ctx, "consumer", "message-2", 500); !accepted {
		t.Fatal("mensaje nuevo rechazado")
	}
	if updated, err := repository.Fail(ctx, "consumer", "message-2", "boom", 600); err != nil || !updated {
		t.Fatalf("fail = %v, %v", updated, err)
	}
}

func TestIdempotencyRepository(t *testing.T) {
	pool := setup(t)
	repository := postgres.NewIdempotencyRepository(pool)
	ctx := context.Background()

	record, status, err := repository.Claim(ctx, "apply", "key-1", "hash-a", 100, 1000)
	if err != nil || status != idempotency.Claimed || record.State != idempotency.Reserved {
		t.Fatalf("claim = %+v, %v, %v", record, status, err)
	}
	if _, status, _ := repository.Claim(ctx, "apply", "key-1", "hash-a", 200, 1000); status != idempotency.InProgress {
		t.Fatalf("estado = %s", status)
	}
	if _, status, _ := repository.Claim(ctx, "apply", "key-1", "hash-b", 200, 1000); status != idempotency.Conflict {
		t.Fatalf("estado = %s", status)
	}
	if updated, err := repository.Complete(ctx, "apply", "key-1", `{"ok":true}`, 300); err != nil || !updated {
		t.Fatalf("complete = %v, %v", updated, err)
	}
	replay, status, err := repository.Claim(ctx, "apply", "key-1", "hash-a", 400, 1000)
	if err != nil || status != idempotency.Replay || replay.ResponseJSON != `{"ok":true}` {
		t.Fatalf("replay = %+v, %v, %v", replay, status, err)
	}
	if _, status, _ := repository.Claim(ctx, "apply", "key-1", "hash-a", 1201, 1000); status != idempotency.Claimed {
		t.Fatalf("estado expirado = %s", status)
	}

	if _, _, err := repository.Claim(ctx, "apply", "key-2", "hash-a", 100, 1000); err != nil {
		t.Fatal(err)
	}
	if updated, err := repository.Fail(ctx, "apply", "key-2", 200); err != nil || !updated {
		t.Fatalf("fail = %v, %v", updated, err)
	}
	if _, status, _ := repository.Claim(ctx, "apply", "key-2", "hash-a", 300, 1000); status != idempotency.Claimed {
		t.Fatalf("reintento = %s", status)
	}
}

type capturePublisher struct {
	ids []string
}

func (publisher *capturePublisher) Publish(_ context.Context, message outbox.Message) error {
	publisher.ids = append(publisher.ids, message.ID)
	return nil
}

func TestTransactionalEnqueueAndWorker(t *testing.T) {
	pool := setup(t)
	repository := postgres.NewOutboxRepository(pool)
	ctx := context.Background()

	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(ctx, "INSERT INTO core.audit_log (created_at, action, detail) VALUES (1, 'tx-test', 'detail')"); err != nil {
		t.Fatal(err)
	}
	message, _ := outbox.New("tx-1", "core.events", `{"ok":true}`, "tx-key-1", 100)
	if inserted, err := repository.InsertTx(ctx, tx, message); err != nil || !inserted {
		t.Fatalf("InsertTx = %v, %v", inserted, err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	var auditCount int
	if err := pool.QueryRow(ctx, "SELECT count(*) FROM core.audit_log WHERE action = 'tx-test'").Scan(&auditCount); err != nil {
		t.Fatal(err)
	}
	if auditCount != 1 {
		t.Fatalf("audit count = %d", auditCount)
	}

	worker, err := outbox.NewWorker(repository, &capturePublisher{}, outbox.WorkerConfig{
		WorkerID: "worker", Batch: 10, Lease: 1000 * 1000 * 1000,
	})
	if err != nil {
		t.Fatal(err)
	}
	result, err := worker.RunOnce(ctx, 100)
	if err != nil {
		t.Fatal(err)
	}
	if result.Published != 1 {
		t.Fatalf("published = %d", result.Published)
	}
	var state string
	if err := pool.QueryRow(ctx, "SELECT state FROM core.outbox WHERE id = 'tx-1'").Scan(&state); err != nil {
		t.Fatal(err)
	}
	if state != "published" {
		t.Fatalf("state = %s", state)
	}
}

func TestTransactionalEnqueueRollback(t *testing.T) {
	pool := setup(t)
	repository := postgres.NewOutboxRepository(pool)
	ctx := context.Background()

	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(ctx, "INSERT INTO core.audit_log (created_at, action, detail) VALUES (1, 'rollback-test', 'detail')"); err != nil {
		t.Fatal(err)
	}
	message, _ := outbox.New("rollback-1", "core.events", "{}", "rollback-key-1", 100)
	if _, err := repository.InsertTx(ctx, tx, message); err != nil {
		t.Fatal(err)
	}
	if err := tx.Rollback(ctx); err != nil {
		t.Fatal(err)
	}
	var auditCount, outboxCount int
	if err := pool.QueryRow(ctx, "SELECT count(*) FROM core.audit_log WHERE action = 'rollback-test'").Scan(&auditCount); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, "SELECT count(*) FROM core.outbox WHERE id = 'rollback-1'").Scan(&outboxCount); err != nil {
		t.Fatal(err)
	}
	if auditCount != 0 || outboxCount != 0 {
		t.Fatalf("rollback incompleto: audit=%d outbox=%d", auditCount, outboxCount)
	}
}
