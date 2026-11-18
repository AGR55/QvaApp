package postgres

import (
	"context"
	"encoding/json"
	"errors"
	"strings"

	"github.com/jackc/pgx/v5/pgxpool"
)

const offerExclusionPrefix = "excluded_offer:"

// OfferExclusionRepository conserva las ofertas que el propietario canceló
// manualmente. Se guardan en runtime_settings para que hunter, core y edge
// compartan la misma decisión sin una migración adicional.
type OfferExclusionRepository struct {
	pool *pgxpool.Pool
}

func NewOfferExclusionRepository(pool *pgxpool.Pool) *OfferExclusionRepository {
	return &OfferExclusionRepository{pool: pool}
}

func (repository *OfferExclusionRepository) ExcludeOffer(
	ctx context.Context,
	offerUUID, source string,
	now int64,
) error {
	if repository == nil || repository.pool == nil {
		return errors.New("offer exclusions: repositorio sin pool")
	}
	offerUUID = strings.TrimSpace(offerUUID)
	if offerUUID == "" {
		return errors.New("offer exclusions: UUID vacío")
	}
	payload, err := json.Marshal(map[string]any{
		"source": source, "created_at": now,
	})
	if err != nil {
		return err
	}
	_, err = repository.pool.Exec(ctx, `
		INSERT INTO shadow.runtime_settings (key, value, updated_at)
		VALUES ($1, $2::jsonb, $3)
		ON CONFLICT (key) DO NOTHING`,
		offerExclusionPrefix+offerUUID, string(payload), now)
	return err
}

func (repository *OfferExclusionRepository) IsOfferExcluded(
	ctx context.Context,
	offerUUID string,
) (bool, error) {
	if repository == nil || repository.pool == nil {
		return false, errors.New("offer exclusions: repositorio sin pool")
	}
	var exists bool
	err := repository.pool.QueryRow(ctx, `
		SELECT EXISTS (
			SELECT 1 FROM shadow.runtime_settings WHERE key = $1
		)`, offerExclusionPrefix+strings.TrimSpace(offerUUID)).Scan(&exists)
	return exists, err
}

func (repository *OfferExclusionRepository) ExcludedOffers(
	ctx context.Context,
) ([]string, error) {
	if repository == nil || repository.pool == nil {
		return nil, errors.New("offer exclusions: repositorio sin pool")
	}
	rows, err := repository.pool.Query(ctx, `
		SELECT key FROM shadow.runtime_settings
		WHERE key LIKE $1`, offerExclusionPrefix+"%")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := make([]string, 0)
	for rows.Next() {
		var key string
		if err := rows.Scan(&key); err != nil {
			return nil, err
		}
		result = append(result, strings.TrimPrefix(key, offerExclusionPrefix))
	}
	return result, rows.Err()
}

// AllowOffer elimina la exclusión para que el propietario pueda revertirla.
func (repository *OfferExclusionRepository) AllowOffer(
	ctx context.Context,
	offerUUID string,
) error {
	if repository == nil || repository.pool == nil {
		return errors.New("offer exclusions: repositorio sin pool")
	}
	_, err := repository.pool.Exec(ctx, `
		DELETE FROM shadow.runtime_settings WHERE key = $1`,
		offerExclusionPrefix+strings.TrimSpace(offerUUID))
	return err
}
