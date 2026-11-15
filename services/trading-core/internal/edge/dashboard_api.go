package edge

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"strconv"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/AGR55/QvaApp/services/trading-core/internal/runtimeconfig"
)

const (
	// dashboardDefaultOffersLimit es el número de ofertas devuelto cuando la
	// query no indica limit.
	dashboardDefaultOffersLimit = 50
	// dashboardDefaultOperationsLimit es el número de operaciones devuelto
	// cuando la query no indica limit.
	dashboardDefaultOperationsLimit = 20
	// dashboardMaxLimit acota el trabajo y el tamaño de cada respuesta.
	dashboardMaxLimit = 100

	dashboardPath      = "/api/dashboard"
	liveOwnOffersPath  = "/api/live/own-offers"
	liveOperationsPath = "/api/live/operations"
	liveBalancePath    = "/api/live/balance"
)

// DashboardSummary es el agregado mostrado en el dashboard web. QvaBalance,
// QvaOffers y CapturedAt provienen del último snapshot QvaPay; si aún no hay
// snapshots quedan en "", 0 y 0 respectivamente.
type DashboardSummary struct {
	HunterEvents int64  `json:"hunterEvents"`
	CoreAllowed  int64  `json:"coreAllowed"`
	CoreBlocked  int64  `json:"coreBlocked"`
	CorePending  int64  `json:"corePending"`
	QvaBalance   string `json:"qvaBalance"`
	QvaOffers    int64  `json:"qvaOffers"`
	CapturedAt   int64  `json:"capturedAt"`
}

// LiveOffer es una oferta QvaPay del último inventario leído en modo
// read-only. Todos los importes viajan como texto para no perder precisión.
type LiveOffer struct {
	UUID       string `json:"uuid"`
	Coin       string `json:"coin"`
	Type       string `json:"type"`
	Status     string `json:"status"`
	Amount     string `json:"amount"`
	Receive    string `json:"receive"`
	Rate       string `json:"rate"`
	CapturedAt int64  `json:"capturedAt"`
}

// DashboardOperation es el estado público de una operación shadow.
type DashboardOperation struct {
	OperationID string `json:"operationId"`
	State       string `json:"state"`
	QusdAmount  string `json:"qusdAmount"`
	FiatAmount  string `json:"fiatAmount"`
	UpdatedAt   int64  `json:"updatedAt"`
}

// DashboardBalance es la vista mínima de saldo QvaPay usada por
// /api/live/balance.
type DashboardBalance struct {
	Balance    string `json:"balance"`
	CapturedAt int64  `json:"capturedAt"`
}

// DashboardStore es la fuente de datos de solo lectura del dashboard. Balance
// se sirve reutilizando Summary para no duplicar consultas ni agregar un método
// que deba mantenerse sincronizado.
type DashboardStore interface {
	Summary(ctx context.Context) (DashboardSummary, error)
	Offers(ctx context.Context, limit int) ([]LiveOffer, error)
	Operations(ctx context.Context, limit int) ([]DashboardOperation, error)
}

// DashboardAPI expone datos de solo lectura para el dashboard web. Toda
// petición exige la cookie de sesión emitida por SessionHandler; el token
// nunca se devuelve ni se registra.
//
// Rutas:
//
//	GET /api/dashboard
//	GET /api/live/own-offers?limit=50
//	GET /api/live/operations?limit=20
//	GET /api/live/balance
//
// limit se recorta al rango 1..100; valores ausentes o no numéricos usan el
// valor por defecto de cada ruta. Cualquier otro método responde 405 y
// cualquier otra ruta 404, siempre JSON.
type DashboardAPI struct {
	Sessions        *SessionManager
	Store           DashboardStore
	Runtime         *runtimeconfig.Repository
	Settings        SettingStore
	CooperativeFile string
	Now             func() time.Time
}

type dashboardWebSnapshot struct {
	DashboardSummary
	GeneratedAt         int64                  `json:"generatedAt"`
	State               dashboardWebState      `json:"state"`
	Markets             []runtimeconfig.Market `json:"markets"`
	Strategy            dashboardStrategy      `json:"strategy"`
	Risk                dashboardRisk          `json:"risk"`
	Availability        dashboardAvailability  `json:"availability"`
	Rankings            dashboardRankings      `json:"rankings"`
	Alerts              []any                  `json:"alerts"`
	Operations          []any                  `json:"operations"`
	OwnOffers           []any                  `json:"ownOffers"`
	Transactions        []any                  `json:"transactions"`
	Market              map[string]any         `json:"market"`
	Budget              map[string]any         `json:"budget"`
	Averages            map[string]any         `json:"averages"`
	Freshness           map[string]any         `json:"freshness"`
	MarketHistory       []any                  `json:"marketHistory"`
	Hunting             any                    `json:"hunting"`
	Automation          any                    `json:"automation"`
	Workflows           []any                  `json:"workflows"`
	MutationIntents     []any                  `json:"mutationIntents"`
	CapitalReservations []any                  `json:"capitalReservations"`
	CooperativeNetwork  map[string]any         `json:"cooperativeNetwork"`
	CooperativeHunting  map[string]any         `json:"cooperativeHunting"`
}

type dashboardWebState struct {
	Paused         bool                    `json:"paused"`
	Active         int                     `json:"active"`
	Fiat           map[string]float64      `json:"fiat"`
	MutationBudget dashboardMutationBudget `json:"mutationBudget"`
	ScanCoverage   dashboardScanCoverage   `json:"scanCoverage"`
}

type dashboardMutationBudget struct {
	ApplyReadyAt int64 `json:"applyReadyAt"`
}

type dashboardScanCoverage struct {
	At      int64    `json:"at"`
	Markets []string `json:"markets"`
}

type dashboardStrategy struct {
	BuyMax  map[string]float64 `json:"buyMax"`
	SellMin map[string]float64 `json:"sellMin"`
}

type dashboardRisk struct {
	Limits dashboardRiskLimits `json:"limits"`
	Usage  dashboardRiskUsage  `json:"usage"`
}

type dashboardRiskLimits struct {
	MaxQusdPerOperation       float64 `json:"maxQusdPerOperation"`
	MaxConcurrentQusdExposure float64 `json:"maxConcurrentQusdExposure"`
	MaxDailyAppliedQusd       float64 `json:"maxDailyAppliedQusd"`
	MaxConcurrentOperations   int     `json:"maxConcurrentOperations"`
	MinQusdReserve            float64 `json:"minQusdReserve"`
}

type dashboardRiskUsage struct {
	ExposureQusd       float64 `json:"exposureQusd"`
	DailyAppliedQusd   float64 `json:"dailyAppliedQusd"`
	ActiveOperations   int64   `json:"activeOperations"`
	UnresolvedMutation bool    `json:"unresolvedMutation"`
	EmergencyStop      bool    `json:"emergencyStop"`
}

type dashboardAvailability struct {
	Fiat map[string]dashboardFiatAvailability `json:"fiat"`
	Qusd dashboardQusdAvailability            `json:"qusd"`
}

type dashboardQusdAvailability struct {
	Available float64 `json:"available"`
	Committed float64 `json:"committed"`
	Declared  float64 `json:"declared"`
	Reported  float64 `json:"reported"`
}

type dashboardFiatAvailability struct {
	Available float64 `json:"available"`
	Committed float64 `json:"committed"`
}

type dashboardRankings struct {
	Potential []any `json:"potential"`
	Rotation  []any `json:"rotation"`
}

// dashboardResponse envuelve todos los datos en una clave "data" para poder
// añadir metadatos en el futuro sin romper el contrato.
type dashboardResponse struct {
	Data any `json:"data"`
}

func (api *DashboardAPI) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")

	switch r.URL.Path {
	case dashboardPath, liveOwnOffersPath, liveOperationsPath, liveBalancePath:
	default:
		writeJSON(w, http.StatusNotFound, map[string]string{"status": "not_found"})
		return
	}

	if r.Method != http.MethodGet {
		w.Header().Set("Allow", http.MethodGet)
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"status": "method_not_allowed"})
		return
	}

	if !api.authenticated(r) {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"status": "unauthenticated"})
		return
	}

	if api.Store == nil {
		writeDashboardUnavailable(w)
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), statsTimeout)
	defer cancel()

	switch r.URL.Path {
	case dashboardPath:
		api.summary(w, ctx)
	case liveOwnOffersPath:
		api.offers(w, ctx, dashboardLimit(r, dashboardDefaultOffersLimit))
	case liveOperationsPath:
		api.operations(w, ctx, dashboardLimit(r, dashboardDefaultOperationsLimit))
	case liveBalancePath:
		api.balance(w, ctx)
	}
}

// authenticated valida la cookie de sesión con el reloj configurado. Un
// SessionManager nil también produce false.
func (api *DashboardAPI) authenticated(r *http.Request) bool {
	if api.Sessions == nil {
		return false
	}
	cookie, err := r.Cookie(CookieName)
	if err != nil || cookie.Value == "" {
		return false
	}
	now := time.Now
	if api.Now != nil {
		now = api.Now
	}
	_, err = api.Sessions.Verify(cookie.Value, now())
	return err == nil
}

func (api *DashboardAPI) summary(w http.ResponseWriter, ctx context.Context) {
	summary, err := api.Store.Summary(ctx)
	if err != nil {
		writeDashboardUnavailable(w)
		return
	}
	writeJSON(w, http.StatusOK, dashboardResponse{Data: api.webSnapshot(ctx, summary)})
}

// webSnapshot amplía el resumen mínimo con la forma que consume el panel web
// completo (public/dashboard). Las secciones que aún no tienen read model en
// el edge viajan vacías para que la interfaz pueda renderizar y operar la
// configuración sin bloquearse.
func (api *DashboardAPI) webSnapshot(ctx context.Context, summary DashboardSummary) dashboardWebSnapshot {
	now := api.now()
	snapshot := dashboardWebSnapshot{
		DashboardSummary: summary,
		GeneratedAt:      now.UnixMilli(),
		State: dashboardWebState{
			MutationBudget: dashboardMutationBudget{},
			ScanCoverage:   dashboardScanCoverage{Markets: []string{}},
		},
		Markets:             []runtimeconfig.Market{},
		Strategy:            dashboardStrategy{BuyMax: map[string]float64{}, SellMin: map[string]float64{}},
		Availability:        dashboardAvailability{Fiat: map[string]dashboardFiatAvailability{}},
		Rankings:            dashboardRankings{Potential: []any{}, Rotation: []any{}},
		Alerts:              []any{},
		Operations:          []any{},
		OwnOffers:           []any{},
		Transactions:        []any{},
		Market:              map[string]any{},
		Budget:              map[string]any{},
		Averages:            map[string]any{},
		Freshness:           map[string]any{},
		MarketHistory:       []any{},
		Workflows:           []any{},
		MutationIntents:     []any{},
		CapitalReservations: []any{},
	}
	if api.Runtime != nil {
		if config, _, err := api.Runtime.Load(ctx); err == nil {
			snapshot.Markets = config.Markets
			snapshot.Hunting = config.Hunting
			snapshot.Automation = config.Automation
			for _, market := range config.Markets {
				snapshot.Strategy.BuyMax[market.Code] = market.BuyMaxRate
				snapshot.Strategy.SellMin[market.Code] = market.SellMinRate
				snapshot.Availability.Fiat[market.Code] = dashboardFiatAvailability{
					Available: market.FiatBalance,
				}
			}
			snapshot.Risk = dashboardRisk{
				Limits: dashboardRiskLimits{
					MaxQusdPerOperation:       config.Risk.MaxQusdPerOperation,
					MaxConcurrentQusdExposure: config.Risk.MaxConcurrentQusdExposure,
					MaxDailyAppliedQusd:       config.Risk.MaxDailyAppliedQusd,
					MaxConcurrentOperations:   config.Risk.MaxConcurrentOperations,
					MinQusdReserve:            config.Risk.MinQusdReserve,
				},
				Usage: dashboardRiskUsage{ActiveOperations: summary.CorePending},
			}
		}
	}
	if api.Settings != nil {
		snapshot.State.Paused = api.boolSetting(ctx, "control.paused")
		snapshot.Risk.Usage.EmergencyStop = api.boolSetting(ctx, "control.emergency_stop")
	}
	if api.CooperativeFile != "" {
		if raw, err := os.ReadFile(api.CooperativeFile); err == nil {
			var cooperative struct {
				Network    map[string]any `json:"network"`
				Executions []any          `json:"executions"`
				QusdOwed   float64        `json:"qusdOwed"`
			}
			if json.Unmarshal(raw, &cooperative) == nil {
				if cooperative.Network != nil {
					snapshot.CooperativeNetwork = cooperative.Network
				}
				enabled := false
				if value, ok := cooperative.Network["enabled"].(bool); ok {
					enabled = value
				}
				snapshot.CooperativeHunting = map[string]any{
					"enabled": enabled, "executions": cooperative.Executions,
					"qusdOwed": cooperative.QusdOwed,
				}
			}
		}
	}
	if summary.CorePending > 0 {
		snapshot.State.Active = int(summary.CorePending)
	}
	if balance, err := strconv.ParseFloat(summary.QvaBalance, 64); err == nil {
		snapshot.Availability.Qusd = dashboardQusdAvailability{
			Available: balance, Reported: balance,
		}
	}
	return snapshot
}

func (api *DashboardAPI) boolSetting(ctx context.Context, key string) bool {
	raw, ok, err := api.Settings.GetSetting(ctx, key)
	if err != nil || !ok {
		return false
	}
	var value bool
	if json.Unmarshal(raw, &value) != nil {
		return false
	}
	return value
}

func (api *DashboardAPI) now() time.Time {
	if api.Now != nil {
		return api.Now()
	}
	return time.Now()
}

func (api *DashboardAPI) offers(w http.ResponseWriter, ctx context.Context, limit int) {
	offers, err := api.Store.Offers(ctx, limit)
	if err != nil {
		writeDashboardUnavailable(w)
		return
	}
	if offers == nil {
		offers = []LiveOffer{}
	}
	writeJSON(w, http.StatusOK, dashboardResponse{Data: offers})
}

func (api *DashboardAPI) operations(w http.ResponseWriter, ctx context.Context, limit int) {
	operations, err := api.Store.Operations(ctx, limit)
	if err != nil {
		writeDashboardUnavailable(w)
		return
	}
	if operations == nil {
		operations = []DashboardOperation{}
	}
	writeJSON(w, http.StatusOK, dashboardResponse{Data: operations})
}

func (api *DashboardAPI) balance(w http.ResponseWriter, ctx context.Context) {
	summary, err := api.Store.Summary(ctx)
	if err != nil {
		writeDashboardUnavailable(w)
		return
	}
	balance := DashboardBalance{Balance: summary.QvaBalance, CapturedAt: summary.CapturedAt}
	writeJSON(w, http.StatusOK, dashboardResponse{Data: balance})
}

// dashboardLimit normaliza el parámetro limit: ausente o inválido usa el
// valor por defecto y los valores fuera de rango se recortan a 1..100.
func dashboardLimit(r *http.Request, fallback int) int {
	raw := r.URL.Query().Get("limit")
	if raw == "" {
		return fallback
	}
	limit, err := strconv.Atoi(raw)
	if err != nil {
		return fallback
	}
	if limit < 1 {
		return 1
	}
	if limit > dashboardMaxLimit {
		return dashboardMaxLimit
	}
	return limit
}

func writeDashboardUnavailable(w http.ResponseWriter) {
	writeJSON(w, http.StatusServiceUnavailable, map[string]string{"status": "unavailable"})
}

// PostgresDashboardStore lee las tablas shadow con SELECT parametrizados. No
// escribe ni abre transacciones de escritura; el pool debe apuntar a una
// sesión de solo lectura cuando se use en producción.
type PostgresDashboardStore struct {
	Pool *pgxpool.Pool
}

// Summary cuenta eventos y decisiones y añade el último snapshot QvaPay. Los
// contadores de eventos y decisiones son globales; los datos QvaPay
// corresponden a la fila más reciente por captured_at.
func (store *PostgresDashboardStore) Summary(ctx context.Context) (DashboardSummary, error) {
	if store == nil || store.Pool == nil {
		return DashboardSummary{}, errors.New("edge: dashboard store sin pool")
	}
	var summary DashboardSummary
	err := store.Pool.QueryRow(ctx, `
		SELECT
			(SELECT count(*) FROM shadow.hunter_events),
			(SELECT count(*) FROM shadow.core_decisions WHERE allowed),
			(SELECT count(*) FROM shadow.core_decisions WHERE NOT allowed),
			(SELECT count(*) FROM shadow.hunter_events
			 WHERE state IN ('pending', 'failed')),
			COALESCE(latest.balance, ''),
			COALESCE(latest.offers::bigint, 0),
			COALESCE(latest.captured_at, 0)
		FROM (VALUES (1)) AS anchor
		LEFT JOIN LATERAL (
			SELECT balance, offers, captured_at
			FROM shadow.qvapay_snapshots
			ORDER BY captured_at DESC, run_id DESC
			LIMIT 1
		) AS latest ON true`,
	).Scan(
		&summary.HunterEvents, &summary.CoreAllowed,
		&summary.CoreBlocked, &summary.CorePending,
		&summary.QvaBalance, &summary.QvaOffers, &summary.CapturedAt,
	)
	if err != nil {
		return DashboardSummary{}, err
	}
	return summary, nil
}

// Offers devuelve las ofertas QvaPay más recientes por captured_at.
func (store *PostgresDashboardStore) Offers(
	ctx context.Context,
	limit int,
) ([]LiveOffer, error) {
	if store == nil || store.Pool == nil {
		return nil, errors.New("edge: dashboard store sin pool")
	}
	if limit <= 0 {
		return []LiveOffer{}, nil
	}
	rows, err := store.Pool.Query(ctx, `
		SELECT offer_uuid, coin, type, amount, receive, rate, status, captured_at
		FROM shadow.qvapay_offers
		ORDER BY captured_at DESC, offer_uuid
		LIMIT $1`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	offers := make([]LiveOffer, 0, limit)
	for rows.Next() {
		var offer LiveOffer
		if err := rows.Scan(
			&offer.UUID, &offer.Coin, &offer.Type, &offer.Amount,
			&offer.Receive, &offer.Rate, &offer.Status, &offer.CapturedAt,
		); err != nil {
			return nil, err
		}
		offers = append(offers, offer)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return offers, nil
}

// Operations devuelve las operaciones shadow más recientes por updated_at.
func (store *PostgresDashboardStore) Operations(
	ctx context.Context,
	limit int,
) ([]DashboardOperation, error) {
	if store == nil || store.Pool == nil {
		return nil, errors.New("edge: dashboard store sin pool")
	}
	if limit <= 0 {
		return []DashboardOperation{}, nil
	}
	rows, err := store.Pool.Query(ctx, `
		SELECT operation_id, state, qusd_amount, fiat_amount, updated_at
		FROM shadow.core_operations
		ORDER BY updated_at DESC, operation_id
		LIMIT $1`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	operations := make([]DashboardOperation, 0, limit)
	for rows.Next() {
		var operation DashboardOperation
		if err := rows.Scan(
			&operation.OperationID, &operation.State,
			&operation.QusdAmount, &operation.FiatAmount,
			&operation.UpdatedAt,
		); err != nil {
			return nil, err
		}
		operations = append(operations, operation)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return operations, nil
}
