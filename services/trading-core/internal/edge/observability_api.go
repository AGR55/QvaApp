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
	// observabilityDefaultDecisionsLimit es el número de decisiones devuelto
	// cuando la query no indica limit.
	observabilityDefaultDecisionsLimit = 20
	// observabilityMaxLimit acota el trabajo y el tamaño de cada respuesta.
	observabilityMaxLimit = 100

	decisionEventsPath    = "/api/decision-events"
	operationalHealthPath = "/api/operational-health"
)

// DecisionEvent es una decisión del core tal como la muestra el panel de
// observabilidad web. Kind corresponde a core_kind en shadow.core_decisions.
type DecisionEvent struct {
	EventID   string `json:"eventId"`
	Coin      string `json:"coin"`
	Side      string `json:"side"`
	Kind      string `json:"kind"`
	Allowed   bool   `json:"allowed"`
	Reason    string `json:"reason"`
	CreatedAt int64  `json:"createdAt"`
}

// OperationalHealth es el estado operativo mostrado en el panel web.
// InvariantAgeSeconds es la antigüedad en segundos del último run del auditor
// de invariantes (0 si aún no hay runs). SSEConnected refleja el estado del
// stream SSE del proceso edge; como ese estado vive en memoria y no en
// Postgres, PostgresObservabilityStore lo devuelve siempre false.
type OperationalHealth struct {
	HunterEvents        int64 `json:"hunterEvents"`
	CoreAllowed         int64 `json:"coreAllowed"`
	CoreBlocked         int64 `json:"coreBlocked"`
	CorePending         int64 `json:"corePending"`
	InvariantViolations int64 `json:"invariantViolations"`
	InvariantAgeSeconds int64 `json:"invariantAgeSeconds"`
	SSEConnected        bool  `json:"sseConnected"`
}

// ObservabilityStore es la fuente de datos de solo lectura del panel de
// observabilidad web.
type ObservabilityStore interface {
	Decisions(ctx context.Context, limit int) ([]DecisionEvent, error)
	Health(ctx context.Context) (OperationalHealth, error)
}

// ObservabilityAPI expone datos de solo lectura para el panel web. Toda
// petición exige la cookie de sesión emitida por SessionHandler; el token
// nunca se devuelve ni se registra.
//
// Rutas:
//
//	GET /api/decision-events?limit=20
//	GET /api/operational-health
//
// limit se recorta al rango 1..100; valores ausentes o no numéricos usan 20.
// Cualquier otro método responde 405 y cualquier otra ruta 404, siempre JSON.
type ObservabilityAPI struct {
	Sessions *SessionManager
	Store    ObservabilityStore
	Now      func() time.Time
}

// observabilityResponse envuelve todos los datos en una clave "data" para
// poder añadir metadatos en el futuro sin romper el contrato.
type observabilityResponse struct {
	Data any `json:"data"`
}

func (api *ObservabilityAPI) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")

	switch r.URL.Path {
	case decisionEventsPath, operationalHealthPath:
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
		writeObservabilityUnavailable(w)
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), statsTimeout)
	defer cancel()

	switch r.URL.Path {
	case decisionEventsPath:
		api.decisions(w, ctx, observabilityLimit(r))
	case operationalHealthPath:
		api.health(w, ctx)
	}
}

// authenticated valida la cookie de sesión con el reloj configurado. Un
// SessionManager nil también produce false.
func (api *ObservabilityAPI) authenticated(r *http.Request) bool {
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

func (api *ObservabilityAPI) decisions(w http.ResponseWriter, ctx context.Context, limit int) {
	decisions, err := api.Store.Decisions(ctx, limit)
	if err != nil {
		writeObservabilityUnavailable(w)
		return
	}
	if decisions == nil {
		decisions = []DecisionEvent{}
	}
	writeJSON(w, http.StatusOK, observabilityResponse{Data: decisions})
}

func (api *ObservabilityAPI) health(w http.ResponseWriter, ctx context.Context) {
	health, err := api.Store.Health(ctx)
	if err != nil {
		writeObservabilityUnavailable(w)
		return
	}
	writeJSON(w, http.StatusOK, observabilityResponse{Data: health})
}

// observabilityLimit normaliza el parámetro limit: ausente o inválido usa el
// valor por defecto y los valores fuera de rango se recortan a 1..100.
func observabilityLimit(r *http.Request) int {
	raw := r.URL.Query().Get("limit")
	if raw == "" {
		return observabilityDefaultDecisionsLimit
	}
	limit, err := strconv.Atoi(raw)
	if err != nil {
		return observabilityDefaultDecisionsLimit
	}
	if limit < 1 {
		return 1
	}
	if limit > observabilityMaxLimit {
		return observabilityMaxLimit
	}
	return limit
}

func writeObservabilityUnavailable(w http.ResponseWriter) {
	writeJSON(w, http.StatusServiceUnavailable, map[string]string{"status": "unavailable"})
}

// PostgresObservabilityStore lee las tablas shadow con SELECT parametrizados.
// No escribe ni abre transacciones de escritura; el pool debe apuntar a una
// sesión de solo lectura cuando se use en producción.
type PostgresObservabilityStore struct {
	Pool *pgxpool.Pool
}

// Decisions devuelve todas las decisiones del core, permitidas y bloqueadas,
// más recientes por created_at.
func (store *PostgresObservabilityStore) Decisions(
	ctx context.Context,
	limit int,
) ([]DecisionEvent, error) {
	if store == nil || store.Pool == nil {
		return nil, errors.New("edge: observability store sin pool")
	}
	if limit <= 0 {
		return []DecisionEvent{}, nil
	}
	rows, err := store.Pool.Query(ctx, `
		SELECT event_id, coin, side, core_kind, allowed, reason, created_at
		FROM shadow.core_decisions
		ORDER BY created_at DESC, event_id
		LIMIT $1`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	decisions := make([]DecisionEvent, 0, limit)
	for rows.Next() {
		var decision DecisionEvent
		if err := rows.Scan(
			&decision.EventID, &decision.Coin, &decision.Side,
			&decision.Kind, &decision.Allowed, &decision.Reason,
			&decision.CreatedAt,
		); err != nil {
			return nil, err
		}
		decisions = append(decisions, decision)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return decisions, nil
}

// Health cuenta eventos, decisiones e invariantes y calcula la antigüedad del
// último run del auditor. shadow.invariant_runs.created_at se persiste en
// segundos Unix, por lo que la edad se calcula contra time.Now().Unix().
// SSEConnected queda en false: el stream SSE no se persiste en Postgres.
func (store *PostgresObservabilityStore) Health(
	ctx context.Context,
) (OperationalHealth, error) {
	if store == nil || store.Pool == nil {
		return OperationalHealth{}, errors.New("edge: observability store sin pool")
	}
	var health OperationalHealth
	var lastInvariantRun int64
	err := store.Pool.QueryRow(ctx, `
		SELECT
			(SELECT count(*) FROM shadow.hunter_events),
			(SELECT count(*) FROM shadow.core_decisions WHERE allowed),
			(SELECT count(*) FROM shadow.core_decisions WHERE NOT allowed),
			(SELECT count(*) FROM shadow.hunter_events
			 WHERE state IN ('pending', 'failed')),
			(SELECT COALESCE(sum(violations), 0) FROM shadow.invariant_runs),
			(SELECT COALESCE(max(created_at), 0) FROM shadow.invariant_runs)`,
	).Scan(
		&health.HunterEvents, &health.CoreAllowed,
		&health.CoreBlocked, &health.CorePending,
		&health.InvariantViolations, &lastInvariantRun,
	)
	if err != nil {
		return OperationalHealth{}, err
	}
	health.SSEConnected = false
	if lastInvariantRun > 0 {
		if age := time.Now().Unix() - lastInvariantRun; age > 0 {
			health.InvariantAgeSeconds = age
		}
	}
	return health, nil
}
