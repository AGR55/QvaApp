package main

import (
	"context"
	"errors"
	"strings"
)

func (service *service) releaseNotification(ctx context.Context, key string) error {
	if service == nil || service.pool == nil || strings.TrimSpace(key) == "" {
		return errors.New("store de deduplicación no disponible")
	}
	_, err := service.pool.Exec(ctx,
		`DELETE FROM shadow.notifier_dedupe_keys WHERE dedupe_key = $1`, key)
	return err
}

func (service *service) claimNotification(ctx context.Context, key string) (bool, error) {
	if service == nil || service.pool == nil || strings.TrimSpace(key) == "" {
		return false, errors.New("store de deduplicación no disponible")
	}
	nowSQL := `(extract(epoch from now()) * 1000)::bigint`
	if _, err := service.pool.Exec(ctx, `
		DELETE FROM shadow.notifier_dedupe_keys
		WHERE created_at < (extract(epoch from now() - interval '30 days') * 1000)::bigint`); err != nil {
		return false, err
	}
	command, err := service.pool.Exec(ctx, `
		INSERT INTO shadow.notifier_dedupe_keys (dedupe_key, created_at)
		VALUES ($1, `+nowSQL+`)
		ON CONFLICT (dedupe_key) DO UPDATE
		SET created_at = EXCLUDED.created_at
		WHERE shadow.notifier_dedupe_keys.created_at < `+nowSQL+` - 10 * 60 * 1000`, key)
	if err != nil {
		return false, err
	}
	return command.RowsAffected() > 0, nil
}
