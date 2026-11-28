// Worker shadow de operaciones core.
//
// Reclama operaciones en estado reserved y las lleva por el ciclo remoto sin
// hablar con QvaPay ni mover dinero. El remoto es inyectable y, por defecto,
// un no-op que confirma la operación. El worker no se arranca desde main.go:
// la integración con el servicio queda fuera de este fichero.
package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"sync/atomic"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/AGR55/QvaApp/services/shared/decimal"
	"github.com/AGR55/QvaApp/services/trading-core/internal/core"
	"github.com/AGR55/QvaApp/services/trading-core/internal/platform/postgres"
)

const (
	defaultOperationInterval   = time.Second
	defaultOperationClaimLimit = 25
	operationTransitionRetries = 3
)

// shadowRemote es el remoto por defecto del worker. Confirma toda operación
// con una referencia opaca y nunca llama a QvaPay: es un no-op puro.
type shadowRemote struct{}

// Submit devuelve siempre un resultado confirmado. No hace I/O.
func (shadowRemote) Submit(context.Context, core.Operation) (core.RemoteResult, error) {
	return core.RemoteResult{
		Confirmed: true,
		Reference: "shadow-noop",
	}, nil
}

// operationWorker reclama operaciones reserved y persiste su ciclo de vida.
// processed cuenta las operaciones cuyo estado final se persistió; failed
// cuenta los fallos de claim, remoto o persistencia.
type operationWorker struct {
	pool       *pgxpool.Pool
	logger     *slog.Logger
	interval   time.Duration
	claimLimit int
	remote     core.Remote
	now        func() int64
	repository *postgres.CoreOperationRepository
	processed  atomic.Uint64
	failed     atomic.Uint64
}

// newOperationWorker construye el worker con el remoto shadow y el reloj de
// Postgres. No arranca nada: el llamador decide cuándo ejecutar run(ctx).
func newOperationWorker(pool *pgxpool.Pool, logger *slog.Logger) *operationWorker {
	if logger == nil {
		logger = slog.Default()
	}
	return &operationWorker{
		pool:       pool,
		logger:     logger,
		interval:   defaultOperationInterval,
		claimLimit: defaultOperationClaimLimit,
		remote:     shadowRemote{},
		now:        postgres.NowMS,
		repository: postgres.NewCoreOperationRepository(pool),
	}
}

// run procesa operaciones hasta que el contexto se cancela.
func (worker *operationWorker) run(ctx context.Context) {
	interval := worker.interval
	if interval <= 0 {
		interval = defaultOperationInterval
	}
	ticker := time.NewTicker(interval)
	defer ticker.Stop()

	for {
		worker.tick(ctx)

		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

// tick reclama y ejecuta un lote de operaciones reserved.
func (worker *operationWorker) tick(ctx context.Context) {
	operations, err := worker.claim(ctx, worker.now())
	if err != nil {
		if ctx.Err() == nil {
			worker.failed.Add(1)
			worker.logger.Warn("claim de operaciones core falló", "error", err)
		}
		return
	}

	for _, operation := range operations {
		if ctx.Err() != nil {
			return
		}
		worker.execute(ctx, operation)
	}
}

type operationCandidate struct {
	id        string
	qusdText  string
	fiatText  string
	updatedAt int64
	version   int
}

// claim reclama hasta claimLimit operaciones reserved.
//
// El SELECT ... FOR UPDATE SKIP LOCKED y el paso a submitted ocurren en la
// misma transacción: la fila queda bloqueada hasta el commit y otro worker no
// puede reclamarla. Las operaciones que otro worker ya bloqueó se saltan y se
// reintentarán en la siguiente vuelta. El estado submitted se persiste con
// compare-and-swap sobre version para no pisar una transición concurrente.
func (worker *operationWorker) claim(ctx context.Context, now int64) ([]core.Operation, error) {
	limit := worker.claimLimit
	if limit <= 0 {
		return nil, nil
	}

	tx, err := worker.pool.Begin(ctx)
	if err != nil {
		return nil, fmt.Errorf("iniciar claim de operaciones core: %w", err)
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	rows, err := tx.Query(ctx, `
		SELECT operation_id, qusd_amount, fiat_amount, updated_at, version
		FROM shadow.core_operations
		WHERE state = $1
		ORDER BY updated_at, operation_id
		FOR UPDATE SKIP LOCKED
		LIMIT $2`,
		string(core.StateReserved), limit,
	)
	if err != nil {
		return nil, fmt.Errorf("seleccionar operaciones core reservadas: %w", err)
	}

	candidates := make([]operationCandidate, 0, limit)
	for rows.Next() {
		var candidate operationCandidate
		if err := rows.Scan(
			&candidate.id,
			&candidate.qusdText,
			&candidate.fiatText,
			&candidate.updatedAt,
			&candidate.version,
		); err != nil {
			rows.Close()
			return nil, fmt.Errorf("leer operación core reservada: %w", err)
		}
		candidates = append(candidates, candidate)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("leer operaciones core reservadas: %w", err)
	}

	claimed := make([]core.Operation, 0, len(candidates))
	for _, candidate := range candidates {
		operation, err := decodeOperationCandidate(candidate)
		if err != nil {
			worker.failed.Add(1)
			worker.logger.Warn("operación core reservada inválida",
				"operation_id", candidate.id, "error", err)
			continue
		}

		submittedAt := now
		if submittedAt < operation.UpdatedAt {
			submittedAt = operation.UpdatedAt
		}
		submitted, err := operation.Transition(core.StateSubmitted, submittedAt)
		if err != nil {
			worker.failed.Add(1)
			worker.logger.Warn("no se pudo marcar la operación core como submitted",
				"operation_id", candidate.id, "error", err)
			continue
		}

		tag, err := tx.Exec(ctx, `
			UPDATE shadow.core_operations
			SET state = $3, updated_at = $4, version = version + 1
			WHERE operation_id = $1 AND version = $2 AND state = $5`,
			candidate.id, candidate.version,
			string(submitted.State), submitted.UpdatedAt,
			string(core.StateReserved),
		)
		if err != nil {
			return nil, fmt.Errorf("reclamar operación core %q: %w", candidate.id, err)
		}
		if tag.RowsAffected() == 0 {
			// Otra transición cambió la versión: no se aplica nada y la fila
			// se reevaluará en la siguiente vuelta.
			worker.failed.Add(1)
			worker.logger.Warn("claim de operación core perdió la carrera",
				"operation_id", candidate.id)
			continue
		}
		claimed = append(claimed, submitted)
	}

	if err := tx.Commit(ctx); err != nil {
		return nil, fmt.Errorf("confirmar claim de operaciones core: %w", err)
	}
	return claimed, nil
}

func decodeOperationCandidate(candidate operationCandidate) (core.Operation, error) {
	qusd, err := decimal.Parse(candidate.qusdText)
	if err != nil {
		return core.Operation{}, fmt.Errorf("importe QUSD inválido: %w", err)
	}
	fiat, err := decimal.Parse(candidate.fiatText)
	if err != nil {
		return core.Operation{}, fmt.Errorf("importe fiat inválido: %w", err)
	}
	return core.Operation{
		ID:         candidate.id,
		State:      core.StateReserved,
		QusdAmount: qusd,
		FiatAmount: fiat,
		UpdatedAt:  candidate.updatedAt,
	}, nil
}

// execute envía la operación al remoto y persiste el estado final. La
// operación ya está submitted: el claim la dejó así antes de llamar al remoto.
func (worker *operationWorker) execute(ctx context.Context, operation core.Operation) {
	if worker.remote == nil {
		worker.failed.Add(1)
		worker.logger.Warn("worker core sin remoto configurado",
			"operation_id", operation.ID)
		return
	}

	result, err := worker.remote.Submit(ctx, operation)
	if err != nil {
		worker.failed.Add(1)
		worker.logger.Warn("envío remoto shadow falló; operación incierta",
			"operation_id", operation.ID, "error", err)
		if persistErr := worker.persist(ctx, operation, core.StateUncertain); persistErr != nil {
			worker.logger.Warn("no se pudo persistir el estado incierto",
				"operation_id", operation.ID, "error", persistErr)
		}
		return
	}

	next := core.StateRejected
	switch {
	case result.Uncertain:
		next = core.StateUncertain
	case result.Confirmed:
		next = core.StateConfirmed
	}

	if err := worker.persist(ctx, operation, next); err != nil {
		worker.failed.Add(1)
		worker.logger.Warn("no se pudo persistir el resultado remoto shadow",
			"operation_id", operation.ID, "state", next, "error", err)
		return
	}
	worker.processed.Add(1)
}

// persist aplica la transición final con compare-and-swap. Un conflicto
// significa que otra transición ganó la carrera: se recarga la operación y se
// reintenta; la siguiente vuelta del worker también puede resolverla.
func (worker *operationWorker) persist(
	ctx context.Context,
	operation core.Operation,
	next core.OperationState,
) error {
	var lastErr error
	for attempt := 0; attempt < operationTransitionRetries; attempt++ {
		_, err := worker.repository.Transition(
			ctx,
			operation.ID,
			next,
			worker.nextTimestamp(operation.UpdatedAt),
		)
		if err == nil {
			return nil
		}
		if !errors.Is(err, postgres.ErrCoreOperationConflict) {
			return err
		}
		lastErr = err

		current, getErr := worker.repository.Get(ctx, operation.ID)
		if getErr != nil {
			return getErr
		}
		if current.State != core.StateSubmitted {
			// Otra transición ya resolvió la operación (por ejemplo,
			// conciliación); no hay nada más que persistir aquí.
			return nil
		}
		operation = current
	}
	return fmt.Errorf(
		"operación core %q: conflicto persistente al pasar a %q: %w",
		operation.ID, next, lastErr,
	)
}

// nextTimestamp nunca retrocede: si el reloj devuelve un instante anterior al
// último conocido, conserva el último (la máquina de estados acepta iguales).
func (worker *operationWorker) nextTimestamp(previous int64) int64 {
	now := worker.now()
	if now < previous {
		return previous
	}
	return now
}
