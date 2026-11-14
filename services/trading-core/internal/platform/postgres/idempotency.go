package postgres

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/AGR55/QvaApp/services/trading-core/internal/platform/idempotency"
)

// IdempotencyRepository persiste claves idempotentes.
type IdempotencyRepository struct {
	pool *pgxpool.Pool
}

// NewIdempotencyRepository crea el repositorio.
func NewIdempotencyRepository(pool *pgxpool.Pool) *IdempotencyRepository {
	return &IdempotencyRepository{pool: pool}
}

// Claim reclama una clave o explica el estado existente.
func (repository *IdempotencyRepository) Claim(ctx context.Context, scope, key, hash string, now, ttlMs int64) (idempotency.Record, idempotency.ClaimStatus, error) {
	tx, err := repository.pool.Begin(ctx)
	if err != nil {
		return idempotency.Record{}, "", err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	record, err := scanIdempotency(tx.QueryRow(ctx, `
		SELECT scope, key, request_hash, state, COALESCE(response_json, ''),
			created_at, updated_at, COALESCE(expires_at, 0)
		FROM core.idempotency_keys
		WHERE scope = $1 AND key = $2
		FOR UPDATE`, scope, key))
	if errors.Is(err, pgx.ErrNoRows) {
		expiresAt := int64(0)
		if ttlMs > 0 {
			expiresAt = now + ttlMs
		}
		record, err = scanIdempotency(tx.QueryRow(ctx, `
			INSERT INTO core.idempotency_keys
				(scope, key, request_hash, state, created_at, updated_at, expires_at)
			VALUES ($1, $2, $3, 'reserved', $4, $4, $5)
			RETURNING scope, key, request_hash, state, COALESCE(response_json, ''),
				created_at, updated_at, COALESCE(expires_at, 0)`,
			scope, key, hash, now, expiresAt))
		if err != nil {
			return idempotency.Record{}, "", err
		}
		if err := tx.Commit(ctx); err != nil {
			return idempotency.Record{}, "", err
		}
		return record, idempotency.Claimed, nil
	}
	if err != nil {
		return idempotency.Record{}, "", err
	}

	expired := record.ExpiresAt == 0 || record.ExpiresAt <= now
	if !expired {
		if record.RequestHash != hash {
			return record, idempotency.Conflict, nil
		}
		switch record.State {
		case idempotency.Completed:
			return record, idempotency.Replay, nil
		case idempotency.Reserved:
			return record, idempotency.InProgress, nil
		case idempotency.Failed:
			// Reintento explícito.
		default:
			return record, idempotency.Conflict, nil
		}
	}

	expiresAt := int64(0)
	if ttlMs > 0 {
		expiresAt = now + ttlMs
	}
	record, err = scanIdempotency(tx.QueryRow(ctx, `
		UPDATE core.idempotency_keys
		SET request_hash = $3, state = 'reserved', response_json = NULL,
			created_at = $4, updated_at = $4, expires_at = $5
		WHERE scope = $1 AND key = $2
		RETURNING scope, key, request_hash, state, COALESCE(response_json, ''),
			created_at, updated_at, COALESCE(expires_at, 0)`,
		scope, key, hash, now, expiresAt))
	if err != nil {
		return idempotency.Record{}, "", err
	}
	if err := tx.Commit(ctx); err != nil {
		return idempotency.Record{}, "", err
	}
	return record, idempotency.Claimed, nil
}

// Complete guarda la respuesta.
func (repository *IdempotencyRepository) Complete(ctx context.Context, scope, key, responseJSON string, now int64) (bool, error) {
	tag, err := repository.pool.Exec(ctx, `
		UPDATE core.idempotency_keys
		SET state = 'completed', response_json = $3, updated_at = $4
		WHERE scope = $1 AND key = $2 AND state = 'reserved'`,
		scope, key, responseJSON, now,
	)
	if err != nil {
		return false, err
	}
	return tag.RowsAffected() == 1, nil
}

// Fail marca la clave fallida para permitir reintento.
func (repository *IdempotencyRepository) Fail(ctx context.Context, scope, key string, now int64) (bool, error) {
	tag, err := repository.pool.Exec(ctx, `
		UPDATE core.idempotency_keys
		SET state = 'failed', updated_at = $3
		WHERE scope = $1 AND key = $2 AND state = 'reserved'`,
		scope, key, now,
	)
	if err != nil {
		return false, err
	}
	return tag.RowsAffected() == 1, nil
}

func scanIdempotency(row rowScanner) (idempotency.Record, error) {
	var record idempotency.Record
	var state string
	if err := row.Scan(
		&record.Scope, &record.Key, &record.RequestHash, &state,
		&record.ResponseJSON, &record.CreatedAt, &record.UpdatedAt, &record.ExpiresAt,
	); err != nil {
		return idempotency.Record{}, err
	}
	record.State = idempotency.State(state)
	return record, nil
}
