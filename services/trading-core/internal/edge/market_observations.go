package edge

import (
	"context"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/AGR55/QvaApp/services/trading-core/internal/platform/qvapay"
)

// MarketObservation es una muestra de precios P2P por mercado.
type MarketObservation struct {
	CreatedAt   int64
	Coin        string
	AverageBuy  *float64
	AverageSell *float64
	MedianBuy   *float64
	MedianSell  *float64
	BestBuy     *float64
	BestSell    *float64
	OpenOffers  int
	Eligible    int
}

// MarketObservationStore persiste y lee el histórico de mercado.
type MarketObservationStore interface {
	Insert(ctx context.Context, observation MarketObservation) error
	History(ctx context.Context, coin string, sinceMS int64, limit int) ([]MarketObservation, error)
}

// PostgresMarketObservationStore usa shadow.market_observations.
type PostgresMarketObservationStore struct {
	Pool *pgxpool.Pool
}

func (store *PostgresMarketObservationStore) Insert(ctx context.Context, observation MarketObservation) error {
	if store == nil || store.Pool == nil {
		return nil
	}
	_, err := store.Pool.Exec(ctx, `
		INSERT INTO shadow.market_observations
			(created_at, coin, average_buy, average_sell, median_buy, median_sell,
			 best_buy, best_sell, open_offers, eligible)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
		observation.CreatedAt, observation.Coin,
		observation.AverageBuy, observation.AverageSell,
		observation.MedianBuy, observation.MedianSell,
		observation.BestBuy, observation.BestSell,
		observation.OpenOffers, observation.Eligible,
	)
	return err
}

func (store *PostgresMarketObservationStore) History(
	ctx context.Context,
	coin string,
	sinceMS int64,
	limit int,
) ([]MarketObservation, error) {
	if store == nil || store.Pool == nil {
		return nil, nil
	}
	if limit <= 0 {
		limit = 240
	}
	rows, err := store.Pool.Query(ctx, `
		SELECT created_at, coin, average_buy, average_sell, median_buy, median_sell,
		       best_buy, best_sell, open_offers, eligible
		FROM shadow.market_observations
		WHERE coin = $1 AND created_at >= $2
		ORDER BY created_at DESC
		LIMIT $3`, coin, sinceMS, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	observations := make([]MarketObservation, 0, limit)
	for rows.Next() {
		var item MarketObservation
		if err := rows.Scan(&item.CreatedAt, &item.Coin, &item.AverageBuy, &item.AverageSell,
			&item.MedianBuy, &item.MedianSell, &item.BestBuy, &item.BestSell,
			&item.OpenOffers, &item.Eligible); err != nil {
			return nil, err
		}
		observations = append(observations, item)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	// La consulta devuelve descendente para recortar; la gráfica necesita ASC.
	for left, right := 0, len(observations)-1; left < right; left, right = left+1, right-1 {
		observations[left], observations[right] = observations[right], observations[left]
	}
	return observations, nil
}

// recordMarketObservations guarda una muestra por mercado como máximo cada
// 30 s. Es best-effort: un fallo no tumba el dashboard.
func (live *LiveDashboard) recordMarketObservations(
	ctx context.Context,
	now time.Time,
	averages map[string]qvapay.Average,
	market map[string]map[string]any,
) {
	if live == nil || live.Observations == nil {
		return
	}
	live.recordMu.Lock()
	if !live.recordAt.IsZero() && now.Sub(live.recordAt) < 30*time.Second {
		live.recordMu.Unlock()
		return
	}
	live.recordAt = now
	live.recordMu.Unlock()

	// Retención semanal: el histórico solo alimenta una gráfica de 24 h y
	// las comparaciones recientes. Se poda de forma best-effort.
	if store, ok := live.Observations.(*PostgresMarketObservationStore); ok && now.Unix()%3600 < 30 {
		_, _ = store.deleteBefore(ctx, now.Add(-7*24*time.Hour).UnixMilli())
	}

	for coin, average := range averages {
		if average.Count <= 0 {
			continue
		}
		observation := MarketObservation{
			CreatedAt: now.UnixMilli(), Coin: coin,
			OpenOffers: int(average.Count), Eligible: 0,
		}
		if average.AverageBuy.Sign() > 0 {
			value := decimalFloat(average.AverageBuy)
			observation.AverageBuy = &value
		}
		if average.AverageSell.Sign() > 0 {
			value := decimalFloat(average.AverageSell)
			observation.AverageSell = &value
		}
		if average.MedianBuy.Sign() > 0 {
			value := decimalFloat(average.MedianBuy)
			observation.MedianBuy = &value
		}
		if average.MedianSell.Sign() > 0 {
			value := decimalFloat(average.MedianSell)
			observation.MedianSell = &value
		}
		if total, ok := market[coin]["total"].(int); ok && observation.OpenOffers == 0 {
			observation.OpenOffers = total
		}
		if err := live.Observations.Insert(ctx, observation); err != nil && live.Logger != nil {
			live.Logger.Warn("no se pudo guardar la observación de mercado", "coin", coin, "error", err)
		}
	}
}

// deleteBefore poda observaciones antiguas. Ignora el error: la gráfica no
// debe fallar si la base rechaza la limpieza.
func (store *PostgresMarketObservationStore) deleteBefore(ctx context.Context, cutoffMS int64) (int64, error) {
	if store == nil || store.Pool == nil {
		return 0, nil
	}
	tag, err := store.Pool.Exec(ctx,
		`DELETE FROM shadow.market_observations WHERE created_at < $1`, cutoffMS)
	if err != nil {
		return 0, err
	}
	return tag.RowsAffected(), nil
}
