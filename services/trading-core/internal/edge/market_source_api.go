package edge

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/AGR55/QvaApp/services/trading-core/internal/platform/vault"
)

const (
	// Rutas servidas por MarketSourceAPI.
	marketSourceBasePath              = "/api/market-source"
	marketSourceWebhookSecretPath     = marketSourceBasePath + "/webhook-secret"
	marketSourceStreamCredentialsPath = marketSourceBasePath + "/stream-credentials"
	marketReadersBasePath             = "/api/market-readers"

	// Claves de shadow.runtime_settings. Los valores se guardan como JSON, de
	// modo que la columna jsonb siempre recibe texto válido.
	marketSettingMode            = "market_source.mode"
	marketSettingWebhookSecret   = "market_source.webhook_secret"
	marketSettingStreamAppID     = "market_source.stream_app_id"
	marketSettingStreamAppSecret = "market_source.stream_app_secret"

	// Modos admitidos por el panel.
	marketModePolling = "polling"
	marketModeHybrid  = "hybrid"

	// Límites de validación. Los tokens y secretos se miden en bytes; la
	// etiqueta se mide en runas para no cortar caracteres multibyte.
	minMarketReaderTokenBytes  = 12
	maxMarketReaderTokenBytes  = 2048
	minMarketReaderLabelRunes  = 1
	maxMarketReaderLabelRunes  = 60
	minMarketReaderInterval    = 3
	maxMarketReaderInterval    = 3600
	minMarketWebhookSecretSize = 16
	maxMarketWebhookSecretSize = 512
	minMarketStreamAppIDSize   = 4
	maxMarketStreamAppIDSize   = 256
	minMarketStreamSecretSize  = 16
	maxMarketStreamSecretSize  = 512
	maxMarketReaderIDBytes     = 128

	// maxMarketSourceBodyBytes acota los cuerpos JSON de esta API.
	maxMarketSourceBodyBytes = 16 << 10
	// marketVaultIVBytes es el tamaño de nonce de AES-GCM usado por vault.
	marketVaultIVBytes = 12
)

// ErrReaderDuplicate señala que otro lector ya usa el mismo fingerprint. Los
// stores deben devolverlo al detectar la violación de unicidad.
var ErrReaderDuplicate = errors.New("edge: lector de mercado duplicado")

// errMarketSourceStore marca un store ausente o sin pool.
var errMarketSourceStore = errors.New("edge: market source store sin pool")

// errMarketSourceVault marca un vault no configurado. Nunca contiene secretos.
var errMarketSourceVault = errors.New("edge: vault no configurado")

// Reader es una fila de shadow.market_readers. Contiene material cifrado y el
// fingerprint del token: nunca se serializa directamente al cliente.
type Reader struct {
	ID                string
	Label             string
	EncryptedToken    string
	TokenFingerprint  string
	IntervalSeconds   int
	Enabled           bool
	CreatedAt         int64
	UpdatedAt         int64
	LastSuccessAt     *int64
	LastAttemptAt     *int64
	NextEligibleAt    int64
	ConsecutiveErrors int
	LastError         *string
}

// ReaderStore abstrae la persistencia de lectores y ajustes. Todas las
// implementaciones deben ser seguras para uso concurrente.
type ReaderStore interface {
	List(ctx context.Context) ([]Reader, error)
	Get(ctx context.Context, id string) (Reader, bool, error)
	Create(ctx context.Context, reader Reader) error
	Update(ctx context.Context, reader Reader) (bool, error)
	Delete(ctx context.Context, id string) (bool, error)
	GetSetting(ctx context.Context, key string) ([]byte, bool, error)
	PutSetting(ctx context.Context, key string, value []byte, now int64) error
}

// MarketReader es la proyección pública de un lector. Nunca incluye el token
// cifrado, su fingerprint ni la clave de cifrado.
type MarketReader struct {
	ID                string  `json:"id"`
	Label             string  `json:"label"`
	IntervalSeconds   int     `json:"intervalSeconds"`
	Enabled           bool    `json:"enabled"`
	Health            string  `json:"health"`
	LastSuccessAt     *int64  `json:"lastSuccessAt"`
	LastAttemptAt     *int64  `json:"lastAttemptAt"`
	NextEligibleAt    int64   `json:"nextEligibleAt"`
	ConsecutiveErrors int     `json:"consecutiveErrors"`
	LastError         *string `json:"lastError,omitempty"`
	TokenConfigured   bool    `json:"tokenConfigured"`
	CreatedAt         int64   `json:"createdAt"`
	UpdatedAt         int64   `json:"updatedAt"`
}

// MarketSourceSnapshot es el estado servido por GET /api/market-source y
// devuelto por las mutaciones para que el panel se actualice en una sola
// respuesta.
type MarketSourceSnapshot struct {
	Mode                       string         `json:"mode"`
	Accounts                   []MarketReader `json:"accounts"`
	Readers                    []MarketReader `json:"readers"`
	HealthyAccounts            int            `json:"healthyAccounts"`
	EffectiveCadenceSeconds    *int           `json:"effectiveCadenceSeconds"`
	EstimatedRequestsPerMinute float64        `json:"estimatedRequestsPerMinute"`
	WebhookConfigured          bool           `json:"webhookConfigured"`
	StreamConfigured           bool           `json:"streamConfigured"`

	// Alias que consume `web/features/settings.jsx`.
	WebhookSecretConfigured     bool   `json:"webhookSecretConfigured"`
	StreamCredentialsConfigured bool   `json:"streamCredentialsConfigured"`
	WebhookURL                  string `json:"webhookUrl"`
	StreamPhase                 string `json:"streamPhase"`
	LastStreamReceivedAt        int64  `json:"lastStreamReceivedAt"`
	LastWebhookReceivedAt       int64  `json:"lastWebhookReceivedAt"`
	PendingWebhookEvents        int64  `json:"pendingWebhookEvents"`
	FailedWebhookEvents         int64  `json:"failedWebhookEvents"`
	LastWebhookError            string `json:"lastWebhookError,omitempty"`
	LastStreamError             string `json:"lastStreamError,omitempty"`
	LastEventOutcome            string `json:"lastEventOutcome"`
	LastDeliveryLagMS           int64  `json:"lastDeliveryLagMs"`
	LastEventLatencyMS          int64  `json:"lastEventLatencyMs"`
	LastDecisionLatencyMS       int64  `json:"lastDecisionLatencyMs"`
	LastApplyQueueMS            int64  `json:"lastApplyQueueMs"`
	LastApplyBudgetWaitMS       int64  `json:"lastApplyBudgetWaitMs"`
	LastApplyResponseMS         int64  `json:"lastApplyResponseMs"`
}

// marketSourceResponse envuelve los datos en "data" como el resto del panel.
type marketSourceResponse struct {
	Data any `json:"data"`
}

// marketSourceRoute describe la ruta reconocida y los métodos admitidos.
type marketSourceRoute struct {
	kind    string
	id      string
	methods []string
}

func (route marketSourceRoute) allows(method string) bool {
	for _, allowed := range route.methods {
		if method == allowed {
			return true
		}
	}
	return false
}

// MarketSourceAPI expone la configuración editable de la fuente de mercado.
// Toda petición exige la cookie de sesión; las mutaciones exigen además el CSRF
// de la sesión y un Origin idéntico a TrustedOrigin.
//
// Rutas:
//
//	GET    /api/market-source                     estado actual
//	PUT    /api/market-source                     cambia polling|hybrid
//	PUT    /api/market-source/webhook-secret      guarda el secreto cifrado
//	PUT    /api/market-source/stream-credentials  guarda app-id y app-secret
//	POST   /api/market-readers                    crea un lector
//	PUT    /api/market-readers/:id                edita label/interval/enabled
//	PUT    /api/market-readers/:id/token          rota el token
//	DELETE /api/market-readers/:id                elimina un lector
//
// Cualquier otra ruta responde 404 y un método no admitido 405 con Allow. El
// handler no registra tokens, secretos ni material cifrado.
type MarketSourceAPI struct {
	Sessions      *SessionManager
	Store         ReaderStore
	Vault         *vault.Vault
	TrustedOrigin string
	Now           func() time.Time
}

func (api *MarketSourceAPI) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")

	route, ok := marketSourceRouteFor(r.URL.Path)
	if !ok {
		writeJSON(w, http.StatusNotFound, map[string]string{"status": "not_found"})
		return
	}
	if !route.allows(r.Method) {
		w.Header().Set("Allow", strings.Join(route.methods, ", "))
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"status": "method_not_allowed"})
		return
	}

	cookie, authenticated := api.authenticated(r)
	if !authenticated {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"status": "unauthenticated"})
		return
	}
	if r.Method != http.MethodGet {
		if !api.originAllowed(r) {
			writeJSON(w, http.StatusForbidden, map[string]string{"status": "forbidden"})
			return
		}
		csrf := requestCSRFToken(r)
		if csrf == "" || !api.Sessions.ValidateCSRF(cookie, csrf, api.now()) {
			writeJSON(w, http.StatusForbidden, map[string]string{"status": "forbidden"})
			return
		}
	}

	ctx, cancel := context.WithTimeout(r.Context(), statsTimeout)
	defer cancel()

	switch route.kind {
	case "status":
		if r.Method == http.MethodGet {
			api.writeSnapshot(w, ctx)
			return
		}
		api.putMode(w, r, ctx)
	case "webhook":
		api.putWebhookSecret(w, r, ctx)
	case "stream":
		api.putStreamCredentials(w, r, ctx)
	case "readers":
		api.createReader(w, r, ctx)
	case "reader":
		if r.Method == http.MethodPut {
			api.updateReader(w, r, ctx, route.id)
			return
		}
		api.deleteReader(w, ctx, route.id)
	case "reader-token":
		api.rotateReaderToken(w, r, ctx, route.id)
	}
}

// marketSourceRouteFor reconoce las rutas de la API. Los ids con separadores o
// demasiado largos se tratan como ruta inexistente.
func marketSourceRouteFor(path string) (marketSourceRoute, bool) {
	switch path {
	case marketSourceBasePath:
		return marketSourceRoute{
			kind:    "status",
			methods: []string{http.MethodGet, http.MethodPut},
		}, true
	case marketSourceWebhookSecretPath:
		return marketSourceRoute{kind: "webhook", methods: []string{http.MethodPut}}, true
	case marketSourceStreamCredentialsPath:
		return marketSourceRoute{kind: "stream", methods: []string{http.MethodPut}}, true
	case marketReadersBasePath:
		return marketSourceRoute{kind: "readers", methods: []string{http.MethodPost}}, true
	}

	prefix := marketReadersBasePath + "/"
	if !strings.HasPrefix(path, prefix) {
		return marketSourceRoute{}, false
	}
	rest := strings.TrimPrefix(path, prefix)
	if rest == "" {
		return marketSourceRoute{}, false
	}

	if strings.HasSuffix(rest, "/token") {
		id := strings.TrimSuffix(rest, "/token")
		if !validMarketReaderID(id) {
			return marketSourceRoute{}, false
		}
		return marketSourceRoute{
			kind:    "reader-token",
			id:      id,
			methods: []string{http.MethodPut},
		}, true
	}
	if !validMarketReaderID(rest) {
		return marketSourceRoute{}, false
	}
	return marketSourceRoute{
		kind:    "reader",
		id:      rest,
		methods: []string{http.MethodPut, http.MethodDelete},
	}, true
}

func validMarketReaderID(id string) bool {
	if id == "" || len(id) > maxMarketReaderIDBytes {
		return false
	}
	return !strings.ContainsRune(id, '/') && !strings.ContainsRune(id, 0)
}

// authenticated valida la cookie de sesión y devuelve su valor para el
// subsecuente ValidateCSRF. Un SessionManager nil produce 401.
func (api *MarketSourceAPI) authenticated(r *http.Request) (string, bool) {
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

// originAllowed exige igualdad textual con TrustedOrigin. Sin origen
// configurado no se acepta ninguna mutación.
func (api *MarketSourceAPI) originAllowed(r *http.Request) bool {
	if api.TrustedOrigin == "" {
		return false
	}
	return r.Header.Get("Origin") == api.TrustedOrigin
}

func (api *MarketSourceAPI) now() time.Time {
	if api.Now != nil {
		return api.Now()
	}
	return time.Now()
}

// writeSnapshot responde el estado completo o 503 si el store falla.
func (api *MarketSourceAPI) writeSnapshot(w http.ResponseWriter, ctx context.Context) {
	snapshot, err := api.snapshot(ctx)
	if err != nil {
		writeMarketSourceUnavailable(w)
		return
	}
	writeJSON(w, http.StatusOK, marketSourceResponse{Data: snapshot})
}

// snapshot construye el estado público. Los ajustes ausentes o vacíos cuentan
// como no configurados y el modo desconocido cae a hybrid.
func (api *MarketSourceAPI) snapshot(ctx context.Context) (MarketSourceSnapshot, error) {
	if api.Store == nil {
		return MarketSourceSnapshot{}, errMarketSourceStore
	}

	readers, err := api.Store.List(ctx)
	if err != nil {
		return MarketSourceSnapshot{}, err
	}

	mode := marketModeHybrid
	if raw, found, err := api.Store.GetSetting(ctx, marketSettingMode); err != nil {
		return MarketSourceSnapshot{}, err
	} else if found {
		if value := decodeMarketSettingString(raw); value == marketModePolling || value == marketModeHybrid {
			mode = value
		}
	}

	webhookConfigured, err := api.settingConfigured(ctx, marketSettingWebhookSecret)
	if err != nil {
		return MarketSourceSnapshot{}, err
	}
	streamAppIDConfigured, err := api.settingConfigured(ctx, marketSettingStreamAppID)
	if err != nil {
		return MarketSourceSnapshot{}, err
	}
	streamSecretConfigured, err := api.settingConfigured(ctx, marketSettingStreamAppSecret)
	if err != nil {
		return MarketSourceSnapshot{}, err
	}

	snapshot := MarketSourceSnapshot{
		Mode:                        mode,
		Accounts:                    make([]MarketReader, 0, len(readers)),
		Readers:                     make([]MarketReader, 0, len(readers)),
		WebhookConfigured:           webhookConfigured,
		StreamConfigured:            streamAppIDConfigured && streamSecretConfigured,
		WebhookSecretConfigured:     webhookConfigured,
		StreamCredentialsConfigured: streamAppIDConfigured && streamSecretConfigured,
		StreamPhase:                 "idle",
		LastEventOutcome:            "Sin eventos recientes",
	}
	if api.TrustedOrigin != "" {
		snapshot.WebhookURL = strings.TrimRight(api.TrustedOrigin, "/") + "/webhooks/qvapay/p2p-feed"
	}

	estimated := 0.0
	minimumInterval := 0
	for _, reader := range readers {
		snapshot.Accounts = append(snapshot.Accounts, publicMarketReader(reader))
		if !reader.Enabled {
			continue
		}
		if reader.ConsecutiveErrors == 0 {
			snapshot.HealthyAccounts++
		}
		if reader.IntervalSeconds <= 0 {
			// La tabla lo impide con un CHECK; se ignora por defensa.
			continue
		}
		estimated += 60 / float64(reader.IntervalSeconds)
		if minimumInterval == 0 || reader.IntervalSeconds < minimumInterval {
			minimumInterval = reader.IntervalSeconds
		}
	}
	snapshot.Readers = snapshot.Accounts
	snapshot.EstimatedRequestsPerMinute = math.Round(estimated*100) / 100
	if minimumInterval > 0 {
		snapshot.EffectiveCadenceSeconds = &minimumInterval
	}
	return snapshot, nil
}

// settingConfigured distingue presente de vacío: un ajuste con cadena vacía no
// cuenta como configurado.
func (api *MarketSourceAPI) settingConfigured(
	ctx context.Context,
	key string,
) (bool, error) {
	raw, found, err := api.Store.GetSetting(ctx, key)
	if err != nil {
		return false, err
	}
	if !found {
		return false, nil
	}
	return strings.TrimSpace(decodeMarketSettingString(raw)) != "", nil
}

// publicMarketReader elimina cualquier material sensible y calcula la salud.
func publicMarketReader(reader Reader) MarketReader {
	health := "healthy"
	switch {
	case reader.ConsecutiveErrors > 0:
		health = "warning"
	case reader.LastAttemptAt == nil:
		health = "idle"
	}
	return MarketReader{
		ID:                reader.ID,
		Label:             reader.Label,
		IntervalSeconds:   reader.IntervalSeconds,
		Enabled:           reader.Enabled,
		Health:            health,
		LastSuccessAt:     reader.LastSuccessAt,
		LastAttemptAt:     reader.LastAttemptAt,
		NextEligibleAt:    reader.NextEligibleAt,
		ConsecutiveErrors: reader.ConsecutiveErrors,
		LastError:         reader.LastError,
		TokenConfigured:   reader.EncryptedToken != "",
		CreatedAt:         reader.CreatedAt,
		UpdatedAt:         reader.UpdatedAt,
	}
}

// decodeMarketSettingString interpreta el texto jsonb como cadena. Un valor no
// JSON se usa tal cual para no romper ajustes escritos por otros procesos.
func decodeMarketSettingString(raw []byte) string {
	var value string
	if err := json.Unmarshal(raw, &value); err == nil {
		return value
	}
	return string(raw)
}

// encodeMarketSettingString serializa una cadena para la columna jsonb.
func encodeMarketSettingString(value string) ([]byte, error) {
	return json.Marshal(value)
}

func (api *MarketSourceAPI) putMode(
	w http.ResponseWriter,
	r *http.Request,
	ctx context.Context,
) {
	var request struct {
		Mode string `json:"mode"`
	}
	if !decodeMarketSourceBody(w, r, &request) {
		return
	}
	mode := strings.TrimSpace(request.Mode)
	if mode != marketModePolling && mode != marketModeHybrid {
		writeMarketSourceValidation(w, "mode")
		return
	}
	if !api.storeReady(w) {
		return
	}
	value, err := encodeMarketSettingString(mode)
	if err != nil {
		writeMarketSourceInternal(w)
		return
	}
	if err := api.Store.PutSetting(ctx, marketSettingMode, value, api.now().Unix()); err != nil {
		writeMarketSourceUnavailable(w)
		return
	}
	api.writeSnapshot(w, ctx)
}

func (api *MarketSourceAPI) putWebhookSecret(
	w http.ResponseWriter,
	r *http.Request,
	ctx context.Context,
) {
	var request struct {
		Secret string `json:"secret"`
	}
	if !decodeMarketSourceBody(w, r, &request) {
		return
	}
	if len(request.Secret) < minMarketWebhookSecretSize ||
		len(request.Secret) > maxMarketWebhookSecretSize {
		writeMarketSourceValidation(w, "secret")
		return
	}
	if !api.storeReady(w) {
		return
	}

	encrypted, err := api.seal(request.Secret)
	if err != nil {
		writeMarketSourceSealError(w, err)
		return
	}
	value, err := encodeMarketSettingString(encrypted)
	if err != nil {
		writeMarketSourceInternal(w)
		return
	}
	if err := api.Store.PutSetting(ctx, marketSettingWebhookSecret, value, api.now().Unix()); err != nil {
		writeMarketSourceUnavailable(w)
		return
	}
	api.writeSnapshot(w, ctx)
}

func (api *MarketSourceAPI) putStreamCredentials(
	w http.ResponseWriter,
	r *http.Request,
	ctx context.Context,
) {
	var request struct {
		AppID     string `json:"appId"`
		AppSecret string `json:"appSecret"`
	}
	if !decodeMarketSourceBody(w, r, &request) {
		return
	}
	appID := strings.TrimSpace(request.AppID)
	if len(appID) < minMarketStreamAppIDSize || len(appID) > maxMarketStreamAppIDSize {
		writeMarketSourceValidation(w, "appId")
		return
	}
	if len(request.AppSecret) < minMarketStreamSecretSize ||
		len(request.AppSecret) > maxMarketStreamSecretSize {
		writeMarketSourceValidation(w, "appSecret")
		return
	}
	if !api.storeReady(w) {
		return
	}

	encryptedAppID, err := api.seal(appID)
	if err != nil {
		writeMarketSourceSealError(w, err)
		return
	}
	encryptedAppSecret, err := api.seal(request.AppSecret)
	if err != nil {
		writeMarketSourceSealError(w, err)
		return
	}
	encodedAppID, err := encodeMarketSettingString(encryptedAppID)
	if err != nil {
		writeMarketSourceInternal(w)
		return
	}
	encodedAppSecret, err := encodeMarketSettingString(encryptedAppSecret)
	if err != nil {
		writeMarketSourceInternal(w)
		return
	}

	now := api.now().Unix()
	if err := api.Store.PutSetting(ctx, marketSettingStreamAppID, encodedAppID, now); err != nil {
		writeMarketSourceUnavailable(w)
		return
	}
	if err := api.Store.PutSetting(ctx, marketSettingStreamAppSecret, encodedAppSecret, now); err != nil {
		writeMarketSourceUnavailable(w)
		return
	}
	api.writeSnapshot(w, ctx)
}

func (api *MarketSourceAPI) createReader(
	w http.ResponseWriter,
	r *http.Request,
	ctx context.Context,
) {
	var request struct {
		Label           string `json:"label"`
		Token           string `json:"token"`
		IntervalSeconds int    `json:"intervalSeconds"`
	}
	if !decodeMarketSourceBody(w, r, &request) {
		return
	}
	label, valid := normalizeMarketReaderLabel(request.Label)
	if !valid {
		writeMarketSourceValidation(w, "label")
		return
	}
	token := strings.TrimSpace(request.Token)
	if len(token) < minMarketReaderTokenBytes || len(token) > maxMarketReaderTokenBytes {
		writeMarketSourceValidation(w, "token")
		return
	}
	if request.IntervalSeconds < minMarketReaderInterval ||
		request.IntervalSeconds > maxMarketReaderInterval {
		writeMarketSourceValidation(w, "intervalSeconds")
		return
	}
	if !api.storeReady(w) {
		return
	}

	fingerprint := marketTokenFingerprint(token)
	inUse, err := api.fingerprintInUse(ctx, "", fingerprint)
	if err != nil {
		writeMarketSourceUnavailable(w)
		return
	}
	if inUse {
		writeMarketSourceDuplicate(w)
		return
	}

	encrypted, err := api.seal(token)
	if err != nil {
		writeMarketSourceSealError(w, err)
		return
	}
	id, err := newMarketReaderID()
	if err != nil {
		writeMarketSourceInternal(w)
		return
	}

	now := api.now().Unix()
	reader := Reader{
		ID:               id,
		Label:            label,
		EncryptedToken:   encrypted,
		TokenFingerprint: fingerprint,
		IntervalSeconds:  request.IntervalSeconds,
		Enabled:          true,
		CreatedAt:        now,
		UpdatedAt:        now,
	}
	if err := api.Store.Create(ctx, reader); err != nil {
		if errors.Is(err, ErrReaderDuplicate) {
			writeMarketSourceDuplicate(w)
			return
		}
		writeMarketSourceUnavailable(w)
		return
	}
	writeJSON(w, http.StatusCreated, marketSourceResponse{Data: publicMarketReader(reader)})
}

func (api *MarketSourceAPI) updateReader(
	w http.ResponseWriter,
	r *http.Request,
	ctx context.Context,
	id string,
) {
	var request struct {
		Label           *string `json:"label"`
		IntervalSeconds *int    `json:"intervalSeconds"`
		Enabled         *bool   `json:"enabled"`
	}
	if !decodeMarketSourceBody(w, r, &request) {
		return
	}
	if request.Label != nil {
		if _, valid := normalizeMarketReaderLabel(*request.Label); !valid {
			writeMarketSourceValidation(w, "label")
			return
		}
	}
	if request.IntervalSeconds != nil &&
		(*request.IntervalSeconds < minMarketReaderInterval ||
			*request.IntervalSeconds > maxMarketReaderInterval) {
		writeMarketSourceValidation(w, "intervalSeconds")
		return
	}
	if !api.storeReady(w) {
		return
	}

	reader, found, err := api.Store.Get(ctx, id)
	if err != nil {
		writeMarketSourceUnavailable(w)
		return
	}
	if !found {
		writeMarketSourceNotFound(w)
		return
	}
	if request.Label != nil {
		reader.Label, _ = normalizeMarketReaderLabel(*request.Label)
	}
	if request.IntervalSeconds != nil {
		reader.IntervalSeconds = *request.IntervalSeconds
	}
	if request.Enabled != nil {
		reader.Enabled = *request.Enabled
	}
	reader.UpdatedAt = api.now().Unix()

	updated, err := api.Store.Update(ctx, reader)
	if err != nil {
		if errors.Is(err, ErrReaderDuplicate) {
			writeMarketSourceDuplicate(w)
			return
		}
		writeMarketSourceUnavailable(w)
		return
	}
	if !updated {
		writeMarketSourceNotFound(w)
		return
	}
	writeJSON(w, http.StatusOK, marketSourceResponse{Data: publicMarketReader(reader)})
}

func (api *MarketSourceAPI) rotateReaderToken(
	w http.ResponseWriter,
	r *http.Request,
	ctx context.Context,
	id string,
) {
	var request struct {
		Token string `json:"token"`
	}
	if !decodeMarketSourceBody(w, r, &request) {
		return
	}
	token := strings.TrimSpace(request.Token)
	if len(token) < minMarketReaderTokenBytes || len(token) > maxMarketReaderTokenBytes {
		writeMarketSourceValidation(w, "token")
		return
	}
	if !api.storeReady(w) {
		return
	}

	reader, found, err := api.Store.Get(ctx, id)
	if err != nil {
		writeMarketSourceUnavailable(w)
		return
	}
	if !found {
		writeMarketSourceNotFound(w)
		return
	}

	fingerprint := marketTokenFingerprint(token)
	inUse, err := api.fingerprintInUse(ctx, reader.ID, fingerprint)
	if err != nil {
		writeMarketSourceUnavailable(w)
		return
	}
	if inUse {
		writeMarketSourceDuplicate(w)
		return
	}

	encrypted, err := api.seal(token)
	if err != nil {
		writeMarketSourceSealError(w, err)
		return
	}
	reader.EncryptedToken = encrypted
	reader.TokenFingerprint = fingerprint
	reader.UpdatedAt = api.now().Unix()

	updated, err := api.Store.Update(ctx, reader)
	if err != nil {
		if errors.Is(err, ErrReaderDuplicate) {
			writeMarketSourceDuplicate(w)
			return
		}
		writeMarketSourceUnavailable(w)
		return
	}
	if !updated {
		writeMarketSourceNotFound(w)
		return
	}
	writeJSON(w, http.StatusOK, marketSourceResponse{Data: publicMarketReader(reader)})
}

func (api *MarketSourceAPI) deleteReader(
	w http.ResponseWriter,
	ctx context.Context,
	id string,
) {
	if !api.storeReady(w) {
		return
	}
	deleted, err := api.Store.Delete(ctx, id)
	if err != nil {
		writeMarketSourceUnavailable(w)
		return
	}
	if !deleted {
		writeMarketSourceNotFound(w)
		return
	}
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.WriteHeader(http.StatusNoContent)
}

// seal cifra un valor con un IV aleatorio de AES-GCM. El error nunca incluye el
// texto plano.
func (api *MarketSourceAPI) seal(plaintext string) (string, error) {
	if api.Vault == nil {
		return "", errMarketSourceVault
	}
	iv := make([]byte, marketVaultIVBytes)
	if _, err := rand.Read(iv); err != nil {
		return "", fmt.Errorf("edge: generar iv: %w", err)
	}
	encrypted, err := api.Vault.Encrypt(plaintext, iv)
	if err != nil {
		return "", fmt.Errorf("edge: cifrar secreto: %w", err)
	}
	return encrypted, nil
}

func (api *MarketSourceAPI) storeReady(w http.ResponseWriter) bool {
	if api.Store == nil {
		writeMarketSourceUnavailable(w)
		return false
	}
	return true
}

// decodeMarketSourceBody exige exactamente un objeto JSON dentro del límite.
func decodeMarketSourceBody(w http.ResponseWriter, r *http.Request, destination any) bool {
	body := http.MaxBytesReader(w, r.Body, maxMarketSourceBodyBytes)
	defer body.Close()

	decoder := json.NewDecoder(body)
	if err := decoder.Decode(destination); err != nil {
		writeMarketSourceBodyError(w, err)
		return false
	}
	var extra json.RawMessage
	if err := decoder.Decode(&extra); !errors.Is(err, io.EOF) {
		if err == nil {
			err = errors.New("edge: cuerpo JSON con datos extra")
		}
		writeMarketSourceBodyError(w, err)
		return false
	}
	return true
}

func writeMarketSourceBodyError(w http.ResponseWriter, err error) {
	var maxErr *http.MaxBytesError
	if errors.As(err, &maxErr) {
		writeJSON(w, http.StatusRequestEntityTooLarge, map[string]string{"status": "payload_too_large"})
		return
	}
	writeJSON(w, http.StatusBadRequest, map[string]string{"status": "invalid_body"})
}

// normalizeMarketReaderLabel recorta espacios y valida el rango en runas.
func normalizeMarketReaderLabel(raw string) (string, bool) {
	label := strings.TrimSpace(raw)
	count := utf8.RuneCountInString(label)
	return label, count >= minMarketReaderLabelRunes && count <= maxMarketReaderLabelRunes
}

// marketTokenFingerprint es sha256(token) en hex, el identificador de
// unicidad guardado en token_fingerprint.
func marketTokenFingerprint(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}

// fingerprintInUse comprueba la unicidad en la API además de la restricción de
// la tabla, para que cualquier ReaderStore respete el 409. exceptID permite
// rotar el token del mismo lector.
func (api *MarketSourceAPI) fingerprintInUse(
	ctx context.Context,
	exceptID string,
	fingerprint string,
) (bool, error) {
	readers, err := api.Store.List(ctx)
	if err != nil {
		return false, err
	}
	for _, reader := range readers {
		if reader.ID != exceptID && reader.TokenFingerprint == fingerprint {
			return true, nil
		}
	}
	return false, nil
}

// newMarketReaderID genera un UUID v4 con crypto/rand.
func newMarketReaderID() (string, error) {
	var raw [16]byte
	if _, err := rand.Read(raw[:]); err != nil {
		return "", fmt.Errorf("edge: generar id de lector: %w", err)
	}
	raw[6] = (raw[6] & 0x0f) | 0x40
	raw[8] = (raw[8] & 0x3f) | 0x80
	return fmt.Sprintf(
		"%x-%x-%x-%x-%x",
		raw[0:4], raw[4:6], raw[6:8], raw[8:10], raw[10:16],
	), nil
}

func writeMarketSourceValidation(w http.ResponseWriter, field string) {
	writeJSON(w, http.StatusBadRequest, map[string]string{
		"status": "validation_failed",
		"field":  field,
	})
}

func writeMarketSourceDuplicate(w http.ResponseWriter) {
	writeJSON(w, http.StatusConflict, map[string]string{"status": "duplicate"})
}

func writeMarketSourceNotFound(w http.ResponseWriter) {
	writeJSON(w, http.StatusNotFound, map[string]string{"status": "not_found"})
}

func writeMarketSourceUnavailable(w http.ResponseWriter) {
	writeJSON(w, http.StatusServiceUnavailable, map[string]string{"status": "unavailable"})
}

func writeMarketSourceInternal(w http.ResponseWriter) {
	writeJSON(w, http.StatusInternalServerError, map[string]string{"status": "internal_error"})
}

func writeMarketSourceSealError(w http.ResponseWriter, err error) {
	if errors.Is(err, errMarketSourceVault) {
		writeMarketSourceUnavailable(w)
		return
	}
	writeMarketSourceInternal(w)
}

// PostgresReaderStore persiste lectores y ajustes en el esquema shadow. Todas
// las sentencias están parametrizadas. Update solo escribe los campos
// editables: la salud y los contadores son responsabilidad del poller.
type PostgresReaderStore struct {
	Pool *pgxpool.Pool
}

var _ ReaderStore = (*PostgresReaderStore)(nil)

const marketReaderColumns = `id, label, encrypted_token, token_fingerprint,
	interval_seconds, enabled, created_at, updated_at, last_success_at,
	last_attempt_at, next_eligible_at, consecutive_errors, last_error`

// marketReaderScanner cubre tanto pgx.Row como pgx.Rows.
type marketReaderScanner interface {
	Scan(dest ...any) error
}

func scanMarketReader(scanner marketReaderScanner) (Reader, error) {
	var reader Reader
	err := scanner.Scan(
		&reader.ID,
		&reader.Label,
		&reader.EncryptedToken,
		&reader.TokenFingerprint,
		&reader.IntervalSeconds,
		&reader.Enabled,
		&reader.CreatedAt,
		&reader.UpdatedAt,
		&reader.LastSuccessAt,
		&reader.LastAttemptAt,
		&reader.NextEligibleAt,
		&reader.ConsecutiveErrors,
		&reader.LastError,
	)
	return reader, err
}

func (store *PostgresReaderStore) pool() (*pgxpool.Pool, error) {
	if store == nil || store.Pool == nil {
		return nil, errMarketSourceStore
	}
	return store.Pool, nil
}

func (store *PostgresReaderStore) List(ctx context.Context) ([]Reader, error) {
	pool, err := store.pool()
	if err != nil {
		return nil, err
	}
	rows, err := pool.Query(ctx, `SELECT `+marketReaderColumns+`
		FROM shadow.market_readers
		ORDER BY created_at ASC, id ASC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	readers := make([]Reader, 0, 8)
	for rows.Next() {
		reader, err := scanMarketReader(rows)
		if err != nil {
			return nil, err
		}
		readers = append(readers, reader)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return readers, nil
}

func (store *PostgresReaderStore) Get(
	ctx context.Context,
	id string,
) (Reader, bool, error) {
	pool, err := store.pool()
	if err != nil {
		return Reader{}, false, err
	}
	reader, err := scanMarketReader(pool.QueryRow(ctx, `SELECT `+marketReaderColumns+`
		FROM shadow.market_readers
		WHERE id = $1`, id))
	if errors.Is(err, pgx.ErrNoRows) {
		return Reader{}, false, nil
	}
	if err != nil {
		return Reader{}, false, err
	}
	return reader, true, nil
}

func (store *PostgresReaderStore) Create(ctx context.Context, reader Reader) error {
	pool, err := store.pool()
	if err != nil {
		return err
	}
	_, err = pool.Exec(ctx, `INSERT INTO shadow.market_readers (
			id, label, encrypted_token, token_fingerprint, interval_seconds,
			enabled, created_at, updated_at, last_success_at, last_attempt_at,
			next_eligible_at, consecutive_errors, last_error
		) VALUES (
			$1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13
		)`,
		reader.ID,
		reader.Label,
		reader.EncryptedToken,
		reader.TokenFingerprint,
		reader.IntervalSeconds,
		reader.Enabled,
		reader.CreatedAt,
		reader.UpdatedAt,
		reader.LastSuccessAt,
		reader.LastAttemptAt,
		reader.NextEligibleAt,
		reader.ConsecutiveErrors,
		reader.LastError,
	)
	if isMarketReaderDuplicateError(err) {
		return ErrReaderDuplicate
	}
	return err
}

func (store *PostgresReaderStore) Update(
	ctx context.Context,
	reader Reader,
) (bool, error) {
	pool, err := store.pool()
	if err != nil {
		return false, err
	}
	tag, err := pool.Exec(ctx, `UPDATE shadow.market_readers SET
			label = $2,
			encrypted_token = $3,
			token_fingerprint = $4,
			interval_seconds = $5,
			enabled = $6,
			updated_at = $7
		WHERE id = $1`,
		reader.ID,
		reader.Label,
		reader.EncryptedToken,
		reader.TokenFingerprint,
		reader.IntervalSeconds,
		reader.Enabled,
		reader.UpdatedAt,
	)
	if isMarketReaderDuplicateError(err) {
		return false, ErrReaderDuplicate
	}
	if err != nil {
		return false, err
	}
	return tag.RowsAffected() > 0, nil
}

func (store *PostgresReaderStore) Delete(
	ctx context.Context,
	id string,
) (bool, error) {
	pool, err := store.pool()
	if err != nil {
		return false, err
	}
	tag, err := pool.Exec(ctx,
		`DELETE FROM shadow.market_readers WHERE id = $1`, id)
	if err != nil {
		return false, err
	}
	return tag.RowsAffected() > 0, nil
}

func (store *PostgresReaderStore) GetSetting(
	ctx context.Context,
	key string,
) ([]byte, bool, error) {
	pool, err := store.pool()
	if err != nil {
		return nil, false, err
	}
	var raw string
	err = pool.QueryRow(ctx,
		`SELECT value::text FROM shadow.runtime_settings WHERE key = $1`,
		key,
	).Scan(&raw)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, err
	}
	return []byte(raw), true, nil
}

func (store *PostgresReaderStore) PutSetting(
	ctx context.Context,
	key string,
	value []byte,
	now int64,
) error {
	pool, err := store.pool()
	if err != nil {
		return err
	}
	if !json.Valid(value) {
		return errors.New("edge: el ajuste debe ser JSON válido")
	}
	_, err = pool.Exec(ctx, `INSERT INTO shadow.runtime_settings (key, value, updated_at)
		VALUES ($1, $2::jsonb, $3)
		ON CONFLICT (key) DO UPDATE SET
			value = EXCLUDED.value,
			updated_at = EXCLUDED.updated_at`,
		key, string(value), now)
	return err
}

// isMarketReaderDuplicateError reconoce la violación de unicidad de Postgres.
func isMarketReaderDuplicateError(err error) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && pgErr.Code == "23505"
}
