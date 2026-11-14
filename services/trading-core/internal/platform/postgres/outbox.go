package postgres

import (
	"context"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/AGR55/QvaApp/services/trading-core/internal/platform/outbox"
)

type execer interface {
	Exec(ctx context.Context, sql string, arguments ...any) (pgconn.CommandTag, error)
}

// OutboxRepository persiste el outbox transaccional.
type OutboxRepository struct {
	pool *pgxpool.Pool
}

// NewOutboxRepository crea el repositorio.
func NewOutboxRepository(pool *pgxpool.Pool) *OutboxRepository {
	return &OutboxRepository{pool: pool}
}

// Insert añade un mensaje; devuelve false si la idempotency_key ya existía.
func (repository *OutboxRepository) Insert(ctx context.Context, message outbox.Message) (bool, error) {
	return insertOutbox(ctx, repository.pool, message)
}

// InsertTx añade un mensaje dentro de una transacción de negocio.
func (repository *OutboxRepository) InsertTx(ctx context.Context, tx pgx.Tx, message outbox.Message) (bool, error) {
	return insertOutbox(ctx, tx, message)
}

func insertOutbox(ctx context.Context, executor execer, message outbox.Message) (bool, error) {
	state := message.State
	if state == "" {
		state = outbox.Pending
	}
	tag, err := executor.Exec(ctx, `
		INSERT INTO core.outbox
			(id, topic, payload_json, idempotency_key, state, attempts, available_at, created_at)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
		ON CONFLICT (idempotency_key) DO NOTHING`,
		message.ID, message.Topic, message.PayloadJSON, message.IdempotencyKey,
		string(state), message.Attempts, message.AvailableAt, message.CreatedAt,
	)
	if err != nil {
		return false, err
	}
	return tag.RowsAffected() == 1, nil
}

// ClaimDue reclama hasta `limit` mensajes pendientes con SKIP LOCKED.
func (repository *OutboxRepository) ClaimDue(ctx context.Context, worker string, now, leaseMs int64, limit int) ([]outbox.Message, error) {
	rows, err := repository.pool.Query(ctx, `
		UPDATE core.outbox
		SET state = 'in_flight', attempts = attempts + 1, locked_by = $1, locked_at = $2
		WHERE id IN (
			SELECT id FROM core.outbox
			WHERE (state = 'pending' AND available_at <= $2)
			   OR (state = 'in_flight' AND locked_at IS NOT NULL AND locked_at + $4 <= $2)
			ORDER BY available_at, id
			FOR UPDATE SKIP LOCKED
			LIMIT $3
		)
		RETURNING id, topic, payload_json, idempotency_key, state, attempts,
			available_at, COALESCE(locked_by, ''), COALESCE(locked_at, 0),
			COALESCE(last_error, ''), created_at`,
		worker, now, limit, leaseMs,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	messages := make([]outbox.Message, 0, limit)
	for rows.Next() {
		message, err := scanOutbox(rows)
		if err != nil {
			return nil, err
		}
		messages = append(messages, message)
	}
	return messages, rows.Err()
}

// Complete publica el mensaje si sigue bloqueado por el worker.
func (repository *OutboxRepository) Complete(ctx context.Context, id, worker string, now int64) (bool, error) {
	tag, err := repository.pool.Exec(ctx, `
		UPDATE core.outbox
		SET state = 'published', locked_by = NULL, locked_at = NULL, last_error = NULL, available_at = $3
		WHERE id = $1 AND state = 'in_flight' AND locked_by = $2`,
		id, worker, now,
	)
	if err != nil {
		return false, err
	}
	return tag.RowsAffected() == 1, nil
}

// Fail devuelve el mensaje a pendiente o lo marca fallido tras el máximo.
func (repository *OutboxRepository) Fail(ctx context.Context, id, worker, reason string, now, retryAt int64, maxAttempts int) (outbox.State, error) {
	var state string
	err := repository.pool.QueryRow(ctx, `
		UPDATE core.outbox
		SET state = CASE WHEN $4 > 0 AND attempts >= $4 THEN 'failed' ELSE 'pending' END,
			available_at = CASE WHEN $4 > 0 AND attempts >= $4 THEN 0 ELSE $5 END,
			locked_by = NULL, locked_at = NULL, last_error = $3
		WHERE id = $1 AND state = 'in_flight' AND locked_by = $2
		RETURNING state`,
		id, worker, reason, maxAttempts, retryAt,
	).Scan(&state)
	if err != nil {
		return "", err
	}
	return outbox.State(state), nil
}

type rowScanner interface {
	Scan(dest ...any) error
}

func scanOutbox(row rowScanner) (outbox.Message, error) {
	var message outbox.Message
	var state string
	var lockedAt int64
	if err := row.Scan(
		&message.ID, &message.Topic, &message.PayloadJSON, &message.IdempotencyKey,
		&state, &message.Attempts, &message.AvailableAt, &message.LockedBy,
		&lockedAt, &message.LastError, &message.CreatedAt,
	); err != nil {
		return outbox.Message{}, err
	}
	message.State = outbox.State(state)
	if lockedAt > 0 {
		message.LockedAt = &lockedAt
	}
	return message, nil
}
