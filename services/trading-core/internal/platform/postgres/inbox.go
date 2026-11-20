package postgres

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/AGR55/QvaApp/services/trading-core/internal/platform/inbox"
)

// InboxRepository persiste la deduplicación por consumidor.
type InboxRepository struct {
	pool *pgxpool.Pool
}

// NewInboxRepository crea el repositorio.
func NewInboxRepository(pool *pgxpool.Pool) *InboxRepository {
	return &InboxRepository{pool: pool}
}

// Accept registra el mensaje o devuelve el existente.
func (repository *InboxRepository) Accept(ctx context.Context, consumer, messageID string, now int64) (inbox.Record, bool, error) {
	record, err := scanInbox(repository.pool.QueryRow(ctx, `
		INSERT INTO core.inbox (consumer, message_id, state, received_at)
		VALUES ($1, $2, 'received', $3)
		ON CONFLICT (consumer, message_id) DO NOTHING
		RETURNING consumer, message_id, state, received_at,
			COALESCE(processed_at, 0), COALESCE(error, '')`,
		consumer, messageID, now,
	))
	if err == nil {
		return record, true, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return inbox.Record{}, false, err
	}
	record, err = scanInbox(repository.pool.QueryRow(ctx, `
		SELECT consumer, message_id, state, received_at,
			COALESCE(processed_at, 0), COALESCE(error, '')
		FROM core.inbox WHERE consumer = $1 AND message_id = $2`,
		consumer, messageID,
	))
	return record, false, err
}

// Complete marca el mensaje procesado.
func (repository *InboxRepository) Complete(ctx context.Context, consumer, messageID string, now int64) (bool, error) {
	tag, err := repository.pool.Exec(ctx, `
		UPDATE core.inbox SET state = 'processed', processed_at = $3, error = NULL
		WHERE consumer = $1 AND message_id = $2 AND state = 'received'`,
		consumer, messageID, now,
	)
	if err != nil {
		return false, err
	}
	return tag.RowsAffected() == 1, nil
}

// Fail marca el mensaje fallido.
func (repository *InboxRepository) Fail(ctx context.Context, consumer, messageID, reason string, now int64) (bool, error) {
	tag, err := repository.pool.Exec(ctx, `
		UPDATE core.inbox SET state = 'failed', processed_at = $4, error = $3
		WHERE consumer = $1 AND message_id = $2 AND state <> 'processed'`,
		consumer, messageID, reason, now,
	)
	if err != nil {
		return false, err
	}
	return tag.RowsAffected() == 1, nil
}

func scanInbox(row rowScanner) (inbox.Record, error) {
	var record inbox.Record
	var state string
	var processedAt int64
	if err := row.Scan(
		&record.Consumer, &record.MessageID, &state, &record.ReceivedAt,
		&processedAt, &record.Error,
	); err != nil {
		return inbox.Record{}, err
	}
	record.State = inbox.State(state)
	if processedAt > 0 {
		record.ProcessedAt = &processedAt
	}
	return record, nil
}
