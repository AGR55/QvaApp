package main

import (
	"context"
	"encoding/json"
	"errors"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type telegramInbox struct {
	pool *pgxpool.Pool
}

func (inbox *telegramInbox) Store(ctx context.Context, updates []json.RawMessage) (int64, bool, error) {
	if inbox == nil || inbox.pool == nil {
		return 0, false, errors.New("telegram inbox sin Postgres")
	}
	if _, err := inbox.pool.Exec(ctx, `
		DELETE FROM shadow.telegram_update_inbox
		WHERE state = 'processed' AND updated_at <
			(extract(epoch from now()) * 1000)::bigint - 90 * 24 * 60 * 60 * 1000`); err != nil {
		return 0, false, err
	}
	var maxID int64
	stored := false
	for _, raw := range updates {
		var update struct {
			ID *int64 `json:"update_id"`
		}
		if err := json.Unmarshal(raw, &update); err != nil {
			return 0, false, err
		}
		if update.ID == nil || *update.ID < 0 {
			return 0, false, errors.New("update de Telegram sin update_id válido")
		}
		if _, err := inbox.pool.Exec(ctx, `
			INSERT INTO shadow.telegram_update_inbox (update_id, payload_json, state, created_at, updated_at)
			VALUES ($1, $2::jsonb, 'pending', (extract(epoch from now()) * 1000)::bigint,
				(extract(epoch from now()) * 1000)::bigint)
			ON CONFLICT (update_id) DO NOTHING`, *update.ID, string(raw)); err != nil {
			return 0, false, err
		}
		if !stored || *update.ID > maxID {
			maxID = *update.ID
		}
		stored = true
	}
	return maxID, stored, nil
}

// Claim durably marks an update before executing its command. A claimed row is
// never automatically replayed after a crash, avoiding duplicate mutations.
func (inbox *telegramInbox) Claim(ctx context.Context) (int64, json.RawMessage, error) {
	if inbox == nil || inbox.pool == nil {
		return 0, nil, errors.New("telegram inbox sin Postgres")
	}
	var id int64
	var payload []byte
	err := inbox.pool.QueryRow(ctx, `
		WITH next_update AS (
			SELECT update_id FROM shadow.telegram_update_inbox
			WHERE state = 'pending'
			ORDER BY update_id
			FOR UPDATE SKIP LOCKED
			LIMIT 1
		)
		UPDATE shadow.telegram_update_inbox AS inbox
		SET state = 'processing', updated_at = (extract(epoch from now()) * 1000)::bigint
		FROM next_update
		WHERE inbox.update_id = next_update.update_id
		RETURNING inbox.update_id, inbox.payload_json`,
	).Scan(&id, &payload)
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, nil, nil
	}
	return id, payload, err
}

func (inbox *telegramInbox) Finish(ctx context.Context, id int64, handled bool) error {
	state := "processed"
	if !handled {
		state = "uncertain"
	}
	command, err := inbox.pool.Exec(ctx, `
		UPDATE shadow.telegram_update_inbox
		SET state = $2, updated_at = (extract(epoch from now()) * 1000)::bigint
		WHERE update_id = $1 AND state = 'processing'`, id, state)
	if err != nil {
		return err
	}
	if command.RowsAffected() != 1 {
		return errors.New("telegram inbox no pudo cerrar el update reclamado")
	}
	return nil
}

func (inbox *telegramInbox) MarkInterruptedUncertain(ctx context.Context) error {
	if inbox == nil || inbox.pool == nil {
		return errors.New("telegram inbox sin Postgres")
	}
	_, err := inbox.pool.Exec(ctx, `
		UPDATE shadow.telegram_update_inbox
		SET state = 'uncertain', updated_at = (extract(epoch from now()) * 1000)::bigint
		WHERE state = 'processing'`)
	return err
}
