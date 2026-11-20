package edge

// Simulación de precios de solo lectura. Replica src/price-simulation.ts sobre
// el snapshot exportado por scripts/f3-export-web-extras.py (web-extras.json):
// recorre las observaciones ya ordenadas, deduplica ofertas y compara las tasas
// efectivas con los límites guardados y con los propuestos por el usuario.
//
// No escribe en la base de datos, no emite cookies y no hace proxy al monolito
// TS. La ruta web exige cookie de sesión, Origin permitido y CSRF; la móvil usa
// la credencial Bearer de operador con scope read.

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"io/fs"
	"math"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/AGR55/QvaApp/services/trading-core/internal/runtimeconfig"
)

const (
	// Rutas servidas por SimulationAPI.
	simulationWebPath    = "/api/hunting/simulate"
	simulationMobilePath = "/api/mobile/simulate"

	// maxSimulationSnapshotBytes acota el snapshot leído del disco. Un archivo
	// mayor se rechaza sin cargarlo entero en memoria.
	maxSimulationSnapshotBytes = 16 << 20

	// simulationMaxBodyBytes acota el cuerpo del POST. Los cinco campos del
	// contrato caben de sobra.
	simulationMaxBodyBytes = 8 << 10

	// simulationMaxObservations es el tope de observaciones examinadas, igual
	// que el bucle del monolito TS.
	simulationMaxObservations = 5000

	// simulationMaxCoinRunes y simulationMaxRate replican los límites del
	// esquema HTTP original.
	simulationMaxCoinRunes = 50
	simulationMaxRate      = 1e9

	// Mensajes copiados literalmente del contrato TS.
	simulationInputError  = "Introduce tasas e importe positivos y un período de 1, 24 o 168 horas."
	simulationMarketError = "Mercado no configurado."
	simulationNote        = "Comparación de precios sobre la última observación de cada oferta. Usa QUSD brutos, comisión fiat actual y límites por rango; no comprueba saldo histórico, cupos, requisitos ni disponibilidad posterior. No garantiza capturas ni modifica tus límites."
)

// Errores centinela del snapshot. Nunca se escriben en la respuesta.
var (
	errSimulationSnapshotTooLarge = errors.New("edge: snapshot de simulación demasiado grande")
	errSimulationSnapshotInvalid  = errors.New("edge: snapshot de simulación inválido")
)

// RuntimeLoader es la fuente de la configuración operativa. *runtimeconfig.
// Repository lo cumple; la interfaz permite sustituirlo en las pruebas.
type RuntimeLoader interface {
	Load(ctx context.Context) (runtimeconfig.Config, int64, error)
}

// SimulationAPI expone el motor de simulación.
//
// Rutas:
//
//	POST /api/hunting/simulate  (cookie de sesión + Origin + CSRF)
//	POST /api/mobile/simulate   (Bearer de operador con scope read)
//
// El cuerpo es {coin,hours,buyMaxRate,sellMinRate,maxQusd}. La respuesta es
// {data:{...}} con el mismo informe que devuelve simulatePrices. Un snapshot
// ausente o vacío produce una simulación válida sin datos; un JSON inválido, un
// archivo mayor de 16 MiB o un fallo de lectura producen 503 sin detalles.
// Cualquier método distinto de POST responde 405 y cualquier otra ruta 404.
//
// No hay caché: cada petición relee el snapshot y la configuración para que un
// cambio sea visible de inmediato. Now permite inyectar el reloj en las
// pruebas; nil usa time.Now.
type SimulationAPI struct {
	Sessions      *SessionManager
	MobileAuth    *MobileAuthAPI
	File          string
	Runtime       RuntimeLoader
	TrustedOrigin string
	Now           func() time.Time
}

// simulationInput es el cuerpo aceptado por ambas rutas.
type simulationInput struct {
	Coin        string  `json:"coin"`
	Hours       int     `json:"hours"`
	BuyMaxRate  float64 `json:"buyMaxRate"`
	SellMinRate float64 `json:"sellMinRate"`
	MaxQusd     float64 `json:"maxQusd"`
}

// simulationSnapshot replica la parte del documento exportado que consume la
// simulación. El resto de claves se ignora.
type simulationSnapshot struct {
	Simulation simulationSource `json:"simulation"`
}

type simulationSource struct {
	AccountUUID  string                  `json:"accountUuid"`
	OwnOffers    []string                `json:"ownOffers"`
	Observations []simulationObservation `json:"observations"`
}

// simulationObservation es una fila de market_feed_events tal como la exporta
// el script: payload es el JSON original en texto.
type simulationObservation struct {
	Key     string `json:"key"`
	At      int64  `json:"at"`
	Payload string `json:"payload"`
}

// simulationCounts y simulationTotals replican los contadores del TS.
type simulationCounts struct {
	Observations  int `json:"observations"`
	Own           int `json:"own"`
	Stale         int `json:"stale"`
	Invalid       int `json:"invalid"`
	RangeOrAmount int `json:"rangeOrAmount"`
}

type simulationTotals struct {
	Buy      int     `json:"buy"`
	Sell     int     `json:"sell"`
	BuyQusd  float64 `json:"buyQusd"`
	SellQusd float64 `json:"sellQusd"`
}

type simulationAssumptions struct {
	OutgoingTransferFee float64 `json:"outgoingTransferFee"`
	CurrentBuyMaxRate   float64 `json:"currentBuyMaxRate"`
	CurrentSellMinRate  float64 `json:"currentSellMinRate"`
}

// simulationReport es el objeto publicado dentro de "data".
type simulationReport struct {
	Coin          string                `json:"coin"`
	Hours         int                   `json:"hours"`
	BuyMaxRate    float64               `json:"buyMaxRate"`
	SellMinRate   float64               `json:"sellMinRate"`
	MaxQusd       float64               `json:"maxQusd"`
	GeneratedAt   int64                 `json:"generatedAt"`
	Since         int64                 `json:"since"`
	CoverageSince int64                 `json:"coverageSince"`
	Truncated     bool                  `json:"truncated"`
	Scanned       int                   `json:"scanned"`
	UniqueOffers  int                   `json:"uniqueOffers"`
	Counts        simulationCounts      `json:"counts"`
	Baseline      simulationTotals      `json:"baseline"`
	Proposed      simulationTotals      `json:"proposed"`
	Assumptions   simulationAssumptions `json:"assumptions"`
	Note          string                `json:"note"`
}

func (api *SimulationAPI) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")

	switch r.URL.Path {
	case simulationWebPath:
		if r.Method != http.MethodPost {
			writeSimulationMethodNotAllowed(w)
			return
		}
		api.serveWeb(w, r)
	case simulationMobilePath:
		if r.Method != http.MethodPost {
			writeSimulationMethodNotAllowed(w)
			return
		}
		api.serveMobile(w, r)
	default:
		writeJSON(w, http.StatusNotFound, map[string]string{"status": "not_found"})
	}
}

// serveWeb valida la cookie de sesión y, antes de calcular, el Origin y el CSRF
// de doble envío.
func (api *SimulationAPI) serveWeb(w http.ResponseWriter, r *http.Request) {
	cookie, ok := api.webSession(r)
	if !ok {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"status": "unauthenticated"})
		return
	}
	if !edgeOriginAllowed(r, api.TrustedOrigin) {
		writeJSON(w, http.StatusForbidden, map[string]any{"error": "Origen de solicitud no autorizado."})
		return
	}
	csrf := requestCSRFToken(r)
	if csrf == "" || api.Sessions == nil || !api.Sessions.ValidateCSRF(cookie, csrf, api.now()) {
		writeJSON(w, http.StatusForbidden, map[string]any{"error": "CSRF inválido."})
		return
	}
	api.simulate(w, r)
}

// serveMobile delega en MobileAuthAPI. Si AuthorizeRead falla ya escribió la
// respuesta (401, 429 o 503).
func (api *SimulationAPI) serveMobile(w http.ResponseWriter, r *http.Request) {
	if api.MobileAuth == nil {
		writeJSON(w, http.StatusUnauthorized, mobileAuthErrorResponse{
			Error: mobileOperatorCredentialError,
		})
		return
	}
	if !api.MobileAuth.AuthorizeRead(w, r) {
		return
	}
	api.simulate(w, r)
}

// webSession comprueba la cookie con el reloj configurado y devuelve su valor
// para validar el CSRF. Un SessionManager nil también produce false.
func (api *SimulationAPI) webSession(r *http.Request) (string, bool) {
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

// simulate reúne la validación y el cálculo. El orden es: snapshot, cuerpo,
// configuración y mercado; cualquier fallo responde sin exponer detalles.
func (api *SimulationAPI) simulate(w http.ResponseWriter, r *http.Request) {
	snapshot, err := api.snapshot()
	if err != nil {
		writeSimulationUnavailable(w)
		return
	}

	input, ok := api.input(w, r)
	if !ok {
		return
	}

	config, ok := api.runtimeConfig(w, r)
	if !ok {
		return
	}
	market, ok := simulationMarket(config, input.Coin)
	if !ok {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": simulationMarketError})
		return
	}

	writeJSON(w, http.StatusOK, dashboardResponse{
		Data: simulationReportFor(snapshot, input, market, api.now().UnixMilli()),
	})
}

// input lee y valida el cuerpo. Cualquier error de forma, tipo o rango usa el
// mismo mensaje que el monolito, sin reflejar el valor recibido.
func (api *SimulationAPI) input(w http.ResponseWriter, r *http.Request) (simulationInput, bool) {
	body := http.MaxBytesReader(w, r.Body, simulationMaxBodyBytes)
	raw, err := io.ReadAll(body)
	if err != nil {
		writeSimulationInputError(w)
		return simulationInput{}, false
	}

	var input simulationInput
	if err := json.Unmarshal(raw, &input); err != nil {
		writeSimulationInputError(w)
		return simulationInput{}, false
	}
	if !simulationValidInput(input) {
		writeSimulationInputError(w)
		return simulationInput{}, false
	}
	return input, true
}

// simulationValidInput aplica los límites del esquema TS: moneda de 1 a 50
// caracteres, período 1/24/168 y tres números finitos en (0, 1e9].
func simulationValidInput(input simulationInput) bool {
	coinRunes := utf8.RuneCountInString(input.Coin)
	if coinRunes < 1 || coinRunes > simulationMaxCoinRunes {
		return false
	}
	switch input.Hours {
	case 1, 24, 168:
	default:
		return false
	}
	return simulationPositiveRate(input.BuyMaxRate) &&
		simulationPositiveRate(input.SellMinRate) &&
		simulationPositiveRate(input.MaxQusd)
}

func simulationPositiveRate(value float64) bool {
	return simulationFinite(value) && value > 0 && value <= simulationMaxRate
}

// runtimeConfig carga la configuración vigente. Sin repositorio o con error de
// lectura no hay forma de conocer mercado ni comisiones: 503.
func (api *SimulationAPI) runtimeConfig(
	w http.ResponseWriter,
	r *http.Request,
) (runtimeconfig.Config, bool) {
	if api.Runtime == nil {
		writeSimulationUnavailable(w)
		return runtimeconfig.Config{}, false
	}
	ctx, cancel := context.WithTimeout(r.Context(), statsTimeout)
	defer cancel()
	config, _, err := api.Runtime.Load(ctx)
	if err != nil {
		writeSimulationUnavailable(w)
		return runtimeconfig.Config{}, false
	}
	return config, true
}

// simulationMarket busca el mercado por código exacto.
func simulationMarket(config runtimeconfig.Config, coin string) (runtimeconfig.Market, bool) {
	for _, market := range config.Markets {
		if market.Code == coin {
			return market, true
		}
	}
	return runtimeconfig.Market{}, false
}

// simulationReportFor ejecuta el recorrido. Las observaciones ya llegan
// ordenadas por at DESC, key DESC y limitadas a 5000 por el exportador.
func simulationReportFor(
	snapshot simulationSnapshot,
	input simulationInput,
	current runtimeconfig.Market,
	nowMS int64,
) simulationReport {
	source := snapshot.Simulation
	own := make(map[string]struct{}, len(source.OwnOffers))
	for _, uuid := range source.OwnOffers {
		own[uuid] = struct{}{}
	}

	since := nowMS - int64(input.Hours)*3_600_000
	oldest := nowMS
	seen := make(map[string]struct{})
	counts := simulationCounts{}
	baseline := simulationTotals{}
	proposed := simulationTotals{}
	scanned := 0

	for _, row := range source.Observations {
		if scanned >= simulationMaxObservations {
			break
		}
		scanned++
		oldest = row.At

		var payload map[string]json.RawMessage
		if err := json.Unmarshal([]byte(row.Payload), &payload); err != nil {
			// JSON.parse lanzó en el TS.
			counts.Invalid++
			continue
		}
		if payload == nil {
			continue
		}

		dataRaw, exists := payload["data"]
		if !exists {
			continue
		}
		trimmed := bytes.TrimSpace(dataRaw)
		if len(trimmed) == 0 || bytes.Equal(trimmed, []byte("null")) {
			continue
		}
		var data map[string]any
		if err := json.Unmarshal(trimmed, &data); err != nil {
			// Un data que no es objeto no tiene coin: el TS sigue sin contar.
			continue
		}

		coin, coinOK := data["coin"].(string)
		uuid, uuidOK := data["uuid"].(string)
		if !coinOK || coin != input.Coin || !uuidOK {
			continue
		}

		counts.Observations++
		if _, duplicate := seen[uuid]; duplicate {
			continue
		}
		seen[uuid] = struct{}{}

		if simulationOwnOffer(data, source.AccountUUID, own, uuid) {
			counts.Own++
			continue
		}

		sentAt := ""
		if raw, ok := payload["sent_at"]; ok {
			// Un sent_at no textual equivale a una fecha inválida en el TS.
			_ = json.Unmarshal(raw, &sentAt)
		}
		published, publishedOK := simulationParseTime(sentAt)
		if !publishedOK || simulationAbsDiff(row.At, published) > 5000 {
			counts.Stale++
			continue
		}

		amount, amountOK := simulationNumber(data["amount"])
		receive, receiveOK := simulationNumber(data["receive"])
		status, statusOK := data["status"].(string)
		offerType, typeOK := data["type"].(string)
		if !statusOK || status != "open" ||
			!typeOK || (offerType != "buy" && offerType != "sell") ||
			!amountOK || !receiveOK ||
			!simulationFinite(receive/amount) ||
			amount <= 0 || receive <= 0 {
			counts.Invalid++
			continue
		}

		amount, receive, ok := simulationSizeOffer(data, amount, receive, input.MaxQusd)
		if !ok {
			counts.RangeOrAmount++
			continue
		}

		side := "sell"
		if offerType == "sell" {
			side = "buy"
		}

		effective := receive / amount
		if side == "buy" {
			fee := 0.0
			if simulationFinite(current.OutgoingTransferFee) && current.OutgoingTransferFee > 0 {
				fee = current.OutgoingTransferFee
			}
			// Misma expresión que outgoingFiatCost(...).effectiveRate.
			effective = (amount*(receive/amount) + math.Max(0, fee)) / amount
		}

		if side == "buy" {
			if effective <= current.BuyMaxRate {
				baseline.Buy++
				baseline.BuyQusd += amount
			}
			if effective <= input.BuyMaxRate {
				proposed.Buy++
				proposed.BuyQusd += amount
			}
		} else {
			if effective >= current.SellMinRate {
				baseline.Sell++
				baseline.SellQusd += amount
			}
			if effective >= input.SellMinRate {
				proposed.Sell++
				proposed.SellQusd += amount
			}
		}
	}

	truncated := scanned == simulationMaxObservations &&
		len(source.Observations) > simulationMaxObservations
	coverageSince := since
	if truncated {
		coverageSince = oldest
	}

	return simulationReport{
		Coin:          input.Coin,
		Hours:         input.Hours,
		BuyMaxRate:    input.BuyMaxRate,
		SellMinRate:   input.SellMinRate,
		MaxQusd:       input.MaxQusd,
		GeneratedAt:   nowMS,
		Since:         since,
		CoverageSince: coverageSince,
		Truncated:     truncated,
		Scanned:       scanned,
		UniqueOffers:  len(seen),
		Counts:        counts,
		Baseline:      baseline,
		Proposed:      proposed,
		Assumptions: simulationAssumptions{
			OutgoingTransferFee: current.OutgoingTransferFee,
			CurrentBuyMaxRate:   current.BuyMaxRate,
			CurrentSellMinRate:  current.SellMinRate,
		},
		Note: simulationNote,
	}
}

// simulationOwnOffer reconoce ofertas propias por owner_uuid, por User.uuid o
// por el conjunto ya conocido de ofertas propias. Con una cuenta vacía no se
// compara owner_uuid para no confundir campos ausentes.
func simulationOwnOffer(
	data map[string]any,
	account string,
	own map[string]struct{},
	uuid string,
) bool {
	if _, found := own[uuid]; found {
		return true
	}
	if account == "" {
		return false
	}
	if owner, ok := data["owner_uuid"].(string); ok && owner == account {
		return true
	}
	if user, ok := data["User"].(map[string]any); ok {
		if userUUID, ok := user["uuid"].(string); ok && userUUID == account {
			return true
		}
	}
	return false
}

// simulationSizeOffer replica sizeFlexibleOffer. Para ofertas normales solo
// rechaza importes por encima del máximo; las flexibles se dimensionan al
// capital disponible sin redondear nunca por encima.
func simulationSizeOffer(
	data map[string]any,
	amount, receive, maxQusd float64,
) (float64, float64, bool) {
	kind, _ := data["offer_kind"].(string)
	if kind != "flexible" {
		if amount > maxQusd {
			return 0, 0, false
		}
		return amount, receive, true
	}

	available, availableOK := simulationNumber(data["available_amount"])
	minAmount, minOK := simulationNumber(data["order_min"])
	maxAmount, maxOK := simulationNumber(data["order_max"])
	quote := receive / amount
	capacity := maxQusd
	limit := maxQusd
	if !availableOK || !minOK || !maxOK ||
		!simulationFinite(available) || !simulationFinite(minAmount) ||
		!simulationFinite(maxAmount) || !simulationFinite(quote) ||
		!simulationFinite(capacity) || minAmount <= 0 ||
		maxAmount < minAmount || available <= 0 || quote <= 0 ||
		capacity <= 0 {
		return 0, 0, false
	}

	candidate := math.Min(math.Min(available, maxAmount), math.Min(capacity, limit))
	sized := math.Floor(candidate*100) / 100
	if sized < minAmount || sized <= 0 {
		return 0, 0, false
	}
	return sized, sized * quote, true
}

// simulationNumber imita Number(value) del TS para los tipos que produce JSON.
func simulationNumber(value any) (float64, bool) {
	switch typed := value.(type) {
	case nil:
		return 0, true
	case float64:
		return typed, true
	case string:
		text := strings.TrimSpace(typed)
		if text == "" {
			return 0, true
		}
		parsed, err := strconv.ParseFloat(text, 64)
		if err != nil {
			return 0, false
		}
		return parsed, true
	case bool:
		if typed {
			return 1, true
		}
		return 0, true
	default:
		return 0, false
	}
}

// simulationParseTime acepta ISO 8601 con o sin zona. Sin zona se interpreta
// como UTC; cualquier formato desconocido cuenta como fecha inválida (stale).
func simulationParseTime(value string) (int64, bool) {
	for _, layout := range []string{
		time.RFC3339Nano,
		"2006-01-02T15:04:05.999999999",
		"2006-01-02T15:04:05",
		"2006-01-02 15:04:05.999999999",
		"2006-01-02 15:04:05",
	} {
		if parsed, err := time.Parse(layout, value); err == nil {
			return parsed.UnixMilli(), true
		}
	}
	return 0, false
}

func simulationFinite(value float64) bool {
	return !math.IsNaN(value) && !math.IsInf(value, 0)
}

func simulationAbsDiff(left, right int64) int64 {
	difference := left - right
	if difference < 0 {
		return -difference
	}
	return difference
}

// snapshot lee y valida el documento exportado. Nunca devuelve el error de E/S
// al cliente ni incluye la ruta en un mensaje. Un archivo ausente o vacío es un
// snapshot vacío válido.
func (api *SimulationAPI) snapshot() (simulationSnapshot, error) {
	if api.File == "" {
		return simulationSnapshot{}, nil
	}

	file, err := os.Open(api.File)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return simulationSnapshot{}, nil
		}
		return simulationSnapshot{}, err
	}
	defer file.Close()

	// Se lee como máximo un byte de más para detectar archivos fuera de límite
	// sin cargar el resto en memoria.
	raw, err := io.ReadAll(io.LimitReader(file, maxSimulationSnapshotBytes+1))
	if err != nil {
		return simulationSnapshot{}, err
	}
	if len(raw) > maxSimulationSnapshotBytes {
		return simulationSnapshot{}, errSimulationSnapshotTooLarge
	}

	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 {
		return simulationSnapshot{}, nil
	}
	if trimmed[0] != '{' || !json.Valid(trimmed) {
		return simulationSnapshot{}, errSimulationSnapshotInvalid
	}

	var snapshot simulationSnapshot
	if err := json.Unmarshal(trimmed, &snapshot); err != nil {
		return simulationSnapshot{}, errSimulationSnapshotInvalid
	}
	return snapshot, nil
}

func (api *SimulationAPI) now() time.Time {
	if api.Now != nil {
		return api.Now()
	}
	return time.Now()
}

func writeSimulationInputError(w http.ResponseWriter) {
	writeJSON(w, http.StatusBadRequest, map[string]any{"error": simulationInputError})
}

func writeSimulationMethodNotAllowed(w http.ResponseWriter) {
	w.Header().Set("Allow", http.MethodPost)
	writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"status": "method_not_allowed"})
}

func writeSimulationUnavailable(w http.ResponseWriter) {
	writeJSON(w, http.StatusServiceUnavailable, map[string]string{"status": "unavailable"})
}
