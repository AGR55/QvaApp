package postgres

import (
	"context"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/AGR55/QvaApp/services/trading-core/internal/notifier"
)

// PushSubscriptionRepository persiste suscripciones Web Push deduplicadas por
// endpoint. No realiza llamadas de red ni envía notificaciones.
type PushSubscriptionRepository struct {
	pool *pgxpool.Pool
}

var _ notifier.PushSubscriptionStore = (*PushSubscriptionRepository)(nil)

// NewPushSubscriptionRepository crea el repositorio.
func NewPushSubscriptionRepository(pool *pgxpool.Pool) *PushSubscriptionRepository {
	return &PushSubscriptionRepository{pool: pool}
}

// Upsert valida y guarda una suscripción. La primera inserción fija created_at;
// los conflictos por endpoint actualizan claves, etiqueta, updated_at y
// expires_at sin tocar created_at. Los instantes se guardan en milisegundos.
func (repository *PushSubscriptionRepository) Upsert(
	ctx context.Context,
	subscription notifier.PushSubscription,
	now time.Time,
	expiresAt time.Time,
) error {
	if err := subscription.Validate(); err != nil {
		return err
	}
	_, err := repository.pool.Exec(ctx, `
		INSERT INTO shadow.push_subscriptions
			(endpoint, p256dh, auth, label, created_at, updated_at, expires_at)
		VALUES ($1, $2, $3, $4, $5, $5, $6)
		ON CONFLICT (endpoint) DO UPDATE
		SET p256dh = EXCLUDED.p256dh,
		    auth = EXCLUDED.auth,
		    label = EXCLUDED.label,
		    updated_at = EXCLUDED.updated_at,
		    expires_at = EXCLUDED.expires_at`,
		subscription.Endpoint, subscription.P256DH, subscription.Auth,
		subscription.Label, now.UnixMilli(), expiresAt.UnixMilli(),
	)
	if err != nil {
		return fmt.Errorf("guardar suscripción push: %w", err)
	}
	return nil
}

// Delete elimina una suscripción por endpoint. Devuelve true si existía.
func (repository *PushSubscriptionRepository) Delete(
	ctx context.Context,
	endpoint string,
) (bool, error) {
	tag, err := repository.pool.Exec(ctx, `
		DELETE FROM shadow.push_subscriptions
		WHERE endpoint = $1`,
		endpoint,
	)
	if err != nil {
		return false, fmt.Errorf("eliminar suscripción push: %w", err)
	}
	return tag.RowsAffected() > 0, nil
}

// List devuelve las suscripciones vigentes en now ordenadas por endpoint. Un
// limit no positivo no aplica límite. Las expiradas se omiten sin borrarlas.
func (repository *PushSubscriptionRepository) List(
	ctx context.Context,
	now time.Time,
	limit int,
) ([]notifier.PushSubscription, error) {
	rows, err := repository.pool.Query(ctx, `
		SELECT endpoint, p256dh, auth, label
		FROM shadow.push_subscriptions
		WHERE expires_at > $1
		ORDER BY endpoint
		LIMIT CASE WHEN $2::bigint > 0 THEN $2::bigint END`,
		now.UnixMilli(), int64(limit),
	)
	if err != nil {
		return nil, fmt.Errorf("listar suscripciones push: %w", err)
	}
	defer rows.Close()

	subscriptions := make([]notifier.PushSubscription, 0)
	for rows.Next() {
		var subscription notifier.PushSubscription
		if err := rows.Scan(
			&subscription.Endpoint, &subscription.P256DH,
			&subscription.Auth, &subscription.Label,
		); err != nil {
			return nil, fmt.Errorf("leer suscripción push: %w", err)
		}
		subscriptions = append(subscriptions, subscription)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("listar suscripciones push: %w", err)
	}
	return subscriptions, nil
}

// Count devuelve cuántas suscripciones están vigentes en now.
func (repository *PushSubscriptionRepository) Count(
	ctx context.Context,
	now time.Time,
) (int, error) {
	var count int
	err := repository.pool.QueryRow(ctx, `
		SELECT count(*)
		FROM shadow.push_subscriptions
		WHERE expires_at > $1`,
		now.UnixMilli(),
	).Scan(&count)
	if err != nil {
		return 0, fmt.Errorf("contar suscripciones push: %w", err)
	}
	return count, nil
}
