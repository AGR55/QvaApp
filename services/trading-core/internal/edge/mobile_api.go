package edge

import (
	"context"
	"errors"
	"net/http"
	"strconv"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

const (
	// mobileDefaultLimit es el número de elementos devuelto cuando la query no
	// indica limit.
	mobileDefaultLimit = 20
	// mobileMaxLimit acota el trabajo y el tamaño de cada respuesta móvil.
	mobileMaxLimit = 100

	mobileOverviewPath   = "/api/mobile/overview"
	mobileMarketsPath    = "/api/mobile/markets"
	mobileAlertsPath     = "/api/mobile/alerts"
	mobileOperationsPath = "/api/mobile/operations"
)

// MobileSummary es el agregado mostrado en la pantalla principal de la app.
// SSEConnected refleja el estado del stream SSE del proceso edge; como ese
// estado vive en memoria y no en Postgres, PostgresMobileStore lo devuelve
// siempre false.
type MobileSummary struct {
	HunterEvents int64 `json:"hunterEvents"`
	CoreAllowed  int64 `json:"coreAllowed"`
	CoreBlocked  int64 `json:"coreBlocked"`
	CorePending  int64 `json:"corePending"`
	SSEConnected bool  `json:"sseConnected"`
}

// MobileMarket resume las ofertas QvaPay por moneda y lado.
type MobileMarket struct {
	Coin string `json:"coin"`
	Buy  int64  `json:"buy"`
	Sell int64  `json:"sell"`
}

// MobileAlert es una decisión bloqueada del core, apta para mostrar en la app.
type MobileAlert struct {
	EventID   string `json:"eventId"`
	Coin      string `json:"coin"`
	Side      string `json:"side"`
	Kind      string `json:"kind"`
	Reason    string `json:"reason"`
	CreatedAt int64  `json:"createdAt"`
}

// MobileOperation es el estado público de una operación shadow.
type MobileOperation struct {
	OperationID string `json:"operationId"`
	State       string `json:"state"`
	QusdAmount  string `json:"qusdAmount"`
	FiatAmount  string `json:"fiatAmount"`
	UpdatedAt   int64  `json:"updatedAt"`
}

// MobileStore es la fuente de datos de solo lectura de la API móvil.
type MobileStore interface {
	Overview(ctx context.Context) (MobileSummary, error)
	Markets(ctx context.Context) ([]MobileMarket, error)
	Alerts(ctx context.Context, limit int) ([]MobileAlert, error)
	Operations(ctx context.Context, limit int) ([]MobileOperation, error)
}

// MobileAPI expone datos de solo lectura para web y Android. Toda petición
// exige la cookie de sesión emitida por SessionHandler; el token nunca se
// devuelve ni se registra.
//
// Rutas:
//
//	GET /api/mobile/overview
//	GET /api/mobile/markets
//	GET /api/mobile/alerts?limit=20
//	GET /api/mobile/operations?limit=20
//
// limit se recorta al rango 1..100; valores ausentes o no numéricos usan 20.
// Cualquier otro método responde 405 y cualquier otra ruta 404, siempre JSON.
type MobileAPI struct {
	Sessions *SessionManager
	Store    MobileStore
	Now      func() time.Time
}

// mobileResponse envuelve todos los datos en una clave "data" para que el
// cliente pueda añadir metadatos en el futuro sin romper el contrato.
type mobileResponse struct {
	Data any `json:"data"`
}

func (api *MobileAPI) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")

	switch r.URL.Path {
	case mobileOverviewPath, mobileMarketsPath, mobileAlertsPath, mobileOperationsPath:
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
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"status": "unavailable"})
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), statsTimeout)
	defer cancel()

	switch r.URL.Path {
	case mobileOverviewPath:
		api.overview(w, ctx)
	case mobileMarketsPath:
		api.markets(w, ctx)
	case mobileAlertsPath:
		api.alerts(w, ctx, mobileLimit(r))
	case mobileOperationsPath:
		api.operations(w, ctx, mobileLimit(r))
	}
}

// authenticated valida la cookie de sesión con el reloj configurado. Un
// SessionManager nil también produce false.
func (api *MobileAPI) authenticated(r *http.Request) bool {
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

func (api *MobileAPI) overview(w http.ResponseWriter, ctx context.Context) {
	summary, err := api.Store.Overview(ctx)
	if err != nil {
		writeMobileUnavailable(w)
		return
	}
	writeJSON(w, http.StatusOK, mobileResponse{Data: summary})
}

func (api *MobileAPI) markets(w http.ResponseWriter, ctx context.Context) {
	markets, err := api.Store.Markets(ctx)
	if err != nil {
		writeMobileUnavailable(w)
		return
	}
	if markets == nil {
		markets = []MobileMarket{}
	}
	writeJSON(w, http.StatusOK, mobileResponse{Data: markets})
}

func (api *MobileAPI) alerts(w http.ResponseWriter, ctx context.Context, limit int) {
	alerts, err := api.Store.Alerts(ctx, limit)
	if err != nil {
		writeMobileUnavailable(w)
		return
	}
	if alerts == nil {
		alerts = []MobileAlert{}
	}
	writeJSON(w, http.StatusOK, mobileResponse{Data: alerts})
}

func (api *MobileAPI) operations(w http.ResponseWriter, ctx context.Context, limit int) {
	operations, err := api.Store.Operations(ctx, limit)
	if err != nil {
		writeMobileUnavailable(w)
		return
	}
	if operations == nil {
		operations = []MobileOperation{}
	}
	writeJSON(w, http.StatusOK, mobileResponse{Data: operations})
}

// mobileLimit normaliza el parámetro limit: ausente o inválido usa el valor
// por defecto y los valores fuera de rango se recortan a 1..100.
func mobileLimit(r *http.Request) int {
	raw := r.URL.Query().Get("limit")
	if raw == "" {
		return mobileDefaultLimit
	}
	limit, err := strconv.Atoi(raw)
	if err != nil {
		return mobileDefaultLimit
	}
	if limit < 1 {
		return 1
	}
	if limit > mobileMaxLimit {
		return mobileMaxLimit
	}
	return limit
}

func writeMobileUnavailable(w http.ResponseWriter) {
	writeJSON(w, http.StatusServiceUnavailable, map[string]string{"status": "unavailable"})
}

// PostgresMobileStore lee las tablas shadow con SELECT parametrizados. No
// escribe ni abre transacciones de escritura; el pool debe apuntar a una
// sesión de solo lectura cuando se use en producción.
type PostgresMobileStore struct {
	Pool *pgxpool.Pool
}

// Overview cuenta eventos y decisiones. CorePending agrupa los estados
// pending y failed porque ambos siguen siendo trabajo reintentable, igual que
// el resumen existente de /api/edge/summary. SSEConnected queda en false: el
// stream SSE no se persiste en Postgres.
func (store *PostgresMobileStore) Overview(ctx context.Context) (MobileSummary, error) {
	if store == nil || store.Pool == nil {
		return MobileSummary{}, errors.New("edge: mobile store sin pool")
	}
	var summary MobileSummary
	err := store.Pool.QueryRow(ctx, `
		SELECT
			(SELECT count(*) FROM shadow.hunter_events),
			(SELECT count(*) FROM shadow.core_decisions WHERE allowed),
			(SELECT count(*) FROM shadow.core_decisions WHERE NOT allowed),
			(SELECT count(*) FROM shadow.hunter_events
			 WHERE state IN ('pending', 'failed'))`,
	).Scan(
		&summary.HunterEvents, &summary.CoreAllowed,
		&summary.CoreBlocked, &summary.CorePending,
	)
	if err != nil {
		return MobileSummary{}, err
	}
	summary.SSEConnected = false
	return summary, nil
}

// Markets agrupa las ofertas por moneda y cuenta los lados buy/sell.
func (store *PostgresMobileStore) Markets(ctx context.Context) ([]MobileMarket, error) {
	if store == nil || store.Pool == nil {
		return nil, errors.New("edge: mobile store sin pool")
	}
	rows, err := store.Pool.Query(ctx, `
		SELECT coin,
		       count(*) FILTER (WHERE type = 'buy'),
		       count(*) FILTER (WHERE type = 'sell')
		FROM shadow.qvapay_offers
		GROUP BY coin
		ORDER BY coin`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	markets := make([]MobileMarket, 0)
	for rows.Next() {
		var market MobileMarket
		if err := rows.Scan(&market.Coin, &market.Buy, &market.Sell); err != nil {
			return nil, err
		}
		markets = append(markets, market)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return markets, nil
}

// Alerts devuelve las decisiones bloqueadas más recientes.
func (store *PostgresMobileStore) Alerts(ctx context.Context, limit int) ([]MobileAlert, error) {
	if store == nil || store.Pool == nil {
		return nil, errors.New("edge: mobile store sin pool")
	}
	if limit <= 0 {
		return []MobileAlert{}, nil
	}
	rows, err := store.Pool.Query(ctx, `
		SELECT event_id, coin, side, core_kind, reason, created_at
		FROM shadow.core_decisions
		WHERE NOT allowed
		ORDER BY created_at DESC, event_id
		LIMIT $1`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	alerts := make([]MobileAlert, 0, limit)
	for rows.Next() {
		var alert MobileAlert
		if err := rows.Scan(
			&alert.EventID, &alert.Coin, &alert.Side,
			&alert.Kind, &alert.Reason, &alert.CreatedAt,
		); err != nil {
			return nil, err
		}
		alerts = append(alerts, alert)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return alerts, nil
}

// Operations devuelve las operaciones shadow más recientes por updated_at.
func (store *PostgresMobileStore) Operations(
	ctx context.Context,
	limit int,
) ([]MobileOperation, error) {
	if store == nil || store.Pool == nil {
		return nil, errors.New("edge: mobile store sin pool")
	}
	if limit <= 0 {
		return []MobileOperation{}, nil
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

	operations := make([]MobileOperation, 0, limit)
	for rows.Next() {
		var operation MobileOperation
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
