package edge

import (
	"context"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/AGR55/QvaApp/services/trading-core/internal/platform/qvapay"
)

// LiveReader es el subconjunto de lecturas QvaPay que usa el dashboard.
type LiveReader interface {
	User(ctx context.Context) (qvapay.User, error)
	Offers(ctx context.Context, params url.Values) ([]qvapay.Offer, error)
	Transactions(ctx context.Context, page, take int) (qvapay.TransactionPage, error)
}

// LiveDashboard cachea lecturas QvaPay para que el panel no golpee la API en
// cada petición. Si una sección falla, conserva el resto y no tumba el panel.
type LiveDashboard struct {
	Reader LiveReader
	Pool   *pgxpool.Pool
	TTL    time.Duration
	Now    func() time.Time

	mu     sync.Mutex
	cached liveDashboardSnapshot
	at     time.Time
	loaded bool
}

type liveDashboardSnapshot struct {
	Balance      float64
	OwnOffers    []map[string]any
	Transactions []map[string]any
	Market       map[string]map[string]any
	Operations   []map[string]any
	UpdatedAt    int64
	Live         bool
}

func (live *LiveDashboard) Snapshot(ctx context.Context) liveDashboardSnapshot {
	if live == nil || live.Reader == nil {
		return liveDashboardSnapshot{}
	}
	now := live.now()
	ttl := live.TTL
	if ttl <= 0 {
		ttl = 15 * time.Second
	}
	live.mu.Lock()
	if live.loaded && now.Sub(live.at) < ttl {
		snapshot := live.cached
		live.mu.Unlock()
		return snapshot
	}
	live.mu.Unlock()

	snapshot := live.fetch(ctx, now)
	live.mu.Lock()
	live.cached, live.at, live.loaded = snapshot, now, true
	live.mu.Unlock()
	return snapshot
}

func (live *LiveDashboard) fetch(ctx context.Context, now time.Time) liveDashboardSnapshot {
	snapshot := liveDashboardSnapshot{
		Market:    map[string]map[string]any{},
		UpdatedAt: now.UnixMilli(),
		Live:      true,
	}
	if user, err := live.Reader.User(ctx); err == nil {
		snapshot.Balance = decimalFloat(user.Balance)
		if snapshot.Balance == 0 {
			snapshot.Balance = decimalFloat(user.Available)
		}
	}
	if offers, err := live.Reader.Offers(ctx, url.Values{
		"my": {"true"}, "status": {"open"}, "page": {"1"}, "take": {"100"},
	}); err == nil {
		snapshot.OwnOffers = make([]map[string]any, 0, len(offers))
		for _, offer := range offers {
			snapshot.OwnOffers = append(snapshot.OwnOffers, liveOfferMap(offer, snapshot.UpdatedAt))
		}
	}
	if page, err := live.Reader.Transactions(ctx, 1, 20); err == nil {
		snapshot.Transactions = make([]map[string]any, 0, len(page.Transactions))
		for _, tx := range page.Transactions {
			snapshot.Transactions = append(snapshot.Transactions, liveTransactionMap(tx))
		}
	}
	if offers, err := live.Reader.Offers(ctx, url.Values{
		"status": {"open"}, "page": {"1"}, "take": {"200"},
	}); err == nil {
		for _, offer := range offers {
			coin := strings.TrimSpace(offer.Coin)
			if coin == "" {
				continue
			}
			entry, ok := snapshot.Market[coin]
			if !ok {
				entry = map[string]any{"offers": []any{}, "total": 0}
			}
			items, _ := entry["offers"].([]any)
			items = append(items, liveOfferMap(offer, snapshot.UpdatedAt))
			entry["offers"] = items
			entry["total"] = len(items)
			snapshot.Market[coin] = entry
		}
	}
	if live.Pool != nil {
		rows, err := live.Pool.Query(ctx, `
			SELECT operation_id, state, qusd_amount, fiat_amount, updated_at
			FROM shadow.core_operations
			ORDER BY updated_at DESC LIMIT 50`)
		if err == nil {
			defer rows.Close()
			snapshot.Operations = make([]map[string]any, 0, 50)
			for rows.Next() {
				var id, state, qusd, fiat string
				var updated int64
				if rows.Scan(&id, &state, &qusd, &fiat, &updated) != nil {
					continue
				}
				snapshot.Operations = append(snapshot.Operations, map[string]any{
					"uuid": id, "state": state, "qusdAmount": qusd,
					"fiatAmount": fiat, "updatedAt": updated,
				})
			}
		}
	}
	return snapshot
}

func (live *LiveDashboard) now() time.Time {
	if live != nil && live.Now != nil {
		return live.Now()
	}
	return time.Now()
}

func liveOfferMap(offer qvapay.Offer, updatedAt int64) map[string]any {
	return map[string]any{
		"uuid": offer.UUID, "type": offer.Type, "coin": offer.Coin,
		"amount": decimalFloat(offer.Amount), "receive": decimalFloat(offer.Receive),
		"rate": decimalFloat(offer.Rate), "status": offer.Status,
		"availableAmount": decimalFloat(offer.AvailableAmount),
		"reservedAmount":  decimalFloat(offer.ReservedAmount),
		"offerKind":       "fixed", "updatedAt": updatedAt,
	}
}

func liveTransactionMap(tx qvapay.Transaction) map[string]any {
	return map[string]any{
		"uuid": tx.UUID, "amount": decimalFloat(tx.Amount),
		"description": tx.Description, "status": tx.Status,
		"createdAt": parseQvaTime(tx.CreatedAt), "updatedAt": parseQvaTime(tx.UpdatedAt),
	}
}

func parseQvaTime(value string) int64 {
	if value == "" {
		return 0
	}
	if parsed, err := time.Parse(time.RFC3339, value); err == nil {
		return parsed.UnixMilli()
	}
	if number, err := strconv.ParseInt(value, 10, 64); err == nil {
		if number < 1_000_000_000_000 {
			number *= 1000
		}
		return number
	}
	return 0
}

func decimalFloat(value interface{ Format(int) string }) float64 {
	parsed, err := strconv.ParseFloat(value.Format(8), 64)
	if err != nil {
		return 0
	}
	return parsed
}
