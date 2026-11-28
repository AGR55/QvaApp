package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"maps"
	"os"
	"sync"
	"sync/atomic"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/AGR55/QvaApp/services/shared/decimal"
	"github.com/AGR55/QvaApp/services/trading-core/internal/core"
	"github.com/AGR55/QvaApp/services/trading-core/internal/platform/postgres"
)

func operationWorkerTestPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	dsn := os.Getenv("TEST_POSTGRES_URL")
	if dsn == "" {
		t.Skip("TEST_POSTGRES_URL no configurado")
	}
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, "TRUNCATE shadow.core_operations"); err != nil {
		pool.Close()
		t.Fatalf("TRUNCATE shadow.core_operations: %v", err)
	}
	t.Cleanup(pool.Close)
	return pool
}

func operationWorkerTestLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

func seedReservedOperation(t *testing.T, pool *pgxpool.Pool, id string, now int64) {
	t.Helper()
	repository := postgres.NewCoreOperationRepository(pool)
	operation, err := core.NewOperation(
		id,
		decimal.MustParse("12.5"),
		decimal.MustParse("22500"),
		now,
	)
	if err != nil {
		t.Fatal(err)
	}
	if err := repository.Create(context.Background(), operation); err != nil {
		t.Fatal(err)
	}
	if _, err := repository.Transition(
		context.Background(), id, core.StateReserved, now+1,
	); err != nil {
		t.Fatal(err)
	}
}

// stubRemote permite probar cada resultado remoto sin red.
type stubRemote struct {
	result core.RemoteResult
	err    error
	calls  atomic.Uint64
}

func (remote *stubRemote) Submit(
	context.Context,
	core.Operation,
) (core.RemoteResult, error) {
	remote.calls.Add(1)
	return remote.result, remote.err
}

func TestShadowRemoteIsNoop(t *testing.T) {
	operation, err := core.NewOperation(
		"op-shadow-remote",
		decimal.MustParse("1"),
		decimal.MustParse("2"),
		1,
	)
	if err != nil {
		t.Fatal(err)
	}

	result, err := shadowRemote{}.Submit(context.Background(), operation)
	if err != nil {
		t.Fatalf("submit shadow devolvió error: %v", err)
	}
	if !result.Confirmed || result.Uncertain {
		t.Fatalf("resultado shadow = %+v, quiero confirmado", result)
	}
	if result.Reference != "shadow-noop" {
		t.Fatalf("reference = %q, quiero shadow-noop", result.Reference)
	}
}

func TestOperationWorkerConfirmsReservedOperation(t *testing.T) {
	pool := operationWorkerTestPool(t)
	ctx := context.Background()
	seedReservedOperation(t, pool, "op-worker-confirm", 100)

	worker := newOperationWorker(pool, operationWorkerTestLogger())
	worker.tick(ctx)

	repository := postgres.NewCoreOperationRepository(pool)
	persisted, err := repository.Get(ctx, "op-worker-confirm")
	if err != nil {
		t.Fatal(err)
	}
	if persisted.State != core.StateConfirmed {
		t.Fatalf("estado = %q, quiero %q", persisted.State, core.StateConfirmed)
	}
	if persisted.UpdatedAt < 101 {
		t.Fatalf("updated_at = %d, quiero >= 101", persisted.UpdatedAt)
	}
	if got := worker.processed.Load(); got != 1 {
		t.Fatalf("processed = %d, quiero 1", got)
	}
	if got := worker.failed.Load(); got != 0 {
		t.Fatalf("failed = %d, quiero 0", got)
	}

	// Idempotencia: una segunda vuelta no encuentra operaciones reserved, no
	// duplica el trabajo y no incrementa los contadores.
	worker.tick(ctx)

	persisted, err = repository.Get(ctx, "op-worker-confirm")
	if err != nil {
		t.Fatal(err)
	}
	if persisted.State != core.StateConfirmed {
		t.Fatalf("estado tras segunda vuelta = %q", persisted.State)
	}
	if got := worker.processed.Load(); got != 1 {
		t.Fatalf("processed tras segunda vuelta = %d, quiero 1", got)
	}
	if got := worker.failed.Load(); got != 0 {
		t.Fatalf("failed tras segunda vuelta = %d, quiero 0", got)
	}

	counts, err := repository.CountByState(ctx)
	if err != nil {
		t.Fatal(err)
	}
	want := map[core.OperationState]int64{core.StateConfirmed: 1}
	if !maps.Equal(counts, want) {
		t.Fatalf("counts = %v, quiero %v", counts, want)
	}
}

func TestOperationWorkerPersistsRemoteOutcomes(t *testing.T) {
	tests := []struct {
		name          string
		result        core.RemoteResult
		err           error
		want          core.OperationState
		wantProcessed uint64
		wantFailed    uint64
	}{
		{
			name:          "confirmado",
			result:        core.RemoteResult{Confirmed: true, Reference: "ref"},
			want:          core.StateConfirmed,
			wantProcessed: 1,
		},
		{
			name:          "rechazado",
			result:        core.RemoteResult{},
			want:          core.StateRejected,
			wantProcessed: 1,
		},
		{
			name:          "incierto",
			result:        core.RemoteResult{Uncertain: true},
			want:          core.StateUncertain,
			wantProcessed: 1,
		},
		{
			name:       "error remoto",
			err:        errors.New("timeout remoto"),
			want:       core.StateUncertain,
			wantFailed: 1,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			pool := operationWorkerTestPool(t)
			ctx := context.Background()
			seedReservedOperation(t, pool, "op-worker-outcome", 100)

			worker := newOperationWorker(pool, operationWorkerTestLogger())
			remote := &stubRemote{result: tt.result, err: tt.err}
			worker.remote = remote
			worker.tick(ctx)

			persisted, err := postgres.NewCoreOperationRepository(pool).
				Get(ctx, "op-worker-outcome")
			if err != nil {
				t.Fatal(err)
			}
			if persisted.State != tt.want {
				t.Fatalf("estado = %q, quiero %q", persisted.State, tt.want)
			}
			if got := remote.calls.Load(); got != 1 {
				t.Fatalf("llamadas al remoto = %d, quiero 1", got)
			}
			if got := worker.processed.Load(); got != tt.wantProcessed {
				t.Fatalf("processed = %d, quiero %d", got, tt.wantProcessed)
			}
			if got := worker.failed.Load(); got != tt.wantFailed {
				t.Fatalf("failed = %d, quiero %d", got, tt.wantFailed)
			}
		})
	}
}

func TestOperationWorkerConcurrentClaimsAreDisjoint(t *testing.T) {
	pool := operationWorkerTestPool(t)
	ctx := context.Background()

	const (
		seeded      = 12
		claimLimit  = 5
		wantClaimed = 10
	)
	for i := 0; i < seeded; i++ {
		seedReservedOperation(
			t, pool, fmt.Sprintf("op-concurrent-%02d", i), int64(100+i),
		)
	}

	workers := []*operationWorker{
		newOperationWorker(pool, operationWorkerTestLogger()),
		newOperationWorker(pool, operationWorkerTestLogger()),
	}
	for _, worker := range workers {
		worker.claimLimit = claimLimit
	}

	start := make(chan struct{})
	results := make([][]core.Operation, len(workers))
	errs := make([]error, len(workers))
	var wg sync.WaitGroup
	for i := range workers {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			<-start
			results[i], errs[i] = workers[i].claim(ctx, postgres.NowMS())
		}(i)
	}
	close(start)
	wg.Wait()

	seen := make(map[string]int)
	for i := range results {
		if errs[i] != nil {
			t.Fatalf("claim %d falló: %v", i, errs[i])
		}
		for _, operation := range results[i] {
			if operation.State != core.StateSubmitted {
				t.Fatalf("operación %q reclamada en estado %q", operation.ID, operation.State)
			}
			seen[operation.ID]++
		}
	}
	for id, count := range seen {
		if count != 1 {
			t.Fatalf("operación %q reclamada %d veces", id, count)
		}
	}
	if len(seen) != wantClaimed {
		t.Fatalf("operaciones reclamadas = %d, quiero %d", len(seen), wantClaimed)
	}

	counts, err := postgres.NewCoreOperationRepository(pool).CountByState(ctx)
	if err != nil {
		t.Fatal(err)
	}
	want := map[core.OperationState]int64{
		core.StateSubmitted: wantClaimed,
		core.StateReserved:  seeded - wantClaimed,
	}
	if !maps.Equal(counts, want) {
		t.Fatalf("counts = %v, quiero %v", counts, want)
	}

	// La siguiente vuelta puede reclamar el resto sin volver a tocar las ya
	// reclamadas.
	rest, err := workers[0].claim(ctx, postgres.NowMS())
	if err != nil {
		t.Fatal(err)
	}
	if len(rest) != seeded-wantClaimed {
		t.Fatalf("resto reclamado = %d, quiero %d", len(rest), seeded-wantClaimed)
	}
}
