package edge

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"math"
	"net/http"
	"strings"
	"sync"
	"time"
)

// CooperativeSync mantiene la conexión HTTP con el sincronizador de cacerías
// conjuntas. El HTTP basta para conectar, publicar y retirar; NATS queda como
// estado informativo y no es necesario para operar.
type CooperativeSync struct {
	mu sync.RWMutex

	baseURL  string
	natsURL  string
	email    string
	password string
	enabled  bool

	http    *http.Client
	logger  *slog.Logger
	token   string
	tokenAt time.Time
	lastAt  int64

	snapshot      map[string]any
	contributions map[string]any
	connected     bool
	lastError     string

	// Fiat y Baselines permiten ajustar la capacidad publicada cuando cambia
	// el saldo local por un pago o una liberación.
	Fiat      MarketConfigLoader
	Baselines SettingStore

	capacityMu sync.Mutex
	// loginMu serializa los inicios de sesión: el sincronizador rechaza dos
	// logins simultáneos al arrancar el edge.
	loginMu sync.Mutex
	// refreshOverride solo se usa en pruebas para evitar HTTP.
	refreshOverride func(context.Context) error
}

const (
	cooperativeMinQusd        = 5.0
	cooperativeCapacityEps    = 0.001
	cooperativeBaselinePrefix = "cooperative_capacity_baseline:"
)

func NewCooperativeSync(
	baseURL, natsURL, email, password string,
	enabled bool,
	logger *slog.Logger,
) *CooperativeSync {
	return &CooperativeSync{
		baseURL: strings.TrimRight(strings.TrimSpace(baseURL), "/"),
		natsURL: strings.TrimSpace(natsURL), email: strings.TrimSpace(email),
		password: password, enabled: enabled, logger: logger,
		http:          &http.Client{Timeout: 10 * time.Second},
		snapshot:      map[string]any{},
		contributions: map[string]any{},
	}
}

func (sync *CooperativeSync) Enabled() bool {
	if sync == nil {
		return false
	}
	sync.mu.RLock()
	defer sync.mu.RUnlock()
	return sync.enabled && sync.baseURL != "" && sync.email != ""
}

func (sync *CooperativeSync) Run(ctx context.Context) {
	if !sync.Enabled() {
		return
	}
	ticker := time.NewTicker(10 * time.Second)
	defer ticker.Stop()
	for {
		sync.Refresh(ctx)
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

func (sync *CooperativeSync) State() map[string]any {
	if sync == nil {
		return map[string]any{
			"enabled": false, "httpConnected": false, "natsConnected": false,
			"snapshot": map[string]any{}, "contributions": map[string]any{},
			"lastHttpAt": nil, "lastNatsAt": nil, "lastError": "",
		}
	}
	sync.mu.RLock()
	defer sync.mu.RUnlock()
	return map[string]any{
		"enabled":       sync.enabled,
		"httpConnected": sync.connected,
		"natsConnected": false,
		"snapshot":      sync.snapshot,
		"contributions": sync.contributions,
		"lastHttpAt":    nullableInt(sync.lastAt),
		"lastNatsAt":    nil,
		"lastError":     sync.lastError,
	}
}

func (sync *CooperativeSync) Refresh(ctx context.Context) error {
	if !sync.Enabled() {
		sync.setError("sincronizador deshabilitado")
		return fmt.Errorf("sincronizador deshabilitado")
	}
	var snapshot struct {
		Data map[string]any `json:"data"`
	}
	if err := sync.request(ctx, http.MethodGet, "/hunts/sync", nil, &snapshot); err != nil {
		sync.setError(err.Error())
		return err
	}
	var contributions struct {
		Data []any `json:"data"`
	}
	if err := sync.request(ctx, http.MethodGet, "/hunts?me=true&active=true&page_size=100", nil, &contributions); err != nil {
		sync.setError(err.Error())
		return err
	}
	sync.mu.Lock()
	sync.snapshot = cooperativeSnapshot(snapshot.Data)
	sync.contributions = cooperativeContributions(contributions.Data)
	sync.connected = true
	sync.lastAt = time.Now().UnixMilli()
	sync.lastError = ""
	sync.mu.Unlock()
	return nil
}

func (sync *CooperativeSync) Publish(
	ctx context.Context,
	coin string,
	fiat, minimal, price float64,
) error {
	if !sync.Enabled() {
		return fmt.Errorf("sincronizador deshabilitado")
	}
	if fiat <= 0 || minimal <= 0 || price <= 0 {
		return fmt.Errorf("aportación inválida")
	}
	if fiat < 5*price {
		return fmt.Errorf("el saldo equivale a menos de 5 QUSD al precio indicado")
	}
	sync.mu.RLock()
	current, _ := sync.contributions[strings.ToUpper(coin)].(map[string]any)
	revision, _ := current["revision"].(string)
	sync.mu.RUnlock()
	body := map[string]any{
		"coin": strings.ToUpper(coin), "fiat": math.Floor(fiat*100) / 100,
		"minimal": minimal, "price": price,
	}
	if revision != "" {
		body["expected_updated_at"] = revision
	}
	if err := sync.request(ctx, http.MethodPost, "/hunts", body, nil); err != nil {
		sync.setError(err.Error())
		return err
	}
	if err := sync.refresh(ctx); err != nil {
		return err
	}
	sync.acknowledgeBaseline(ctx, strings.ToUpper(coin))
	return nil
}

func (sync *CooperativeSync) Withdraw(ctx context.Context, coin string) error {
	if !sync.Enabled() {
		return fmt.Errorf("sincronizador deshabilitado")
	}
	if err := sync.request(ctx, http.MethodDelete, "/hunts/"+strings.ToUpper(coin), nil, nil); err != nil {
		sync.setError(err.Error())
		return err
	}
	return sync.refresh(ctx)
}

func (sync *CooperativeSync) refresh(ctx context.Context) error {
	if sync.refreshOverride != nil {
		return sync.refreshOverride(ctx)
	}
	return sync.Refresh(ctx)
}

// RunCapacity mantiene sincronizada la capacidad cooperativa con el saldo
// fiat local de cada mercado.
func (sync *CooperativeSync) RunCapacity(ctx context.Context) {
	if !sync.Enabled() {
		return
	}
	ticker := time.NewTicker(5 * time.Second)
	defer ticker.Stop()
	for {
		if err := sync.SyncCapacity(ctx); err != nil && ctx.Err() == nil && sync.logger != nil {
			sync.logger.Warn("sincronización de capacidad cooperativa falló", "error", err)
		}
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

// SyncCapacity aplica solo el cambio local de fiat a la capacidad remota. No
// reemplaza el total con el saldo local: el sincronizador puede haber gastado
// parte de la capacidad en una cacería conjunta.
func (sync *CooperativeSync) SyncCapacity(ctx context.Context) error {
	if sync == nil || !sync.Enabled() || sync.Fiat == nil || sync.Baselines == nil {
		return nil
	}
	sync.capacityMu.Lock()
	defer sync.capacityMu.Unlock()
	if err := sync.refresh(ctx); err != nil {
		return err
	}
	sync.mu.RLock()
	contributions := make(map[string]map[string]any, len(sync.contributions))
	for coin, raw := range sync.contributions {
		if item, ok := raw.(map[string]any); ok {
			contributions[coin] = item
		}
	}
	sync.mu.RUnlock()
	for coin, current := range contributions {
		local, err := sync.localFiat(ctx, coin)
		if err != nil {
			if sync.logger != nil {
				sync.logger.Warn("capacidad cooperativa: fiat local no disponible", "coin", coin, "error", err)
			}
			continue
		}
		previous, found, err := sync.baseline(ctx, coin)
		if err != nil {
			if sync.logger != nil {
				sync.logger.Warn("capacidad cooperativa: baseline no disponible", "coin", coin, "error", err)
			}
			continue
		}
		if !found {
			// Primera observación: fija la base sin alterar la capacidad remota.
			_ = sync.setBaseline(ctx, coin, local)
			continue
		}
		remote := numberValue(current["fiat"])
		price := numberValue(current["price"])
		minimal := numberValue(current["minimal"])
		if price <= 0 {
			continue
		}
		delta := local - previous
		available := local
		if remote+delta < available {
			available = remote + delta
		}
		if available < 0 {
			available = 0
		}
		available = math.Floor(available*100) / 100
		switch {
		case available < cooperativeMinQusd*price:
			if err := sync.Withdraw(ctx, coin); err != nil {
				if sync.logger != nil {
					sync.logger.Warn("capacidad cooperativa: retirar falló", "coin", coin, "error", err)
				}
				continue
			}
			if sync.logger != nil {
				sync.logger.Info("capacidad cooperativa retirada", "coin", coin, "fiat", available)
			}
		case math.Abs(available-remote) > cooperativeCapacityEps:
			if err := sync.Publish(ctx, coin, available, minimal, price); err != nil {
				if sync.logger != nil {
					sync.logger.Warn("capacidad cooperativa: publicar ajuste falló", "coin", coin, "error", err)
				}
				continue
			}
			if sync.logger != nil {
				sync.logger.Info("capacidad cooperativa ajustada", "coin", coin, "fiat", available, "anterior", remote)
			}
		}
		if err := sync.setBaseline(ctx, coin, local); err != nil && sync.logger != nil {
			sync.logger.Warn("capacidad cooperativa: baseline no persistido", "coin", coin, "error", err)
		}
	}
	return nil
}

// EnsureBaseline fija el saldo local previo a un cambio de fiat. Así el ajuste
// posterior conoce el delta exacto aunque el bucle de capacidad aún no haya
// pasado por ese mercado.
func (sync *CooperativeSync) EnsureBaseline(ctx context.Context, coin string) error {
	if sync == nil || sync.Fiat == nil || sync.Baselines == nil {
		return nil
	}
	coin = strings.ToUpper(strings.TrimSpace(coin))
	if coin == "" {
		return nil
	}
	if _, found, err := sync.baseline(ctx, coin); err != nil || found {
		return err
	}
	local, err := sync.localFiat(ctx, coin)
	if err != nil {
		return err
	}
	return sync.setBaseline(ctx, coin, local)
}

func (sync *CooperativeSync) localFiat(ctx context.Context, coin string) (float64, error) {
	config, _, err := sync.Fiat.Load(ctx)
	if err != nil {
		return 0, err
	}
	for _, market := range config.Markets {
		if market.Code == coin {
			return market.FiatBalance, nil
		}
	}
	return 0, fmt.Errorf("mercado %s no configurado", coin)
}

func (sync *CooperativeSync) baseline(ctx context.Context, coin string) (float64, bool, error) {
	raw, found, err := sync.Baselines.GetSetting(ctx, cooperativeBaselinePrefix+coin)
	if err != nil || !found {
		return 0, found, err
	}
	var value float64
	if err := json.Unmarshal(raw, &value); err != nil {
		return 0, false, err
	}
	return value, true, nil
}

func (sync *CooperativeSync) setBaseline(ctx context.Context, coin string, value float64) error {
	encoded, err := json.Marshal(value)
	if err != nil {
		return err
	}
	return sync.Baselines.PutSetting(ctx, cooperativeBaselinePrefix+coin, encoded, sync.now().UnixMilli())
}

func (sync *CooperativeSync) acknowledgeBaseline(ctx context.Context, coin string) {
	if sync.Fiat == nil || sync.Baselines == nil {
		return
	}
	local, err := sync.localFiat(ctx, coin)
	if err == nil {
		_ = sync.setBaseline(ctx, coin, local)
	}
}

func (sync *CooperativeSync) now() time.Time {
	return time.Now()
}

func (sync *CooperativeSync) request(
	ctx context.Context,
	method, path string,
	body any,
	out any,
) error {
	for attempt := 0; attempt < 2; attempt++ {
		token, err := sync.ensureToken(ctx)
		if err != nil {
			return err
		}
		var reader io.Reader
		if body != nil {
			encoded, err := json.Marshal(body)
			if err != nil {
				return err
			}
			reader = bytes.NewReader(encoded)
		}
		request, err := http.NewRequestWithContext(ctx, method, sync.baseURL+path, reader)
		if err != nil {
			return err
		}
		request.Header.Set("Accept", "application/json")
		if body != nil {
			request.Header.Set("Content-Type", "application/json")
		}
		if token != "" {
			request.Header.Set("Authorization", "Bearer "+token)
		}
		response, err := sync.http.Do(request)
		if err != nil {
			return fmt.Errorf("conectar con sincronizador: %w", err)
		}
		raw, _ := io.ReadAll(io.LimitReader(response.Body, 1<<20))
		response.Body.Close()
		if response.StatusCode == http.StatusUnauthorized && attempt == 0 {
			sync.mu.Lock()
			sync.token = ""
			sync.mu.Unlock()
			continue
		}
		if response.StatusCode < 200 || response.StatusCode >= 300 {
			message := strings.TrimSpace(string(raw))
			if len(message) > 200 {
				message = message[:200]
			}
			return fmt.Errorf("sincronizador respondió %d: %s", response.StatusCode, message)
		}
		if out != nil && len(raw) > 0 {
			if err := json.Unmarshal(raw, out); err != nil {
				return fmt.Errorf("respuesta inválida del sincronizador")
			}
		}
		return nil
	}
	return fmt.Errorf("sincronizador no autorizado")
}

func (sync *CooperativeSync) ensureToken(ctx context.Context) (string, error) {
	sync.mu.RLock()
	token := sync.token
	issued := sync.tokenAt
	sync.mu.RUnlock()
	if token != "" && time.Since(issued) < 4*24*time.Hour {
		return token, nil
	}
	sync.loginMu.Lock()
	defer sync.loginMu.Unlock()
	// Otro goroutine pudo iniciar sesión mientras se esperaba el turno.
	sync.mu.RLock()
	token = sync.token
	issued = sync.tokenAt
	sync.mu.RUnlock()
	if token != "" && time.Since(issued) < 4*24*time.Hour {
		return token, nil
	}
	payload, _ := json.Marshal(map[string]string{
		"email": sync.email, "password": sync.password,
	})
	request, err := http.NewRequestWithContext(ctx, http.MethodPost,
		sync.baseURL+"/auth/login", bytes.NewReader(payload))
	if err != nil {
		return "", err
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Accept", "application/json")
	response, err := sync.http.Do(request)
	if err != nil {
		return "", fmt.Errorf("login del sincronizador: %w", err)
	}
	raw, _ := io.ReadAll(io.LimitReader(response.Body, 1<<20))
	response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return "", fmt.Errorf("login del sincronizador: %d", response.StatusCode)
	}
	var body struct {
		APIKey string `json:"api_key"`
	}
	if err := json.Unmarshal(raw, &body); err != nil || !strings.HasPrefix(body.APIKey, "csk_") {
		return "", fmt.Errorf("el sincronizador no devolvió una API key válida")
	}
	sync.mu.Lock()
	sync.token = body.APIKey
	sync.tokenAt = time.Now()
	sync.mu.Unlock()
	return body.APIKey, nil
}

func (sync *CooperativeSync) setError(message string) {
	sync.mu.Lock()
	sync.connected = false
	sync.lastError = message
	sync.mu.Unlock()
	if sync.logger != nil {
		sync.logger.Warn("sincronizador cooperativo", "error", message)
	}
}

func cooperativeSnapshot(data map[string]any) map[string]any {
	out := make(map[string]any, len(data))
	for coin, raw := range data {
		item, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		out[strings.ToUpper(coin)] = map[string]any{
			"coin": strings.ToUpper(coin), "fiat": numberValue(item["fiat"]),
			"price": numberValue(item["price"]), "minimal": numberValue(item["minimal"]),
			"offersCount": int(numberValue(item["offers_count"])),
			"capacities":  item["capacities"],
		}
	}
	return out
}

func cooperativeContributions(data []any) map[string]any {
	out := map[string]any{}
	for _, raw := range data {
		item, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		coin := strings.ToUpper(stringValue(item["coin"]))
		if coin == "" {
			continue
		}
		updated := int64(numberValue(item["updated_at"]))
		if text, ok := item["updated_at"].(string); ok {
			if parsed, err := time.Parse(time.RFC3339, text); err == nil {
				updated = parsed.UnixMilli()
			}
		}
		out[coin] = map[string]any{
			"coin": coin, "fiat": numberValue(item["fiat"]),
			"minimal": numberValue(item["minimal"]), "price": numberValue(item["price"]),
			"state": "confirmed", "updatedAt": updated,
			"revision": stringValue(item["updated_at"]),
		}
	}
	return out
}

func numberValue(value any) float64 {
	switch typed := value.(type) {
	case float64:
		return typed
	case json.Number:
		parsed, _ := typed.Float64()
		return parsed
	case string:
		var parsed float64
		_, _ = fmt.Sscanf(typed, "%f", &parsed)
		return parsed
	}
	return 0
}

func stringValue(value any) string {
	if text, ok := value.(string); ok {
		return text
	}
	return ""
}

func nullableInt(value int64) any {
	if value == 0 {
		return nil
	}
	return value
}
