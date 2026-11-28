package edge

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/AGR55/QvaApp/services/trading-core/internal/runtimeconfig"
)

const (
	configAdminPath           = "/api/config"
	configAdminRevisionsPath  = "/api/config-revisions"
	configAdminHuntingPath    = "/api/hunting"
	configAdminStrategyPath   = "/api/strategy"
	configAdminControlPath    = "/api/control"
	configAdminMaxBodyBytes   = 2 << 20
	configAdminMaxReasonRunes = 500
)

// AdminConfigStore es la persistencia de configuración usada por el panel.
type AdminConfigStore interface {
	Load(ctx context.Context) (runtimeconfig.Config, int64, error)
	Save(ctx context.Context, config runtimeconfig.Config, reason, actor string, now time.Time) (int64, error)
	Revisions(ctx context.Context, limit int) ([]runtimeconfig.Revision, error)
}

// SettingStore guarda ajustes de control y fuente de mercado.
type SettingStore interface {
	GetSetting(ctx context.Context, key string) ([]byte, bool, error)
	PutSetting(ctx context.Context, key string, value []byte, now int64) error
}

// ConfigAdminAPI expone la configuración completa y sus mutaciones desde la web.
// Las lecturas exigen cookie de sesión; las escrituras exigen además CSRF y un
// Origin idéntico a TrustedOrigin.
type ConfigAdminAPI struct {
	Sessions      *SessionManager
	Config        AdminConfigStore
	Settings      SettingStore
	TrustedOrigin string
	Now           func() time.Time
}

type configAdminEnvelope struct {
	Data any `json:"data"`
}

type configAdminRevision struct {
	ID           int64                `json:"id"`
	CreatedAt    int64                `json:"createdAt"`
	Source       string               `json:"source"`
	Reason       *string              `json:"reason"`
	Config       runtimeconfig.Config `json:"config"`
	PreviousHash *string              `json:"previousHash"`
	Hash         string               `json:"hash"`
}

type configAdminHuntingRequest struct {
	BuyRunning  *bool                     `json:"buyRunning"`
	SellRunning *bool                     `json:"sellRunning"`
	Market      *configAdminHuntingMarket `json:"market"`
}

type configAdminHuntingMarket struct {
	Code            string   `json:"code"`
	HuntBuyEnabled  *bool    `json:"huntBuyEnabled"`
	HuntSellEnabled *bool    `json:"huntSellEnabled"`
	BuyMaxRate      *float64 `json:"buyMaxRate"`
	SellMinRate     *float64 `json:"sellMinRate"`
}

type configAdminStrategyRequest struct {
	BuyMaxCup  *float64 `json:"buyMaxCup"`
	BuyMaxUsd  *float64 `json:"buyMaxUsd"`
	SellMinCup *float64 `json:"sellMinCup"`
	SellMinUsd *float64 `json:"sellMinUsd"`
	Reserve    *float64 `json:"reserve"`
	CupLimit   *float64 `json:"cupLimit"`
}

type configAdminControlRequest struct {
	Paused        *bool `json:"paused"`
	Refresh       *bool `json:"refresh"`
	EmergencyStop *bool `json:"emergencyStop"`
}

func (api *ConfigAdminAPI) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")

	switch r.URL.Path {
	case configAdminPath, configAdminRevisionsPath, configAdminHuntingPath,
		configAdminStrategyPath, configAdminControlPath:
	default:
		writeJSON(w, http.StatusNotFound, map[string]string{"status": "not_found"})
		return
	}

	cookie, authenticated := api.authenticated(r)
	if !authenticated {
		writeJSON(w, http.StatusUnauthorized, map[string]any{"error": "Autenticación requerida."})
		return
	}
	if r.Method != http.MethodGet && !api.mutationAllowed(w, r, cookie) {
		return
	}

	if r.Method == http.MethodGet {
		switch r.URL.Path {
		case configAdminPath:
			api.readConfig(w, r)
		case configAdminRevisionsPath:
			api.readRevisions(w, r)
		default:
			w.Header().Set("Allow", http.MethodPut)
			writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"status": "method_not_allowed"})
		}
		return
	}
	if r.Method != http.MethodPut {
		w.Header().Set("Allow", "GET, PUT")
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"status": "method_not_allowed"})
		return
	}

	switch r.URL.Path {
	case configAdminPath:
		api.saveConfig(w, r)
	case configAdminHuntingPath:
		api.saveHunting(w, r)
	case configAdminStrategyPath:
		api.saveStrategy(w, r)
	case configAdminControlPath:
		api.saveControl(w, r)
	default:
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"status": "method_not_allowed"})
	}
}

func (api *ConfigAdminAPI) authenticated(r *http.Request) (string, bool) {
	if api.Sessions == nil {
		return "", false
	}
	cookie, err := r.Cookie(CookieName)
	if err != nil || cookie.Value == "" {
		return "", false
	}
	_, err = api.Sessions.Verify(cookie.Value, api.now())
	return cookie.Value, err == nil
}

func (api *ConfigAdminAPI) mutationAllowed(w http.ResponseWriter, r *http.Request, cookie string) bool {
	if !edgeOriginAllowed(r, api.TrustedOrigin) {
		writeJSON(w, http.StatusForbidden, map[string]any{"error": "Origen de solicitud no autorizado."})
		return false
	}
	csrf := requestCSRFToken(r)
	if csrf == "" || api.Sessions == nil || !api.Sessions.ValidateCSRF(cookie, csrf, api.now()) {
		writeJSON(w, http.StatusForbidden, map[string]any{"error": "CSRF inválido."})
		return false
	}
	return true
}

func (api *ConfigAdminAPI) readConfig(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()
	config, _, err := api.Config.Load(ctx)
	if errors.Is(err, runtimeconfig.ErrNotFound) {
		writeJSON(w, http.StatusServiceUnavailable, map[string]any{"error": "La configuración aún no está inicializada."})
		return
	}
	if err != nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]any{"error": "No se pudo leer la configuración."})
		return
	}
	writeJSON(w, http.StatusOK, configAdminEnvelope{Data: config})
}

func (api *ConfigAdminAPI) readRevisions(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()
	limit := 20
	if raw := r.URL.Query().Get("limit"); raw != "" {
		if parsed, err := strconv.Atoi(raw); err == nil && parsed > 0 && parsed <= 100 {
			limit = parsed
		}
	}
	revisions, err := api.Config.Revisions(ctx, limit)
	if err != nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]any{"error": "No se pudo leer el historial."})
		return
	}
	data := make([]configAdminRevision, 0, len(revisions))
	for _, revision := range revisions {
		raw, err := json.Marshal(revision.Config)
		if err != nil {
			continue
		}
		sum := sha256.Sum256(raw)
		reason := revision.Reason
		data = append(data, configAdminRevision{
			ID: revision.Version, CreatedAt: revision.CreatedAt,
			Source: revision.Actor, Reason: &reason, Config: revision.Config,
			Hash: hex.EncodeToString(sum[:]),
		})
	}
	writeJSON(w, http.StatusOK, configAdminEnvelope{Data: data})
}

func (api *ConfigAdminAPI) saveConfig(w http.ResponseWriter, r *http.Request) {
	var payload json.RawMessage
	if !decodeConfigBody(w, r, &payload) {
		return
	}
	var wrapper struct {
		Config json.RawMessage `json:"config"`
		Reason string          `json:"reason"`
	}
	configRaw := payload
	reason := "Configuración actualizada desde el panel"
	if err := json.Unmarshal(payload, &wrapper); err == nil && len(wrapper.Config) > 0 {
		configRaw = wrapper.Config
		if strings.TrimSpace(wrapper.Reason) != "" {
			reason = wrapper.Reason
		}
	}
	var config runtimeconfig.Config
	if err := json.Unmarshal(configRaw, &config); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "Configuración inválida."})
		return
	}
	now := api.now()
	config = runtimeconfig.Normalize(config, now)
	reviewedAt := now.UnixMilli()
	config.Risk.ReviewedAt = &reviewedAt
	api.persistConfig(w, r, config, reason)
}

func (api *ConfigAdminAPI) saveHunting(w http.ResponseWriter, r *http.Request) {
	var body configAdminHuntingRequest
	if !decodeConfigBody(w, r, &body) {
		return
	}
	if body.BuyRunning == nil && body.SellRunning == nil && body.Market == nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "No hay cambios de cacería."})
		return
	}
	config, _, ok := api.loadForWrite(w, r)
	if !ok {
		return
	}
	if body.BuyRunning != nil {
		config.Hunting.BuyRunning = *body.BuyRunning
	}
	if body.SellRunning != nil {
		config.Hunting.SellRunning = *body.SellRunning
	}
	if body.Market != nil {
		market := body.Market
		found := false
		for index := range config.Markets {
			if config.Markets[index].Code != market.Code {
				continue
			}
			found = true
			if market.HuntBuyEnabled != nil {
				config.Markets[index].HuntBuyEnabled = *market.HuntBuyEnabled
			}
			if market.HuntSellEnabled != nil {
				config.Markets[index].HuntSellEnabled = *market.HuntSellEnabled
			}
			if market.BuyMaxRate != nil {
				config.Markets[index].BuyMaxRate = *market.BuyMaxRate
			}
			if market.SellMinRate != nil {
				config.Markets[index].SellMinRate = *market.SellMinRate
			}
		}
		if !found {
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": "Mercado no configurado."})
			return
		}
	}
	api.persistConfig(w, r, config, "Cacería actualizada desde el panel")
}

func (api *ConfigAdminAPI) saveStrategy(w http.ResponseWriter, r *http.Request) {
	var body configAdminStrategyRequest
	if !decodeConfigBody(w, r, &body) {
		return
	}
	for _, value := range []*float64{body.BuyMaxCup, body.BuyMaxUsd, body.SellMinCup, body.SellMinUsd, body.Reserve, body.CupLimit} {
		if value != nil && *value < 0 {
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": "Los límites deben ser números positivos."})
			return
		}
	}
	config, _, ok := api.loadForWrite(w, r)
	if !ok {
		return
	}
	for index := range config.Markets {
		market := &config.Markets[index]
		switch market.Code {
		case "BANK_CUP":
			if body.BuyMaxCup != nil {
				market.BuyMaxRate = *body.BuyMaxCup
			}
			if body.SellMinCup != nil {
				market.SellMinRate = *body.SellMinCup
			}
			if body.CupLimit != nil {
				market.PurchaseMaxQusd = *body.CupLimit
			}
		case "BANDECPREPAGO":
			if body.BuyMaxUsd != nil {
				market.BuyMaxRate = *body.BuyMaxUsd
			}
			if body.SellMinUsd != nil {
				market.SellMinRate = *body.SellMinUsd
			}
		}
	}
	if body.Reserve != nil {
		config.QusdReserve = *body.Reserve
		config.Risk.MinQusdReserve = *body.Reserve
	}
	api.persistConfig(w, r, config, "Estrategia actualizada desde el panel")
}

func (api *ConfigAdminAPI) saveControl(w http.ResponseWriter, r *http.Request) {
	var body configAdminControlRequest
	if !decodeConfigBody(w, r, &body) {
		return
	}
	supplied := 0
	for _, value := range []*bool{body.Paused, body.Refresh, body.EmergencyStop} {
		if value != nil {
			supplied++
		}
	}
	if supplied == 0 || (body.EmergencyStop != nil && supplied > 1) {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "Acción de control inválida."})
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()
	now := api.now().UnixMilli()
	settings := map[string]*bool{
		"control.paused": body.Paused, "control.refresh": body.Refresh,
		"control.emergency_stop": body.EmergencyStop,
	}
	for key, value := range settings {
		if value == nil {
			continue
		}
		raw, _ := json.Marshal(*value)
		if err := api.Settings.PutSetting(ctx, key, raw, now); err != nil {
			writeJSON(w, http.StatusServiceUnavailable, map[string]any{"error": "No se pudo aplicar el control."})
			return
		}
	}
	w.WriteHeader(http.StatusNoContent)
}

func (api *ConfigAdminAPI) loadForWrite(w http.ResponseWriter, r *http.Request) (runtimeconfig.Config, int64, bool) {
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()
	config, version, err := api.Config.Load(ctx)
	if err != nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]any{"error": "No se pudo leer la configuración."})
		return runtimeconfig.Config{}, 0, false
	}
	_ = version
	return config, version, true
}

func (api *ConfigAdminAPI) persistConfig(w http.ResponseWriter, r *http.Request, config runtimeconfig.Config, reason string) {
	now := api.now()
	config = runtimeconfig.Normalize(config, now)
	reviewedAt := now.UnixMilli()
	config.Risk.ReviewedAt = &reviewedAt
	if err := runtimeconfig.Validate(config); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": strings.TrimPrefix(err.Error(), runtimeconfig.ErrInvalidConfig.Error()+": ")})
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()
	if strings.TrimSpace(reason) == "" {
		reason = "Configuración actualizada desde el panel"
	}
	if _, err := api.Config.Save(ctx, config, reason, "panel", now); err != nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]any{"error": "No se pudo guardar la configuración."})
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (api *ConfigAdminAPI) now() time.Time {
	if api.Now != nil {
		return api.Now()
	}
	return time.Now()
}

func decodeConfigBody(w http.ResponseWriter, r *http.Request, target any) bool {
	body := http.MaxBytesReader(w, r.Body, configAdminMaxBodyBytes)
	raw, err := io.ReadAll(body)
	if err != nil {
		writeJSON(w, http.StatusRequestEntityTooLarge, map[string]any{"error": "Cuerpo demasiado grande."})
		return false
	}
	if len(strings.TrimSpace(string(raw))) == 0 {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "Cuerpo vacío."})
		return false
	}
	if err := json.Unmarshal(raw, target); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "JSON inválido."})
		return false
	}
	return true
}

// edgeOriginAllowed acepta el origen configurado o una petición same-origin.
// La segunda comprobación permite servir el panel por otro puerto/host sin
// relajar la protección CSRF: el navegador solo envía Origin en peticiones
// cross-origin y el Host debe coincidir con el de la propia petición.
func edgeOriginAllowed(r *http.Request, trusted string) bool {
	origin := r.Header.Get("Origin")
	if origin == "" {
		return false
	}
	if trusted != "" && origin == trusted {
		return true
	}
	parsed, err := url.Parse(origin)
	if err != nil || parsed.Host == "" {
		return false
	}
	return strings.EqualFold(parsed.Host, r.Host)
}
