package edge

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"io/fs"
	"net/http"
	"os"
	"regexp"
	"sort"
	"strconv"
	"time"
)

const (
	// huntingDiagnosticsPath es la única ruta servida por la API.
	huntingDiagnosticsPath = "/api/hunting/diagnostics"

	// maxHuntingDiagnosticsSnapshotBytes acota el snapshot leído del disco. Un
	// archivo mayor se rechaza sin cargarlo entero en memoria.
	maxHuntingDiagnosticsSnapshotBytes = 8 << 20

	// huntingDiagnosticsExportLimit es el máximo de filas de auditLog que
	// publica el exportador (5000 por cada una de las tres acciones). Si el
	// snapshot trae exactamente ese número y todas caen en la ventana, la
	// cobertura puede estar recortada.
	huntingDiagnosticsExportLimit = 15000

	// huntingDiagnosticsCoinLimit replica maxLength=50 del esquema TS.
	huntingDiagnosticsCoinLimit = 50

	// huntingDiagnosticsDefaultHours es la ventana usada cuando hours falta o
	// no es uno de los valores admitidos.
	huntingDiagnosticsDefaultHours = 24

	// huntingDiagnosticsHourMS es la duración de una hora en milisegundos.
	huntingDiagnosticsHourMS = int64(3_600_000)

	// huntingDiagnosticsNote acompaña al informe para evitar interpretaciones
	// que el conteo no puede sostener.
	huntingDiagnosticsNote = "Se cuentan observaciones del feed y solicitudes registradas; no demuestra ofertas perdidas frente a otros bots. No incluye todas las evaluaciones del sondeo de recuperación."
)

var (
	// errHuntingDiagnosticsSnapshotTooLarge marca snapshots por encima del
	// límite. El detalle nunca se escribe en la respuesta.
	errHuntingDiagnosticsSnapshotTooLarge = errors.New("edge: snapshot de diagnóstico demasiado grande")
	// errHuntingDiagnosticsSnapshotInvalid marca snapshots que no son un
	// objeto JSON válido. El detalle nunca se escribe en la respuesta.
	errHuntingDiagnosticsSnapshotInvalid = errors.New("edge: snapshot de diagnóstico inválido")

	// huntingDiagnosticsFeedPattern replica el patrón del monolito TS para las
	// observaciones del feed. (?s) permite que el outcome contenga saltos de
	// línea y $ ancla el punto final.
	huntingDiagnosticsFeedPattern = regexp.MustCompile(`(?s)Evento (p2p\.(?:created|reopened|range_created|range_updated)) de oferta (\S+) \(([^)]+)\) procesado desde el feed: (.*)\.$`)

	// huntingDiagnosticsAcceptedPattern reconoce los outcomes aplicados.
	huntingDiagnosticsAcceptedPattern = regexp.MustCompile(`(?i)^(?:venta )?aplicada `)

	// Categorías de motivo, en el mismo orden de precedencia que el TS.
	huntingDiagnosticsStalePattern       = regexp.MustCompile(`(?i)antigua|>5 s|fresca|vencid`)
	huntingDiagnosticsOwnPattern         = regexp.MustCompile(`(?i)propia`)
	huntingDiagnosticsInactivePattern    = regexp.MustCompile(`(?i)inactiv|detenid|pausad|emergencia`)
	huntingDiagnosticsCapitalPattern     = regexp.MustCompile(`(?i)saldo|capital|límites|cupo|mínimo de la orden`)
	huntingDiagnosticsPricePattern       = regexp.MustCompile(`(?i)tasa|precio|comisión|objetivo`)
	huntingDiagnosticsPreviousPattern    = regexp.MustCompile(`(?i)previa|ya evaluada|en curso`)
	huntingDiagnosticsUnavailablePattern = regexp.MustCompile(`(?i)invalidada|no disponible|ya no disponible`)
	huntingDiagnosticsSafetyPattern      = regexp.MustCompile(`(?i)VIP|KYC|requisito|conciliación|seguridad|condiciones`)
)

// huntingDiagnosticsReasonLabels replica las etiquetas exactas del TS.
var huntingDiagnosticsReasonLabels = map[string]string{
	"price":       "Precio o comisión fuera del objetivo",
	"capital":     "Saldo o límites insuficientes",
	"inactive":    "Cacería desactivada o pausada",
	"stale":       "Observación antigua",
	"own":         "Oferta propia",
	"previous":    "Operación previa o ya evaluada",
	"unavailable": "Oferta no disponible",
	"safety":      "Requisitos o protección de la operación",
	"other":       "Otros motivos",
}

// huntingDiagnosticsSnapshot replica la parte del documento privado que usa
// esta ruta. Las listas ausentes se tratan como vacías.
type huntingDiagnosticsSnapshot struct {
	AuditLog  []huntingDiagnosticsAuditRow `json:"auditLog"`
	Analytics struct {
		Markets []huntingDiagnosticsMarket `json:"markets"`
	} `json:"analytics"`
}

// huntingDiagnosticsAuditRow es una fila de telemetría exportada.
type huntingDiagnosticsAuditRow struct {
	ID        int64  `json:"id"`
	CreatedAt int64  `json:"createdAt"`
	Action    string `json:"action"`
	UUID      string `json:"uuid"`
	Detail    string `json:"detail"`
}

// huntingDiagnosticsMarket es un mercado configurado del snapshot.
type huntingDiagnosticsMarket struct {
	Code     string `json:"code"`
	Label    string `json:"label"`
	Currency string `json:"currency"`
}

// huntingDiagnosticsReason es un motivo agregado de rechazo.
type huntingDiagnosticsReason struct {
	Code  string `json:"code"`
	Label string `json:"label"`
	Count int    `json:"count"`
}

// huntingDiagnosticsApplications agrega las solicitudes registradas.
type huntingDiagnosticsApplications struct {
	Sent          int      `json:"sent"`
	Confirmed     int      `json:"confirmed"`
	Rejected      int      `json:"rejected"`
	Uncertain     int      `json:"uncertain"`
	NotSent       int      `json:"notSent"`
	UnknownMarket int      `json:"unknownMarket"`
	ResponseP50Ms *float64 `json:"responseP50Ms"`
}

// huntingDiagnosticsData es el contrato exacto devuelto dentro de "data".
type huntingDiagnosticsData struct {
	Hours                int                            `json:"hours"`
	Coin                 *string                        `json:"coin"`
	GeneratedAt          int64                          `json:"generatedAt"`
	Since                int64                          `json:"since"`
	CoverageSince        int64                          `json:"coverageSince"`
	Truncated            bool                           `json:"truncated"`
	Observations         int                            `json:"observations"`
	UniqueOffers         int                            `json:"uniqueOffers"`
	AcceptedObservations int                            `json:"acceptedObservations"`
	Reasons              []huntingDiagnosticsReason     `json:"reasons"`
	Applications         huntingDiagnosticsApplications `json:"applications"`
	Note                 string                         `json:"note"`
}

// huntingDiagnosticsObservation es una fila del feed ya parseada.
type huntingDiagnosticsObservation struct {
	uuid    string
	outcome string
}

// huntingDiagnosticsTiming es el contenido de offer_apply_timing.
type huntingDiagnosticsTiming struct {
	dispatchedAt  float64
	hasDispatched bool
	finishedAt    float64
	hasFinished   bool
	outcome       string
}

// HuntingDiagnosticsAPI sirve en solo lectura el diagnóstico local de
// oportunidades a partir del snapshot JSON publicado por producción.
//
// Ruta:
//
//	GET /api/hunting/diagnostics?hours=24&coin=CLASICA
//
// hours solo admite 1, 24 o 168; cualquier otro valor usa 24. coin es
// opcional, se limita a 50 caracteres y debe existir en analytics.markets; si
// no existe responde 400 unknown_market. Toda petición exige la cookie de
// sesión emitida por SessionHandler.
//
// Un snapshot ausente o vacío produce un informe válido con contadores en
// cero; un JSON inválido, un archivo mayor de 8 MiB o un fallo de lectura
// producen 503 sin detalles. El handler no registra la ruta del archivo ni su
// contenido. Cualquier otro método responde 405 y cualquier otra ruta 404,
// siempre JSON.
//
// No hay caché: cada petición relee el snapshot. Now permite inyectar el reloj
// en las pruebas; nil usa time.Now. El mismo reloj valida la sesión y calcula
// la ventana de horas.
type HuntingDiagnosticsAPI struct {
	Sessions *SessionManager
	File     string
	Now      func() time.Time
}

func (api *HuntingDiagnosticsAPI) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")

	if r.URL.Path != huntingDiagnosticsPath {
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

	snapshot, err := api.snapshot()
	if err != nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"status": "unavailable"})
		return
	}

	coin, ok := huntingDiagnosticsCoin(r, snapshot)
	if !ok {
		writeJSON(w, http.StatusBadRequest, map[string]string{"status": "unknown_market"})
		return
	}

	writeJSON(w, http.StatusOK, dashboardResponse{
		Data: huntingDiagnosticsReport(snapshot, huntingDiagnosticsHours(r), coin, api.now()),
	})
}

// authenticated valida la cookie de sesión con el reloj configurado. Un
// SessionManager nil también produce false.
func (api *HuntingDiagnosticsAPI) authenticated(r *http.Request) bool {
	if api.Sessions == nil {
		return false
	}
	cookie, err := r.Cookie(CookieName)
	if err != nil || cookie.Value == "" {
		return false
	}
	_, err = api.Sessions.Verify(cookie.Value, api.now())
	return err == nil
}

// now devuelve el reloj inyectado o el del sistema.
func (api *HuntingDiagnosticsAPI) now() time.Time {
	if api.Now != nil {
		return api.Now()
	}
	return time.Now()
}

// snapshot lee y valida el documento publicado. Nunca devuelve el error de E/S
// al cliente ni incluye la ruta en un mensaje. Un archivo ausente o vacío es un
// snapshot vacío válido.
func (api *HuntingDiagnosticsAPI) snapshot() (huntingDiagnosticsSnapshot, error) {
	if api.File == "" {
		return huntingDiagnosticsSnapshot{}, nil
	}

	file, err := os.Open(api.File)
	if err != nil {
		// Un snapshot ausente es un estado normal mientras el exportador no
		// haya publicado nada; cualquier otro fallo es indisponibilidad.
		if errors.Is(err, fs.ErrNotExist) {
			return huntingDiagnosticsSnapshot{}, nil
		}
		return huntingDiagnosticsSnapshot{}, err
	}
	defer file.Close()

	// Se lee como máximo un byte de más para detectar archivos fuera de límite
	// sin cargar el resto en memoria.
	raw, err := io.ReadAll(io.LimitReader(file, maxHuntingDiagnosticsSnapshotBytes+1))
	if err != nil {
		return huntingDiagnosticsSnapshot{}, err
	}
	if len(raw) > maxHuntingDiagnosticsSnapshotBytes {
		return huntingDiagnosticsSnapshot{}, errHuntingDiagnosticsSnapshotTooLarge
	}

	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 {
		return huntingDiagnosticsSnapshot{}, nil
	}
	// json.Valid garantiza que el valor completo (sin datos extra al final) es
	// JSON; el primer byte descarta escalares y arreglos.
	if trimmed[0] != '{' || !json.Valid(trimmed) {
		return huntingDiagnosticsSnapshot{}, errHuntingDiagnosticsSnapshotInvalid
	}

	var snapshot huntingDiagnosticsSnapshot
	if err := json.Unmarshal(trimmed, &snapshot); err != nil {
		return huntingDiagnosticsSnapshot{}, errHuntingDiagnosticsSnapshotInvalid
	}
	return snapshot, nil
}

// huntingDiagnosticsHours normaliza hours: solo 1, 24 y 168 son válidos; el
// resto, incluidos ausentes y no numéricos, usan 24.
func huntingDiagnosticsHours(r *http.Request) int {
	raw := r.URL.Query().Get("hours")
	if raw == "" {
		return huntingDiagnosticsDefaultHours
	}
	hours, err := strconv.Atoi(raw)
	if err != nil {
		return huntingDiagnosticsDefaultHours
	}
	switch hours {
	case 1, 24, 168:
		return hours
	default:
		return huntingDiagnosticsDefaultHours
	}
}

// huntingDiagnosticsCoin valida el filtro opcional contra analytics.markets.
// Un valor vacío equivale a ausente; uno mayor de 50 caracteres o ausente del
// snapshot se rechaza.
func huntingDiagnosticsCoin(
	r *http.Request,
	snapshot huntingDiagnosticsSnapshot,
) (*string, bool) {
	coin := r.URL.Query().Get("coin")
	if coin == "" {
		return nil, true
	}
	if len(coin) > huntingDiagnosticsCoinLimit {
		return nil, false
	}
	for _, market := range snapshot.Analytics.Markets {
		if market.Code == coin {
			value := coin
			return &value, true
		}
	}
	return nil, false
}

// huntingDiagnosticsReport aplica la ventana, parsea las observaciones del feed
// y agrega los motivos y las solicitudes registradas.
func huntingDiagnosticsReport(
	snapshot huntingDiagnosticsSnapshot,
	hours int,
	coin *string,
	now time.Time,
) huntingDiagnosticsData {
	nowMS := now.UnixMilli()
	since := nowMS - int64(hours)*huntingDiagnosticsHourMS

	rows := make([]huntingDiagnosticsAuditRow, 0, len(snapshot.AuditLog))
	for _, row := range snapshot.AuditLog {
		if row.CreatedAt < since || row.CreatedAt > nowMS {
			continue
		}
		rows = append(rows, row)
	}

	// El exportador publica como máximo 15000 filas. Si están todas dentro de
	// la ventana, es posible que existan filas más antiguas sin exportar.
	truncated := len(snapshot.AuditLog) == huntingDiagnosticsExportLimit &&
		len(rows) == len(snapshot.AuditLog)
	coverageSince := since
	if truncated && len(rows) > 0 {
		coverageSince = rows[len(rows)-1].CreatedAt
	}

	observedCoins := make(map[string]string)
	observations := make([]huntingDiagnosticsObservation, 0)
	for _, row := range rows {
		if row.Action != "market_feed_processed" {
			continue
		}
		match := huntingDiagnosticsFeedPattern.FindStringSubmatch(row.Detail)
		if match == nil {
			continue
		}
		observedCoins[row.UUID] = match[3]
		if coin != nil && match[3] != *coin {
			continue
		}
		observations = append(observations, huntingDiagnosticsObservation{
			uuid:    row.UUID,
			outcome: match[4],
		})
	}

	reasonsByCode := make(map[string]int)
	reasonOrder := make([]string, 0, len(huntingDiagnosticsReasonLabels))
	accepted := 0
	uniqueOffers := make(map[string]struct{})
	for _, observation := range observations {
		uniqueOffers[observation.uuid] = struct{}{}
		if huntingDiagnosticsAcceptedPattern.MatchString(observation.outcome) {
			accepted++
			continue
		}
		code := huntingDiagnosticsReasonCode(observation.outcome)
		if _, seen := reasonsByCode[code]; !seen {
			reasonOrder = append(reasonOrder, code)
		}
		reasonsByCode[code]++
	}
	reasons := make([]huntingDiagnosticsReason, 0, len(reasonOrder))
	for _, code := range reasonOrder {
		reasons = append(reasons, huntingDiagnosticsReason{
			Code:  code,
			Label: huntingDiagnosticsReasonLabels[code],
			Count: reasonsByCode[code],
		})
	}
	// El TS ordena por count descendente; la estabilidad conserva el orden de
	// primera aparición en los empates.
	sort.SliceStable(reasons, func(i, j int) bool {
		return reasons[i].Count > reasons[j].Count
	})

	applications, responseP50Ms := huntingDiagnosticsApplicationsReport(rows, observedCoins, coin)
	applications.ResponseP50Ms = responseP50Ms

	return huntingDiagnosticsData{
		Hours:                hours,
		Coin:                 coin,
		GeneratedAt:          nowMS,
		Since:                since,
		CoverageSince:        coverageSince,
		Truncated:            truncated,
		Observations:         len(observations),
		UniqueOffers:         len(uniqueOffers),
		AcceptedObservations: accepted,
		Reasons:              reasons,
		Applications:         applications,
		Note:                 huntingDiagnosticsNote,
	}
}

// huntingDiagnosticsApplicationsReport agrega offer_apply_timing y devuelve el
// percentil 50 de las respuestas (elemento len/2 de la lista ordenada).
func huntingDiagnosticsApplicationsReport(
	rows []huntingDiagnosticsAuditRow,
	observedCoins map[string]string,
	coin *string,
) (huntingDiagnosticsApplications, *float64) {
	var applications huntingDiagnosticsApplications
	responseMs := make([]float64, 0)

	for _, row := range rows {
		if row.Action != "offer_apply_timing" {
			continue
		}
		market := observedCoins[row.UUID]
		if coin != nil && market != *coin {
			if market == "" {
				applications.UnknownMarket++
			}
			continue
		}

		timing, ok := huntingDiagnosticsParseTiming(row.Detail)
		if !ok {
			// Telemetría antigua o malformada no es evidencia de una solicitud.
			continue
		}
		if !timing.hasDispatched {
			applications.NotSent++
			continue
		}
		applications.Sent++
		switch timing.outcome {
		case "confirmed":
			applications.Confirmed++
		case "uncertain":
			applications.Uncertain++
		default:
			applications.Rejected++
		}
		if timing.hasFinished && timing.finishedAt >= timing.dispatchedAt {
			responseMs = append(responseMs, timing.finishedAt-timing.dispatchedAt)
		}
	}

	sort.Float64s(responseMs)
	if len(responseMs) == 0 {
		return applications, nil
	}
	p50 := responseMs[len(responseMs)/2]
	return applications, &p50
}

// huntingDiagnosticsParseTiming replica JSON.parse y las comprobaciones de tipo
// del TS. Un JSON inválido no cuenta como solicitud; un JSON válido sin
// dispatchedAt numérico se contabiliza como no enviado.
func huntingDiagnosticsParseTiming(detail string) (huntingDiagnosticsTiming, bool) {
	var value any
	if err := json.Unmarshal([]byte(detail), &value); err != nil {
		return huntingDiagnosticsTiming{}, false
	}
	if value == nil {
		// Acceder a una propiedad de null lanza en el TS y la fila se ignora.
		return huntingDiagnosticsTiming{}, false
	}
	object, isObject := value.(map[string]any)
	if !isObject {
		// Un valor JSON no objeto no tiene dispatchedAt y cuenta como no enviado.
		return huntingDiagnosticsTiming{}, true
	}

	timing := huntingDiagnosticsTiming{}
	timing.dispatchedAt, timing.hasDispatched = object["dispatchedAt"].(float64)
	timing.finishedAt, timing.hasFinished = object["finishedAt"].(float64)
	timing.outcome, _ = object["outcome"].(string)
	return timing, true
}

// huntingDiagnosticsReasonCode clasifica un outcome rechazado con la precedencia
// del TS.
func huntingDiagnosticsReasonCode(text string) string {
	switch {
	case huntingDiagnosticsStalePattern.MatchString(text):
		return "stale"
	case huntingDiagnosticsOwnPattern.MatchString(text):
		return "own"
	case huntingDiagnosticsInactivePattern.MatchString(text):
		return "inactive"
	case huntingDiagnosticsCapitalPattern.MatchString(text):
		return "capital"
	case huntingDiagnosticsPricePattern.MatchString(text):
		return "price"
	case huntingDiagnosticsPreviousPattern.MatchString(text):
		return "previous"
	case huntingDiagnosticsUnavailablePattern.MatchString(text):
		return "unavailable"
	case huntingDiagnosticsSafetyPattern.MatchString(text):
		return "safety"
	default:
		return "other"
	}
}
