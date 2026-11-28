package postgres

import (
	"context"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
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

// CoreDecision es el resultado persistido del shadow core.
type CoreDecision struct {
	EventID        string
	OfferUUID      string
	Coin           string
	Side           string
	HunterDecision string
	CoreKind       string
	Allowed        bool
	Amount         string
	Receive        string
	Rate           string
	Reason         string
	ChecksJSON     string
	CreatedAt      int64
	Execution      *CoreExecution
}

// CoreExecution es la simulación ledger de una decisión allowed.
type CoreExecution struct {
	OperationID   string
	QusdAmount    string
	ReserveQusd   string
	RemainingQusd string
	LedgerJSON    string
	Reason        string
	CreatedAt     int64
}

// CompleteWithDecision guarda la decisión y marca el evento como procesado en
// la misma transacción.
func (repository *HunterEventRepository) CompleteWithDecision(
	ctx context.Context,
	decision CoreDecision,
	processedAt int64,
) error {
	tx, err := repository.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	// Las tres escrituras se envían en un solo batch para no pagar tres
	// round trips por evento en el camino caliente.
	batch := &pgx.Batch{}
	batch.Queue(`
		INSERT INTO shadow.core_decisions
			(event_id, offer_uuid, coin, side, hunter_decision, core_kind,
			 allowed, amount, receive, rate, reason, checks_json, created_at)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
		ON CONFLICT (event_id) DO UPDATE SET
			core_kind = excluded.core_kind,
			allowed = excluded.allowed,
			reason = excluded.reason,
			checks_json = excluded.checks_json,
			created_at = excluded.created_at`,
		decision.EventID, decision.OfferUUID, decision.Coin, decision.Side,
		decision.HunterDecision, decision.CoreKind, decision.Allowed,
		decision.Amount, decision.Receive, decision.Rate, decision.Reason,
		decision.ChecksJSON, decision.CreatedAt,
	)
	if decision.Execution != nil {
		batch.Queue(`
			INSERT INTO shadow.core_executions
				(event_id, operation_id, qusd_amount, reserve_qusd, remaining_qusd,
				 ledger_json, reason, created_at)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
			ON CONFLICT (event_id) DO UPDATE SET
				operation_id = excluded.operation_id,
				qusd_amount = excluded.qusd_amount,
				reserve_qusd = excluded.reserve_qusd,
				remaining_qusd = excluded.remaining_qusd,
				ledger_json = excluded.ledger_json,
				reason = excluded.reason,
				created_at = excluded.created_at`,
			decision.EventID, decision.Execution.OperationID,
			decision.Execution.QusdAmount, decision.Execution.ReserveQusd,
			decision.Execution.RemainingQusd, decision.Execution.LedgerJSON,
			decision.Execution.Reason, decision.Execution.CreatedAt,
		)
	}
	batch.Queue(`
		UPDATE shadow.hunter_events
		SET state = 'processed', processed_at = $2, last_error = NULL
		WHERE event_id = $1 AND state = 'claimed'`,
		decision.EventID, processedAt,
	)
	results := tx.SendBatch(ctx, batch)
	var lastTag interface{ RowsAffected() int64 }
	for index := 0; index < batch.Len(); index++ {
		tag, execErr := results.Exec()
		if execErr != nil {
			_ = results.Close()
			return execErr
		}
		lastTag = tag
	}
	if closeErr := results.Close(); closeErr != nil {
		return closeErr
	}
	if lastTag != nil && lastTag.RowsAffected() == 0 {
		return fmt.Errorf("evento hunter %s no está reclamado", decision.EventID)
	}
	return tx.Commit(ctx)
}
