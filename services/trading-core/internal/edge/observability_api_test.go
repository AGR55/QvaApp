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

type fakeObservabilityStore struct {
	decisions     []DecisionEvent
	health        OperationalHealth
	err           error
	limits        []int
	decisionCalls int
	healthCalls   int
}

func (store *fakeObservabilityStore) Decisions(
	_ context.Context,
	limit int,
) ([]DecisionEvent, error) {
	store.decisionCalls++
	if store.err != nil {
		return nil, store.err
	}
	store.limits = append(store.limits, limit)
	return store.decisions, nil
}

func (store *fakeObservabilityStore) Health(context.Context) (OperationalHealth, error) {
	store.healthCalls++
	if store.err != nil {
		return OperationalHealth{}, store.err
	}
	return store.health, nil
}

func newObservabilityTestAPI(
	t *testing.T,
) (*ObservabilityAPI, *fakeObservabilityStore, *http.Cookie, time.Time) {
	t.Helper()
	manager := newSessionTestManager(t, 15*time.Minute)
	now := time.Unix(1_700_000_000, 0)
	token, _, err := manager.Issue(now)
	if err != nil {
		t.Fatalf("Issue: %v", err)
	}
	store := &fakeObservabilityStore{
		decisions: []DecisionEvent{{
			EventID: "event-1", Coin: "BANK_CUP", Side: "buy",
			Kind: "auto_buy", Allowed: true, Reason: "ok", CreatedAt: 4000,
		}},
		health: OperationalHealth{
			HunterEvents: 21, CoreAllowed: 13, CoreBlocked: 5,
			CorePending: 6, InvariantViolations: 2,
			InvariantAgeSeconds: 90, SSEConnected: false,
		},
	}
	api := &ObservabilityAPI{
		Sessions: manager,
		Store:    store,
		Now:      func() time.Time { return now },
	}
	cookie := &http.Cookie{Name: CookieName, Value: token}
	return api, store, cookie, now
}

func observabilityDo(
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

func decodeObservabilityData[T any](
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

func decodeObservabilityStatus(t *testing.T, recorder *httptest.ResponseRecorder) string {
	t.Helper()
	var body map[string]string
	if err := json.Unmarshal(recorder.Body.Bytes(), &body); err != nil {
		t.Fatalf("JSON inválido: %v (cuerpo %q)", err, recorder.Body.String())
	}
	return body["status"]
}

func assertObservabilityJSONHeaders(t *testing.T, recorder *httptest.ResponseRecorder) {
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

func observabilityRoutes() []string {
	return []string{decisionEventsPath, operationalHealthPath}
}

func TestObservabilityAPIServesAuthenticatedData(t *testing.T) {
	api, store, cookie, _ := newObservabilityTestAPI(t)

	decisions := observabilityDo(api, http.MethodGet, decisionEventsPath+"?limit=20", cookie)
	if decisions.Code != http.StatusOK {
		t.Fatalf("decision-events: status = %d (cuerpo %q)",
			decisions.Code, decisions.Body.String())
	}
	assertObservabilityJSONHeaders(t, decisions)
	gotDecisions := decodeObservabilityData[[]DecisionEvent](t, decisions)
	if len(gotDecisions) != 1 || gotDecisions[0] != store.decisions[0] {
		t.Fatalf("decisions = %+v", gotDecisions)
	}

	health := observabilityDo(api, http.MethodGet, operationalHealthPath, cookie)
	if health.Code != http.StatusOK {
		t.Fatalf("operational-health: status = %d (cuerpo %q)",
			health.Code, health.Body.String())
	}
	assertObservabilityJSONHeaders(t, health)
	gotHealth := decodeObservabilityData[OperationalHealth](t, health)
	if gotHealth.HunterEvents != store.health.HunterEvents ||
		gotHealth.CoreAllowed != store.health.CoreAllowed ||
		gotHealth.CoreBlocked != store.health.CoreBlocked ||
		gotHealth.CorePending != store.health.CorePending ||
		gotHealth.SSEConnected != store.health.SSEConnected {
		t.Fatalf("health = %+v, se esperaba %+v", gotHealth, store.health)
	}

	for _, recorder := range []*httptest.ResponseRecorder{decisions, health} {
		if strings.Contains(recorder.Body.String(), cookie.Value) {
			t.Fatal("la respuesta filtra el token de sesión")
		}
		if len(recorder.Result().Cookies()) != 0 {
			t.Fatal("la API de observabilidad no debe emitir cookies")
		}
	}
}

func TestObservabilityAPIRejectsMissingOrInvalidSession(t *testing.T) {
	api, _, _, now := newObservabilityTestAPI(t)
	invalid := &http.Cookie{Name: CookieName, Value: "no-es-un-token"}
	expiredToken, _, err := api.Sessions.Issue(now.Add(-2 * time.Hour))
	if err != nil {
		t.Fatalf("Issue: %v", err)
	}
	expired := &http.Cookie{Name: CookieName, Value: expiredToken}
	empty := &http.Cookie{Name: CookieName, Value: ""}

	for _, target := range observabilityRoutes() {
		for name, cookie := range map[string]*http.Cookie{
			"sin cookie": nil,
			"inválida":   invalid,
			"expirada":   expired,
			"vacía":      empty,
		} {
			recorder := observabilityDo(api, http.MethodGet, target, cookie)
			if recorder.Code != http.StatusUnauthorized {
				t.Fatalf("%s %s: status = %d, se esperaba 401 (cuerpo %q)",
					target, name, recorder.Code, recorder.Body.String())
			}
			assertObservabilityJSONHeaders(t, recorder)
			if status := decodeObservabilityStatus(t, recorder); status != "unauthenticated" {
				t.Fatalf("%s %s: status = %q", target, name, status)
			}
		}
	}

	noSessions := &ObservabilityAPI{Store: &fakeObservabilityStore{}}
	recorder := observabilityDo(noSessions, http.MethodGet, decisionEventsPath, nil)
	if recorder.Code != http.StatusUnauthorized {
		t.Fatalf("sin SessionManager: status = %d, se esperaba 401", recorder.Code)
	}
}

func TestObservabilityAPIRejectsNonGET(t *testing.T) {
	api, _, cookie, _ := newObservabilityTestAPI(t)
	for _, method := range []string{
		http.MethodPost, http.MethodPut, http.MethodPatch,
		http.MethodDelete, http.MethodHead,
	} {
		for _, target := range observabilityRoutes() {
			recorder := observabilityDo(api, method, target, cookie)
			if recorder.Code != http.StatusMethodNotAllowed {
				t.Fatalf("%s %s: status = %d, se esperaba 405 (cuerpo %q)",
					method, target, recorder.Code, recorder.Body.String())
			}
			if got := recorder.Header().Get("Allow"); got != http.MethodGet {
				t.Fatalf("%s %s: Allow = %q, se esperaba GET", method, target, got)
			}
			assertObservabilityJSONHeaders(t, recorder)
			if status := decodeObservabilityStatus(t, recorder); status != "method_not_allowed" {
				t.Fatalf("%s %s: status = %q", method, target, status)
			}
		}
	}
}

func TestObservabilityAPIRejectsUnknownRoutes(t *testing.T) {
	api, _, cookie, _ := newObservabilityTestAPI(t)
	for _, target := range []string{
		"/api/decision-events/", "/api/decision-events/extra",
		"/api/operational-health/", "/api/operational-health/extra",
		"/api/decisions", "/api/health", "/api/dashboard",
	} {
		recorder := observabilityDo(api, http.MethodGet, target, cookie)
		if recorder.Code != http.StatusNotFound {
			t.Fatalf("%s: status = %d, se esperaba 404 (cuerpo %q)",
				target, recorder.Code, recorder.Body.String())
		}
		assertObservabilityJSONHeaders(t, recorder)
		if status := decodeObservabilityStatus(t, recorder); status != "not_found" {
			t.Fatalf("%s: status = %q", target, status)
		}
	}

	// La ruta se resuelve antes que el método: una ruta desconocida es 404.
	recorder := observabilityDo(api, http.MethodPost, "/api/decision-events/extra", cookie)
	if recorder.Code != http.StatusNotFound {
		t.Fatalf("POST desconocido: status = %d, se esperaba 404", recorder.Code)
	}
}

func TestObservabilityAPIClampsLimit(t *testing.T) {
	api, store, cookie, _ := newObservabilityTestAPI(t)
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

	for _, testCase := range cases {
		store.limits = nil
		recorder := observabilityDo(
			api, http.MethodGet, decisionEventsPath+testCase.query, cookie)
		if recorder.Code != http.StatusOK {
			t.Fatalf("decision-events%s: status = %d", testCase.query, recorder.Code)
		}
		if len(store.limits) != 1 || store.limits[0] != testCase.want {
			t.Fatalf("decision-events%s: límites = %v, se esperaba %d",
				testCase.query, store.limits, testCase.want)
		}
	}
}

func TestObservabilityAPIEmitsEmptyArrays(t *testing.T) {
	api, store, cookie, _ := newObservabilityTestAPI(t)
	store.decisions = nil

	recorder := observabilityDo(api, http.MethodGet, decisionEventsPath, cookie)
	if recorder.Code != http.StatusOK {
		t.Fatalf("decision-events: status = %d", recorder.Code)
	}
	if body := recorder.Body.String(); !strings.Contains(body, `"data":[]`) {
		t.Fatalf("decision-events: cuerpo = %q, se esperaba data vacío", body)
	}
}

func TestObservabilityAPIMapsStoreErrorsToUnavailable(t *testing.T) {
	api, store, cookie, _ := newObservabilityTestAPI(t)
	store.err = fmt.Errorf("fuente caída")

	for _, target := range observabilityRoutes() {
		recorder := observabilityDo(api, http.MethodGet, target, cookie)
		if recorder.Code != http.StatusServiceUnavailable {
			t.Fatalf("%s: status = %d, se esperaba 503 (cuerpo %q)",
				target, recorder.Code, recorder.Body.String())
		}
		assertObservabilityJSONHeaders(t, recorder)
		if status := decodeObservabilityStatus(t, recorder); status != "unavailable" {
			t.Fatalf("%s: status = %q", target, status)
		}
	}
}

func TestObservabilityAPINilStoreIsUnavailable(t *testing.T) {
	api, _, cookie, _ := newObservabilityTestAPI(t)
	api.Store = nil

	for _, target := range observabilityRoutes() {
		recorder := observabilityDo(api, http.MethodGet, target, cookie)
		if recorder.Code != http.StatusServiceUnavailable {
			t.Fatalf("%s: status = %d, se esperaba 503", target, recorder.Code)
		}
		if status := decodeObservabilityStatus(t, recorder); status != "unavailable" {
			t.Fatalf("%s: status = %q", target, status)
		}
	}
}

// observabilityPostgresTestSetup abre el pool de pruebas y registra una
// limpieza limitada al prefijo del test, sin truncar tablas compartidas.
func observabilityPostgresTestSetup(
	t *testing.T,
) (*pgxpool.Pool, *PostgresObservabilityStore, string) {
	t.Helper()
	dsn := os.Getenv("TEST_POSTGRES_URL")
	if dsn == "" {
		t.Skip("TEST_POSTGRES_URL no configurado")
	}
	pool, err := pgxpool.New(context.Background(), dsn)
	if err != nil {
		t.Fatal(err)
	}
	prefix := fmt.Sprintf("observability-api-test-%d", time.Now().UnixNano())
	store := &PostgresObservabilityStore{Pool: pool}
	t.Cleanup(func() {
		ctx := context.Background()
		_, _ = pool.Exec(ctx,
			`DELETE FROM shadow.invariant_runs WHERE run_id LIKE $1`, prefix+"%")
		_, _ = pool.Exec(ctx,
			`DELETE FROM shadow.core_decisions WHERE event_id LIKE $1`, prefix+"%")
		_, _ = pool.Exec(ctx,
			`DELETE FROM shadow.hunter_events WHERE event_id LIKE $1`, prefix+"%")
		pool.Close()
	})
	return pool, store, prefix
}

func observabilityInsertHunterEvent(
	t *testing.T,
	pool *pgxpool.Pool,
	eventID string,
	state string,
) {
	t.Helper()
	_, err := pool.Exec(context.Background(), `
		INSERT INTO shadow.hunter_events
			(event_id, offer_uuid, coin, side, decision, rate, payload_json,
			 state, available_at, created_at)
		VALUES ($1, $2, 'BANK_CUP', 'buy', 'auto_buy', '1800', '{}', $3, 1000, 1000)`,
		eventID, eventID+"-offer", state)
	if err != nil {
		t.Fatalf("insertar hunter_event %s: %v", eventID, err)
	}
}

func observabilityInsertDecision(
	t *testing.T,
	pool *pgxpool.Pool,
	eventID string,
	allowed bool,
	kind string,
	reason string,
	createdAt int64,
) {
	t.Helper()
	_, err := pool.Exec(context.Background(), `
		INSERT INTO shadow.core_decisions
			(event_id, offer_uuid, coin, side, hunter_decision, core_kind, allowed,
			 amount, receive, rate, reason, checks_json, created_at)
		VALUES ($1, $2, 'BANK_CUP', 'buy', 'auto_buy', $3, $4,
		        '10', '18000', '1800', $5, '{}', $6)`,
		eventID, eventID+"-offer", kind, allowed, reason, createdAt)
	if err != nil {
		t.Fatalf("insertar core_decision %s: %v", eventID, err)
	}
}

func TestPostgresObservabilityStoreDecisions(t *testing.T) {
	pool, store, prefix := observabilityPostgresTestSetup(t)
	ctx := context.Background()
	base := time.Now().UnixMilli()

	createdAt := []int64{base, base + 2, base + 1}
	for index, at := range createdAt {
		eventID := fmt.Sprintf("%s-event-%d", prefix, index)
		observabilityInsertHunterEvent(t, pool, eventID, "processed")
		reason := fmt.Sprintf("reason-%d", index)
		observabilityInsertDecision(t, pool, eventID, index != 1, "auto_buy", reason, at)
	}

	decisions, err := store.Decisions(ctx, 2)
	if err != nil {
		t.Fatal(err)
	}
	if len(decisions) != 2 {
		t.Fatalf("decisions = %+v, se esperaban 2", decisions)
	}
	if decisions[0].EventID != prefix+"-event-1" ||
		decisions[1].EventID != prefix+"-event-0" {
		t.Fatalf("orden de decisions = %+v", decisions)
	}
	want := DecisionEvent{
		EventID: prefix + "-event-1", Coin: "BANK_CUP", Side: "buy",
		Kind: "auto_buy", Allowed: false, Reason: "reason-1", CreatedAt: base + 2,
	}
	if decisions[0] != want {
		t.Fatalf("decision inesperada = %+v, se esperaba %+v", decisions[0], want)
	}

	empty, err := store.Decisions(ctx, 0)
	if err != nil {
		t.Fatal(err)
	}
	if empty == nil || len(empty) != 0 {
		t.Fatalf("Decisions(0) = %#v, se esperaba slice vacío no nil", empty)
	}
}

func TestPostgresObservabilityStoreHealth(t *testing.T) {
	pool, store, prefix := observabilityPostgresTestSetup(t)
	ctx := context.Background()

	before, err := store.Health(ctx)
	if err != nil {
		t.Fatal(err)
	}

	observabilityInsertHunterEvent(t, pool, prefix+"-e1", "pending")
	observabilityInsertHunterEvent(t, pool, prefix+"-e2", "processed")
	observabilityInsertHunterEvent(t, pool, prefix+"-e3", "failed")
	observabilityInsertDecision(t, pool, prefix+"-e1", true, "auto_buy", "ok", 1000)
	observabilityInsertDecision(t, pool, prefix+"-e3", false, "blocked", "rate", 1000)

	runID := prefix + "-run"
	invariantCreatedAt := time.Now().Unix() - 30
	if _, err := pool.Exec(ctx, `
		INSERT INTO shadow.invariant_runs (run_id, source, violations, created_at)
		VALUES ($1, 'observability-test', 3, $2)`,
		runID, invariantCreatedAt); err != nil {
		t.Fatalf("insertar invariant_run %s: %v", runID, err)
	}

	after, err := store.Health(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if got := after.HunterEvents - before.HunterEvents; got != 3 {
		t.Fatalf("hunter events = %d, delta = %d, se esperaba 3",
			after.HunterEvents, got)
	}
	if got := after.CoreAllowed - before.CoreAllowed; got != 1 {
		t.Fatalf("core allowed = %d, delta = %d, se esperaba 1",
			after.CoreAllowed, got)
	}
	if got := after.CoreBlocked - before.CoreBlocked; got != 1 {
		t.Fatalf("core blocked = %d, delta = %d, se esperaba 1",
			after.CoreBlocked, got)
	}
	if got := after.CorePending - before.CorePending; got != 2 {
		t.Fatalf("core pending = %d, delta = %d, se esperaba 2",
			after.CorePending, got)
	}
	if got := after.InvariantViolations - before.InvariantViolations; got != 3 {
		t.Fatalf("invariant violations = %d, delta = %d, se esperaba 3",
			after.InvariantViolations, got)
	}
	if after.SSEConnected {
		t.Fatal("SSEConnected debe ser false: no se persiste en Postgres")
	}

	// La edad se calcula contra el máximo global de created_at, que puede ser
	// de otro test; se compara contra una lectura directa para verificar la
	// conversión a segundos sin depender del resto de filas.
	var maxCreatedAt int64
	if err := pool.QueryRow(ctx,
		`SELECT COALESCE(max(created_at), 0) FROM shadow.invariant_runs`,
	).Scan(&maxCreatedAt); err != nil {
		t.Fatal(err)
	}
	wantAge := time.Now().Unix() - maxCreatedAt
	if wantAge < 0 {
		wantAge = 0
	}
	if age := after.InvariantAgeSeconds; age < wantAge-2 || age > wantAge+2 {
		t.Fatalf("invariantAgeSeconds = %d, se esperaba ~%d", age, wantAge)
	}
}

func TestPostgresObservabilityStoreWithoutPool(t *testing.T) {
	store := &PostgresObservabilityStore{}
	ctx := context.Background()

	if _, err := store.Decisions(ctx, 10); err == nil {
		t.Fatal("Decisions sin pool debe fallar")
	}
	if _, err := store.Health(ctx); err == nil {
		t.Fatal("Health sin pool debe fallar")
	}

	var nilStore *PostgresObservabilityStore
	if _, err := nilStore.Decisions(ctx, 10); err == nil {
		t.Fatal("Decisions con receptor nil debe fallar")
	}
	if _, err := nilStore.Health(ctx); err == nil {
		t.Fatal("Health con receptor nil debe fallar")
	}
}
