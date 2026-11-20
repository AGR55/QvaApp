// Configuración runtime del hunter: puente entre el contrato del panel
// (runtimeconfig.Config) y el evaluador puro (hunter.Config), ajustes de
// control guardados en shadow.runtime_settings y rotación de lectores QvaPay.
// Nunca registra tokens ni secretos.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"math"
	"strconv"
	"strings"
	"time"

	"github.com/AGR55/QvaApp/services/shared/decimal"
	"github.com/AGR55/QvaApp/services/trading-core/internal/hunter"
	"github.com/AGR55/QvaApp/services/trading-core/internal/platform/qvapay"
	"github.com/AGR55/QvaApp/services/trading-core/internal/runtimeconfig"
)

const (
	settingMarketSourceMode     = "market_source.mode"
	settingControlPaused        = "control.paused"
	settingControlEmergencyStop = "control.emergency_stop"

	defaultMarketSourceMode = "hybrid"
	marketSourceModePolling = "polling"

	// minPollIntervalMS evita ráfagas contra QvaPay aunque el panel pida un
	// ciclo más corto.
	minPollIntervalMS = 3000
	// runtimeReloadInterval es cada cuánto se relee la configuración y los
	// ajustes de control.
	runtimeReloadInterval = 5 * time.Second
	runtimeReloadTimeout  = 5 * time.Second
	// readerCacheTTL limita las consultas a shadow.market_readers desde el
	// bucle de poll y el feed SSE.
	readerCacheTTL = 30 * time.Second
	// readerLimit acota cuántas cuentas lectoras se rotan a la vez.
	readerLimit = 50
)

// hunterConfigFromRuntime traduce la configuración del panel al contrato del
// evaluador. Los float64 se convierten a decimal exacto desde su representación
// canónica, sin aritmética intermedia.
func hunterConfigFromRuntime(config runtimeconfig.Config) hunter.Config {
	markets := make(map[string]hunter.Market, len(config.Markets))
	for _, market := range config.Markets {
		code := strings.TrimSpace(market.Code)
		if code == "" {
			continue
		}
		markets[code] = hunter.Market{
			Active:          market.Active,
			BuyMaxRate:      runtimeDecimal(market.BuyMaxRate),
			SellMinRate:     runtimeDecimal(market.SellMinRate),
			PurchaseMaxQusd: runtimeDecimal(market.PurchaseMaxQusd),
			OutgoingFee:     runtimeDecimal(market.OutgoingTransferFee),
			HuntBuy:         config.Hunting.BuyRunning && market.HuntBuyEnabled,
			HuntSell:        config.Hunting.SellRunning && market.HuntSellEnabled,
		}
	}
	return hunter.Config{
		PriceGuardPercent: runtimeDecimal(config.Automation.PriceGuardPercent),
		Markets:           markets,
	}
}

// runtimeDecimal convierte un valor numérico ya validado del panel en un
// decimal exacto. Un valor no representable queda en cero.
func runtimeDecimal(value float64) decimal.Value {
	if math.IsNaN(value) || math.IsInf(value, 0) {
		return decimal.Zero()
	}
	parsed, err := decimal.Parse(strconv.FormatFloat(value, 'f', -1, 64))
	if err != nil {
		return decimal.Zero()
	}
	return parsed
}

// runtimePollIntervalMS calcula el ciclo de poll en milisegundos. Solo el modo
// "polling" usa scanIntervalSeconds; "hybrid" mantiene el intervalo de la
// variable de entorno (normalmente 0 = solo SSE).
func runtimePollIntervalMS(config runtimeconfig.Config, mode string, fallbackMS int) int {
	if normalizeMarketSourceMode(mode) != marketSourceModePolling {
		return fallbackMS
	}
	seconds := config.Automation.ScanIntervalSeconds
	if math.IsNaN(seconds) || math.IsInf(seconds, 0) {
		return minPollIntervalMS
	}
	if seconds > runtimeconfig.MaxScanIntervalSeconds {
		seconds = runtimeconfig.MaxScanIntervalSeconds
	}
	interval := int(math.Round(seconds * 1000))
	if interval < minPollIntervalMS {
		return minPollIntervalMS
	}
	return interval
}

// normalizeMarketSourceMode acepta solo los modos del panel; cualquier otro
// valor cae en híbrido.
func normalizeMarketSourceMode(mode string) string {
	switch strings.ToLower(strings.TrimSpace(mode)) {
	case marketSourceModePolling:
		return marketSourceModePolling
	case defaultMarketSourceMode:
		return defaultMarketSourceMode
	default:
		return defaultMarketSourceMode
	}
}

// loadRuntimeSettings lee los ajustes operativos de shadow.runtime_settings.
// Las claves ausentes usan los valores por defecto: modo híbrido y sin pausa.
func loadRuntimeSettings(
	ctx context.Context,
	repository *runtimeconfig.Repository,
) (string, bool, bool, error) {
	if repository == nil || repository.Pool == nil {
		return defaultMarketSourceMode, false, false,
			errors.New("runtimeconfig: repositorio sin pool")
	}
	rows, err := repository.Pool.Query(ctx, `
		SELECT key, value::text
		FROM shadow.runtime_settings
		WHERE key = ANY($1)`,
		[]string{
			settingMarketSourceMode,
			settingControlPaused,
			settingControlEmergencyStop,
		},
	)
	if err != nil {
		return defaultMarketSourceMode, false, false, err
	}
	defer rows.Close()

	values := make(map[string][]byte, 3)
	for rows.Next() {
		var key, raw string
		if err := rows.Scan(&key, &raw); err != nil {
			return defaultMarketSourceMode, false, false, err
		}
		values[key] = []byte(raw)
	}
	if err := rows.Err(); err != nil {
		return defaultMarketSourceMode, false, false, err
	}
	mode, paused, emergency := normalizeRuntimeSettings(values)
	return mode, paused, emergency, nil
}

// normalizeRuntimeSettings es la parte pura de loadRuntimeSettings: recibe los
// valores JSON ya leídos y aplica defaults. Se separa para poder probarla sin
// base de datos.
func normalizeRuntimeSettings(values map[string][]byte) (string, bool, bool) {
	mode := defaultMarketSourceMode
	if raw, ok := values[settingMarketSourceMode]; ok {
		if text, ok := decodeSettingString(raw); ok {
			mode = normalizeMarketSourceMode(text)
		}
	}
	paused := settingBool(values[settingControlPaused], false)
	emergency := settingBool(values[settingControlEmergencyStop], false)
	return mode, paused, emergency
}

// decodeSettingString acepta un string JSON (formato normal de jsonb) y, por
// tolerancia, texto plano.
func decodeSettingString(raw []byte) (string, bool) {
	var value string
	if err := json.Unmarshal(raw, &value); err == nil {
		return strings.TrimSpace(value), true
	}
	text := strings.TrimSpace(string(raw))
	if text == "" || strings.HasPrefix(text, "{") || strings.HasPrefix(text, "[") {
		return "", false
	}
	return text, true
}

// settingBool interpreta el JSON booleano que escribe el panel y tolera
// "true"/"false" y 1/0 como texto.
func settingBool(raw []byte, fallback bool) bool {
	if len(raw) == 0 {
		return fallback
	}
	var flag bool
	if err := json.Unmarshal(raw, &flag); err == nil {
		return flag
	}
	var text string
	if err := json.Unmarshal(raw, &text); err == nil {
		return parseBoolText(text, fallback)
	}
	var number float64
	if err := json.Unmarshal(raw, &number); err == nil {
		return number != 0
	}
	return parseBoolText(string(raw), fallback)
}

func parseBoolText(text string, fallback bool) bool {
	switch strings.ToLower(strings.TrimSpace(text)) {
	case "true", "1", "yes", "on":
		return true
	case "false", "0", "no", "off":
		return false
	default:
		return fallback
	}
}

// reloadRuntimeConfig aplica la configuración persistida y los ajustes de
// control. Si la configuración no existe o falla, conserva la vigente y solo
// intenta refrescar pausa e intervalo.
func (service *service) reloadRuntimeConfig(ctx context.Context) {
	if service.runtime != nil {
		config, version, err := service.runtime.Load(ctx)
		switch {
		case errors.Is(err, runtimeconfig.ErrNotFound):
			service.logger.Debug("configuración runtime ausente; se conserva la vigente")
		case err != nil:
			service.logger.Warn(
				"no se pudo leer la configuración runtime; se conserva la vigente",
				"error", err,
			)
		default:
			if err := runtimeconfig.Validate(config); err != nil {
				service.logger.Warn(
					"configuración runtime inválida; se conserva la vigente",
					"version", version, "error", err,
				)
				break
			}
			mapped := hunterConfigFromRuntime(config)
			service.configMu.Lock()
			service.config = mapped
			service.configVersion.Store(version)
			service.runtimeConfig = config
			service.runtimeLoaded = true
			service.configMu.Unlock()
			service.logger.Debug(
				"configuración runtime aplicada",
				"version", version, "markets", len(mapped.Markets),
			)
		}
	}

	runtimeConfig, _ := service.runtimeSnapshot()
	mode, paused, emergency, err := loadRuntimeSettings(ctx, service.runtime)
	if err != nil {
		service.logger.Warn(
			"ajustes runtime no disponibles; se conservan los vigentes",
			"error", err,
		)
		return
	}
	stopped := paused || emergency
	interval := runtimePollIntervalMS(runtimeConfig, mode, service.cfg.PollMS)
	service.paused.Store(stopped)
	service.pollInterval.Store(int64(interval))
	if stopped || interval > 0 {
		service.logger.Debug(
			"ajustes runtime aplicados",
			"mode", mode, "paused", stopped, "poll_ms", interval,
		)
	}
}

// runtimeSnapshot devuelve la última configuración runtime válida y si existe.
func (service *service) runtimeSnapshot() (runtimeconfig.Config, bool) {
	service.configMu.RLock()
	defer service.configMu.RUnlock()
	return service.runtimeConfig, service.runtimeLoaded
}

// runtimeLoop refresca la configuración y los ajustes de control cada 5 s.
func (service *service) runtimeLoop(ctx context.Context) {
	ticker := time.NewTicker(runtimeReloadInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			reloadCtx, cancel := context.WithTimeout(ctx, runtimeReloadTimeout)
			service.reloadRuntimeConfig(reloadCtx)
			cancel()
		}
	}
}

// readerClients devuelve los clientes de las cuentas lectoras habilitadas. La
// lista se cachea 30 s y nunca incluye el token primario: el llamador lo usa
// como fallback. Un fallo de base de datos conserva la caché anterior.
func (service *service) readerClients(ctx context.Context) []*qvapay.Client {
	if service == nil || service.pool == nil || service.vault == nil {
		return nil
	}
	service.readersMu.Lock()
	defer service.readersMu.Unlock()
	if !service.readersAt.IsZero() && time.Since(service.readersAt) < readerCacheTTL {
		return service.readerCache
	}
	clients, err := service.loadReaderClients(ctx)
	if err != nil {
		service.logger.Warn(
			"no se pudieron cargar los lectores QvaPay; se conserva la caché",
			"error", err,
		)
		return service.readerCache
	}
	service.readerCache = clients
	service.readersAt = time.Now()
	return service.readerCache
}

// loadReaderClients descifra los tokens de shadow.market_readers y construye
// clientes de lectura. Las filas inválidas se ignoran sin exponer el token.
func (service *service) loadReaderClients(ctx context.Context) ([]*qvapay.Client, error) {
	rows, err := service.pool.Query(ctx, `
		SELECT encrypted_token
		FROM shadow.market_readers
		WHERE enabled = true AND interval_seconds > 0
		ORDER BY created_at ASC
		LIMIT $1`,
		readerLimit,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	baseURL := strings.TrimSpace(service.baseURL)
	if baseURL == "" {
		baseURL = service.cfg.BaseURL
	}
	clients := make([]*qvapay.Client, 0, 4)
	invalid := 0
	for rows.Next() {
		var encrypted string
		if err := rows.Scan(&encrypted); err != nil {
			return nil, err
		}
		token, err := service.vault.Decrypt(encrypted)
		if err != nil || strings.TrimSpace(token) == "" {
			invalid++
			continue
		}
		client, err := qvapay.New(baseURL, token)
		if err != nil {
			invalid++
			continue
		}
		clients = append(clients, client)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if invalid > 0 {
		service.logger.Warn(
			"lectores QvaPay inválidos ignorados",
			"count", invalid,
		)
	}
	return clients, nil
}

// selectReaderClient elige un cliente por posición. Es pura para poder probar
// la rotación sin red.
func selectReaderClient(
	clients []*qvapay.Client,
	position uint64,
) *qvapay.Client {
	if len(clients) == 0 {
		return nil
	}
	return clients[position%uint64(len(clients))]
}
