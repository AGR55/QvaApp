package runtimeconfig

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Revision es una entrada del historial de configuraciones guardadas.
type Revision struct {
	Version   int64  `json:"version"`
	Config    Config `json:"config"`
	Reason    string `json:"reason"`
	Actor     string `json:"actor"`
	CreatedAt int64  `json:"createdAt"`
}

// Repository persiste la configuración y su historial en las tablas shadow.
type Repository struct {
	Pool *pgxpool.Pool
}

// Load devuelve la configuración vigente y su versión. Si todavía no hay fila
// devuelve ErrNotFound.
func (repository *Repository) Load(ctx context.Context) (Config, int64, error) {
	if repository == nil || repository.Pool == nil {
		return Config{}, 0, errors.New("runtimeconfig: repositorio sin pool")
	}

	var (
		payload []byte
		version int64
	)
	err := repository.Pool.QueryRow(ctx, `
		SELECT config_json, version
		FROM shadow.runtime_config
		WHERE id = 1`,
	).Scan(&payload, &version)
	if errors.Is(err, pgx.ErrNoRows) {
		return Config{}, 0, ErrNotFound
	}
	if err != nil {
		return Config{}, 0, err
	}

	var config Config
	if err := json.Unmarshal(payload, &config); err != nil {
		return Config{}, 0, fmt.Errorf(
			"runtimeconfig: no se pudo leer la configuración guardada: %w", err,
		)
	}
	return config, version, nil
}

// Save valida y persiste la configuración en una transacción, incrementando la
// versión y registrando una revisión. Devuelve la versión escrita.
func (repository *Repository) Save(
	ctx context.Context,
	config Config,
	reason, actor string,
	now time.Time,
) (int64, error) {
	if repository == nil || repository.Pool == nil {
		return 0, errors.New("runtimeconfig: repositorio sin pool")
	}
	if err := Validate(config); err != nil {
		return 0, err
	}

	payload, err := json.Marshal(config)
	if err != nil {
		return 0, fmt.Errorf(
			"runtimeconfig: no se pudo serializar la configuración: %w", err,
		)
	}
	reason = truncate(reason, MaxReasonLength)
	actor = truncate(actor, MaxActorLength)
	if actor == "" {
		actor = "system"
	}
	timestamp := now.UnixMilli()

	tx, err := repository.Pool.Begin(ctx)
	if err != nil {
		return 0, err
	}
	defer tx.Rollback(ctx) //nolint:errcheck // el rollback tras commit es inocuo

	var version int64
	err = tx.QueryRow(ctx, `
		SELECT version
		FROM shadow.runtime_config
		WHERE id = 1
		FOR UPDATE`,
	).Scan(&version)
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		version = 1
		_, err = tx.Exec(ctx, `
			INSERT INTO shadow.runtime_config
				(id, config_json, version, reason, updated_by, updated_at)
			VALUES (1, $1::jsonb, 1, $2, $3, $4)`,
			string(payload), reason, actor, timestamp,
		)
	case err != nil:
		return 0, err
	default:
		version++
		_, err = tx.Exec(ctx, `
			UPDATE shadow.runtime_config
			SET config_json = $1::jsonb,
				version = $2,
				reason = $3,
				updated_by = $4,
				updated_at = $5
			WHERE id = 1`,
			string(payload), version, reason, actor, timestamp,
		)
	}
	if err != nil {
		return 0, err
	}

	if _, err := tx.Exec(ctx, `
		INSERT INTO shadow.runtime_config_revisions
			(version, config_json, reason, updated_by, created_at)
		VALUES ($1, $2::jsonb, $3, $4, $5)`,
		version, string(payload), reason, actor, timestamp,
	); err != nil {
		return 0, err
	}

	if err := tx.Commit(ctx); err != nil {
		return 0, err
	}
	return version, nil
}

// SettingBool lee un ajuste booleano de shadow.runtime_settings. found=false
// cuando la clave no existe.
func (repository *Repository) SettingBool(
	ctx context.Context,
	key string,
) (bool, bool, error) {
	if repository == nil || repository.Pool == nil {
		return false, false, errors.New("runtimeconfig: repositorio sin pool")
	}
	var raw []byte
	err := repository.Pool.QueryRow(ctx, `
		SELECT value FROM shadow.runtime_settings WHERE key = $1`, key,
	).Scan(&raw)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, false, nil
	}
	if err != nil {
		return false, false, err
	}
	var value bool
	if err := json.Unmarshal(raw, &value); err != nil {
		return false, false, err
	}
	return value, true, nil
}

// Revisions devuelve las últimas revisiones, de la más nueva a la más antigua.
// El límite se recorta a 1..100 y usa 20 cuando no se indica.
func (repository *Repository) Revisions(
	ctx context.Context,
	limit int,
) ([]Revision, error) {
	if repository == nil || repository.Pool == nil {
		return nil, errors.New("runtimeconfig: repositorio sin pool")
	}
	if limit < 1 {
		limit = DefaultRevisionLimit
	}
	if limit > MaxRevisionLimit {
		limit = MaxRevisionLimit
	}

	rows, err := repository.Pool.Query(ctx, `
		SELECT version, config_json, reason, updated_by, created_at
		FROM shadow.runtime_config_revisions
		ORDER BY version DESC
		LIMIT $1`,
		limit,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	revisions := make([]Revision, 0, limit)
	for rows.Next() {
		var (
			revision Revision
			payload  []byte
		)
		if err := rows.Scan(
			&revision.Version, &payload, &revision.Reason,
			&revision.Actor, &revision.CreatedAt,
		); err != nil {
			return nil, err
		}
		if err := json.Unmarshal(payload, &revision.Config); err != nil {
			return nil, fmt.Errorf(
				"runtimeconfig: no se pudo leer la revisión %d: %w",
				revision.Version, err,
			)
		}
		revisions = append(revisions, revision)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return revisions, nil
}

// Seed inserta la configuración inicial solo si todavía no existe. Si ya hay
// una fila no la modifica.
func (repository *Repository) Seed(
	ctx context.Context,
	config Config,
	now time.Time,
) error {
	if repository == nil || repository.Pool == nil {
		return errors.New("runtimeconfig: repositorio sin pool")
	}
	if err := Validate(config); err != nil {
		return err
	}

	payload, err := json.Marshal(config)
	if err != nil {
		return fmt.Errorf(
			"runtimeconfig: no se pudo serializar la configuración: %w", err,
		)
	}

	_, err = repository.Pool.Exec(ctx, `
		INSERT INTO shadow.runtime_config
			(id, config_json, version, reason, updated_by, updated_at)
		VALUES (1, $1::jsonb, 1, '', 'system', $2)
		ON CONFLICT (id) DO NOTHING`,
		string(payload), now.UnixMilli(),
	)
	return err
}

// truncate recorta espacios y limita por caracteres, no por bytes.
func truncate(value string, limit int) string {
	value = strings.TrimSpace(value)
	runes := []rune(value)
	if len(runes) > limit {
		return string(runes[:limit])
	}
	return value
}
