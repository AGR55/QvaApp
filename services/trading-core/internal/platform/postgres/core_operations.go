package postgres

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/AGR55/QvaApp/services/shared/decimal"
	"github.com/AGR55/QvaApp/services/trading-core/internal/core"
)

// ErrCoreOperationConflict indica que la operación cambió entre la lectura y
// la escritura: otra transición ganó la carrera por la misma versión.
var ErrCoreOperationConflict = errors.New("conflicto concurrente: la operación core cambió de versión")

// CoreOperationRepository persiste operaciones shadow con transiciones
// optimistas. No mueve dinero: solo guarda el estado y los importes exactos.
type CoreOperationRepository struct {
	pool *pgxpool.Pool
}

// NewCoreOperationRepository crea el repositorio.
func NewCoreOperationRepository(pool *pgxpool.Pool) *CoreOperationRepository {
	return &CoreOperationRepository{pool: pool}
}

// Create inserta una operación nueva. Solo acepta operaciones en estado
// created y falla si el operation_id ya existe.
func (repository *CoreOperationRepository) Create(ctx context.Context, operation core.Operation) error {
	if operation.State != core.StateCreated {
		return fmt.Errorf(
			"operación core %q: solo se puede crear en estado %q, recibido %q",
			operation.ID, core.StateCreated, operation.State,
		)
	}
	tag, err := repository.pool.Exec(ctx, `
		INSERT INTO shadow.core_operations
			(operation_id, state, qusd_amount, fiat_amount, updated_at, created_at)
		VALUES ($1, $2, $3, $4, $5, $5)
		ON CONFLICT (operation_id) DO NOTHING`,
		operation.ID, string(operation.State),
		operation.QusdAmount.Format(8), operation.FiatAmount.Format(8),
		operation.UpdatedAt,
	)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return fmt.Errorf("operación core %q ya existe", operation.ID)
	}
	return nil
}

// Get devuelve la operación persistida. Falla si no existe.
func (repository *CoreOperationRepository) Get(ctx context.Context, id string) (core.Operation, error) {
	operation, _, err := repository.load(ctx, id)
	if err != nil {
		return core.Operation{}, err
	}
	return operation, nil
}

// Transition valida next con la máquina de estados del core y persiste el
// cambio con compare-and-swap sobre version. Si la fila cambió desde la
// lectura, devuelve ErrCoreOperationConflict y no aplica nada.
func (repository *CoreOperationRepository) Transition(
	ctx context.Context,
	id string,
	next core.OperationState,
	now int64,
) (core.Operation, error) {
	current, version, err := repository.load(ctx, id)
	if err != nil {
		return core.Operation{}, err
	}
	updated, err := current.Transition(next, now)
	if err != nil {
		return core.Operation{}, err
	}
	tag, err := repository.pool.Exec(ctx, `
		UPDATE shadow.core_operations
		SET state = $3, updated_at = $4, version = version + 1
		WHERE operation_id = $1 AND version = $2`,
		id, version, string(updated.State), updated.UpdatedAt,
	)
	if err != nil {
		return core.Operation{}, err
	}
	if tag.RowsAffected() == 0 {
		return core.Operation{}, fmt.Errorf("operación core %q: %w", id, ErrCoreOperationConflict)
	}
	return updated, nil
}

// CountByState cuenta las operaciones agrupadas por estado.
func (repository *CoreOperationRepository) CountByState(
	ctx context.Context,
) (map[core.OperationState]int64, error) {
	rows, err := repository.pool.Query(ctx, `
		SELECT state, count(*)
		FROM shadow.core_operations
		GROUP BY state`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	counts := make(map[core.OperationState]int64)
	for rows.Next() {
		var state string
		var count int64
		if err := rows.Scan(&state, &count); err != nil {
			return nil, err
		}
		counts[core.OperationState(state)] = count
	}
	return counts, rows.Err()
}

// Usage devuelve la exposición y el volumen ya usados, calculados desde las
// operaciones persistentes. dailySinceMS marca el inicio del día en UTC.
func (repository *CoreOperationRepository) Usage(
	ctx context.Context,
	dailySinceMS int64,
) (core.Usage, error) {
	var exposureText, dailyText string
	var active int64
	err := repository.pool.QueryRow(ctx, `
		SELECT
			COALESCE(SUM(qusd_amount::numeric) FILTER (
				WHERE state IN ('reserved', 'submitted', 'uncertain')
			), 0)::text,
			COALESCE(SUM(qusd_amount::numeric) FILTER (
				WHERE state IN ('confirmed', 'reconciled') AND updated_at >= $1
			), 0)::text,
			COUNT(*) FILTER (
				WHERE state IN ('reserved', 'submitted', 'uncertain')
			)
		FROM shadow.core_operations`,
		dailySinceMS,
	).Scan(&exposureText, &dailyText, &active)
	if err != nil {
		return core.Usage{}, err
	}
	exposure, err := decimal.Parse(exposureText)
	if err != nil {
		return core.Usage{}, fmt.Errorf("exposición core inválida: %w", err)
	}
	daily, err := decimal.Parse(dailyText)
	if err != nil {
		return core.Usage{}, fmt.Errorf("volumen diario core inválido: %w", err)
	}
	return core.Usage{
		ConcurrentQusdExposure: exposure,
		DailyAppliedQusd:       daily,
		ActiveOperations:       decimal.FromInt(active),
	}, nil
}

// load lee una operación y su versión actual. Los importes se persisten como
// texto y se reconstruyen con decimal.Parse, sin pasar por float64.
func (repository *CoreOperationRepository) load(
	ctx context.Context,
	id string,
) (core.Operation, int, error) {
	var state, qusdText, fiatText string
	var updatedAt int64
	var version int
	err := repository.pool.QueryRow(ctx, `
		SELECT state, qusd_amount, fiat_amount, updated_at, version
		FROM shadow.core_operations
		WHERE operation_id = $1`,
		id,
	).Scan(&state, &qusdText, &fiatText, &updatedAt, &version)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return core.Operation{}, 0, fmt.Errorf("operación core %q no existe: %w", id, err)
		}
		return core.Operation{}, 0, err
	}
	qusd, err := decimal.Parse(qusdText)
	if err != nil {
		return core.Operation{}, 0, fmt.Errorf("operación core %q: importe QUSD inválido: %w", id, err)
	}
	fiat, err := decimal.Parse(fiatText)
	if err != nil {
		return core.Operation{}, 0, fmt.Errorf("operación core %q: importe fiat inválido: %w", id, err)
	}
	return core.Operation{
		ID:         id,
		State:      core.OperationState(state),
		QusdAmount: qusd,
		FiatAmount: fiat,
		UpdatedAt:  updatedAt,
	}, version, nil
}
