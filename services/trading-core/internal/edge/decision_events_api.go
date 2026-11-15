package edge

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

const (
	decisionEventsAuditPath      = "/api/decision-events"
	decisionEventsDismissAllPath = decisionEventsAuditPath + "/dismiss-all"
	decisionEventsDismissSuffix  = "/dismiss"

	// decisionEventsMaxSnapshotBytes acota el snapshot que el proceso edge
	// carga en memoria por petición.
	decisionEventsMaxSnapshotBytes = 8 << 20
	decisionEventsMaxBodyBytes     = 4 << 10

	decisionEventsDefaultPage     = 1
	decisionEventsDefaultPageSize = 20
	decisionEventsMaxPage         = 100_000
	decisionEventsMaxPageSize     = 100
)

// DismissalStore persiste y consulta las versiones de decisión descartadas por
// el usuario.
type DismissalStore interface {
	All(ctx context.Context) (map[int64]struct{}, error)
	Add(ctx context.Context, ids []int64, now int64) error
}

// PostgresDismissalStore implementa DismissalStore sobre
// shadow.decision_dismissals. Sólo guarda el identificador del evento y el
// instante del descarte.
type PostgresDismissalStore struct {
	Pool *pgxpool.Pool
}

var _ DismissalStore = (*PostgresDismissalStore)(nil)

// All devuelve el conjunto de identificadores ya descartados.
func (store *PostgresDismissalStore) All(ctx context.Context) (map[int64]struct{}, error) {
	if store == nil || store.Pool == nil {
		return nil, errors.New("edge: dismissal store sin pool")
	}
	rows, err := store.Pool.Query(ctx, `SELECT id FROM shadow.decision_dismissals`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	dismissed := make(map[int64]struct{})
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		dismissed[id] = struct{}{}
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return dismissed, nil
}

// Add registra uno o varios descartes. Repetir el mismo descarte no cambia el
// instante original almacenado.
func (store *PostgresDismissalStore) Add(ctx context.Context, ids []int64, now int64) error {
	if store == nil || store.Pool == nil {
		return errors.New("edge: dismissal store sin pool")
	}
	if len(ids) == 0 {
		return nil
	}
	_, err := store.Pool.Exec(ctx, `
		INSERT INTO shadow.decision_dismissals (id, dismissed_at)
		SELECT unnest($1::bigint[]), $2
		ON CONFLICT DO NOTHING`, ids, now)
	return err
}

// DecisionEventsAPI expone las decisiones operativas registradas por el
// monolito TS en el snapshot exportado, con el descarte de versiones guardado
// aparte en Postgres.
//
// Rutas:
//
//	GET  /api/decision-events
//	POST /api/decision-events/{id}/dismiss
//	POST /api/decision-events/dismiss-all
//
// Todas exigen cookie de sesión. Las mutaciones exigen además Origin permitido
// y CSRF de doble envío. Las respuestas nunca exponen rutas ni errores
// internos.
type DecisionEventsAPI struct {
	Sessions      *SessionManager
	File          string
	Dismissals    DismissalStore
	TrustedOrigin string
	Now           func() time.Time
}

type decisionEventsSnapshot struct {
	DecisionEvents []decisionEventRecord `json:"decisionEvents"`
}

// decisionEventRecord replica el formato exportado en web-extras.json. Checks
// se conserva como JSON crudo para no perder la forma exacta de cada
// comprobación.
type decisionEventRecord struct {
	ID            int64           `json:"id"`
	Version       string          `json:"version"`
	UUID          string          `json:"uuid"`
	Coin          string          `json:"coin"`
	OfferType     string          `json:"offerType"`
	Amount        float64         `json:"amount"`
	Receive       float64         `json:"receive"`
	Rate          float64         `json:"rate"`
	Decision      string          `json:"decision"`
	Reason        string          `json:"reason"`
	Checks        json.RawMessage `json:"checks"`
	ReferenceRate *float64        `json:"referenceRate"`
	Resolution    *string         `json:"resolution"`
	CreatedAt     int64           `json:"createdAt"`
	UpdatedAt     int64           `json:"updatedAt"`
	ResolvedAt    *int64          `json:"resolvedAt"`
}

type decisionEventItem struct {
	ID            int64           `json:"id"`
	Version       string          `json:"version"`
	UUID          string          `json:"uuid"`
	Coin          string          `json:"coin"`
	OfferType     string          `json:"offerType"`
	Amount        float64         `json:"amount"`
	Receive       float64         `json:"receive"`
	Rate          float64         `json:"rate"`
	Decision      string          `json:"decision"`
	Reason        string          `json:"reason"`
	Checks        json.RawMessage `json:"checks"`
	ReferenceRate *float64        `json:"referenceRate,omitempty"`
	Resolution    *string         `json:"resolution,omitempty"`
	CreatedAt     int64           `json:"createdAt"`
	UpdatedAt     int64           `json:"updatedAt"`
	ResolvedAt    *int64          `json:"resolvedAt"`
}

type decisionEventsPage struct {
	Items            []decisionEventItem `json:"items"`
	Total            int                 `json:"total"`
	Pending          int                 `json:"pending"`
	Page             int                 `json:"page"`
	PageSize         int                 `json:"pageSize"`
	DismissThroughID int64               `json:"dismissThroughId"`
}

type decisionEventsResponse struct {
	Data   decisionEventsPage `json:"data"`
	Source string             `json:"source"`
}

type decisionEventsDismissAllResponse struct {
	Data struct {
		Dismissed int `json:"dismissed"`
	} `json:"data"`
}

type decisionEventsQuery struct {
	decision string
	status   string
	page     int
	pageSize int
}

func (api *DecisionEventsAPI) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")

	path := r.URL.Path
	switch {
	case path == decisionEventsAuditPath:
		if r.Method != http.MethodGet {
			w.Header().Set("Allow", http.MethodGet)
			writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"status": "method_not_allowed"})
			return
		}
		api.list(w, r)
	case path == decisionEventsDismissAllPath:
		if r.Method != http.MethodPost {
			w.Header().Set("Allow", http.MethodPost)
			writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"status": "method_not_allowed"})
			return
		}
		api.dismissAll(w, r)
	default:
		rawID, ok := decisionEventDismissID(path)
		if !ok {
			writeJSON(w, http.StatusNotFound, map[string]string{"status": "not_found"})
			return
		}
		if r.Method != http.MethodPost {
			w.Header().Set("Allow", http.MethodPost)
			writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"status": "method_not_allowed"})
			return
		}
		api.dismiss(w, r, rawID)
	}
}

// decisionEventDismissID reconoce /api/decision-events/{id}/dismiss con
// exactamente un segmento no vacío. No valida que el segmento sea numérico:
// esa comprobación ocurre tras autenticar la petición.
func decisionEventDismissID(path string) (string, bool) {
	remainder, ok := strings.CutPrefix(path, decisionEventsAuditPath+"/")
	if !ok {
		return "", false
	}
	id, ok := strings.CutSuffix(remainder, decisionEventsDismissSuffix)
	if !ok || id == "" || strings.Contains(id, "/") {
		return "", false
	}
	return id, true
}

func (api *DecisionEventsAPI) list(w http.ResponseWriter, r *http.Request) {
	if _, ok := api.authenticated(r); !ok {
		writeJSON(w, http.StatusUnauthorized, map[string]any{"error": "Autenticación requerida."})
		return
	}

	query, message := decisionEventsParseQuery(r)
	if message != "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": message})
		return
	}

	snapshot, ok := api.loadSnapshot()
	if !ok {
		writeDecisionEventsUnavailable(w)
		return
	}

	dismissed := map[int64]struct{}{}
	if api.Dismissals != nil {
		ctx, cancel := context.WithTimeout(r.Context(), statsTimeout)
		defer cancel()
		loaded, err := api.Dismissals.All(ctx)
		if err != nil {
			writeDecisionEventsUnavailable(w)
			return
		}
		if loaded != nil {
			dismissed = loaded
		}
	}

	page := decisionEventsBuildPage(snapshot, dismissed, query)
	writeJSON(w, http.StatusOK, decisionEventsResponse{Data: page, Source: "sqlite"})
}

func (api *DecisionEventsAPI) dismiss(w http.ResponseWriter, r *http.Request, rawID string) {
	cookie, ok := api.authenticated(r)
	if !ok {
		writeJSON(w, http.StatusUnauthorized, map[string]any{"error": "Autenticación requerida."})
		return
	}
	if !api.mutationAllowed(w, r, cookie) {
		return
	}

	id, err := strconv.ParseInt(rawID, 10, 64)
	if err != nil || id <= 0 {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "Evento inválido."})
		return
	}
	if api.Dismissals == nil {
		writeDecisionEventsUnavailable(w)
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), statsTimeout)
	defer cancel()
	if err := api.Dismissals.Add(ctx, []int64{id}, api.now().UnixMilli()); err != nil {
		writeDecisionEventsUnavailable(w)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (api *DecisionEventsAPI) dismissAll(w http.ResponseWriter, r *http.Request) {
	cookie, ok := api.authenticated(r)
	if !ok {
		writeJSON(w, http.StatusUnauthorized, map[string]any{"error": "Autenticación requerida."})
		return
	}
	if !api.mutationAllowed(w, r, cookie) {
		return
	}

	throughID, ok := decisionEventsParseDismissAllBody(r)
	if !ok {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "Solicitud inválida."})
		return
	}

	snapshot, ok := api.loadSnapshot()
	if !ok {
		writeDecisionEventsUnavailable(w)
		return
	}
	if api.Dismissals == nil {
		writeDecisionEventsUnavailable(w)
		return
	}

	ids := make([]int64, 0, len(snapshot.DecisionEvents))
	for _, event := range snapshot.DecisionEvents {
		if event.Decision == "blocked" && event.ResolvedAt == nil && event.ID <= throughID {
			ids = append(ids, event.ID)
		}
	}

	ctx, cancel := context.WithTimeout(r.Context(), statsTimeout)
	defer cancel()
	if err := api.Dismissals.Add(ctx, ids, api.now().UnixMilli()); err != nil {
		writeDecisionEventsUnavailable(w)
		return
	}

	response := decisionEventsDismissAllResponse{}
	response.Data.Dismissed = len(ids)
	writeJSON(w, http.StatusOK, response)
}

func (api *DecisionEventsAPI) authenticated(r *http.Request) (string, bool) {
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

func (api *DecisionEventsAPI) mutationAllowed(w http.ResponseWriter, r *http.Request, cookie string) bool {
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

func (api *DecisionEventsAPI) loadSnapshot() (decisionEventsSnapshot, bool) {
	if api.File == "" {
		return decisionEventsSnapshot{}, true
	}
	file, err := os.Open(api.File)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return decisionEventsSnapshot{}, true
		}
		return decisionEventsSnapshot{}, false
	}
	defer file.Close()

	if info, err := file.Stat(); err == nil && info.IsDir() {
		return decisionEventsSnapshot{}, false
	}
	raw, err := io.ReadAll(io.LimitReader(file, decisionEventsMaxSnapshotBytes+1))
	if err != nil || len(raw) > decisionEventsMaxSnapshotBytes {
		return decisionEventsSnapshot{}, false
	}
	var snapshot decisionEventsSnapshot
	if err := json.Unmarshal(raw, &snapshot); err != nil {
		return decisionEventsSnapshot{}, false
	}
	return snapshot, true
}

func (api *DecisionEventsAPI) now() time.Time {
	if api.Now != nil {
		return api.Now()
	}
	return time.Now()
}

func writeDecisionEventsUnavailable(w http.ResponseWriter) {
	writeJSON(w, http.StatusServiceUnavailable, map[string]string{"status": "unavailable"})
}

func decisionEventsParseQuery(r *http.Request) (decisionEventsQuery, string) {
	values := r.URL.Query()
	query := decisionEventsQuery{
		page:     decisionEventsDefaultPage,
		pageSize: decisionEventsDefaultPageSize,
	}

	if raw := values.Get("decision"); raw != "" {
		switch raw {
		case "applied", "blocked", "manual_review":
			query.decision = raw
		default:
			return decisionEventsQuery{}, "Filtro de decisión inválido."
		}
	}
	if raw := values.Get("status"); raw != "" {
		switch raw {
		case "pending", "resolved", "all":
			query.status = raw
		default:
			return decisionEventsQuery{}, "Filtro de estado inválido."
		}
	}
	if raw := values.Get("page"); raw != "" {
		parsed, err := strconv.Atoi(raw)
		if err != nil || parsed < 1 || parsed > decisionEventsMaxPage {
			return decisionEventsQuery{}, "Página inválida."
		}
		query.page = parsed
	}
	if raw := values.Get("pageSize"); raw != "" {
		parsed, err := strconv.Atoi(raw)
		if err != nil || parsed < 1 || parsed > decisionEventsMaxPageSize {
			return decisionEventsQuery{}, "Tamaño de página inválido."
		}
		query.pageSize = parsed
	}
	return query, ""
}

func decisionEventsParseDismissAllBody(r *http.Request) (int64, bool) {
	if r.Body == nil {
		return 0, false
	}
	raw, err := io.ReadAll(io.LimitReader(r.Body, decisionEventsMaxBodyBytes+1))
	if err != nil || len(raw) > decisionEventsMaxBodyBytes {
		return 0, false
	}

	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	var request struct {
		ThroughID *int64 `json:"throughId"`
	}
	if err := decoder.Decode(&request); err != nil {
		return 0, false
	}
	var extra json.RawMessage
	if err := decoder.Decode(&extra); !errors.Is(err, io.EOF) {
		return 0, false
	}
	if request.ThroughID == nil || *request.ThroughID < 1 {
		return 0, false
	}
	return *request.ThroughID, true
}

func decisionEventsBuildPage(
	snapshot decisionEventsSnapshot,
	dismissed map[int64]struct{},
	query decisionEventsQuery,
) decisionEventsPage {
	filtered := make([]decisionEventRecord, 0, len(snapshot.DecisionEvents))
	for _, event := range snapshot.DecisionEvents {
		if _, skip := dismissed[event.ID]; skip {
			continue
		}
		if query.decision != "" && event.Decision != query.decision {
			continue
		}
		if query.status == "pending" && event.ResolvedAt != nil {
			continue
		}
		if query.status == "resolved" && event.ResolvedAt == nil {
			continue
		}
		filtered = append(filtered, event)
	}

	pending := 0
	for index := range filtered {
		event := &filtered[index]
		if event.ResolvedAt == nil && (event.Decision == "blocked" || event.Decision == "manual_review") {
			pending++
		}
	}

	// Orden: no resueltos primero, luego updatedAt DESC y finalmente id DESC.
	sort.SliceStable(filtered, func(left, right int) bool {
		a, b := filtered[left], filtered[right]
		aPending := a.ResolvedAt == nil
		bPending := b.ResolvedAt == nil
		if aPending != bPending {
			return aPending
		}
		if a.UpdatedAt != b.UpdatedAt {
			return a.UpdatedAt > b.UpdatedAt
		}
		return a.ID > b.ID
	})

	var dismissThroughID int64
	for _, event := range snapshot.DecisionEvents {
		if event.Decision == "blocked" && event.ResolvedAt == nil && event.ID > dismissThroughID {
			dismissThroughID = event.ID
		}
	}

	start := (query.page - 1) * query.pageSize
	if start > len(filtered) {
		start = len(filtered)
	}
	end := start + query.pageSize
	if end > len(filtered) {
		end = len(filtered)
	}

	items := make([]decisionEventItem, 0, end-start)
	for _, event := range filtered[start:end] {
		items = append(items, decisionEventsItemOf(event))
	}

	return decisionEventsPage{
		Items:            items,
		Total:            len(filtered),
		Pending:          pending,
		Page:             query.page,
		PageSize:         query.pageSize,
		DismissThroughID: dismissThroughID,
	}
}

func decisionEventsItemOf(event decisionEventRecord) decisionEventItem {
	return decisionEventItem{
		ID:            event.ID,
		Version:       event.Version,
		UUID:          event.UUID,
		Coin:          event.Coin,
		OfferType:     event.OfferType,
		Amount:        event.Amount,
		Receive:       event.Receive,
		Rate:          event.Rate,
		Decision:      event.Decision,
		Reason:        event.Reason,
		Checks:        decisionEventsNormalizeChecks(event.Checks),
		ReferenceRate: event.ReferenceRate,
		Resolution:    event.Resolution,
		CreatedAt:     event.CreatedAt,
		UpdatedAt:     event.UpdatedAt,
		ResolvedAt:    event.ResolvedAt,
	}
}

// decisionEventsNormalizeChecks garantiza que checks siempre se serialice como
// un array JSON, incluso si el snapshot lo omite o lo trae como null.
func decisionEventsNormalizeChecks(raw json.RawMessage) json.RawMessage {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || !json.Valid(trimmed) || trimmed[0] != '[' {
		return json.RawMessage("[]")
	}
	return trimmed
}
