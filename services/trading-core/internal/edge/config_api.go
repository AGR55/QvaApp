package edge

import (
	"context"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

const (
	// configDefaultLimit es el número de filas devuelto cuando la query no
	// indica limit.
	configDefaultLimit = 20
	// configMaxLimit acota el trabajo y el tamaño de cada respuesta.
	configMaxLimit = 100

	configPath              = "/api/config"
	configRevisionsPath     = "/api/config-revisions"
	marketSourcePath        = "/api/market-source"
	auditPath               = "/api/audit"
	notificationsPath       = "/api/notifications"
	logsPath                = "/api/logs"
	recoveryPath            = "/api/recovery"
	openAPIDocumentPath     = "/api/openapi.json"
	pushPublicKeyPath       = "/api/push/public-key"
	openAPITitle            = "QvaApply Edge API"
	openAPIVersion          = "1.0.0"
	configReadOnlyStoreMode = "go-shadow"
)

// ConfigStore es la fuente de datos de solo lectura de las rutas P2.
// Config devuelve un resumen seguro (sin secretos); Revisions, Audit y
// Recovery devuelven colecciones acotadas por limit.
type ConfigStore interface {
	Config(ctx context.Context) (any, error)
	Revisions(ctx context.Context, limit int) ([]any, error)
	Audit(ctx context.Context, limit int) ([]any, error)
	Recovery(ctx context.Context, limit int) ([]any, error)
}

// ConfigAPI expone las rutas P2 de solo lectura del panel web. Toda petición
// exige la cookie de sesión emitida por SessionHandler; el token nunca se
// devuelve ni se registra.
//
// Rutas:
//
//	GET /api/config
//	GET /api/config-revisions?limit=20
//	GET /api/market-source
//	GET /api/audit?limit=20
//	GET /api/notifications
//	GET /api/logs
//	GET /api/recovery?limit=20
//	GET /api/openapi.json
//	GET /api/push/public-key
//
// limit se recorta al rango 1..100; valores ausentes o no numéricos usan 20.
// Cualquier otro método responde 405 y cualquier otra ruta 404, siempre JSON.
type ConfigAPI struct {
	Sessions      *SessionManager
	Now           func() time.Time
	PublicPushKey string
	Store         ConfigStore
}

// configResponse envuelve todos los datos en una clave "data" para poder
// añadir metadatos en el futuro sin romper el contrato.
type configResponse struct {
	Data any `json:"data"`
}

// configFallback es el resumen mínimo cuando no hay store configurado. No
// contiene secretos ni detalles del despliegue.
type configFallback struct {
	Mode string `json:"mode"`
}

// MarketSourceStatus describe el modo actual de lectura del mercado. El edge
// sirve SSE y no hace polling propio.
type MarketSourceStatus struct {
	Mode    string `json:"mode"`
	Polling bool   `json:"polling"`
}

// pushPublicKeyResponse es la clave pública VAPID usada por el navegador.
type pushPublicKeyResponse struct {
	PublicKey string `json:"publicKey"`
}

func (api *ConfigAPI) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")

	switch r.URL.Path {
	case configPath, configRevisionsPath, marketSourcePath, auditPath,
		notificationsPath, logsPath, recoveryPath, openAPIDocumentPath,
		pushPublicKeyPath:
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

	ctx, cancel := context.WithTimeout(r.Context(), statsTimeout)
	defer cancel()

	switch r.URL.Path {
	case configPath:
		api.config(w, ctx)
	case configRevisionsPath:
		api.collection(w, ctx, configRevisionsPath, configLimit(r))
	case auditPath:
		api.collection(w, ctx, auditPath, configLimit(r))
	case recoveryPath:
		api.collection(w, ctx, recoveryPath, configLimit(r))
	case marketSourcePath:
		writeJSON(w, http.StatusOK, configResponse{Data: MarketSourceStatus{
			Mode:    "go-sse",
			Polling: false,
		}})
	case notificationsPath, logsPath:
		writeJSON(w, http.StatusOK, configResponse{Data: []any{}})
	case openAPIDocumentPath:
		writeJSON(w, http.StatusOK, newOpenAPIDocument())
	case pushPublicKeyPath:
		api.pushPublicKey(w)
	}
}

// authenticated valida la cookie de sesión con el reloj configurado. Un
// SessionManager nil también produce false.
func (api *ConfigAPI) authenticated(r *http.Request) bool {
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

// config devuelve el resumen del store o, si no hay store, un fallback seguro.
func (api *ConfigAPI) config(w http.ResponseWriter, ctx context.Context) {
	if api.Store == nil {
		writeJSON(w, http.StatusOK, configResponse{Data: configFallback{
			Mode: configReadOnlyStoreMode,
		}})
		return
	}

	value, err := api.Store.Config(ctx)
	if err != nil {
		writeConfigUnavailable(w)
		return
	}
	if value == nil {
		value = configFallback{Mode: configReadOnlyStoreMode}
	}
	writeJSON(w, http.StatusOK, configResponse{Data: value})
}

// collection sirve config-revisions, audit y recovery. Sin store responde una
// lista vacía, de modo que el panel puede arrancar antes de que Postgres esté
// disponible.
func (api *ConfigAPI) collection(
	w http.ResponseWriter,
	ctx context.Context,
	route string,
	limit int,
) {
	if api.Store == nil {
		writeJSON(w, http.StatusOK, configResponse{Data: []any{}})
		return
	}

	var (
		items []any
		err   error
	)
	switch route {
	case configRevisionsPath:
		items, err = api.Store.Revisions(ctx, limit)
	case auditPath:
		items, err = api.Store.Audit(ctx, limit)
	case recoveryPath:
		items, err = api.Store.Recovery(ctx, limit)
	}
	if err != nil {
		writeConfigUnavailable(w)
		return
	}
	if items == nil {
		items = []any{}
	}
	writeJSON(w, http.StatusOK, configResponse{Data: items})
}

// pushPublicKey publica la clave VAPID pública. Una clave ausente deja push
// deshabilitado y responde 503 sin exponer detalles.
func (api *ConfigAPI) pushPublicKey(w http.ResponseWriter) {
	key := strings.TrimSpace(api.PublicPushKey)
	if key == "" {
		writeConfigUnavailable(w)
		return
	}
	writeJSON(w, http.StatusOK, configResponse{Data: pushPublicKeyResponse{
		PublicKey: key,
	}})
}

// configLimit normaliza el parámetro limit: ausente o inválido usa el valor por
// defecto y los valores fuera de rango se recortan a 1..100.
func configLimit(r *http.Request) int {
	raw := r.URL.Query().Get("limit")
	if raw == "" {
		return configDefaultLimit
	}
	limit, err := strconv.Atoi(raw)
	if err != nil {
		return configDefaultLimit
	}
	if limit < 1 {
		return 1
	}
	if limit > configMaxLimit {
		return configMaxLimit
	}
	return limit
}

func writeConfigUnavailable(w http.ResponseWriter) {
	writeJSON(w, http.StatusServiceUnavailable, map[string]string{"status": "unavailable"})
}

// openAPIDocument es el subconjunto estático de OpenAPI publicado por el
// edge. Se construye en memoria y no incluye servidores, credenciales ni
// esquemas de seguridad.
type openAPIDocument struct {
	OpenAPI string                 `json:"openapi"`
	Info    openAPIInfo            `json:"info"`
	Paths   map[string]openAPIPath `json:"paths"`
}

type openAPIInfo struct {
	Title   string `json:"title"`
	Version string `json:"version"`
}

type openAPIPath struct {
	Get openAPIOperation `json:"get"`
}

type openAPIOperation struct {
	Summary   string                     `json:"summary"`
	Responses map[string]openAPIResponse `json:"responses"`
}

type openAPIResponse struct {
	Description string `json:"description"`
}

func newOpenAPIDocument() openAPIDocument {
	paths := make(map[string]openAPIPath)
	for _, route := range []string{
		configPath, configRevisionsPath, marketSourcePath, auditPath,
		notificationsPath, logsPath, recoveryPath, openAPIDocumentPath,
		pushPublicKeyPath,
	} {
		paths[route] = openAPIPath{Get: openAPIOperation{
			Summary: "Lectura autenticada de " + route,
			Responses: map[string]openAPIResponse{
				"200": {Description: "OK"},
				"401": {Description: "No autenticado"},
			},
		}}
	}
	return openAPIDocument{
		OpenAPI: "3.0.3",
		Info: openAPIInfo{
			Title:   openAPITitle,
			Version: openAPIVersion,
		},
		Paths: paths,
	}
}

// ConfigSnapshot es el resumen seguro servido por /api/config. Solo contiene
// contadores de las tablas shadow y el modo del store; nunca secretos.
type ConfigSnapshot struct {
	Mode            string `json:"mode"`
	HunterEvents    int64  `json:"hunterEvents"`
	CoreDecisions   int64  `json:"coreDecisions"`
	InvariantRuns   int64  `json:"invariantRuns"`
	ShadowRuns      int64  `json:"shadowRuns"`
	LastInvariantAt int64  `json:"lastInvariantAt"`
}

// ConfigRevision es una ejecución del auditor de invariantes expuesta como
// revisión de solo lectura.
type ConfigRevision struct {
	RevisionID string `json:"revisionId"`
	Source     string `json:"source"`
	Violations int64  `json:"violations"`
	CreatedAt  int64  `json:"createdAt"`
}

// ConfigAuditEvent es una decisión del core usada como registro de auditoría.
type ConfigAuditEvent struct {
	EventID   string `json:"eventId"`
	Coin      string `json:"coin"`
	Side      string `json:"side"`
	Allowed   bool   `json:"allowed"`
	Reason    string `json:"reason"`
	CreatedAt int64  `json:"createdAt"`
}

// ConfigRecoveryItem es un evento de hunter pendiente o fallido que requiere
// recuperación manual.
type ConfigRecoveryItem struct {
	EventID   string `json:"eventId"`
	Coin      string `json:"coin"`
	Side      string `json:"side"`
	State     string `json:"state"`
	Attempts  int64  `json:"attempts"`
	CreatedAt int64  `json:"createdAt"`
}

// PostgresConfigStore lee las tablas shadow con SELECT parametrizados. No
// escribe ni abre transacciones de escritura; el pool debe apuntar a una
// sesión de solo lectura cuando se use en producción.
type PostgresConfigStore struct {
	Pool *pgxpool.Pool
}

var _ ConfigStore = (*PostgresConfigStore)(nil)

// Config devuelve contadores agregados de las tablas shadow. Es un resumen
// operativo, no la configuración completa del monolito: no expone secretos,
// credenciales ni valores de entorno.
func (store *PostgresConfigStore) Config(
	ctx context.Context,
) (any, error) {
	if store == nil || store.Pool == nil {
		return nil, errors.New("edge: config store sin pool")
	}
	var snapshot ConfigSnapshot
	err := store.Pool.QueryRow(ctx, `
		SELECT
			(SELECT count(*) FROM shadow.hunter_events),
			(SELECT count(*) FROM shadow.core_decisions),
			(SELECT count(*) FROM shadow.invariant_runs),
			(SELECT count(*) FROM shadow.runs),
			(SELECT COALESCE(max(created_at), 0) FROM shadow.invariant_runs)`,
	).Scan(
		&snapshot.HunterEvents, &snapshot.CoreDecisions,
		&snapshot.InvariantRuns, &snapshot.ShadowRuns,
		&snapshot.LastInvariantAt,
	)
	if err != nil {
		return nil, err
	}
	snapshot.Mode = configReadOnlyStoreMode
	return snapshot, nil
}

// Revisions devuelve las ejecuciones del auditor de invariantes más recientes.
func (store *PostgresConfigStore) Revisions(
	ctx context.Context,
	limit int,
) ([]any, error) {
	if store == nil || store.Pool == nil {
		return nil, errors.New("edge: config store sin pool")
	}
	if limit <= 0 {
		return []any{}, nil
	}
	rows, err := store.Pool.Query(ctx, `
		SELECT run_id, source, violations, created_at
		FROM shadow.invariant_runs
		ORDER BY created_at DESC, run_id
		LIMIT $1`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	revisions := make([]any, 0, limit)
	for rows.Next() {
		var revision ConfigRevision
		if err := rows.Scan(
			&revision.RevisionID, &revision.Source,
			&revision.Violations, &revision.CreatedAt,
		); err != nil {
			return nil, err
		}
		revisions = append(revisions, revision)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return revisions, nil
}

// Audit devuelve las decisiones del core más recientes, permitidas y
// bloqueadas, sin el detalle de checks_json.
func (store *PostgresConfigStore) Audit(
	ctx context.Context,
	limit int,
) ([]any, error) {
	if store == nil || store.Pool == nil {
		return nil, errors.New("edge: config store sin pool")
	}
	if limit <= 0 {
		return []any{}, nil
	}
	rows, err := store.Pool.Query(ctx, `
		SELECT event_id, coin, side, allowed, reason, created_at
		FROM shadow.core_decisions
		ORDER BY created_at DESC, event_id
		LIMIT $1`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	events := make([]any, 0, limit)
	for rows.Next() {
		var event ConfigAuditEvent
		if err := rows.Scan(
			&event.EventID, &event.Coin, &event.Side,
			&event.Allowed, &event.Reason, &event.CreatedAt,
		); err != nil {
			return nil, err
		}
		events = append(events, event)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return events, nil
}

// Recovery devuelve los eventos de hunter pendientes o fallidos que todavía
// requieren intervención.
func (store *PostgresConfigStore) Recovery(
	ctx context.Context,
	limit int,
) ([]any, error) {
	if store == nil || store.Pool == nil {
		return nil, errors.New("edge: config store sin pool")
	}
	if limit <= 0 {
		return []any{}, nil
	}
	rows, err := store.Pool.Query(ctx, `
		SELECT event_id, coin, side, state, attempts, created_at
		FROM shadow.hunter_events
		WHERE state IN ('pending', 'failed')
		ORDER BY created_at DESC, event_id
		LIMIT $1`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	items := make([]any, 0, limit)
	for rows.Next() {
		var item ConfigRecoveryItem
		if err := rows.Scan(
			&item.EventID, &item.Coin, &item.Side, &item.State,
			&item.Attempts, &item.CreatedAt,
		); err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return items, nil
}
