package postgres

import (
	"context"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// HunterEvent es un candidato durable producido por el servicio hunter.
type HunterEvent struct {
	EventID     string
	PayloadJSON string
	Attempts    int
}

// HunterEventRepository implementa el claim idempotente de la cola.
type HunterEventRepository struct {
	pool *pgxpool.Pool
}

// NewHunterEventRepository crea el repositorio.
func NewHunterEventRepository(pool *pgxpool.Pool) *HunterEventRepository {
	return &HunterEventRepository{pool: pool}
}

// Claim reclama hasta limit eventos disponibles. Usa SKIP LOCKED para que
// varios consumidores no procesen el mismo evento.
func (repository *HunterEventRepository) Claim(
	ctx context.Context,
	worker string,
	nowMS int64,
	limit int,
) ([]HunterEvent, error) {
	if limit <= 0 {
		return []HunterEvent{}, nil
	}
	rows, err := repository.pool.Query(ctx, `
		WITH due AS (
			SELECT event_id
			FROM shadow.hunter_events
			WHERE state IN ('pending', 'failed')
			  AND available_at <= $1
			  AND attempts < 10
			ORDER BY available_at, created_at
			FOR UPDATE SKIP LOCKED
			LIMIT $2
		)
		UPDATE shadow.hunter_events e
		SET state = 'claimed', claimed_by = $3, claimed_at = $1,
		    attempts = e.attempts + 1
		FROM due
		WHERE e.event_id = due.event_id
		RETURNING e.event_id, e.payload_json, e.attempts`,
		nowMS, limit, worker,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	events := make([]HunterEvent, 0, limit)
	for rows.Next() {
		var event HunterEvent
		if err := rows.Scan(&event.EventID, &event.PayloadJSON, &event.Attempts); err != nil {
			return nil, err
		}
		events = append(events, event)
	}
	return events, rows.Err()
}

// Complete marca un evento como procesado.
func (repository *HunterEventRepository) Complete(ctx context.Context, eventID string, nowMS int64) error {
	tag, err := repository.pool.Exec(ctx, `
		UPDATE shadow.hunter_events
		SET state = 'processed', processed_at = $2, last_error = NULL
		WHERE event_id = $1 AND state = 'claimed'`,
		eventID, nowMS,
	)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return fmt.Errorf("evento hunter %s no está reclamado", eventID)
	}
	return nil
}

// Fail devuelve un evento a la cola con backoff exponencial.
func (repository *HunterEventRepository) Fail(
	ctx context.Context,
	eventID string,
	attempts int,
	nowMS int64,
	reason string,
) error {
	if attempts < 1 {
		attempts = 1
	}
	if attempts > 7 {
		attempts = 7
	}
	backoff := int64(1000) << uint(attempts)
	availableAt := nowMS + backoff
	_, err := repository.pool.Exec(ctx, `
		UPDATE shadow.hunter_events
		SET state = 'failed', last_error = $2, available_at = $3,
		    claimed_by = NULL, claimed_at = NULL
		WHERE event_id = $1`,
		eventID, truncate(reason, 1000), availableAt,
	)
	return err
}

// Pending cuenta eventos pendientes o reintentables.
func (repository *HunterEventRepository) Pending(ctx context.Context) (int64, error) {
	var count int64
	err := repository.pool.QueryRow(ctx, `
		SELECT count(*) FROM shadow.hunter_events
		WHERE state IN ('pending', 'failed')`).Scan(&count)
	return count, err
}

func truncate(value string, max int) string {
	if len(value) <= max {
		return value
	}
	return value[:max]
}

// NowMS facilita pruebas deterministas.
func NowMS() int64 { return time.Now().UnixMilli() }
