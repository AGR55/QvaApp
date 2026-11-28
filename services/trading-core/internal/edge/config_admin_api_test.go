package edge

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/AGR55/QvaApp/services/trading-core/internal/runtimeconfig"
)

type fakeAdminConfigStore struct {
	config    runtimeconfig.Config
	version   int64
	revisions []runtimeconfig.Revision
	saves     int
}

func (store *fakeAdminConfigStore) Load(context.Context) (runtimeconfig.Config, int64, error) {
	if store.version == 0 {
		return runtimeconfig.Config{}, 0, runtimeconfig.ErrNotFound
	}
	return store.config, store.version, nil
}

func (store *fakeAdminConfigStore) Save(_ context.Context, config runtimeconfig.Config, reason, actor string, now time.Time) (int64, error) {
	store.saves++
	store.config = config
	store.version++
	store.revisions = append([]runtimeconfig.Revision{{
		Version: store.version, Config: config, Reason: reason,
		Actor: actor, CreatedAt: now.UnixMilli(),
	}}, store.revisions...)
	return store.version, nil
}

func (store *fakeAdminConfigStore) Revisions(context.Context, int) ([]runtimeconfig.Revision, error) {
	return store.revisions, nil
}

type fakeSettings map[string][]byte

func (settings fakeSettings) GetSetting(_ context.Context, key string) ([]byte, bool, error) {
	value, ok := settings[key]
	return value, ok, nil
}

func (settings fakeSettings) PutSetting(_ context.Context, key string, value []byte, _ int64) error {
	settings[key] = value
	return nil
}

func testRuntimeConfig() runtimeconfig.Config {
	return runtimeconfig.Config{
		Version:       3,
		MaxOpenOffers: 10,
		Hunting:       runtimeconfig.Hunting{BuyRunning: true, SellRunning: true},
		Automation: runtimeconfig.Automation{
			ScanIntervalSeconds: 3, AutoCancelMinutes: 60,
			OfferRefreshIntervalMinutes: 4, OfferRefreshSpacingSeconds: 10,
			PriceGuardPercent: 25, WelcomeMessage: "hola",
		},
		Risk: runtimeconfig.Risk{
			MaxQusdPerOperation: 2000, MaxConcurrentQusdExposure: 10000,
			MaxDailyAppliedQusd: 10000, MaxConcurrentOperations: 6,
			MaxQuoteAgeSeconds: 90, MinExpectedMarginPercent: 0.5,
			MaxSlippagePercent: 25, MaxConsecutiveErrors: 3,
			MarketCooldownSeconds: 30, CounterpartyCooldownSeconds: 300,
		},
		Markets: []runtimeconfig.Market{
			{Code: "BANK_CUP", Label: "CUP", Currency: "CUP", Active: true, FiatBalance: 100, BuyMaxRate: 1100, SellMinRate: 1180, PurchaseMaxQusd: 200},
			{Code: "BANDECPREPAGO", Label: "Tropical", Currency: "USD", Active: true, FiatBalance: 100, BuyMaxRate: 1.07, SellMinRate: 1.12, PurchaseMaxQusd: 100},
		},
	}
}

func newConfigAdminTestAPI(t *testing.T) (*ConfigAdminAPI, *fakeAdminConfigStore, fakeSettings, *http.Cookie, string) {
	t.Helper()
	now := time.UnixMilli(1_700_000_000_000)
	manager := newSessionTestManager(t, time.Hour)
	token, csrf, err := manager.Issue(now)
	if err != nil {
		t.Fatalf("Issue: %v", err)
	}
	store := &fakeAdminConfigStore{config: testRuntimeConfig(), version: 1}
	settings := fakeSettings{}
	api := &ConfigAdminAPI{
		Sessions: manager, Config: store, Settings: settings,
		TrustedOrigin: "https://panel.example", Now: func() time.Time { return now },
	}
	return api, store, settings, &http.Cookie{Name: CookieName, Value: token}, csrf
}

func configAdminDo(api *ConfigAdminAPI, method, target, body string, cookie *http.Cookie, csrf, origin string) *httptest.ResponseRecorder {
	request := httptest.NewRequest(method, target, strings.NewReader(body))
	if cookie != nil {
		request.AddCookie(cookie)
	}
	if csrf != "" {
		request.Header.Set("X-CSRF-Token", csrf)
	}
	if origin != "" {
		request.Header.Set("Origin", origin)
	}
	recorder := httptest.NewRecorder()
	api.ServeHTTP(recorder, request)
	return recorder
}

func TestConfigAdminAPIReadAndAuth(t *testing.T) {
	api, _, _, cookie, _ := newConfigAdminTestAPI(t)
	recorder := configAdminDo(api, http.MethodGet, configAdminPath, "", cookie, "", "")
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d (cuerpo %q)", recorder.Code, recorder.Body.String())
	}
	if got := recorder.Header().Get("Cache-Control"); got != "no-store" {
		t.Fatalf("Cache-Control = %q", got)
	}
	var payload struct {
		Data runtimeconfig.Config `json:"data"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &payload); err != nil {
		t.Fatalf("config: %v", err)
	}
	if payload.Data.Version != 3 || len(payload.Data.Markets) != 2 {
		t.Fatalf("config = %+v", payload.Data)
	}

	anonymous := configAdminDo(api, http.MethodGet, configAdminPath, "", nil, "", "")
	if anonymous.Code != http.StatusUnauthorized {
		t.Fatalf("sin sesión: %d", anonymous.Code)
	}
	other := configAdminDo(api, http.MethodGet, "/api/otra", "", cookie, "", "")
	if other.Code != http.StatusNotFound {
		t.Fatalf("ruta desconocida: %d", other.Code)
	}
}

func TestConfigAdminAPISaveConfigRequiresCSRFAndOrigin(t *testing.T) {
	api, store, _, cookie, csrf := newConfigAdminTestAPI(t)
	body := `{"config":{"version":3,"qusdReserve":0,"maxOpenOffers":5,"hunting":{"buyRunning":true,"sellRunning":false},"automation":{"scanIntervalSeconds":5,"autoCancelMinutes":60,"offerRefreshIntervalMinutes":4,"offerRefreshSpacingSeconds":10,"priceGuardPercent":20,"welcomeMessage":"hola"},"risk":{"maxQusdPerOperation":100,"maxConcurrentQusdExposure":100,"maxDailyAppliedQusd":100,"maxConcurrentOperations":2,"minQusdReserve":0,"maxQuoteAgeSeconds":30,"minExpectedMarginPercent":0,"maxSlippagePercent":10,"maxConsecutiveErrors":3,"marketCooldownSeconds":10,"counterpartyCooldownSeconds":10,"reviewedAt":null},"markets":[]},"reason":"cambio"}`
	if got := configAdminDo(api, http.MethodPut, configAdminPath, body, cookie, "", "https://panel.example"); got.Code != http.StatusForbidden {
		t.Fatalf("sin CSRF: %d", got.Code)
	}
	if got := configAdminDo(api, http.MethodPut, configAdminPath, body, cookie, csrf, "https://evil.example"); got.Code != http.StatusForbidden {
		t.Fatalf("origen inválido: %d", got.Code)
	}
	recorder := configAdminDo(api, http.MethodPut, configAdminPath, body, cookie, csrf, "https://panel.example")
	if recorder.Code != http.StatusNoContent {
		t.Fatalf("status = %d (cuerpo %q)", recorder.Code, recorder.Body.String())
	}
	if store.saves != 1 || store.version != 2 {
		t.Fatalf("saves=%d version=%d", store.saves, store.version)
	}
	if store.config.Risk.ReviewedAt == nil || *store.config.Risk.ReviewedAt != 1_700_000_000_000 {
		t.Fatalf("reviewedAt = %v", store.config.Risk.ReviewedAt)
	}
	if store.config.MaxOpenOffers != 5 || store.config.Hunting.SellRunning {
		t.Fatalf("config guardada = %+v", store.config)
	}
}

func TestConfigAdminAPIHuntingAndStrategy(t *testing.T) {
	api, store, _, cookie, csrf := newConfigAdminTestAPI(t)
	hunting := `{"buyRunning":false,"sellRunning":true,"market":{"code":"BANK_CUP","huntSellEnabled":false,"buyMaxRate":1234}}`
	recorder := configAdminDo(api, http.MethodPut, configAdminHuntingPath, hunting, cookie, csrf, "https://panel.example")
	if recorder.Code != http.StatusNoContent {
		t.Fatalf("hunting: %d (cuerpo %q)", recorder.Code, recorder.Body.String())
	}
	if store.config.Hunting.BuyRunning || !store.config.Hunting.SellRunning {
		t.Fatalf("hunting = %+v", store.config.Hunting)
	}
	market := configAdminMarket(store.config, "BANK_CUP")
	if market == nil || market.BuyMaxRate != 1234 || market.HuntSellEnabled {
		t.Fatalf("mercado = %+v", store.config.Markets)
	}

	unknown := `{"market":{"code":"NOPE","huntSellEnabled":false}}`
	if got := configAdminDo(api, http.MethodPut, configAdminHuntingPath, unknown, cookie, csrf, "https://panel.example"); got.Code != http.StatusBadRequest {
		t.Fatalf("mercado desconocido: %d", got.Code)
	}

	strategy := `{"buyMaxCup":1200,"sellMinCup":1300,"reserve":50}`
	if got := configAdminDo(api, http.MethodPut, configAdminStrategyPath, strategy, cookie, csrf, "https://panel.example"); got.Code != http.StatusNoContent {
		t.Fatalf("strategy: %d (cuerpo %q)", got.Code, got.Body.String())
	}
	market = configAdminMarket(store.config, "BANK_CUP")
	if market == nil || market.BuyMaxRate != 1200 || market.SellMinRate != 1300 || store.config.Risk.MinQusdReserve != 50 {
		t.Fatalf("strategy = %+v", store.config)
	}
}

func TestConfigAdminAPIControlAndRevisions(t *testing.T) {
	api, store, settings, cookie, csrf := newConfigAdminTestAPI(t)
	body := `{"paused":true}`
	if got := configAdminDo(api, http.MethodPut, configAdminControlPath, body, cookie, csrf, "https://panel.example"); got.Code != http.StatusNoContent {
		t.Fatalf("control: %d (cuerpo %q)", got.Code, got.Body.String())
	}
	if string(settings["control.paused"]) != "true" {
		t.Fatalf("paused = %q", settings["control.paused"])
	}
	invalid := `{"emergencyStop":true,"paused":true}`
	if got := configAdminDo(api, http.MethodPut, configAdminControlPath, invalid, cookie, csrf, "https://panel.example"); got.Code != http.StatusBadRequest {
		t.Fatalf("control inválido: %d", got.Code)
	}

	store.revisions = []runtimeconfig.Revision{{Version: 2, Config: store.config, Reason: "cambio", Actor: "panel", CreatedAt: 10}}
	recorder := configAdminDo(api, http.MethodGet, configAdminRevisionsPath, "", cookie, "", "")
	if recorder.Code != http.StatusOK {
		t.Fatalf("revisions: %d", recorder.Code)
	}
	var payload struct {
		Data []configAdminRevision `json:"data"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &payload); err != nil {
		t.Fatalf("revisions: %v", err)
	}
	if len(payload.Data) != 1 || payload.Data[0].ID != 2 || len(payload.Data[0].Hash) != 64 {
		t.Fatalf("revisions = %+v", payload.Data)
	}
}

func configAdminMarket(config runtimeconfig.Config, code string) *runtimeconfig.Market {
	for index := range config.Markets {
		if config.Markets[index].Code == code {
			return &config.Markets[index]
		}
	}
	return nil
}
