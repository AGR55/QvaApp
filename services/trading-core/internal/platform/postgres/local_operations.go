package postgres

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// LocalOperation es la vista que consume el panel web para operaciones. Une
// las operaciones importadas de TS y las que crea el motor Go.
type LocalOperation struct {
	UUID           string
	OfferType      string
	Coin           string
	Amount         float64
	Receive        float64
	Rate           float64
	State          string
	AutoApplied    bool
	OrderUUID      string
	CounterpartyID string
	CreatedAt      int64
	UpdatedAt      int64
}

// LocalOperationRepository mantiene shadow.local_operations.
type LocalOperationRepository struct {
	pool *pgxpool.Pool
}

// NewLocalOperationRepository crea el repositorio.
func NewLocalOperationRepository(pool *pgxpool.Pool) *LocalOperationRepository {
	return &LocalOperationRepository{pool: pool}
}

// Upsert crea o actualiza una operación. Conserva created_at y no borra el
// order_uuid existente si el nuevo viene vacío.
func (repository *LocalOperationRepository) Upsert(ctx context.Context, operation LocalOperation) error {
	if repository == nil || repository.pool == nil {
		return errors.New("local operations: repositorio sin pool")
	}
	if operation.UUID == "" {
		return errors.New("local operations: uuid vacío")
	}
	_, err := repository.pool.Exec(ctx, `
		INSERT INTO shadow.local_operations
			(uuid, offer_type, coin, amount, receive, rate, state, auto_applied,
			 order_uuid, counterparty_id, created_at, updated_at)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11)
		ON CONFLICT (uuid) DO UPDATE SET
			offer_type = EXCLUDED.offer_type,
			coin = EXCLUDED.coin,
			amount = EXCLUDED.amount,
			receive = EXCLUDED.receive,
			rate = EXCLUDED.rate,
			state = EXCLUDED.state,
			auto_applied = EXCLUDED.auto_applied,
			order_uuid = CASE WHEN EXCLUDED.order_uuid = '' THEN shadow.local_operations.order_uuid ELSE EXCLUDED.order_uuid END,
			counterparty_id = COALESCE(NULLIF(EXCLUDED.counterparty_id, ''), shadow.local_operations.counterparty_id),
			updated_at = EXCLUDED.updated_at`,
		operation.UUID, operation.OfferType, operation.Coin, operation.Amount,
		operation.Receive, operation.Rate, operation.State, operation.AutoApplied,
		operation.OrderUUID, operation.CounterpartyID, operation.UpdatedAt,
	)
	if err != nil {
		return fmt.Errorf("local operations: no se pudo guardar %q: %w", operation.UUID, err)
	}
	return nil
}

// Get devuelve una operación local. found=false si no existe.
func (repository *LocalOperationRepository) Get(ctx context.Context, uuid string) (LocalOperation, bool, error) {
	if repository == nil || repository.pool == nil {
		return LocalOperation{}, false, errors.New("local operations: repositorio sin pool")
	}
	var operation LocalOperation
	var order, counterparty *string
	err := repository.pool.QueryRow(ctx, `
		SELECT uuid, offer_type, coin, amount, receive, rate, state, auto_applied,
		       order_uuid, counterparty_id, created_at, updated_at
		FROM shadow.local_operations WHERE uuid = $1`, uuid,
	).Scan(&operation.UUID, &operation.OfferType, &operation.Coin, &operation.Amount,
		&operation.Receive, &operation.Rate, &operation.State, &operation.AutoApplied,
		&order, &counterparty, &operation.CreatedAt, &operation.UpdatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return LocalOperation{}, false, nil
	}
	if err != nil {
		return LocalOperation{}, false, err
	}
	if order != nil {
		operation.OrderUUID = *order
	}
	if counterparty != nil {
		operation.CounterpartyID = *counterparty
	}
	return operation, true, nil
}

// SetState actualiza el estado y la marca de tiempo.
func (repository *LocalOperationRepository) SetState(ctx context.Context, uuid, state string, now int64) error {
	_, err := repository.pool.Exec(ctx, `
		UPDATE shadow.local_operations SET state = $2, updated_at = $3 WHERE uuid = $1`,
		uuid, state, now,
	)
	return err
}
