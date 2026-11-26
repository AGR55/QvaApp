package postgres_test

import (
	"context"
	"errors"
	"maps"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/AGR55/QvaApp/services/shared/decimal"
	"github.com/AGR55/QvaApp/services/trading-core/internal/core"
	"github.com/AGR55/QvaApp/services/trading-core/internal/platform/postgres"
)

func coreOperationsSetup(t *testing.T) *pgxpool.Pool {
	t.Helper()
	dsn := os.Getenv("TEST_POSTGRES_URL")
	if dsn == "" {
		t.Skip("TEST_POSTGRES_URL no configurado")
	}
	pool, err := pgxpool.New(context.Background(), dsn)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(context.Background(), "TRUNCATE shadow.core_operations"); err != nil {
		pool.Close()
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	return pool
}

func newCoreOperation(t *testing.T, id string, now int64) core.Operation {
	t.Helper()
	operation, err := core.NewOperation(
		id,
		decimal.MustParse("12.5"),
		decimal.MustParse("22500"),
		now,
	)
	if err != nil {
		t.Fatal(err)
	}
	return operation
}

func TestCoreOperationRepositoryCreateGetTransition(t *testing.T) {
	pool := coreOperationsSetup(t)
	repository := postgres.NewCoreOperationRepository(pool)
	ctx := context.Background()

	operation := newCoreOperation(t, "op-1", 100)
	if err := repository.Create(ctx, operation); err != nil {
		t.Fatal(err)
	}

	got, err := repository.Get(ctx, "op-1")
	if err != nil {
		t.Fatal(err)
	}
	if got.ID != operation.ID || got.State != core.StateCreated || got.UpdatedAt != 100 {
		t.Fatalf("operación creada = %+v", got)
	}
	if got.QusdAmount.Cmp(operation.QusdAmount) != 0 ||
		got.FiatAmount.Cmp(operation.FiatAmount) != 0 {
		t.Fatalf("importes alterados: %+v", got)
	}

	reserved, err := repository.Transition(ctx, "op-1", core.StateReserved, 200)
	if err != nil {
		t.Fatal(err)
	}
	if reserved.State != core.StateReserved || reserved.UpdatedAt != 200 {
		t.Fatalf("transición = %+v", reserved)
	}
	persisted, err := repository.Get(ctx, "op-1")
	if err != nil {
		t.Fatal(err)
	}
	if persisted.State != core.StateReserved || persisted.UpdatedAt != 200 {
		t.Fatalf("transición no persistida = %+v", persisted)
	}

	submitted, err := repository.Transition(ctx, "op-1", core.StateSubmitted, 300)
	if err != nil {
		t.Fatal(err)
	}
	if submitted.State != core.StateSubmitted || submitted.UpdatedAt != 300 {
		t.Fatalf("segunda transición = %+v", submitted)
	}
	if submitted.QusdAmount.Cmp(operation.QusdAmount) != 0 ||
		submitted.FiatAmount.Cmp(operation.FiatAmount) != 0 {
		t.Fatalf("importes alterados tras transición: %+v", submitted)
	}

	if _, err := repository.Get(ctx, "op-inexistente"); err == nil {
		t.Fatal("Get aceptó una operación inexistente")
	}
	if _, err := repository.Transition(ctx, "op-inexistente", core.StateReserved, 400); err == nil {
		t.Fatal("Transition aceptó una operación inexistente")
	}
}

func TestCoreOperationRepositoryRejectsInvalidTransitions(t *testing.T) {
	pool := coreOperationsSetup(t)
	repository := postgres.NewCoreOperationRepository(pool)
	ctx := context.Background()

	operation := newCoreOperation(t, "op-invalid", 100)
	if err := repository.Create(ctx, operation); err != nil {
		t.Fatal(err)
	}

	// created solo puede pasar a reserved.
	if _, err := repository.Transition(ctx, "op-invalid", core.StateConfirmed, 200); err == nil {
		t.Fatal("Transition aceptó created -> confirmed")
	}
	if _, err := repository.Transition(ctx, "op-invalid", core.OperationState("teleported"), 200); err == nil {
		t.Fatal("Transition aceptó un estado desconocido")
	}
	if _, err := repository.Transition(ctx, "op-invalid", core.StateCreated, 200); err == nil {
		t.Fatal("Transition aceptó una transición no-op")
	}
	if _, err := repository.Transition(ctx, "op-invalid", core.StateReserved, 99); err == nil {
		t.Fatal("Transition aceptó un timestamp que retrocede")
	}

	persisted, err := repository.Get(ctx, "op-invalid")
	if err != nil {
		t.Fatal(err)
	}
	if persisted.State != core.StateCreated || persisted.UpdatedAt != 100 {
		t.Fatalf("una transición inválida mutó la operación: %+v", persisted)
	}

	invalid := newCoreOperation(t, "op-not-created", 100)
	invalid.State = core.StateReserved
	if err := repository.Create(ctx, invalid); err == nil {
		t.Fatal("Create aceptó una operación que no está en created")
	}
	if _, err := repository.Get(ctx, "op-not-created"); err == nil {
		t.Fatal("Create persistió una operación con estado inválido")
	}
}

func TestCoreOperationRepositoryRejectsDuplicate(t *testing.T) {
	pool := coreOperationsSetup(t)
	repository := postgres.NewCoreOperationRepository(pool)
	ctx := context.Background()

	operation := newCoreOperation(t, "op-duplicate", 100)
	if err := repository.Create(ctx, operation); err != nil {
		t.Fatal(err)
	}
	duplicate := newCoreOperation(t, "op-duplicate", 200)
	if err := repository.Create(ctx, duplicate); err == nil {
		t.Fatal("Create aceptó un operation_id duplicado")
	}

	persisted, err := repository.Get(ctx, "op-duplicate")
	if err != nil {
		t.Fatal(err)
	}
	if persisted.UpdatedAt != 100 {
		t.Fatalf("el duplicado sobrescribió la operación: %+v", persisted)
	}
}

func TestCoreOperationRepositoryTransitionConflict(t *testing.T) {
	pool := coreOperationsSetup(t)
	repository := postgres.NewCoreOperationRepository(pool)
	ctx := context.Background()

	operation := newCoreOperation(t, "op-conflict", 100)
	if err := repository.Create(ctx, operation); err != nil {
		t.Fatal(err)
	}

	dsn := os.Getenv("TEST_POSTGRES_URL")
	conn, err := pgx.Connect(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(ctx) //nolint:errcheck

	// La transacción concurrente bloquea la fila. La lectura de Transition no
	// se bloquea (MVCC), pero su UPDATE sí; así reproducimos la carrera entre
	// la lectura de version y el compare-and-swap.
	tx, err := conn.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	var version int
	if err := tx.QueryRow(ctx, `
		SELECT version FROM shadow.core_operations
		WHERE operation_id = $1
		FOR UPDATE`, operation.ID).Scan(&version); err != nil {
		t.Fatal(err)
	}

	result := make(chan error, 1)
	go func() {
		_, transitionErr := repository.Transition(ctx, operation.ID, core.StateReserved, 200)
		result <- transitionErr
	}()

	waitForBlockedCoreOperationUpdate(t, pool)

	// El ganador avanza la versión; el UPDATE pendiente ya no coincide.
	if _, err := tx.Exec(ctx, `
		UPDATE shadow.core_operations
		SET state = $2, updated_at = $3, version = version + 1
		WHERE operation_id = $1`,
		operation.ID, string(core.StateReserved), int64(200),
	); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}

	if err := <-result; !errors.Is(err, postgres.ErrCoreOperationConflict) {
		t.Fatalf("conflicto = %v, quiero %v", err, postgres.ErrCoreOperationConflict)
	}

	persisted, err := repository.Get(ctx, operation.ID)
	if err != nil {
		t.Fatal(err)
	}
	if persisted.State != core.StateReserved || persisted.UpdatedAt != 200 {
		t.Fatalf("estado tras conflicto = %+v", persisted)
	}
	var persistedVersion int
	if err := pool.QueryRow(ctx, `
		SELECT version FROM shadow.core_operations
		WHERE operation_id = $1`, operation.ID).Scan(&persistedVersion); err != nil {
		t.Fatal(err)
	}
	if persistedVersion != 2 {
		t.Fatalf("version = %d, quiero 2", persistedVersion)
	}
}

func waitForBlockedCoreOperationUpdate(t *testing.T, pool *pgxpool.Pool) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		var blocked int
		err := pool.QueryRow(context.Background(), `
			SELECT count(*)
			FROM pg_stat_activity
			WHERE datname = current_database()
			  AND state = 'active'
			  AND wait_event_type = 'Lock'
			  AND query LIKE '%UPDATE shadow.core_operations%'`).Scan(&blocked)
		if err != nil {
			t.Fatal(err)
		}
		if blocked > 0 {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatal("la actualización optimista no quedó bloqueada")
}

func TestCoreOperationRepositoryCountByState(t *testing.T) {
	pool := coreOperationsSetup(t)
	repository := postgres.NewCoreOperationRepository(pool)
	ctx := context.Background()

	if err := repository.Create(ctx, newCoreOperation(t, "op-created", 100)); err != nil {
		t.Fatal(err)
	}
	if err := repository.Create(ctx, newCoreOperation(t, "op-reserved", 100)); err != nil {
		t.Fatal(err)
	}
	if err := repository.Create(ctx, newCoreOperation(t, "op-submitted", 100)); err != nil {
		t.Fatal(err)
	}
	if _, err := repository.Transition(ctx, "op-reserved", core.StateReserved, 110); err != nil {
		t.Fatal(err)
	}
	if _, err := repository.Transition(ctx, "op-submitted", core.StateReserved, 110); err != nil {
		t.Fatal(err)
	}
	if _, err := repository.Transition(ctx, "op-submitted", core.StateSubmitted, 120); err != nil {
		t.Fatal(err)
	}

	counts, err := repository.CountByState(ctx)
	if err != nil {
		t.Fatal(err)
	}
	want := map[core.OperationState]int64{
		core.StateCreated:   1,
		core.StateReserved:  1,
		core.StateSubmitted: 1,
	}
	if !maps.Equal(counts, want) {
		t.Fatalf("counts = %v, quiero %v", counts, want)
	}
}

func TestActiveForOfferBloqueaHastaTerminarLaOperacionLocal(t *testing.T) {
	pool := coreOperationsSetup(t)
	repository := postgres.NewCoreOperationRepository(pool)
	ctx := context.Background()
	offer := "offer-active-test"
	operation := newCoreOperation(t, "op-active-test", 100)
	operation.State = core.StateReserved
	if err := repository.Create(ctx, operation); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO shadow.core_decisions
			(event_id, offer_uuid, coin, side, hunter_decision, core_kind,
			 allowed, amount, receive, rate, reason, checks_json, created_at)
		VALUES ($1, $2, 'BANK_CUP', 'buy', 'auto_buy', 'apply', true,
			'10', '11', '1.1', 'test', 'null', 100)`, operation.ID, offer); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO shadow.local_operations
			(uuid, offer_type, coin, amount, receive, rate, state, auto_applied,
			 order_uuid, created_at, updated_at)
		VALUES ($1, 'sell', 'BANK_CUP', 10, 11, 1.1, 'applied', true, '', 100, 100)`,
		offer); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `DELETE FROM shadow.local_operations WHERE uuid = $1`, offer)
		_, _ = pool.Exec(context.Background(), `DELETE FROM shadow.core_decisions WHERE offer_uuid = $1`, offer)
	})
	if active, err := repository.ActiveForOffer(ctx, offer); err != nil || !active {
		t.Fatalf("con operación applied debe bloquear: active=%v err=%v", active, err)
	}
	if _, err := pool.Exec(ctx, `UPDATE shadow.local_operations SET state='completed' WHERE uuid=$1`, offer); err != nil {
		t.Fatal(err)
	}
	if active, err := repository.ActiveForOffer(ctx, offer); err != nil || active {
		t.Fatalf("con operación terminada no debe bloquear: active=%v err=%v", active, err)
	}
}
