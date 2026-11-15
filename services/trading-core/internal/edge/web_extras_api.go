package edge

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5/pgxpool"
)

const (
	webExtrasLogsPath          = "/api/logs"
	webExtrasNotificationsPath = "/api/notifications"
	webExtrasRecoveryPath      = "/api/recovery"
	webExtrasAckSuffix         = "/ack"

	// webExtrasMaxSnapshotBytes acota el snapshot que el proceso edge carga en
	// memoria por petición.
	webExtrasMaxSnapshotBytes = 8 << 20
	webExtrasDefaultLogLimit  = 100
	webExtrasMaxLogLimit      = 200
	webExtrasMaxQueryRunes    = 120
	webExtrasMinSinceMS       = 1_000
	webExtrasMaxSinceMS       = 604_800_000
	webExtrasMaxAckIDRunes    = 200
	webExtrasMaxAckBodyBytes  = 4 << 10
	webExtrasMaxDetailRunes   = 2_000
)

// AckStore persiste y consulta los avisos ya confirmados por el usuario.
type AckStore interface {
	Acked(ctx context.Context) (map[string]struct{}, error)
	Ack(ctx context.Context, id string, now int64) error
}

// PostgresAckStore implementa AckStore sobre shadow.notification_acks. No
// guarda nada más que el identificador y el instante de confirmación.
type PostgresAckStore struct {
	Pool *pgxpool.Pool
}

var _ AckStore = (*PostgresAckStore)(nil)

// Acked devuelve el conjunto de identificadores ya confirmados.
func (store *PostgresAckStore) Acked(ctx context.Context) (map[string]struct{}, error) {
	if store == nil || store.Pool == nil {
		return nil, errors.New("edge: ack store sin pool")
	}
	rows, err := store.Pool.Query(ctx, `SELECT id FROM shadow.notification_acks`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	acked := make(map[string]struct{})
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		acked[id] = struct{}{}
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return acked, nil
}

// Ack registra una confirmación. Repetir la misma confirmación no cambia el
// instante original almacenado.
func (store *PostgresAckStore) Ack(ctx context.Context, id string, now int64) error {
	if store == nil || store.Pool == nil {
		return errors.New("edge: ack store sin pool")
	}
	_, err := store.Pool.Exec(ctx, `
		INSERT INTO shadow.notification_acks (id, acknowledged_at)
		VALUES ($1, $2)
		ON CONFLICT DO NOTHING`, id, now)
	return err
}

// WebExtrasAPI expone logs operativos, notificaciones pendientes y el estado de
// recuperación del snapshot exportado por el monolito TS.
//
// Rutas:
//
//	GET  /api/logs
//	GET  /api/notifications
//	POST /api/notifications/{id}/ack
//	GET  /api/recovery
//
// Todas exigen cookie de sesión. La mutación exige además Origin permitido y
// CSRF de doble envío. Las respuestas nunca exponen rutas ni errores internos.
type WebExtrasAPI struct {
	Sessions      *SessionManager
	File          string
	Acks          AckStore
	TrustedOrigin string
	Now           func() time.Time
}

type webExtrasSnapshot struct {
	Logs          []webExtrasLog          `json:"logs"`
	Notifications []webExtrasNotification `json:"notifications"`
	Recovery      json.RawMessage         `json:"recovery"`
}

type webExtrasLog struct {
	ID        int64   `json:"id"`
	CreatedAt int64   `json:"createdAt"`
	Action    string  `json:"action"`
	UUID      *string `json:"uuid"`
	Detail    string  `json:"detail"`
}

type webExtrasNotification struct {
	ID            string         `json:"id"`
	Kind          string         `json:"kind"`
	Message       string         `json:"message"`
	OperationUUID *string        `json:"operationUuid"`
	Payload       map[string]any `json:"payload"`
	CreatedAt     int64          `json:"createdAt"`
}

type webExtrasLogQuery struct {
	after     int64
	limit     int
	level     string
	component string
	query     string
	since     int64
}

type webExtrasLogItem struct {
	ID        int64   `json:"id"`
	CreatedAt int64   `json:"createdAt"`
	Action    string  `json:"action"`
	UUID      *string `json:"uuid"`
	Detail    string  `json:"detail"`
	Level     string  `json:"level"`
	Component string  `json:"component"`
}

type webExtrasLogPage struct {
	Items    []webExtrasLogItem `json:"items"`
	HasMore  bool               `json:"hasMore"`
	NewestID int64              `json:"newestId"`
}

type webExtrasLogsResponse struct {
	Data   webExtrasLogPage `json:"data"`
	Source string           `json:"source"`
}

type webExtrasNotificationAlert struct {
	UUID   string `json:"uuid"`
	Coin   string `json:"coin"`
	Amount any    `json:"amount"`
}

type webExtrasNotificationItem struct {
	ID        string `json:"id"`
	Type      string `json:"type"`
	Message   string `json:"message"`
	Alert     any    `json:"alert"`
	URL       string `json:"url"`
	CreatedAt int64  `json:"createdAt"`
}

type webExtrasNotificationsResponse struct {
	Data []webExtrasNotificationItem `json:"data"`
}

type webExtrasRecoveryResponse struct {
	Data json.RawMessage `json:"data"`
}

var (
	webExtrasBearerRE = regexp.MustCompile(`(?i)Bearer\s+\S+`)
	webExtrasOpaqueRE = regexp.MustCompile(`\b\d+\|[A-Za-z0-9._~-]+\b`)
	webExtrasSecretRE = regexp.MustCompile(`(?i)\b(token|password|secret|api[_-]?key|authorization)\s*([=:])\s*\S+`)
)

func (api *WebExtrasAPI) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")

	path := r.URL.Path
	if path == webExtrasNotificationsPath || strings.HasPrefix(path, webExtrasNotificationsPath+"/") {
		if id, ok := webExtrasAckID(path); ok {
			if r.Method != http.MethodPost {
				w.Header().Set("Allow", http.MethodPost)
				writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"status": "method_not_allowed"})
				return
			}
			api.ack(w, r, id)
			return
		}
	}

	switch path {
	case webExtrasLogsPath, webExtrasNotificationsPath, webExtrasRecoveryPath:
	default:
		writeJSON(w, http.StatusNotFound, map[string]string{"status": "not_found"})
		return
	}

	if r.Method != http.MethodGet {
		w.Header().Set("Allow", http.MethodGet)
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"status": "method_not_allowed"})
		return
	}

	if _, ok := api.authenticated(r); !ok {
		writeJSON(w, http.StatusUnauthorized, map[string]any{"error": "Autenticación requerida."})
		return
	}

	snapshot, ok := api.loadSnapshot()
	if !ok {
		writeWebExtrasUnavailable(w)
		return
	}

	switch path {
	case webExtrasLogsPath:
		api.logs(w, r, snapshot)
	case webExtrasNotificationsPath:
		api.notifications(w, r, snapshot)
	case webExtrasRecoveryPath:
		api.recovery(w, snapshot)
	}
}

// webExtrasAckID reconoce /api/notifications/{id}/ack con exactamente un
// segmento no vacío.
func webExtrasAckID(path string) (string, bool) {
	remainder, ok := strings.CutPrefix(path, webExtrasNotificationsPath+"/")
	if !ok {
		return "", false
	}
	id, ok := strings.CutSuffix(remainder, webExtrasAckSuffix)
	if !ok || id == "" || strings.Contains(id, "/") {
		return "", false
	}
	return id, true
}

func (api *WebExtrasAPI) authenticated(r *http.Request) (string, bool) {
	if api.Sessions == nil {
		return "", false
	}
	cookie, err := r.Cookie(CookieName)
	if err != nil || cookie.Value == "" {
		return "", false
	}
	if _, err := api.Sessions.Verify(cookie.Value, api.now()); err != nil {
		return "", false
	}
	return cookie.Value, true
}

func (api *WebExtrasAPI) mutationAllowed(w http.ResponseWriter, r *http.Request, cookie string) bool {
	if !edgeOriginAllowed(r, api.TrustedOrigin) {
		writeJSON(w, http.StatusForbidden, map[string]any{"error": "Origen de solicitud no autorizado."})
		return false
	}
	csrf := requestCSRFToken(r)
	if csrf == "" || api.Sessions == nil ||
		!api.Sessions.ValidateCSRF(cookie, csrf, api.now()) {
		writeJSON(w, http.StatusForbidden, map[string]any{"error": "CSRF inválido."})
		return false
	}
	return true
}

func (api *WebExtrasAPI) logs(w http.ResponseWriter, r *http.Request, snapshot webExtrasSnapshot) {
	query, ok := webExtrasParseLogQuery(r)
	if !ok {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "Filtro inválido."})
		return
	}
	page := webExtrasBuildLogPage(snapshot, query, api.now().UnixMilli())
	writeJSON(w, http.StatusOK, webExtrasLogsResponse{Data: page, Source: "sqlite"})
}

func (api *WebExtrasAPI) notifications(w http.ResponseWriter, r *http.Request, snapshot webExtrasSnapshot) {
	acked := map[string]struct{}{}
	if api.Acks != nil {
		ctx, cancel := context.WithTimeout(r.Context(), statsTimeout)
		defer cancel()
		loaded, err := api.Acks.Acked(ctx)
		if err != nil {
			writeWebExtrasUnavailable(w)
			return
		}
		if loaded != nil {
			acked = loaded
		}
	}

	items := make([]webExtrasNotificationItem, 0, len(snapshot.Notifications))
	for _, notification := range snapshot.Notifications {
		if _, skip := acked[notification.ID]; skip {
			continue
		}
		operationUUID := ""
		if notification.OperationUUID != nil {
			operationUUID = *notification.OperationUUID
		}
		items = append(items, webExtrasNotificationItem{
			ID:        notification.ID,
			Type:      notification.Kind,
			Message:   notification.Message,
			Alert:     webExtrasNotificationAlertValue(notification.Payload),
			URL:       webExtrasNotificationURL(notification.Kind, operationUUID, notification.Payload),
			CreatedAt: notification.CreatedAt,
		})
	}
	writeJSON(w, http.StatusOK, webExtrasNotificationsResponse{Data: items})
}

func (api *WebExtrasAPI) recovery(w http.ResponseWriter, snapshot webExtrasSnapshot) {
	recovery := snapshot.Recovery
	if len(recovery) == 0 || string(recovery) == "null" {
		recovery = json.RawMessage(`{"items":[],"blocked":false}`)
	}
	writeJSON(w, http.StatusOK, webExtrasRecoveryResponse{Data: recovery})
}

func (api *WebExtrasAPI) ack(w http.ResponseWriter, r *http.Request, id string) {
	cookie, ok := api.authenticated(r)
	if !ok {
		writeJSON(w, http.StatusUnauthorized, map[string]any{"error": "Autenticación requerida."})
		return
	}
	if !api.mutationAllowed(w, r, cookie) {
		return
	}
	if utf8.RuneCountInString(id) > webExtrasMaxAckIDRunes {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "Aviso inválido."})
		return
	}
	if !webExtrasValidAckBody(r) {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "Aviso inválido."})
		return
	}
	if api.Acks == nil {
		writeWebExtrasUnavailable(w)
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), statsTimeout)
	defer cancel()
	if err := api.Acks.Ack(ctx, id, api.now().UnixMilli()); err != nil {
		writeWebExtrasUnavailable(w)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// webExtrasValidAckBody admite cuerpo vacío o el objeto JSON vacío. Cualquier
// otro contenido se rechaza sin reflejarlo.
func webExtrasValidAckBody(r *http.Request) bool {
	if r.Body == nil {
		return true
	}
	raw, err := io.ReadAll(io.LimitReader(r.Body, webExtrasMaxAckBodyBytes+1))
	if err != nil || len(raw) > webExtrasMaxAckBodyBytes {
		return false
	}
	trimmed := strings.TrimSpace(string(raw))
	if trimmed == "" {
		return true
	}
	var object map[string]json.RawMessage
	if err := json.Unmarshal([]byte(trimmed), &object); err != nil {
		return false
	}
	return object != nil && len(object) == 0
}

func (api *WebExtrasAPI) loadSnapshot() (webExtrasSnapshot, bool) {
	if api.File == "" {
		return webExtrasSnapshot{}, true
	}
	file, err := os.Open(api.File)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return webExtrasSnapshot{}, true
		}
		return webExtrasSnapshot{}, false
	}
	defer file.Close()

	if info, err := file.Stat(); err == nil && info.IsDir() {
		return webExtrasSnapshot{}, false
	}
	raw, err := io.ReadAll(io.LimitReader(file, webExtrasMaxSnapshotBytes+1))
	if err != nil || len(raw) > webExtrasMaxSnapshotBytes {
		return webExtrasSnapshot{}, false
	}
	var snapshot webExtrasSnapshot
	if err := json.Unmarshal(raw, &snapshot); err != nil {
		return webExtrasSnapshot{}, false
	}
	return snapshot, true
}

func (api *WebExtrasAPI) now() time.Time {
	if api.Now != nil {
		return api.Now()
	}
	return time.Now()
}

func writeWebExtrasUnavailable(w http.ResponseWriter) {
	writeJSON(w, http.StatusServiceUnavailable, map[string]string{"status": "unavailable"})
}

func webExtrasParseLogQuery(r *http.Request) (webExtrasLogQuery, bool) {
	values := r.URL.Query()
	query := webExtrasLogQuery{limit: webExtrasDefaultLogLimit}

	if raw := values.Get("after"); raw != "" {
		parsed, err := strconv.ParseInt(raw, 10, 64)
		if err != nil || parsed < 0 {
			return webExtrasLogQuery{}, false
		}
		query.after = parsed
	}
	if raw := values.Get("limit"); raw != "" {
		parsed, err := strconv.Atoi(raw)
		if err != nil || parsed < 1 || parsed > webExtrasMaxLogLimit {
			return webExtrasLogQuery{}, false
		}
		query.limit = parsed
	}
	if raw := values.Get("level"); raw != "" {
		switch raw {
		case "info", "success", "warning", "error":
			query.level = raw
		default:
			return webExtrasLogQuery{}, false
		}
	}
	if raw := values.Get("component"); raw != "" {
		switch raw {
		case "trading", "qvapay", "notifications", "network", "system":
			query.component = raw
		default:
			return webExtrasLogQuery{}, false
		}
	}
	if raw := strings.TrimSpace(values.Get("query")); raw != "" {
		if utf8.RuneCountInString(raw) > webExtrasMaxQueryRunes {
			return webExtrasLogQuery{}, false
		}
		query.query = raw
	}
	if raw := values.Get("since"); raw != "" {
		parsed, err := strconv.ParseInt(raw, 10, 64)
		if err != nil || parsed < webExtrasMinSinceMS || parsed > webExtrasMaxSinceMS {
			return webExtrasLogQuery{}, false
		}
		query.since = parsed
	}
	return query, true
}

func webExtrasBuildLogPage(snapshot webExtrasSnapshot, query webExtrasLogQuery, nowMS int64) webExtrasLogPage {
	selected := make([]int, 0, len(snapshot.Logs))
	for index := range snapshot.Logs {
		entry := &snapshot.Logs[index]
		if query.after > 0 && entry.ID <= query.after {
			continue
		}
		if query.since > 0 && entry.CreatedAt < nowMS-query.since {
			continue
		}
		if query.level != "" && webExtrasLogLevel(entry.Action) != query.level {
			continue
		}
		if query.component != "" && webExtrasLogComponent(entry.Action) != query.component {
			continue
		}
		if query.query != "" && !webExtrasLogMatches(entry, query.query) {
			continue
		}
		selected = append(selected, index)
	}

	ascending := query.after > 0
	sort.SliceStable(selected, func(left, right int) bool {
		a := snapshot.Logs[selected[left]].ID
		b := snapshot.Logs[selected[right]].ID
		if ascending {
			return a < b
		}
		return a > b
	})

	hasMore := len(selected) > query.limit
	if hasMore {
		selected = selected[:query.limit]
	}

	items := make([]webExtrasLogItem, 0, len(selected))
	for _, index := range selected {
		entry := snapshot.Logs[index]
		items = append(items, webExtrasLogItem{
			ID:        entry.ID,
			CreatedAt: entry.CreatedAt,
			Action:    entry.Action,
			UUID:      entry.UUID,
			Detail:    redactWebExtrasDetail(entry.Detail),
			Level:     webExtrasLogLevel(entry.Action),
			Component: webExtrasLogComponent(entry.Action),
		})
	}

	var globalNewest int64
	for index := range snapshot.Logs {
		if snapshot.Logs[index].ID > globalNewest {
			globalNewest = snapshot.Logs[index].ID
		}
	}
	newestID := globalNewest
	if ascending && hasMore && len(selected) > 0 {
		newestID = snapshot.Logs[selected[len(selected)-1]].ID
	}

	return webExtrasLogPage{Items: items, HasMore: hasMore, NewestID: newestID}
}

func webExtrasLogMatches(entry *webExtrasLog, query string) bool {
	lower := strings.ToLower(query)
	if strings.Contains(strings.ToLower(entry.Action), lower) ||
		strings.Contains(strings.ToLower(entry.Detail), lower) {
		return true
	}
	return entry.UUID != nil && strings.Contains(strings.ToLower(*entry.UUID), lower)
}

func webExtrasLogLevel(action string) string {
	lower := strings.ToLower(action)
	switch {
	case strings.Contains(lower, "error"),
		strings.Contains(lower, "failed"),
		strings.Contains(lower, "uncertain"):
		return "error"
	case strings.Contains(lower, "warning"),
		strings.Contains(lower, "rejected"),
		strings.Contains(lower, "blocked"),
		strings.Contains(lower, "pending"),
		strings.Contains(lower, "retry"),
		strings.Contains(lower, "skipped"):
		return "warning"
	case strings.Contains(lower, "applied"),
		strings.Contains(lower, "confirmed"),
		strings.Contains(lower, "completed"),
		strings.Contains(lower, "reconciled"),
		strings.Contains(lower, "activated"),
		strings.Contains(lower, "resumed"),
		strings.Contains(lower, "created"),
		strings.Contains(lower, "added"):
		return "success"
	default:
		return "info"
	}
}

func webExtrasLogComponent(action string) string {
	lower := strings.ToLower(action)
	switch {
	case hasAnyPrefix(lower, "scan_", "price_", "risk_", "opportunity_", "hunting_", "sell_"):
		return "trading"
	case hasAnyPrefix(lower,
		"fiat_", "qvapay_", "operation_", "remote_operation_", "mutation_",
		"workflow_", "refresh_", "auto_cancel_", "surplus_"):
		return "qvapay"
	case hasAnyPrefix(lower, "telegram_", "notification_", "push_"):
		return "notifications"
	case hasAnyPrefix(lower, "cooperative_", "nats_"):
		return "network"
	default:
		return "system"
	}
}

func hasAnyPrefix(value string, prefixes ...string) bool {
	for _, prefix := range prefixes {
		if strings.HasPrefix(value, prefix) {
			return true
		}
	}
	return false
}

func redactWebExtrasDetail(value string) string {
	value = webExtrasBearerRE.ReplaceAllString(value, "Bearer [redacted]")
	value = webExtrasOpaqueRE.ReplaceAllString(value, "[redacted]")
	value = webExtrasSecretRE.ReplaceAllStringFunc(value, func(match string) string {
		groups := webExtrasSecretRE.FindStringSubmatch(match)
		if len(groups) != 3 {
			return "[redacted]"
		}
		return groups[1] + groups[2] + "[redacted]"
	})
	runes := []rune(value)
	if len(runes) > webExtrasMaxDetailRunes {
		value = string(runes[:webExtrasMaxDetailRunes])
	}
	return value
}

func webExtrasNotificationAlertValue(payload map[string]any) any {
	if payload != nil {
		if alert, ok := payload["alert"]; ok && alert != nil {
			return alert
		}
	}
	alert := webExtrasNotificationAlert{Amount: 0}
	if payload == nil {
		return alert
	}
	if value, ok := payload["uuid"].(string); ok {
		alert.UUID = value
	}
	if value, ok := payload["coin"].(string); ok {
		alert.Coin = value
	}
	alert.Amount = webExtrasNotificationAmount(payload["amount"])
	return alert
}

func webExtrasNotificationAmount(value any) any {
	switch typed := value.(type) {
	case nil:
		return 0
	case string:
		if typed == "" {
			return 0
		}
		return typed
	case bool:
		if !typed {
			return 0
		}
		return typed
	case float64:
		if typed == 0 {
			return 0
		}
		return typed
	default:
		return typed
	}
}

func webExtrasNotificationURL(kind, operationUUID string, payload map[string]any) string {
	switch {
	case kind == "informational-summary":
		return "/?view=ofertas"
	case kind == "system-health":
		return "/?view=caceria"
	case kind == "recovery-blocked":
		intent := ""
		if payload != nil {
			if value, ok := payload["intentId"].(string); ok {
				intent = value
			}
		}
		return "/?view=auditoria&intent=" + webExtrasQueryEscape(intent)
	case strings.HasPrefix(kind, "rebalance-"):
		return "/?view=ofertas"
	case kind == "operation-applied", kind == "own-offer-applied":
		return "/?view=operaciones&operation=" + webExtrasQueryEscape(operationUUID)
	default:
		return "/?view=auditoria"
	}
}

// webExtrasQueryEscape replica encodeURIComponent para los valores que el panel
// usa en URLs: los espacios se codifican como %20, no como +.
func webExtrasQueryEscape(value string) string {
	return strings.ReplaceAll(url.QueryEscape(value), "+", "%20")
}
