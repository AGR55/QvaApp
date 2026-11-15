package edge

import (
	"context"
	"encoding/json"
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
	Offer(ctx context.Context, uuid string) (qvapay.Offer, error)
	Transactions(ctx context.Context, page, take int) (qvapay.TransactionPage, error)
	Averages(ctx context.Context) (map[string]qvapay.Average, error)
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
	Averages     map[string]any
	Operations   []map[string]any
	History      []map[string]any
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
		Averages:  map[string]any{},
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
	operations := map[string]map[string]any{}
	if page, err := live.Reader.Transactions(ctx, 1, 20); err == nil {
		snapshot.Transactions = make([]map[string]any, 0, len(page.Transactions))
		for _, tx := range page.Transactions {
			snapshot.Transactions = append(snapshot.Transactions, liveTransactionMap(tx))
			if operation, ok := liveP2POperation(tx); ok {
				operations[operation["uuid"].(string)] = operation
			}
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
	snapshot.Operations = make([]map[string]any, 0, len(operations))
	for _, operation := range operations {
		snapshot.Operations = append(snapshot.Operations, operation)
	}
	if averages, err := live.Reader.Averages(ctx); err == nil {
		for coin, average := range averages {
			snapshot.Averages[coin] = map[string]any{
				"medianBuy":   decimalFloat(average.MedianBuy),
				"medianSell":  decimalFloat(average.MedianSell),
				"averageBuy":  decimalFloat(average.AverageBuy),
				"averageSell": decimalFloat(average.AverageSell),
				"count":       average.Count,
				"updatedAt":   average.UpdatedAt,
			}
		}
	}
	if live.Pool != nil {
		rows, err := live.Pool.Query(ctx, `
			SELECT uuid, offer_type, coin, amount, receive, rate, state,
			       auto_applied, created_at, updated_at, order_uuid
			FROM shadow.local_operations
			ORDER BY updated_at DESC LIMIT 50`)
		if err == nil {
			existing := make(map[string]struct{}, len(snapshot.Operations))
			for _, operation := range snapshot.Operations {
				if uuid, ok := operation["uuid"].(string); ok {
					existing[uuid] = struct{}{}
				}
			}
			for rows.Next() {
				var id, offerType, coin, state string
				var amount, receive, rate float64
				var auto bool
				var created, updated int64
				var order *string
				if rows.Scan(&id, &offerType, &coin, &amount, &receive, &rate, &state,
					&auto, &created, &updated, &order) != nil {
					continue
				}
				if _, ok := existing[id]; ok {
					continue
				}
				orderUUID := ""
				if order != nil {
					orderUUID = *order
				}
				snapshot.Operations = append(snapshot.Operations, map[string]any{
					"uuid": id, "offerType": offerType, "coin": coin,
					"amount": amount, "receive": receive, "rate": rate,
					"state": state, "autoApplied": auto, "orderUuid": orderUUID,
					"createdAt": created, "updatedAt": updated,
				})
			}
			rows.Close()
		}
		if _, err := live.Pool.Exec(ctx, `
			INSERT INTO shadow.live_dashboard_history(created_at, qusd_balance, open_offers, active_operations)
			SELECT $1::bigint, $2::double precision, $3::integer, $4::integer
			WHERE NOT EXISTS (SELECT 1 FROM shadow.live_dashboard_history WHERE created_at > $1::bigint - 300000)`,
			snapshot.UpdatedAt, snapshot.Balance, len(snapshot.OwnOffers), len(snapshot.Operations)); err == nil {
			historyRows, err := live.Pool.Query(ctx, `
				SELECT created_at, qusd_balance, open_offers, active_operations
				FROM shadow.live_dashboard_history
				WHERE created_at >= $1 ORDER BY created_at DESC LIMIT 500`, snapshot.UpdatedAt-7*86_400_000)
			if err == nil {
				for historyRows.Next() {
					var created int64
					var balance float64
					var open, active int
					if historyRows.Scan(&created, &balance, &open, &active) != nil {
						continue
					}
					snapshot.History = append(snapshot.History, map[string]any{
						"createdAt": created, "qusdBalance": balance,
						"openOffers": open, "activeOperations": active,
					})
				}
				historyRows.Close()
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
	amount := decimalFloat(offer.Amount)
	receive := decimalFloat(offer.Receive)
	rate := decimalFloat(offer.Rate)
	if rate == 0 && amount > 0 {
		rate = receive / amount
	}
	return map[string]any{
		"uuid": offer.UUID, "type": offer.Type, "coin": offer.Coin,
		"amount": amount, "receive": receive,
		"rate": rate, "status": offer.Status,
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

func liveP2POperation(tx qvapay.Transaction) (map[string]any, bool) {
	if len(tx.P2P) == 0 || string(tx.P2P) == "null" {
		return nil, false
	}
	var raw struct {
		UUID    string `json:"uuid"`
		Coin    string `json:"coin"`
		Type    string `json:"type"`
		Status  string `json:"status"`
		Amount  any    `json:"amount"`
		Receive any    `json:"receive"`
	}
	if json.Unmarshal(tx.P2P, &raw) != nil || raw.UUID == "" || raw.Coin == "" {
		return nil, false
	}
	amount := anyFloat(raw.Amount)
	receive := anyFloat(raw.Receive)
	rate := 0.0
	if amount > 0 {
		rate = receive / amount
	}
	return map[string]any{
		"uuid": raw.UUID, "coin": raw.Coin, "offerType": raw.Type,
		"amount": amount, "receive": receive, "rate": rate,
		"state": raw.Status, "createdAt": parseQvaTime(tx.CreatedAt),
		"updatedAt": parseQvaTime(tx.UpdatedAt),
	}, true
}

func anyFloat(value any) float64 {
	switch item := value.(type) {
	case float64:
		return item
	case string:
		parsed, _ := strconv.ParseFloat(item, 64)
		return parsed
	case json.Number:
		parsed, _ := item.Float64()
		return parsed
	}
	return 0
}
