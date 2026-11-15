package edge

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"io/fs"
	"math"
	"net/http"
	"os"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
)

const (
	// Rutas servidas por DashboardReadAPI.
	dashboardReadDevicesPath         = "/api/mobile/devices"
	dashboardReadFiatHistoryPath     = "/api/fiat-history"
	dashboardReadRebalancePrefix     = "/api/offers/rebalance/"
	dashboardReadMarketAnalyticsPath = "/api/market-analytics"
	dashboardReadAnalyticsFeesPath   = "/api/analytics/fees"

	// maxDashboardReadSnapshotBytes acota el snapshot leído del disco. Un
	// archivo mayor se rechaza sin cargarlo entero en memoria.
	maxDashboardReadSnapshotBytes = 8 << 20

	// dashboardReadPageSize es el número de elementos por página.
	dashboardReadPageSize = 20
	// dashboardReadMaxPage acota la página aceptada; fuera de rango se usa 1.
	dashboardReadMaxPage = 1000
	// dashboardReadMaxMarketPoints es el máximo de observaciones devueltas.
	dashboardReadMaxMarketPoints = 240
	// dashboardReadMarketWindow es la ventana de observaciones de mercado.
	dashboardReadMarketWindow = 24 * time.Hour
	// dashboardReadMaxRebalanceID acota el identificador de rebalanceo.
	dashboardReadMaxRebalanceID = 100
)

// dashboardReadCoinPattern valida el código de moneda aceptado por las rutas.
var dashboardReadCoinPattern = regexp.MustCompile(`^[A-Z0-9_]{2,40}$`)

var (
	// errDashboardReadSnapshotTooLarge marca snapshots por encima del límite.
	// El detalle nunca se escribe en la respuesta.
	errDashboardReadSnapshotTooLarge = errors.New("edge: snapshot del dashboard demasiado grande")
	// errDashboardReadSnapshotInvalid marca snapshots que no son un objeto JSON
	// válido. El detalle nunca se escribe en la respuesta.
	errDashboardReadSnapshotInvalid = errors.New("edge: snapshot del dashboard inválido")
)

// dashboardReadSnapshot replica el documento privado generado por el
// exportador. Los campos ausentes se normalizan a listas vacías.
type dashboardReadSnapshot struct {
	GeneratedAt        int64                       `json:"generatedAt"`
	Devices            []dashboardReadDevice       `json:"devices"`
	FiatHistory        []dashboardReadFiatEntry    `json:"fiatHistory"`
	RebalanceJobs      []dashboardReadRebalanceJob `json:"rebalanceJobs"`
	MarketObservations []dashboardReadMarketPoint  `json:"marketObservations"`
	AnalyticsFees      []dashboardReadAnalyticsFee `json:"analyticsFees"`
}

// dashboardReadDevice es un dispositivo móvil registrado.
type dashboardReadDevice struct {
	ID        string          `json:"id"`
	Label     string          `json:"label"`
	CreatedAt int64           `json:"createdAt"`
	RevokedAt json.RawMessage `json:"revokedAt"`
}

// dashboardReadFiatEntry es un movimiento del historial de saldo fiat. Before y
// After pueden ser null en los movimientos heredados del ledger.
type dashboardReadFiatEntry struct {
	ID        string   `json:"id"`
	Coin      string   `json:"coin"`
	Before    *float64 `json:"before"`
	After     *float64 `json:"after"`
	Amount    float64  `json:"amount"`
	UUID      *string  `json:"uuid"`
	Source    string   `json:"source"`
	Kind      string   `json:"kind"`
	CreatedAt int64    `json:"createdAt"`
	Origin    int64    `json:"origin"`
	Sequence  int64    `json:"sequence"`
}

// dashboardReadRebalanceAdjustment es un ajuste de capital de un rebalanceo.
type dashboardReadRebalanceAdjustment struct {
	UUID   string  `json:"uuid"`
	Amount float64 `json:"amount"`
}

// dashboardReadRebalanceJob es el estado público de un trabajo de rebalanceo.
// Error solo viaja cuando el snapshot lo incluye.
type dashboardReadRebalanceJob struct {
	ID          string                             `json:"id"`
	State       string                             `json:"state"`
	Adjustments []dashboardReadRebalanceAdjustment `json:"adjustments"`
	Error       string                             `json:"error,omitempty"`
	CreatedAt   int64                              `json:"createdAt"`
	UpdatedAt   int64                              `json:"updatedAt"`
}

// dashboardReadMarketPoint es una observación de mercado. Los precios son
// opcionales: se conservan ausentes cuando el snapshot no los trae.
type dashboardReadMarketPoint struct {
	CreatedAt   int64    `json:"createdAt"`
	Coin        string   `json:"coin"`
	AverageBuy  *float64 `json:"averageBuy,omitempty"`
	AverageSell *float64 `json:"averageSell,omitempty"`
	MedianBuy   *float64 `json:"medianBuy,omitempty"`
	MedianSell  *float64 `json:"medianSell,omitempty"`
	BestBuy     *float64 `json:"bestBuy,omitempty"`
	BestSell    *float64 `json:"bestSell,omitempty"`
	OpenOffers  int64    `json:"openOffers"`
	Eligible    int64    `json:"eligible"`
}

// dashboardReadAnalyticsFee es la evidencia de comisión de una oferta. Los
// importes pueden ser null cuando la evidencia aún no existe.
type dashboardReadAnalyticsFee struct {
	UUID        string   `json:"uuid"`
	Coin        string   `json:"coin"`
	Amount      *float64 `json:"amount"`
	Receive     *float64 `json:"receive"`
	CompletedAt int64    `json:"completedAt"`
	FeeQusd     *float64 `json:"feeQusd"`
	Evidence    string   `json:"evidence"`
	Version     int64    `json:"version"`
	Stale       bool     `json:"stale"`
}

// dashboardReadPageEnvelope es el sobre paginado común a historial y comisiones.
type dashboardReadPageEnvelope[T any] struct {
	Page    int  `json:"page"`
	HasMore bool `json:"hasMore"`
	Items   []T  `json:"items"`
}

// dashboardReadMarketAnalytics es la respuesta de /api/market-analytics.
type dashboardReadMarketAnalytics struct {
	Coin    string                     `json:"coin"`
	History []dashboardReadMarketPoint `json:"history"`
}

// DashboardReadAPI sirve en solo lectura el snapshot JSON generado por
// producción. Es una vista agregada del dashboard móvil: no escribe, no emite
// cookies ni hace proxy al monolito TS.
//
// Rutas:
//
//	GET /api/mobile/devices
//	GET /api/fiat-history?coin=CUP&page=1
//	GET /api/offers/rebalance/:id
//	GET /api/market-analytics?coin=CUP
//	GET /api/analytics/fees?page=1
//
// Toda petición exige la cookie de sesión emitida por SessionHandler. Un
// snapshot ausente o vacío produce listas vacías; un JSON inválido, un archivo
// mayor de 8 MiB o un fallo de lectura producen 503 sin detalles. El handler no
// registra la ruta del archivo ni su contenido. Cualquier otro método responde
// 405 y cualquier otra ruta 404, siempre JSON.
//
// No hay caché: cada petición relee el snapshot para que una revocación sea
// visible de inmediato. El escritor del snapshot debe publicarlo de forma
// atómica (escribir un temporal y renombrarlo) para que un lector concurrente
// nunca observe un archivo a medio escribir; si lo observara, respondería 503.
//
// Now permite inyectar el reloj en las pruebas; nil usa time.Now. El mismo
// reloj valida la sesión y calcula la ventana de 24 h de las observaciones.
type DashboardReadAPI struct {
	Sessions *SessionManager
	File     string
	Now      func() time.Time
}

func (api *DashboardReadAPI) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")

	rebalanceID, isRebalance := dashboardReadRebalanceID(r.URL.Path)
	known := isRebalance ||
		r.URL.Path == dashboardReadDevicesPath ||
		r.URL.Path == dashboardReadFiatHistoryPath ||
		r.URL.Path == dashboardReadMarketAnalyticsPath ||
		r.URL.Path == dashboardReadAnalyticsFeesPath
	if !known {
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

	switch {
	case r.URL.Path == dashboardReadDevicesPath:
		writeJSON(w, http.StatusOK, dashboardResponse{Data: snapshot.Devices})
	case r.URL.Path == dashboardReadFiatHistoryPath:
		api.fiatHistory(w, r, snapshot)
	case isRebalance:
		api.rebalanceJob(w, rebalanceID, snapshot)
	case r.URL.Path == dashboardReadMarketAnalyticsPath:
		api.marketAnalytics(w, r, snapshot)
	case r.URL.Path == dashboardReadAnalyticsFeesPath:
		page := dashboardReadPage(r)
		writeJSON(w, http.StatusOK, dashboardResponse{
			Data: dashboardReadPageItems(snapshot.AnalyticsFees, page),
		})
	}
}

// authenticated valida la cookie de sesión con el reloj configurado. Un
// SessionManager nil también produce false.
func (api *DashboardReadAPI) authenticated(r *http.Request) bool {
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
func (api *DashboardReadAPI) now() time.Time {
	if api.Now != nil {
		return api.Now()
	}
	return time.Now()
}

// dashboardReadRebalanceID resuelve /api/offers/rebalance/:id. Un
// identificador vacío, con separadores o fuera de 1..100 caracteres no
// identifica una ruta válida y termina en 404.
func dashboardReadRebalanceID(path string) (string, bool) {
	if !strings.HasPrefix(path, dashboardReadRebalancePrefix) {
		return "", false
	}
	id := strings.TrimPrefix(path, dashboardReadRebalancePrefix)
	if len(id) < 1 || len(id) > dashboardReadMaxRebalanceID || strings.Contains(id, "/") {
		return "", false
	}
	return id, true
}

// dashboardReadPage normaliza el parámetro page. Ausente, no numérico o fuera
// de 1..1000 usa 1.
func dashboardReadPage(r *http.Request) int {
	raw := r.URL.Query().Get("page")
	if raw == "" {
		return 1
	}
	page, err := strconv.Atoi(raw)
	if err != nil || page < 1 || page > dashboardReadMaxPage {
		return 1
	}
	return page
}

// dashboardReadCoin devuelve el código de moneda validado. Un valor ausente o
// fuera del patrón se rechaza con 400 invalid_coin.
func dashboardReadCoin(w http.ResponseWriter, r *http.Request) (string, bool) {
	coin := r.URL.Query().Get("coin")
	if !dashboardReadCoinPattern.MatchString(coin) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"status": "invalid_coin"})
		return "", false
	}
	return coin, true
}

// fiatHistory filtra por moneda, ordena por createdAt, origin y sequence
// descendente y devuelve una página de 20 movimientos.
func (api *DashboardReadAPI) fiatHistory(
	w http.ResponseWriter,
	r *http.Request,
	snapshot dashboardReadSnapshot,
) {
	coin, ok := dashboardReadCoin(w, r)
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

// rebalanceJob busca el trabajo por id. Un id ausente del snapshot produce 404.
func (api *DashboardReadAPI) rebalanceJob(
	w http.ResponseWriter,
	id string,
	snapshot dashboardReadSnapshot,
) {
	for _, job := range snapshot.RebalanceJobs {
		if job.ID == id {
			writeJSON(w, http.StatusOK, dashboardResponse{Data: job})
			return
		}
	}
	writeJSON(w, http.StatusNotFound, map[string]string{"status": "not_found"})
}

// marketAnalytics devuelve las observaciones de las últimas 24 h ordenadas por
// createdAt ascendente y compactadas a un máximo de 240 puntos uniformes.
func (api *DashboardReadAPI) marketAnalytics(
	w http.ResponseWriter,
	r *http.Request,
	snapshot dashboardReadSnapshot,
) {
	coin, ok := dashboardReadCoin(w, r)
	if !ok {
		return
	}

	now := api.now()
	cutoff := now.Add(-dashboardReadMarketWindow).UnixMilli()
	limit := now.UnixMilli()
	points := make([]dashboardReadMarketPoint, 0, len(snapshot.MarketObservations))
	for _, point := range snapshot.MarketObservations {
		if point.Coin != coin || point.CreatedAt < cutoff || point.CreatedAt > limit {
			continue
		}
		points = append(points, point)
	}
	sort.SliceStable(points, func(i, j int) bool {
		return points[i].CreatedAt < points[j].CreatedAt
	})

	writeJSON(w, http.StatusOK, dashboardResponse{
		Data: dashboardReadMarketAnalytics{
			Coin:    coin,
			History: dashboardReadCompactPoints(points),
		},
	})
}

// dashboardReadPageItems recorta una página de 20 elementos. Los elementos
// fuera de rango producen una lista vacía, nunca null.
func dashboardReadPageItems[T any](items []T, page int) dashboardReadPageEnvelope[T] {
	start := (page - 1) * dashboardReadPageSize
	if start >= len(items) {
		return dashboardReadPageEnvelope[T]{Page: page, Items: []T{}}
	}
	end := start + dashboardReadPageSize
	if end > len(items) {
		end = len(items)
	}
	return dashboardReadPageEnvelope[T]{
		Page:    page,
		HasMore: end < len(items),
		Items:   items[start:end],
	}
}

// dashboardReadCompactPoints reduce la serie a 240 muestras uniformes. Con 240
// puntos o menos se devuelve la serie completa sin copiar.
func dashboardReadCompactPoints(points []dashboardReadMarketPoint) []dashboardReadMarketPoint {
	if len(points) <= dashboardReadMaxMarketPoints {
		if points == nil {
			return []dashboardReadMarketPoint{}
		}
		return points
	}
	compacted := make([]dashboardReadMarketPoint, 0, dashboardReadMaxMarketPoints)
	last := len(points) - 1
	for i := 0; i < dashboardReadMaxMarketPoints; i++ {
		index := int(math.Round(float64(i) * float64(last) /
			float64(dashboardReadMaxMarketPoints-1)))
		compacted = append(compacted, points[index])
	}
	return compacted
}

// snapshot lee y valida el documento publicado. Nunca devuelve el error de E/S
// al cliente ni incluye la ruta en un mensaje. Un archivo ausente o vacío es un
// snapshot vacío válido.
func (api *DashboardReadAPI) snapshot() (dashboardReadSnapshot, error) {
	if api.File == "" {
		return emptyDashboardReadSnapshot(), nil
	}

	file, err := os.Open(api.File)
	if err != nil {
		// Un snapshot ausente es un estado normal mientras el exportador no
		// haya publicado nada; cualquier otro fallo es indisponibilidad.
		if errors.Is(err, fs.ErrNotExist) {
			return emptyDashboardReadSnapshot(), nil
		}
		return dashboardReadSnapshot{}, err
	}
	defer file.Close()

	// Se lee como máximo un byte de más para detectar archivos fuera de límite
	// sin cargar el resto en memoria.
	raw, err := io.ReadAll(io.LimitReader(file, maxDashboardReadSnapshotBytes+1))
	if err != nil {
		return dashboardReadSnapshot{}, err
	}
	if len(raw) > maxDashboardReadSnapshotBytes {
		return dashboardReadSnapshot{}, errDashboardReadSnapshotTooLarge
	}

	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 {
		return emptyDashboardReadSnapshot(), nil
	}
	// json.Valid garantiza que el valor completo (sin datos extra al final) es
	// JSON; el primer byte descarta escalares y arreglos.
	if trimmed[0] != '{' || !json.Valid(trimmed) {
		return dashboardReadSnapshot{}, errDashboardReadSnapshotInvalid
	}

	var snapshot dashboardReadSnapshot
	if err := json.Unmarshal(trimmed, &snapshot); err != nil {
		return dashboardReadSnapshot{}, errDashboardReadSnapshotInvalid
	}
	snapshot.normalize()
	return snapshot, nil
}

// normalize convierte las listas ausentes en listas vacías para que ninguna
// respuesta contenga null en lugar de un arreglo.
func (snapshot *dashboardReadSnapshot) normalize() {
	if snapshot.Devices == nil {
		snapshot.Devices = []dashboardReadDevice{}
	}
	if snapshot.FiatHistory == nil {
		snapshot.FiatHistory = []dashboardReadFiatEntry{}
	}
	if snapshot.RebalanceJobs == nil {
		snapshot.RebalanceJobs = []dashboardReadRebalanceJob{}
	}
	if snapshot.MarketObservations == nil {
		snapshot.MarketObservations = []dashboardReadMarketPoint{}
	}
	if snapshot.AnalyticsFees == nil {
		snapshot.AnalyticsFees = []dashboardReadAnalyticsFee{}
	}
}

// emptyDashboardReadSnapshot es el snapshot válido sin datos.
func emptyDashboardReadSnapshot() dashboardReadSnapshot {
	return dashboardReadSnapshot{
		Devices:            []dashboardReadDevice{},
		FiatHistory:        []dashboardReadFiatEntry{},
		RebalanceJobs:      []dashboardReadRebalanceJob{},
		MarketObservations: []dashboardReadMarketPoint{},
		AnalyticsFees:      []dashboardReadAnalyticsFee{},
	}
}
