package edge

// Evidencia de comisiones de compras completadas. Replica las rutas
// /api/analytics/fees del monolito TS sobre el snapshot exportado
// (web-extras.json) y la tabla shadow.analytics_fee_evidence.
//
// La consulta nunca escribe. El registro sólo guarda la evidencia documental
// de una comisión; no mueve dinero, no altera ofertas y no emite auditoría.

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"math"
	"net/http"
	"os"
	"strconv"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5/pgxpool"
)

const (
	analyticsFeesPath = "/api/analytics/fees"

	// analyticsFeesPageSize es el tamaño fijo de página que usa el panel.
	analyticsFeesPageSize    = 20
	analyticsFeesDefaultPage = 1
	analyticsFeesMaxPage     = 1000

	// analyticsFeesMaxSnapshotBytes acota el snapshot leído del disco.
	analyticsFeesMaxSnapshotBytes = 8 << 20

	// analyticsFeesMaxBodyBytes acota el cuerpo del POST.
	analyticsFeesMaxBodyBytes = 8 << 10

	analyticsFeesMaxUUIDRunes     = 100
	analyticsFeesMinEvidenceRunes = 10
	analyticsFeesMaxEvidenceRunes = 500
)

// FeeRecord es la evidencia persistida de una comisión. OfferUUID identifica la
// compra dentro de la cuenta y es la clave de la tabla.
type FeeRecord struct {
	OfferUUID string
	GrossQusd float64
	FeeQusd   float64
	Evidence  string
	Version   int
	UpdatedAt int64
}

// FeeStore persiste y consulta la evidencia de comisiones por cuenta. Load
// devuelve un mapa indexado por el UUID de la oferta. Save es atómico: calcula
// la versión nueva y la devuelve; ignorar el valor de Version del registro.
type FeeStore interface {
	Load(ctx context.Context, account string) (map[string]FeeRecord, error)
	Save(ctx context.Context, account string, record FeeRecord) (int, error)
}

// PostgresFeeStore implementa FeeStore sobre shadow.analytics_fee_evidence.
type PostgresFeeStore struct {
	Pool *pgxpool.Pool
}

var _ FeeStore = (*PostgresFeeStore)(nil)

// Load devuelve todas las evidencias de la cuenta indexadas por oferta.
func (store *PostgresFeeStore) Load(ctx context.Context, account string) (map[string]FeeRecord, error) {
	if store == nil || store.Pool == nil {
		return nil, errors.New("edge: fee store sin pool")
	}
	rows, err := store.Pool.Query(ctx, `
		SELECT offer_uuid, gross_qusd, fee_qusd, evidence, version, updated_at
		FROM shadow.analytics_fee_evidence
		WHERE account_uuid = $1
		ORDER BY offer_uuid`, account)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	records := make(map[string]FeeRecord)
	for rows.Next() {
		var offerUUID string
		var record FeeRecord
		if err := rows.Scan(
			&offerUUID,
			&record.GrossQusd,
			&record.FeeQusd,
			&record.Evidence,
			&record.Version,
			&record.UpdatedAt,
		); err != nil {
			return nil, err
		}
		record.OfferUUID = offerUUID
		records[offerUUID] = record
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return records, nil
}

// Save inserta la evidencia con versión 1 o incrementa la existente en una sola
// sentencia. Devolver la versión resultante evita una segunda lectura y hace
// que dos escrituras concurrentes nunca compartan número de versión.
func (store *PostgresFeeStore) Save(ctx context.Context, account string, record FeeRecord) (int, error) {
	if store == nil || store.Pool == nil {
		return 0, errors.New("edge: fee store sin pool")
	}
	if record.OfferUUID == "" {
		return 0, errors.New("edge: fee store sin oferta")
	}
	var version int
	err := store.Pool.QueryRow(ctx, `
		INSERT INTO shadow.analytics_fee_evidence
			(account_uuid, offer_uuid, gross_qusd, fee_qusd, evidence, version, updated_at)
		VALUES ($1, $2, $3, $4, $5, 1, $6)
		ON CONFLICT (account_uuid, offer_uuid) DO UPDATE SET
			gross_qusd = EXCLUDED.gross_qusd,
			fee_qusd = EXCLUDED.fee_qusd,
			evidence = EXCLUDED.evidence,
			version = shadow.analytics_fee_evidence.version + 1,
			updated_at = EXCLUDED.updated_at
		RETURNING version`,
		account, record.OfferUUID, record.GrossQusd, record.FeeQusd,
		record.Evidence, record.UpdatedAt,
	).Scan(&version)
	if err != nil {
		return 0, err
	}
	return version, nil
}

// AnalyticsFeesAPI expone las compras completadas y su evidencia de comisión.
//
// Rutas:
//
//	GET  /api/analytics/fees?page=1
//	POST /api/analytics/fees
//
// Ambas exigen cookie de sesión. La mutación exige además Origin permitido y
// CSRF de doble envío. Las respuestas nunca exponen rutas ni errores internos.
type AnalyticsFeesAPI struct {
	Sessions      *SessionManager
	File          string
	Store         FeeStore
	TrustedOrigin string
	Now           func() time.Time
}

// analyticsFeesSnapshot replica la parte del documento exportado que consume la
// ruta. Las compras ya llegan ordenadas por completedAt descendente.
type analyticsFeesSnapshot struct {
	AnalyticsFees []analyticsFeeRecord `json:"analyticsFees"`
	Simulation    analyticsFeesAccount `json:"simulation"`
}

type analyticsFeesAccount struct {
	AccountUUID string `json:"accountUuid"`
}

// analyticsFeeRecord es una compra completada tal como la exporta el monolito.
type analyticsFeeRecord struct {
	UUID        string   `json:"uuid"`
	Coin        string   `json:"coin"`
	Amount      float64  `json:"amount"`
	Receive     float64  `json:"receive"`
	CompletedAt int64    `json:"completedAt"`
	FeeQusd     *float64 `json:"feeQusd"`
	Evidence    string   `json:"evidence"`
	Version     int      `json:"version"`
	Stale       bool     `json:"stale"`
}

type analyticsFeeItem struct {
	UUID        string   `json:"uuid"`
	Coin        string   `json:"coin"`
	Amount      float64  `json:"amount"`
	Receive     float64  `json:"receive"`
	CompletedAt int64    `json:"completedAt"`
	FeeQusd     *float64 `json:"feeQusd"`
	Evidence    string   `json:"evidence"`
	Version     int      `json:"version"`
	Stale       bool     `json:"stale"`
}

type analyticsFeePage struct {
	Page    int                `json:"page"`
	HasMore bool               `json:"hasMore"`
	Items   []analyticsFeeItem `json:"items"`
}

type analyticsFeesResponse struct {
	Data analyticsFeePage `json:"data"`
}

type analyticsFeesSaveResponse struct {
	Data struct {
		Version int `json:"version"`
	} `json:"data"`
}

type analyticsFeesSaveRequest struct {
	UUID            *string  `json:"uuid"`
	FeeQusd         *float64 `json:"feeQusd"`
	Evidence        *string  `json:"evidence"`
	ExpectedVersion *int     `json:"expectedVersion"`
}

func (api *AnalyticsFeesAPI) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")

	if r.URL.Path != analyticsFeesPath {
		writeJSON(w, http.StatusNotFound, map[string]string{"status": "not_found"})
		return
	}

	switch r.Method {
	case http.MethodGet:
		api.list(w, r)
	case http.MethodPost:
		api.save(w, r)
	default:
		w.Header().Set("Allow", "GET, POST")
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"status": "method_not_allowed"})
	}
}

func (api *AnalyticsFeesAPI) list(w http.ResponseWriter, r *http.Request) {
	if _, ok := api.authenticated(r); !ok {
		writeJSON(w, http.StatusUnauthorized, map[string]any{"error": "Autenticación requerida."})
		return
	}

	page, ok := analyticsFeesParsePage(r)
	if !ok {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "Página inválida."})
		return
	}

	snapshot, ok := api.loadSnapshot()
	if !ok {
		writeAnalyticsFeesUnavailable(w)
		return
	}

	records := map[string]FeeRecord(nil)
	if api.Store != nil {
		ctx, cancel := context.WithTimeout(r.Context(), statsTimeout)
		defer cancel()
		loaded, err := api.Store.Load(ctx, snapshot.Simulation.AccountUUID)
		if err != nil {
			writeAnalyticsFeesUnavailable(w)
			return
		}
		records = loaded
	}

	writeJSON(w, http.StatusOK, analyticsFeesResponse{
		Data: analyticsFeesBuildPage(snapshot, records, page),
	})
}

func (api *AnalyticsFeesAPI) save(w http.ResponseWriter, r *http.Request) {
	cookie, ok := api.authenticated(r)
	if !ok {
		writeJSON(w, http.StatusUnauthorized, map[string]any{"error": "Autenticación requerida."})
		return
	}
	if !api.mutationAllowed(w, r, cookie) {
		return
	}

	request, ok := analyticsFeesParseSaveBody(r)
	if !ok {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "Solicitud inválida."})
		return
	}
	if request.UUID == nil ||
		utf8.RuneCountInString(*request.UUID) < 1 ||
		utf8.RuneCountInString(*request.UUID) > analyticsFeesMaxUUIDRunes {
		writeAnalyticsFeesMissingOffer(w)
		return
	}
	if request.FeeQusd == nil || !analyticsFeesValidFeeFloor(*request.FeeQusd) {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "Comisión inválida."})
		return
	}
	evidenceRunes := 0
	if request.Evidence != nil {
		evidenceRunes = utf8.RuneCountInString(*request.Evidence)
	}
	if request.Evidence == nil ||
		evidenceRunes < analyticsFeesMinEvidenceRunes ||
		evidenceRunes > analyticsFeesMaxEvidenceRunes {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "Añade evidencia de entre 10 y 500 caracteres."})
		return
	}
	if request.ExpectedVersion == nil || *request.ExpectedVersion < 0 {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "Versión inválida."})
		return
	}

	snapshot, ok := api.loadSnapshot()
	if !ok {
		writeAnalyticsFeesUnavailable(w)
		return
	}
	offer, ok := analyticsFeesFindOffer(snapshot, *request.UUID)
	if !ok {
		writeAnalyticsFeesMissingOffer(w)
		return
	}
	if *request.FeeQusd >= offer.Amount {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "Comisión inválida."})
		return
	}

	if api.Store == nil {
		writeAnalyticsFeesUnavailable(w)
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), statsTimeout)
	defer cancel()

	account := snapshot.Simulation.AccountUUID
	current := 0
	records, err := api.Store.Load(ctx, account)
	if err != nil {
		writeAnalyticsFeesUnavailable(w)
		return
	}
	if record, found := records[offer.UUID]; found {
		current = record.Version
	}
	if *request.ExpectedVersion != current {
		writeJSON(w, http.StatusConflict, map[string]any{
			"error": "El registro cambió; actualiza la lista antes de guardar.",
		})
		return
	}

	version, err := api.Store.Save(ctx, account, FeeRecord{
		OfferUUID: offer.UUID,
		GrossQusd: offer.Amount,
		FeeQusd:   *request.FeeQusd,
		Evidence:  *request.Evidence,
		Version:   current,
		UpdatedAt: api.now().UnixMilli(),
	})
	if err != nil {
		writeAnalyticsFeesUnavailable(w)
		return
	}

	response := analyticsFeesSaveResponse{}
	response.Data.Version = version
	writeJSON(w, http.StatusOK, response)
}

func (api *AnalyticsFeesAPI) authenticated(r *http.Request) (string, bool) {
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

func (api *AnalyticsFeesAPI) mutationAllowed(w http.ResponseWriter, r *http.Request, cookie string) bool {
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

func (api *AnalyticsFeesAPI) loadSnapshot() (analyticsFeesSnapshot, bool) {
	if api.File == "" {
		return analyticsFeesSnapshot{}, true
	}
	file, err := os.Open(api.File)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return analyticsFeesSnapshot{}, true
		}
		return analyticsFeesSnapshot{}, false
	}
	defer file.Close()

	if info, err := file.Stat(); err == nil && info.IsDir() {
		return analyticsFeesSnapshot{}, false
	}
	raw, err := io.ReadAll(io.LimitReader(file, analyticsFeesMaxSnapshotBytes+1))
	if err != nil || len(raw) > analyticsFeesMaxSnapshotBytes {
		return analyticsFeesSnapshot{}, false
	}
	var snapshot analyticsFeesSnapshot
	if err := json.Unmarshal(raw, &snapshot); err != nil {
		return analyticsFeesSnapshot{}, false
	}
	return snapshot, true
}

func (api *AnalyticsFeesAPI) now() time.Time {
	if api.Now != nil {
		return api.Now()
	}
	return time.Now()
}

func writeAnalyticsFeesUnavailable(w http.ResponseWriter) {
	writeJSON(w, http.StatusServiceUnavailable, map[string]string{"status": "unavailable"})
}

func writeAnalyticsFeesMissingOffer(w http.ResponseWriter) {
	writeJSON(w, http.StatusBadRequest, map[string]any{
		"error": "La compra completada no está en el historial.",
	})
}

func analyticsFeesParsePage(r *http.Request) (int, bool) {
	raw := r.URL.Query().Get("page")
	if raw == "" {
		return analyticsFeesDefaultPage, true
	}
	page, err := strconv.Atoi(raw)
	if err != nil || page < 1 || page > analyticsFeesMaxPage {
		return 0, false
	}
	return page, true
}

func analyticsFeesParseSaveBody(r *http.Request) (analyticsFeesSaveRequest, bool) {
	if r.Body == nil {
		return analyticsFeesSaveRequest{}, false
	}
	raw, err := io.ReadAll(io.LimitReader(r.Body, analyticsFeesMaxBodyBytes+1))
	if err != nil || len(raw) > analyticsFeesMaxBodyBytes {
		return analyticsFeesSaveRequest{}, false
	}

	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	var request analyticsFeesSaveRequest
	if err := decoder.Decode(&request); err != nil {
		return analyticsFeesSaveRequest{}, false
	}
	var extra json.RawMessage
	if err := decoder.Decode(&extra); !errors.Is(err, io.EOF) {
		return analyticsFeesSaveRequest{}, false
	}
	return request, true
}

// analyticsFeesValidFeeFloor comprueba lo que no depende del importe de la
// compra: un número finito y no negativo.
func analyticsFeesValidFeeFloor(fee float64) bool {
	return !math.IsNaN(fee) && !math.IsInf(fee, 0) && fee >= 0
}

func analyticsFeesFindOffer(snapshot analyticsFeesSnapshot, uuid string) (analyticsFeeRecord, bool) {
	for _, offer := range snapshot.AnalyticsFees {
		if offer.UUID == uuid {
			return offer, true
		}
	}
	return analyticsFeeRecord{}, false
}

func analyticsFeesBuildPage(
	snapshot analyticsFeesSnapshot,
	records map[string]FeeRecord,
	page int,
) analyticsFeePage {
	total := len(snapshot.AnalyticsFees)
	start := (page - 1) * analyticsFeesPageSize
	if start > total {
		start = total
	}
	end := start + analyticsFeesPageSize
	if end > total {
		end = total
	}

	items := make([]analyticsFeeItem, 0, end-start)
	for _, offer := range snapshot.AnalyticsFees[start:end] {
		record, found := records[offer.UUID]
		items = append(items, analyticsFeesItemFor(offer, record, found))
	}
	return analyticsFeePage{
		Page:    page,
		HasMore: end < total,
		Items:   items,
	}
}

func analyticsFeesItemFor(
	offer analyticsFeeRecord,
	record FeeRecord,
	override bool,
) analyticsFeeItem {
	item := analyticsFeeItem(offer)
	if !override {
		return item
	}
	fee := record.FeeQusd
	item.FeeQusd = &fee
	item.Evidence = record.Evidence
	item.Version = record.Version
	item.Stale = record.GrossQusd != offer.Amount
	return item
}
