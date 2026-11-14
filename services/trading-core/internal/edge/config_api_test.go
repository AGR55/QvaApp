package edge

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

type fakeConfigStore struct {
	config         any
	revisions      []any
	audit          []any
	recovery       []any
	err            error
	configCalls    int
	revisionsCalls int
	auditCalls     int
	recoveryCalls  int
	limits         []int
}

func (store *fakeConfigStore) Config(context.Context) (any, error) {
	store.configCalls++
	if store.err != nil {
		return nil, store.err
	}
	return store.config, nil
}

func (store *fakeConfigStore) Revisions(
	_ context.Context,
	limit int,
) ([]any, error) {
	store.revisionsCalls++
	store.limits = append(store.limits, limit)
	if store.err != nil {
		return nil, store.err
	}
	return store.revisions, nil
}

func (store *fakeConfigStore) Audit(
	_ context.Context,
	limit int,
) ([]any, error) {
	store.auditCalls++
	store.limits = append(store.limits, limit)
	if store.err != nil {
		return nil, store.err
	}
	return store.audit, nil
}

func (store *fakeConfigStore) Recovery(
	_ context.Context,
	limit int,
) ([]any, error) {
	store.recoveryCalls++
	store.limits = append(store.limits, limit)
	if store.err != nil {
		return nil, store.err
	}
	return store.recovery, nil
}

func newConfigTestAPI(
	t *testing.T,
) (*ConfigAPI, *fakeConfigStore, *http.Cookie, time.Time) {
	t.Helper()
	manager := newSessionTestManager(t, 15*time.Minute)
	now := time.Unix(1_700_000_000, 0)
	token, _, err := manager.Issue(now)
	if err != nil {
		t.Fatalf("Issue: %v", err)
	}
	store := &fakeConfigStore{
		config: map[string]any{"mode": "go-shadow", "revision": "rev-7"},
		revisions: []any{ConfigRevision{
			RevisionID: "rev-7", Source: "invariants", Violations: 0, CreatedAt: 4000,
		}},
		audit: []any{ConfigAuditEvent{
			EventID: "event-1", Coin: "BANK_CUP", Side: "buy",
			Allowed: true, Reason: "ok", CreatedAt: 4001,
		}},
		recovery: []any{ConfigRecoveryItem{
			EventID: "event-2", Coin: "BANK_CUP", Side: "sell",
			State: "pending", Attempts: 1, CreatedAt: 4002,
		}},
	}
	api := &ConfigAPI{
		Sessions:      manager,
		Store:         store,
		Now:           func() time.Time { return now },
		PublicPushKey: "BPublic-VAPID-Key",
	}
	cookie := &http.Cookie{Name: CookieName, Value: token}
	return api, store, cookie, now
}

func configDo(
	handler http.Handler,
	method string,
	target string,
	cookie *http.Cookie,
) *httptest.ResponseRecorder {
	request := httptest.NewRequest(method, target, nil)
	if cookie != nil {
		request.AddCookie(cookie)
	}
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)
	return recorder
}

func decodeConfigData[T any](
	t *testing.T,
	recorder *httptest.ResponseRecorder,
) T {
	t.Helper()
	var body struct {
		Data T `json:"data"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &body); err != nil {
		t.Fatalf("JSON inválido: %v (cuerpo %q)", err, recorder.Body.String())
	}
	return body.Data
}

func decodeConfigStatus(t *testing.T, recorder *httptest.ResponseRecorder) string {
	t.Helper()
	var body map[string]string
	if err := json.Unmarshal(recorder.Body.Bytes(), &body); err != nil {
		t.Fatalf("JSON inválido: %v (cuerpo %q)", err, recorder.Body.String())
	}
	return body["status"]
}

func assertConfigJSONHeaders(t *testing.T, recorder *httptest.ResponseRecorder) {
	t.Helper()
	if got := recorder.Header().Get("Content-Type"); !strings.HasPrefix(got, "application/json") {
		t.Fatalf("Content-Type = %q, se esperaba JSON", got)
	}
	if got := recorder.Header().Get("Cache-Control"); got != "no-store" {
		t.Fatalf("Cache-Control = %q, se esperaba no-store", got)
	}
	if got := recorder.Header().Get("Access-Control-Allow-Origin"); got != "" {
		t.Fatalf("no debe emitirse CORS, Access-Control-Allow-Origin = %q", got)
	}
}

func configRoutes() []string {
	return []string{
		configPath, configRevisionsPath, marketSourcePath, auditPath,
		notificationsPath, logsPath, recoveryPath, openAPIDocumentPath,
		pushPublicKeyPath,
	}
}

func TestConfigAPIServesAuthenticatedData(t *testing.T) {
	api, store, cookie, _ := newConfigTestAPI(t)

	config := configDo(api, http.MethodGet, configPath, cookie)
	if config.Code != http.StatusOK {
		t.Fatalf("config: status = %d (cuerpo %q)", config.Code, config.Body.String())
	}
	assertConfigJSONHeaders(t, config)
	gotConfig := decodeConfigData[map[string]any](t, config)
	if gotConfig["mode"] != "go-shadow" || gotConfig["revision"] != "rev-7" {
		t.Fatalf("config = %+v", gotConfig)
	}

	listRoutes := []struct {
		target string
	}{
		{configRevisionsPath},
		{auditPath},
		{recoveryPath},
	}
	for _, route := range listRoutes {
		recorder := configDo(api, http.MethodGet, route.target, cookie)
		if recorder.Code != http.StatusOK {
			t.Fatalf("%s: status = %d (cuerpo %q)",
				route.target, recorder.Code, recorder.Body.String())
		}
		assertConfigJSONHeaders(t, recorder)
		got := decodeConfigData[[]any](t, recorder)
		if len(got) != 1 {
			t.Fatalf("%s: data = %+v", route.target, got)
		}
	}

	marketSource := configDo(api, http.MethodGet, marketSourcePath, cookie)
	if marketSource.Code != http.StatusOK {
		t.Fatalf("market-source: status = %d", marketSource.Code)
	}
	assertConfigJSONHeaders(t, marketSource)
	if got := decodeConfigData[MarketSourceStatus](t, marketSource); got.Mode != "go-sse" || got.Polling {
		t.Fatalf("market-source = %+v", got)
	}

	for _, target := range []string{notificationsPath, logsPath} {
		recorder := configDo(api, http.MethodGet, target, cookie)
		if recorder.Code != http.StatusOK {
			t.Fatalf("%s: status = %d", target, recorder.Code)
		}
		assertConfigJSONHeaders(t, recorder)
		if body := recorder.Body.String(); !strings.Contains(body, `"data":[]`) {
			t.Fatalf("%s: cuerpo = %q, se esperaba data vacío", target, body)
		}
	}

	pushKey := configDo(api, http.MethodGet, pushPublicKeyPath, cookie)
	if pushKey.Code != http.StatusOK {
		t.Fatalf("push/public-key: status = %d", pushKey.Code)
	}
	assertConfigJSONHeaders(t, pushKey)
	if got := decodeConfigData[pushPublicKeyResponse](t, pushKey); got.PublicKey != "BPublic-VAPID-Key" {
		t.Fatalf("publicKey = %q", got.PublicKey)
	}

	openAPI := configDo(api, http.MethodGet, openAPIDocumentPath, cookie)
	if openAPI.Code != http.StatusOK {
		t.Fatalf("openapi.json: status = %d", openAPI.Code)
	}
	assertConfigJSONHeaders(t, openAPI)
	assertOpenAPIDocument(t, openAPI)

	if store.configCalls != 1 ||
		store.revisionsCalls != 1 ||
		store.auditCalls != 1 ||
		store.recoveryCalls != 1 {
		t.Fatalf("llamadas inesperadas al store: %+v", store)
	}

	for _, recorder := range []*httptest.ResponseRecorder{
		config, marketSource, pushKey, openAPI,
	} {
		if strings.Contains(recorder.Body.String(), cookie.Value) {
			t.Fatal("la respuesta filtra el token de sesión")
		}
		if len(recorder.Result().Cookies()) != 0 {
			t.Fatal("la API de configuración no debe emitir cookies")
		}
	}
}

func assertOpenAPIDocument(t *testing.T, recorder *httptest.ResponseRecorder) {
	t.Helper()
	var document struct {
		OpenAPI string `json:"openapi"`
		Info    struct {
			Title   string `json:"title"`
			Version string `json:"version"`
		} `json:"info"`
		Paths map[string]json.RawMessage `json:"paths"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &document); err != nil {
		t.Fatalf("openapi inválido: %v (cuerpo %q)", err, recorder.Body.String())
	}
	if document.OpenAPI == "" || document.Info.Title == "" || document.Info.Version == "" {
		t.Fatalf("openapi incompleto = %+v", document)
	}
	for _, route := range configRoutes() {
		if _, ok := document.Paths[route]; !ok {
			t.Fatalf("openapi no incluye %s: %v", route, document.Paths)
		}
	}
	body := strings.ToLower(recorder.Body.String())
	for _, secret := range []string{"password", "secret", "authorization", "database_url"} {
		if strings.Contains(body, secret) {
			t.Fatalf("openapi contiene %q: %s", secret, recorder.Body.String())
		}
	}
}

func TestConfigAPIFallbacksWithoutStore(t *testing.T) {
	api, _, cookie, _ := newConfigTestAPI(t)
	api.Store = nil
	api.PublicPushKey = ""

	config := configDo(api, http.MethodGet, configPath, cookie)
	if config.Code != http.StatusOK {
		t.Fatalf("config: status = %d", config.Code)
	}
	assertConfigJSONHeaders(t, config)
	if got := decodeConfigData[configFallback](t, config); got.Mode != "go-shadow" {
		t.Fatalf("config fallback = %+v", got)
	}

	for _, target := range []string{configRevisionsPath, auditPath, recoveryPath, notificationsPath, logsPath} {
		recorder := configDo(api, http.MethodGet, target, cookie)
		if recorder.Code != http.StatusOK {
			t.Fatalf("%s: status = %d", target, recorder.Code)
		}
		assertConfigJSONHeaders(t, recorder)
		if body := recorder.Body.String(); !strings.Contains(body, `"data":[]`) {
			t.Fatalf("%s: cuerpo = %q, se esperaba data vacío", target, body)
		}
	}

	marketSource := configDo(api, http.MethodGet, marketSourcePath, cookie)
	if marketSource.Code != http.StatusOK {
		t.Fatalf("market-source: status = %d", marketSource.Code)
	}
	if got := decodeConfigData[MarketSourceStatus](t, marketSource); got.Mode != "go-sse" || got.Polling {
		t.Fatalf("market-source = %+v", got)
	}

	pushKey := configDo(api, http.MethodGet, pushPublicKeyPath, cookie)
	if pushKey.Code != http.StatusServiceUnavailable {
		t.Fatalf("push/public-key sin clave: status = %d, se esperaba 503", pushKey.Code)
	}
	assertConfigJSONHeaders(t, pushKey)
	if status := decodeConfigStatus(t, pushKey); status != "unavailable" {
		t.Fatalf("push/public-key sin clave: status = %q", status)
	}

	api.PublicPushKey = "   "
	pushKey = configDo(api, http.MethodGet, pushPublicKeyPath, cookie)
	if pushKey.Code != http.StatusServiceUnavailable {
		t.Fatalf("push/public-key en blanco: status = %d, se esperaba 503", pushKey.Code)
	}

	// openapi.json es estático y no depende del store.
	openAPI := configDo(api, http.MethodGet, openAPIDocumentPath, cookie)
	if openAPI.Code != http.StatusOK {
		t.Fatalf("openapi.json: status = %d", openAPI.Code)
	}
	assertOpenAPIDocument(t, openAPI)
}

func TestConfigAPINilStoreConfigFallsBack(t *testing.T) {
	api, store, cookie, _ := newConfigTestAPI(t)
	store.config = nil

	recorder := configDo(api, http.MethodGet, configPath, cookie)
	if recorder.Code != http.StatusOK {
		t.Fatalf("config: status = %d", recorder.Code)
	}
	if got := decodeConfigData[configFallback](t, recorder); got.Mode != "go-shadow" {
		t.Fatalf("config fallback = %+v", got)
	}
}

func TestConfigAPIRejectsMissingOrInvalidSession(t *testing.T) {
	api, _, _, now := newConfigTestAPI(t)
	invalid := &http.Cookie{Name: CookieName, Value: "no-es-un-token"}
	expiredToken, _, err := api.Sessions.Issue(now.Add(-2 * time.Hour))
	if err != nil {
		t.Fatalf("Issue: %v", err)
	}
	expired := &http.Cookie{Name: CookieName, Value: expiredToken}
	empty := &http.Cookie{Name: CookieName, Value: ""}

	for _, target := range configRoutes() {
		for name, cookie := range map[string]*http.Cookie{
			"sin cookie": nil,
			"inválida":   invalid,
			"expirada":   expired,
			"vacía":      empty,
		} {
			recorder := configDo(api, http.MethodGet, target, cookie)
			if recorder.Code != http.StatusUnauthorized {
				t.Fatalf("%s %s: status = %d, se esperaba 401 (cuerpo %q)",
					target, name, recorder.Code, recorder.Body.String())
			}
			assertConfigJSONHeaders(t, recorder)
			if status := decodeConfigStatus(t, recorder); status != "unauthenticated" {
				t.Fatalf("%s %s: status = %q", target, name, status)
			}
		}
	}

	noSessions := &ConfigAPI{Store: &fakeConfigStore{}}
	recorder := configDo(noSessions, http.MethodGet, configPath, nil)
	if recorder.Code != http.StatusUnauthorized {
		t.Fatalf("sin SessionManager: status = %d, se esperaba 401", recorder.Code)
	}
}

func TestConfigAPIRejectsNonGET(t *testing.T) {
	api, _, cookie, _ := newConfigTestAPI(t)
	for _, method := range []string{
		http.MethodPost, http.MethodPut, http.MethodPatch,
		http.MethodDelete, http.MethodHead,
	} {
		for _, target := range configRoutes() {
			recorder := configDo(api, method, target, cookie)
			if recorder.Code != http.StatusMethodNotAllowed {
				t.Fatalf("%s %s: status = %d, se esperaba 405 (cuerpo %q)",
					method, target, recorder.Code, recorder.Body.String())
			}
			if got := recorder.Header().Get("Allow"); got != http.MethodGet {
				t.Fatalf("%s %s: Allow = %q, se esperaba GET", method, target, got)
			}
			assertConfigJSONHeaders(t, recorder)
			if status := decodeConfigStatus(t, recorder); status != "method_not_allowed" {
				t.Fatalf("%s %s: status = %q", method, target, status)
			}
		}
	}
}

func TestConfigAPIRejectsUnknownRoutes(t *testing.T) {
	api, _, cookie, _ := newConfigTestAPI(t)
	for _, target := range []string{
		"/api/config/", "/api/config/extra",
		"/api/config-revisions/", "/api/config-revisions/extra",
		"/api/market-source/", "/api/market-sources",
		"/api/audit/", "/api/audits",
		"/api/notifications/", "/api/notifications/extra",
		"/api/logs/extra", "/api/recovery/extra",
		"/api/openapi", "/api/openapi.json/extra",
		"/api/push", "/api/push/public-key/", "/api/push/public-key/extra",
	} {
		recorder := configDo(api, http.MethodGet, target, cookie)
		if recorder.Code != http.StatusNotFound {
			t.Fatalf("%s: status = %d, se esperaba 404 (cuerpo %q)",
				target, recorder.Code, recorder.Body.String())
		}
		assertConfigJSONHeaders(t, recorder)
		if status := decodeConfigStatus(t, recorder); status != "not_found" {
			t.Fatalf("%s: status = %q", target, status)
		}
	}

	// La ruta se resuelve antes que el método: una ruta desconocida es 404.
	recorder := configDo(api, http.MethodPost, "/api/config/extra", cookie)
	if recorder.Code != http.StatusNotFound {
		t.Fatalf("POST desconocido: status = %d, se esperaba 404", recorder.Code)
	}
}

func TestConfigAPIClampsLimit(t *testing.T) {
	api, store, cookie, _ := newConfigTestAPI(t)
	cases := []struct {
		query string
		want  int
	}{
		{"", 20},
		{"?limit=1", 1},
		{"?limit=20", 20},
		{"?limit=55", 55},
		{"?limit=100", 100},
		{"?limit=0", 1},
		{"?limit=-7", 1},
		{"?limit=101", 100},
		{"?limit=99999", 100},
		{"?limit=abc", 20},
		{"?limit=1.5", 20},
	}

	for _, target := range []string{configRevisionsPath, auditPath, recoveryPath} {
		for _, testCase := range cases {
			store.limits = nil
			recorder := configDo(
				api, http.MethodGet, target+testCase.query, cookie)
			if recorder.Code != http.StatusOK {
				t.Fatalf("%s%s: status = %d", target, testCase.query, recorder.Code)
			}
			if len(store.limits) != 1 || store.limits[0] != testCase.want {
				t.Fatalf("%s%s: límites = %v, se esperaba %d",
					target, testCase.query, store.limits, testCase.want)
			}
		}
	}
}

func TestConfigAPIMapsStoreErrorsToUnavailable(t *testing.T) {
	api, store, cookie, _ := newConfigTestAPI(t)
	store.err = fmt.Errorf("fuente caída")

	for _, target := range []string{
		configPath, configRevisionsPath, auditPath, recoveryPath,
	} {
		recorder := configDo(api, http.MethodGet, target, cookie)
		if recorder.Code != http.StatusServiceUnavailable {
			t.Fatalf("%s: status = %d, se esperaba 503 (cuerpo %q)",
				target, recorder.Code, recorder.Body.String())
		}
		assertConfigJSONHeaders(t, recorder)
		if status := decodeConfigStatus(t, recorder); status != "unavailable" {
			t.Fatalf("%s: status = %q", target, status)
		}
	}
}

func TestConfigAPIEmitsEmptyArraysForNilCollections(t *testing.T) {
	api, store, cookie, _ := newConfigTestAPI(t)
	store.revisions = nil
	store.audit = nil
	store.recovery = nil

	for _, target := range []string{configRevisionsPath, auditPath, recoveryPath} {
		recorder := configDo(api, http.MethodGet, target, cookie)
		if recorder.Code != http.StatusOK {
			t.Fatalf("%s: status = %d", target, recorder.Code)
		}
		if body := recorder.Body.String(); !strings.Contains(body, `"data":[]`) {
			t.Fatalf("%s: cuerpo = %q, se esperaba data vacío", target, body)
		}
	}
}

func TestPostgresConfigStoreWithoutPool(t *testing.T) {
	ctx := context.Background()
	store := &PostgresConfigStore{}

	if _, err := store.Config(ctx); err == nil {
		t.Fatal("Config sin pool debe fallar")
	}
	if _, err := store.Revisions(ctx, 10); err == nil {
		t.Fatal("Revisions sin pool debe fallar")
	}
	if _, err := store.Audit(ctx, 10); err == nil {
		t.Fatal("Audit sin pool debe fallar")
	}
	if _, err := store.Recovery(ctx, 10); err == nil {
		t.Fatal("Recovery sin pool debe fallar")
	}

	var nilStore *PostgresConfigStore
	if _, err := nilStore.Config(ctx); err == nil {
		t.Fatal("Config con receptor nil debe fallar")
	}
	if _, err := nilStore.Revisions(ctx, 10); err == nil {
		t.Fatal("Revisions con receptor nil debe fallar")
	}
	if _, err := nilStore.Audit(ctx, 10); err == nil {
		t.Fatal("Audit con receptor nil debe fallar")
	}
	if _, err := nilStore.Recovery(ctx, 10); err == nil {
		t.Fatal("Recovery con receptor nil debe fallar")
	}
}

// configPostgresTestSetup abre el pool de pruebas y limpia solo las filas con
// el prefijo del test, sin truncar tablas compartidas.
func configPostgresTestSetup(
	t *testing.T,
) (*pgxpool.Pool, *PostgresConfigStore, string) {
	t.Helper()
	dsn := os.Getenv("TEST_POSTGRES_URL")
	if dsn == "" {
		t.Skip("TEST_POSTGRES_URL no configurado")
	}
	pool, err := pgxpool.New(context.Background(), dsn)
	if err != nil {
		t.Fatal(err)
	}
	prefix := fmt.Sprintf("config-api-test-%d", time.Now().UnixNano())
	store := &PostgresConfigStore{Pool: pool}
	t.Cleanup(func() {
		ctx := context.Background()
		_, _ = pool.Exec(ctx,
			`DELETE FROM shadow.core_decisions WHERE event_id LIKE $1`, prefix+"%")
		_, _ = pool.Exec(ctx,
			`DELETE FROM shadow.hunter_events WHERE event_id LIKE $1`, prefix+"%")
		_, _ = pool.Exec(ctx,
			`DELETE FROM shadow.invariant_runs WHERE run_id LIKE $1`, prefix+"%")
		_, _ = pool.Exec(ctx,
			`DELETE FROM shadow.runs WHERE run_id LIKE $1`, prefix+"%")
		pool.Close()
	})
	return pool, store, prefix
}

func configInsertHunterEvent(
	t *testing.T,
	pool *pgxpool.Pool,
	eventID string,
	state string,
	createdAt int64,
) {
	t.Helper()
	_, err := pool.Exec(context.Background(), `
		INSERT INTO shadow.hunter_events
			(event_id, offer_uuid, coin, side, decision, rate, payload_json,
			 state, available_at, created_at)
		VALUES ($1, $2, 'BANK_CUP', 'buy', 'auto_buy', '1800', '{}', $3, 1000, $4)`,
		eventID, eventID+"-offer", state, createdAt)
	if err != nil {
		t.Fatalf("insertar hunter_event %s: %v", eventID, err)
	}
}

func configInsertDecision(
	t *testing.T,
	pool *pgxpool.Pool,
	eventID string,
	allowed bool,
	reason string,
	createdAt int64,
) {
	t.Helper()
	_, err := pool.Exec(context.Background(), `
		INSERT INTO shadow.core_decisions
			(event_id, offer_uuid, coin, side, hunter_decision, core_kind, allowed,
			 amount, receive, rate, reason, checks_json, created_at)
		VALUES ($1, $2, 'BANK_CUP', 'buy', 'auto_buy', 'auto_buy', $3,
		        '10', '18000', '1800', $4, '{}', $5)`,
		eventID, eventID+"-offer", allowed, reason, createdAt)
	if err != nil {
		t.Fatalf("insertar core_decision %s: %v", eventID, err)
	}
}

func configInsertInvariantRun(
	t *testing.T,
	pool *pgxpool.Pool,
	runID string,
	source string,
	violations int64,
	createdAt int64,
) {
	t.Helper()
	_, err := pool.Exec(context.Background(), `
		INSERT INTO shadow.invariant_runs (run_id, source, violations, created_at)
		VALUES ($1, $2, $3, $4)`,
		runID, source, violations, createdAt)
	if err != nil {
		t.Fatalf("insertar invariant_run %s: %v", runID, err)
	}
}

func configInsertShadowRun(
	t *testing.T,
	pool *pgxpool.Pool,
	runID string,
	createdAt int64,
) {
	t.Helper()
	_, err := pool.Exec(context.Background(), `
		INSERT INTO shadow.runs
			(run_id, source, cases, steps, matched, created_at)
		VALUES ($1, 'config-test', 1, 1, 1, $2)`,
		runID, createdAt)
	if err != nil {
		t.Fatalf("insertar shadow run %s: %v", runID, err)
	}
}

func configIDsWithPrefix(items []any, prefix string, id func(any) string) []string {
	ids := make([]string, 0)
	for _, item := range items {
		value := id(item)
		if strings.HasPrefix(value, prefix) {
			ids = append(ids, value)
		}
	}
	return ids
}

func TestPostgresConfigStoreReadsShadowTables(t *testing.T) {
	pool, store, prefix := configPostgresTestSetup(t)
	ctx := context.Background()

	beforeAny, err := store.Config(ctx)
	if err != nil {
		t.Fatal(err)
	}
	before, ok := beforeAny.(ConfigSnapshot)
	if !ok {
		t.Fatalf("Config devolvió %T, se esperaba ConfigSnapshot", beforeAny)
	}

	baseMillis := time.Now().Add(time.Hour).UnixMilli()
	baseSeconds := time.Now().Add(time.Hour).Unix()
	eventPending := prefix + "-e1"
	eventFailed := prefix + "-e2"
	eventProcessed := prefix + "-e3"

	configInsertHunterEvent(t, pool, eventProcessed, "processed", baseMillis)
	configInsertHunterEvent(t, pool, eventPending, "pending", baseMillis+2)
	configInsertHunterEvent(t, pool, eventFailed, "failed", baseMillis+3)
	configInsertDecision(t, pool, eventProcessed, true, "ok", baseMillis+10)
	configInsertDecision(t, pool, eventPending, false, "rate", baseMillis+11)
	configInsertInvariantRun(t, pool, prefix+"-inv1", "config-test", 0, baseSeconds)
	configInsertInvariantRun(t, pool, prefix+"-inv2", "config-test", 2, baseSeconds+10)
	configInsertShadowRun(t, pool, prefix+"-run1", baseSeconds)

	afterAny, err := store.Config(ctx)
	if err != nil {
		t.Fatal(err)
	}
	after, ok := afterAny.(ConfigSnapshot)
	if !ok {
		t.Fatalf("Config devolvió %T, se esperaba ConfigSnapshot", afterAny)
	}
	if after.Mode != "go-shadow" {
		t.Fatalf("mode = %q", after.Mode)
	}
	if got := after.HunterEvents - before.HunterEvents; got != 3 {
		t.Fatalf("hunter events delta = %d, se esperaba 3", got)
	}
	if got := after.CoreDecisions - before.CoreDecisions; got != 2 {
		t.Fatalf("core decisions delta = %d, se esperaba 2", got)
	}
	if got := after.InvariantRuns - before.InvariantRuns; got != 2 {
		t.Fatalf("invariant runs delta = %d, se esperaba 2", got)
	}
	if got := after.ShadowRuns - before.ShadowRuns; got != 1 {
		t.Fatalf("shadow runs delta = %d, se esperaba 1", got)
	}
	if after.LastInvariantAt < baseSeconds+10 {
		t.Fatalf("lastInvariantAt = %d, se esperaba >= %d",
			after.LastInvariantAt, baseSeconds+10)
	}

	revisions, err := store.Revisions(ctx, 100)
	if err != nil {
		t.Fatal(err)
	}
	revisionIDs := configIDsWithPrefix(revisions, prefix, func(item any) string {
		return item.(ConfigRevision).RevisionID
	})
	wantRevisions := []string{prefix + "-inv2", prefix + "-inv1"}
	if len(revisionIDs) != 2 || revisionIDs[0] != wantRevisions[0] ||
		revisionIDs[1] != wantRevisions[1] {
		t.Fatalf("revisions = %v, se esperaba %v", revisionIDs, wantRevisions)
	}
	for _, item := range revisions {
		revision := item.(ConfigRevision)
		if revision.RevisionID == prefix+"-inv2" && revision.Violations != 2 {
			t.Fatalf("violations = %d, se esperaba 2", revision.Violations)
		}
	}

	audit, err := store.Audit(ctx, 100)
	if err != nil {
		t.Fatal(err)
	}
	auditIDs := configIDsWithPrefix(audit, prefix, func(item any) string {
		return item.(ConfigAuditEvent).EventID
	})
	wantAudit := []string{eventPending, eventProcessed}
	if len(auditIDs) != 2 || auditIDs[0] != wantAudit[0] || auditIDs[1] != wantAudit[1] {
		t.Fatalf("audit = %v, se esperaba %v", auditIDs, wantAudit)
	}
	for _, item := range audit {
		event := item.(ConfigAuditEvent)
		if event.EventID == eventPending &&
			(event.Allowed || event.Reason != "rate" || event.Coin != "BANK_CUP") {
			t.Fatalf("evento de auditoría inesperado = %+v", event)
		}
	}

	recovery, err := store.Recovery(ctx, 100)
	if err != nil {
		t.Fatal(err)
	}
	recoveryIDs := configIDsWithPrefix(recovery, prefix, func(item any) string {
		return item.(ConfigRecoveryItem).EventID
	})
	wantRecovery := []string{eventFailed, eventPending}
	if len(recoveryIDs) != 2 ||
		recoveryIDs[0] != wantRecovery[0] ||
		recoveryIDs[1] != wantRecovery[1] {
		t.Fatalf("recovery = %v, se esperaba %v", recoveryIDs, wantRecovery)
	}
	for _, item := range recovery {
		recoveryItem := item.(ConfigRecoveryItem)
		if recoveryItem.EventID == eventProcessed {
			t.Fatal("recovery no debe incluir eventos procesados")
		}
	}

	empty, err := store.Revisions(ctx, 0)
	if err != nil {
		t.Fatal(err)
	}
	if empty == nil || len(empty) != 0 {
		t.Fatalf("Revisions(0) = %#v, se esperaba slice vacío no nil", empty)
	}
	emptyAudit, err := store.Audit(ctx, -1)
	if err != nil {
		t.Fatal(err)
	}
	if emptyAudit == nil || len(emptyAudit) != 0 {
		t.Fatalf("Audit(-1) = %#v, se esperaba slice vacío no nil", emptyAudit)
	}
	emptyRecovery, err := store.Recovery(ctx, 0)
	if err != nil {
		t.Fatal(err)
	}
	if emptyRecovery == nil || len(emptyRecovery) != 0 {
		t.Fatalf("Recovery(0) = %#v, se esperaba slice vacío no nil", emptyRecovery)
	}
}
