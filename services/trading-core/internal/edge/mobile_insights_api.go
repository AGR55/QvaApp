package edge

// API de solo lectura para los paneles de la app móvil. Reúne en una sola ruta
// las vistas que el snapshot privado ya publica: salud operativa, histórico
// fiat, diagnóstico de caza y rentabilidad. No escribe, no emite cookies y no
// hace proxy al monolito TS.

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"io/fs"
	"net/http"
	"os"
	"sort"
	"strconv"
	"time"
)

const (
	// mobileInsightsPath es la única ruta servida por esta API.
	mobileInsightsPath = "/api/mobile/insights"

	// maxMobileInsightsSnapshotBytes acota el snapshot leído del disco. Un
	// archivo mayor se rechaza sin cargarlo entero en memoria.
	maxMobileInsightsSnapshotBytes = 8 << 20

	// mobileInsightsDiagnosticsHours es la ventana fija del diagnóstico móvil.
	mobileInsightsDiagnosticsHours = 24

	// mobileInsightsDefaultDays es el periodo usado cuando days falta o no es
	// 7, 30 o 90.
	mobileInsightsDefaultDays = 30

	// mobileInsightsLimitedTransactions y mobileInsightsLimitedOffers acotan la
	// muestra que el exportador publica para el cálculo de rentabilidad.
	mobileInsightsLimitedTransactions = 1000
	mobileInsightsLimitedOffers       = 1000

	// Notas exactas que acompañan al informe de rentabilidad. La primera evita
	// interpretar la muestra recortada como un historial completo.
	mobileInsightsLimitedNote = "Muestra parcial: como máximo 1.000 ofertas y 1.000 transacciones recientes. El coste anterior puede faltar; consulta Gráficas en la web para un historial más amplio."
	mobileInsightsLocalNote   = "Calculado con el archivo local. Puede faltar historial pendiente de sincronizar."
)

// Errores centinela. Nunca se escriben en la respuesta.
var (
	errMobileInsightsSnapshotTooLarge = errors.New("edge: snapshot de insights móviles demasiado grande")
	errMobileInsightsSnapshotInvalid  = errors.New("edge: snapshot de insights móviles inválido")
)

// mobileInsightsSnapshot replica la parte del documento privado que consumen
// los paneles móviles. El resto del snapshot del dashboard se ignora.
type mobileInsightsSnapshot struct {
	OperationalHealth json.RawMessage              `json:"operationalHealth"`
	FiatHistory       []dashboardReadFiatEntry     `json:"fiatHistory"`
	AuditLog          []huntingDiagnosticsAuditRow `json:"auditLog"`
	Analytics         tradingAnalyticsInput        `json:"analytics"`
}

// mobileInsightsProfitability es la proyección móvil del informe de
// buildTradingAnalytics. Solo publica lo que la app necesita; el detalle
// completo queda en /api/trading-analytics.
type mobileInsightsProfitability struct {
	Days        int                        `json:"days"`
	GeneratedAt int64                      `json:"generatedAt"`
	Currencies  []tradingAnalyticsCurrency `json:"currencies"`
	Coverage    tradingAnalyticsCoverage   `json:"coverage"`
	Limited     bool                       `json:"limited"`
	Note        string                     `json:"note"`
}

// MobileInsightsAPI sirve GET /api/mobile/insights con una credencial Bearer
// de operador y scope read.
//
// Parámetros:
//
//	kind=health|profitability|history|diagnostics (obligatorio)
//	coin=<código> (obligatorio para history y diagnostics)
//	page=1..1000 (solo history, por defecto 1)
//	days=7|30|90 (solo profitability, por defecto 30)
//
// Un kind ausente o desconocido responde 400 invalid_kind; una moneda ausente
// o fuera de analytics.markets responde 400 unknown_market. Un snapshot ausente
// o vacío produce datos vacíos válidos; un JSON inválido, un archivo mayor de
// 8 MiB o un fallo de lectura producen 503 sin detalles. El handler no registra
// la ruta del archivo ni su contenido. Cualquier otro método responde 405 y
// cualquier otra ruta 404, siempre JSON.
//
// No hay caché: cada petición relee el snapshot para que una revocación sea
// visible de inmediato. Auth es la API que valida el Bearer y aplica el límite
// de lecturas; si es nil toda petición termina en 401. Now permite inyectar el
// reloj en las pruebas; nil usa time.Now.
type MobileInsightsAPI struct {
	Auth *MobileAuthAPI
	File string
	Now  func() time.Time
}

func (api *MobileInsightsAPI) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")

	if r.URL.Path != mobileInsightsPath {
		writeJSON(w, http.StatusNotFound, map[string]string{"status": "not_found"})
		return
	}

	if r.Method != http.MethodGet {
		w.Header().Set("Allow", http.MethodGet)
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"status": "method_not_allowed"})
		return
	}

	if api.Auth == nil {
		writeJSON(w, http.StatusUnauthorized, mobileAuthErrorResponse{
			Error: mobileOperatorCredentialError,
		})
		return
	}
	if !api.Auth.AuthorizeRead(w, r) {
		// AuthorizeRead ya escribió 401, 429 o 503.
		return
	}

	kind := r.URL.Query().Get("kind")
	if !mobileInsightsValidKind(kind) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"status": "invalid_kind"})
		return
	}

	snapshot, err := api.snapshot()
	if err != nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"status": "unavailable"})
		return
	}

	switch kind {
	case "health":
		writeJSON(w, http.StatusOK, dashboardResponse{Data: snapshot.OperationalHealth})
	case "history":
		api.history(w, r, snapshot)
	case "diagnostics":
		api.diagnostics(w, r, snapshot)
	default:
		// "profitability" y, por seguridad, cualquier valor que hubiera pasado
		// la validación anterior.
		api.profitability(w, r, snapshot)
	}
}

// mobileInsightsValidKind acepta solo los cuatro paneles del contrato.
func mobileInsightsValidKind(kind string) bool {
	switch kind {
	case "health", "profitability", "history", "diagnostics":
		return true
	default:
		return false
	}
}

// now devuelve el reloj inyectado o el del sistema.
func (api *MobileInsightsAPI) now() time.Time {
	if api.Now != nil {
		return api.Now()
	}
	return time.Now()
}

// mobileInsightsDays normaliza days. Solo 7, 30 y 90 son válidos; cualquier
// otro valor usa 30.
func mobileInsightsDays(r *http.Request) int {
	raw := r.URL.Query().Get("days")
	if raw == "" {
		return mobileInsightsDefaultDays
	}
	days, err := strconv.Atoi(raw)
	if err != nil {
		return mobileInsightsDefaultDays
	}
	switch days {
	case 7, 30, 90:
		return days
	default:
		return mobileInsightsDefaultDays
	}
}

// mobileInsightsCoin exige un código presente en analytics.markets. Una moneda
// ausente o desconocida responde 400 unknown_market.
func mobileInsightsCoin(
	w http.ResponseWriter,
	r *http.Request,
	snapshot mobileInsightsSnapshot,
) (string, bool) {
	coin := r.URL.Query().Get("coin")
	if coin == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"status": "unknown_market"})
		return "", false
	}
	for _, market := range snapshot.Analytics.Markets {
		if market.Code == coin {
			return coin, true
		}
	}
	writeJSON(w, http.StatusBadRequest, map[string]string{"status": "unknown_market"})
	return "", false
}

// history filtra el histórico fiat por moneda y devuelve la misma página de 20
// movimientos que /api/fiat-history, ordenada por createdAt, origin y sequence
// descendente.
func (api *MobileInsightsAPI) history(
	w http.ResponseWriter,
	r *http.Request,
	snapshot mobileInsightsSnapshot,
) {
	coin, ok := mobileInsightsCoin(w, r, snapshot)
	if !ok {
		return
	}

	entries := make([]dashboardReadFiatEntry, 0, len(snapshot.FiatHistory))
	for _, entry := range snapshot.FiatHistory {
		if entry.Coin == coin {
			entries = append(entries, entry)
		}
	}
	sort.SliceStable(entries, func(i, j int) bool {
		if entries[i].CreatedAt != entries[j].CreatedAt {
			return entries[i].CreatedAt > entries[j].CreatedAt
		}
		if entries[i].Origin != entries[j].Origin {
			return entries[i].Origin > entries[j].Origin
		}
		return entries[i].Sequence > entries[j].Sequence
	})

	writeJSON(w, http.StatusOK, dashboardResponse{
		Data: dashboardReadPageItems(entries, dashboardReadPage(r)),
	})
}

// diagnostics construye el informe de caza con la ventana fija de 24 h y el
// mercado indicado, usando el auditLog y analytics.markets del snapshot móvil.
func (api *MobileInsightsAPI) diagnostics(
	w http.ResponseWriter,
	r *http.Request,
	snapshot mobileInsightsSnapshot,
) {
	coin, ok := mobileInsightsCoin(w, r, snapshot)
	if !ok {
		return
	}
	selected := coin
	writeJSON(w, http.StatusOK, dashboardResponse{
		Data: huntingDiagnosticsReport(
			snapshot.diagnosticsSnapshot(),
			mobileInsightsDiagnosticsHours,
			&selected,
			api.now(),
		),
	})
}

// diagnosticsSnapshot adapta el snapshot móvil al contrato del diagnóstico.
func (snapshot mobileInsightsSnapshot) diagnosticsSnapshot() huntingDiagnosticsSnapshot {
	markets := make([]huntingDiagnosticsMarket, 0, len(snapshot.Analytics.Markets))
	for _, market := range snapshot.Analytics.Markets {
		label := market.Code
		if market.Label != nil {
			label = *market.Label
		}
		currency := market.Code
		if market.Currency != nil {
			currency = *market.Currency
		}
		markets = append(markets, huntingDiagnosticsMarket{
			Code:     market.Code,
			Label:    label,
			Currency: currency,
		})
	}

	var diagnostics huntingDiagnosticsSnapshot
	diagnostics.AuditLog = snapshot.AuditLog
	diagnostics.Analytics.Markets = markets
	return diagnostics
}

// profitability calcula el informe con buildTradingAnalytics y publica solo la
// proyección móvil. limited refleja la muestra cruda del snapshot, antes de
// deduplicar.
func (api *MobileInsightsAPI) profitability(
	w http.ResponseWriter,
	r *http.Request,
	snapshot mobileInsightsSnapshot,
) {
	input := snapshot.Analytics
	days := mobileInsightsDays(r)
	report := buildTradingAnalytics(input, days, api.now().UnixMilli())

	limited := len(input.Transactions) > mobileInsightsLimitedTransactions ||
		len(input.Offers) > mobileInsightsLimitedOffers
	note := mobileInsightsLocalNote
	if limited {
		note = mobileInsightsLimitedNote
	}

	writeJSON(w, http.StatusOK, dashboardResponse{
		Data: mobileInsightsProfitability{
			Days:        report.Days,
			GeneratedAt: report.GeneratedAt,
			Currencies:  report.Currencies,
			Coverage:    report.Coverage,
			Limited:     limited,
			Note:        note,
		},
	})
}

// snapshot lee y valida el documento publicado. Nunca devuelve el error de E/S
// al cliente ni incluye la ruta en un mensaje. Un archivo ausente o vacío es un
// snapshot vacío válido.
func (api *MobileInsightsAPI) snapshot() (mobileInsightsSnapshot, error) {
	if api.File == "" {
		return mobileInsightsSnapshot{}, nil
	}

	file, err := os.Open(api.File)
	if err != nil {
		// Un snapshot ausente es un estado normal mientras el exportador no
		// haya publicado nada; cualquier otro fallo es indisponibilidad.
		if errors.Is(err, fs.ErrNotExist) {
			return mobileInsightsSnapshot{}, nil
		}
		return mobileInsightsSnapshot{}, err
	}
	defer file.Close()

	// Se lee como máximo un byte de más para detectar archivos fuera de límite
	// sin cargar el resto en memoria.
	raw, err := io.ReadAll(io.LimitReader(file, maxMobileInsightsSnapshotBytes+1))
	if err != nil {
		return mobileInsightsSnapshot{}, err
	}
	if len(raw) > maxMobileInsightsSnapshotBytes {
		return mobileInsightsSnapshot{}, errMobileInsightsSnapshotTooLarge
	}

	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 {
		return mobileInsightsSnapshot{}, nil
	}
	// json.Valid garantiza que el valor completo (sin datos extra al final) es
	// JSON; el primer byte descarta escalares y arreglos, que no son el objeto
	// esperado.
	if trimmed[0] != '{' || !json.Valid(trimmed) {
		return mobileInsightsSnapshot{}, errMobileInsightsSnapshotInvalid
	}

	var snapshot mobileInsightsSnapshot
	if err := json.Unmarshal(trimmed, &snapshot); err != nil {
		return mobileInsightsSnapshot{}, errMobileInsightsSnapshotInvalid
	}
	return snapshot, nil
}
