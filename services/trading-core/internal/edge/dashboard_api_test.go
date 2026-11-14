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

type fakeDashboardStore struct {
	summary         DashboardSummary
	offers          []LiveOffer
	operations      []DashboardOperation
	err             error
	offerLimits     []int
	operationLimits []int
	summaryCalls    int
}

func (store *fakeDashboardStore) Summary(context.Context) (DashboardSummary, error) {
	store.summaryCalls++
	if store.err != nil {
		return DashboardSummary{}, store.err
	}
	return store.summary, nil
}

func (store *fakeDashboardStore) Offers(_ context.Context, limit int) ([]LiveOffer, error) {
	if store.err != nil {
		return nil, store.err
	}
	store.offerLimits = append(store.offerLimits, limit)
	return store.offers, nil
}

func (store *fakeDashboardStore) Operations(
	_ context.Context,
	limit int,
) ([]DashboardOperation, error) {
	if store.err != nil {
		return nil, store.err
	}
	store.operationLimits = append(store.operationLimits, limit)
	return store.operations, nil
}

func newDashboardTestAPI(
	t *testing.T,
) (*DashboardAPI, *fakeDashboardStore, *http.Cookie, time.Time) {
	t.Helper()
	manager := newSessionTestManager(t, 15*time.Minute)
	now := time.Unix(1_700_000_000, 0)
	token, _, err := manager.Issue(now)
	if err != nil {
		t.Fatalf("Issue: %v", err)
	}
	store := &fakeDashboardStore{
		summary: DashboardSummary{
			HunterEvents: 21, CoreAllowed: 13, CoreBlocked: 5,
			CorePending: 6, QvaBalance: "321.50", QvaOffers: 9,
			CapturedAt: 3000,
		},
		offers: []LiveOffer{{
			UUID: "offer-1", Coin: "BANK_CUP", Type: "sell", Status: "open",
			Amount: "10", Receive: "18000", Rate: "1800", CapturedAt: 4000,
		}},
		operations: []DashboardOperation{{
			OperationID: "op-1", State: "reserved",
			QusdAmount: "12.5", FiatAmount: "22500", UpdatedAt: 5000,
		}},
	}
	api := &DashboardAPI{
		Sessions: manager,
		Store:    store,
		Now:      func() time.Time { return now },
	}
	cookie := &http.Cookie{Name: CookieName, Value: token}
	return api, store, cookie, now
}

func dashboardDo(
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

func decodeDashboardData[T any](t *testing.T, recorder *httptest.ResponseRecorder) T {
	t.Helper()
	var body struct {
		Data T `json:"data"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &body); err != nil {
		t.Fatalf("JSON inválido: %v (cuerpo %q)", err, recorder.Body.String())
	}
	return body.Data
}

func decodeDashboardStatus(t *testing.T, recorder *httptest.ResponseRecorder) string {
	t.Helper()
	var body map[string]string
	if err := json.Unmarshal(recorder.Body.Bytes(), &body); err != nil {
		t.Fatalf("JSON inválido: %v (cuerpo %q)", err, recorder.Body.String())
	}
	return body["status"]
}

func assertDashboardJSONHeaders(t *testing.T, recorder *httptest.ResponseRecorder) {
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

func dashboardRoutes() []string {
	return []string{dashboardPath, liveOwnOffersPath, liveOperationsPath, liveBalancePath}
}

func TestDashboardAPIServesAuthenticatedData(t *testing.T) {
	api, store, cookie, _ := newDashboardTestAPI(t)

	summary := dashboardDo(api, http.MethodGet, dashboardPath, cookie)
	if summary.Code != http.StatusOK {
		t.Fatalf("dashboard: status = %d (cuerpo %q)", summary.Code, summary.Body.String())
	}
	assertDashboardJSONHeaders(t, summary)
	if got := decodeDashboardData[DashboardSummary](t, summary); got != store.summary {
		t.Fatalf("dashboard = %+v, se esperaba %+v", got, store.summary)
	}

	offers := dashboardDo(api, http.MethodGet, liveOwnOffersPath+"?limit=50", cookie)
	if offers.Code != http.StatusOK {
		t.Fatalf("offers: status = %d (cuerpo %q)", offers.Code, offers.Body.String())
	}
	assertDashboardJSONHeaders(t, offers)
	gotOffers := decodeDashboardData[[]LiveOffer](t, offers)
	if len(gotOffers) != 1 || gotOffers[0] != store.offers[0] {
		t.Fatalf("offers = %+v", gotOffers)
	}

	operations := dashboardDo(api, http.MethodGet, liveOperationsPath+"?limit=20", cookie)
	if operations.Code != http.StatusOK {
		t.Fatalf("operations: status = %d (cuerpo %q)",
			operations.Code, operations.Body.String())
	}
	assertDashboardJSONHeaders(t, operations)
	gotOperations := decodeDashboardData[[]DashboardOperation](t, operations)
	if len(gotOperations) != 1 || gotOperations[0] != store.operations[0] {
		t.Fatalf("operations = %+v", gotOperations)
	}

	balance := dashboardDo(api, http.MethodGet, liveBalancePath, cookie)
	if balance.Code != http.StatusOK {
		t.Fatalf("balance: status = %d (cuerpo %q)", balance.Code, balance.Body.String())
	}
	assertDashboardJSONHeaders(t, balance)
	wantBalance := DashboardBalance{
		Balance:    store.summary.QvaBalance,
		CapturedAt: store.summary.CapturedAt,
	}
	if got := decodeDashboardData[DashboardBalance](t, balance); got != wantBalance {
		t.Fatalf("balance = %+v, se esperaba %+v", got, wantBalance)
	}

	for _, recorder := range []*httptest.ResponseRecorder{summary, offers, operations, balance} {
		if strings.Contains(recorder.Body.String(), cookie.Value) {
			t.Fatal("la respuesta filtra el token de sesión")
		}
		if len(recorder.Result().Cookies()) != 0 {
			t.Fatal("la API del dashboard no debe emitir cookies")
		}
	}
}

func TestDashboardAPIRejectsMissingOrInvalidSession(t *testing.T) {
	api, _, _, now := newDashboardTestAPI(t)
	invalid := &http.Cookie{Name: CookieName, Value: "no-es-un-token"}
	expiredToken, _, err := api.Sessions.Issue(now.Add(-2 * time.Hour))
	if err != nil {
		t.Fatalf("Issue: %v", err)
	}
	expired := &http.Cookie{Name: CookieName, Value: expiredToken}
	empty := &http.Cookie{Name: CookieName, Value: ""}

	for _, target := range dashboardRoutes() {
		for name, cookie := range map[string]*http.Cookie{
			"sin cookie": nil,
			"inválida":   invalid,
			"expirada":   expired,
			"vacía":      empty,
		} {
			recorder := dashboardDo(api, http.MethodGet, target, cookie)
			if recorder.Code != http.StatusUnauthorized {
				t.Fatalf("%s %s: status = %d, se esperaba 401 (cuerpo %q)",
					target, name, recorder.Code, recorder.Body.String())
			}
			assertDashboardJSONHeaders(t, recorder)
			if status := decodeDashboardStatus(t, recorder); status != "unauthenticated" {
				t.Fatalf("%s %s: status = %q", target, name, status)
			}
		}
	}

	noSessions := &DashboardAPI{Store: &fakeDashboardStore{}}
	recorder := dashboardDo(noSessions, http.MethodGet, dashboardPath, nil)
	if recorder.Code != http.StatusUnauthorized {
		t.Fatalf("sin SessionManager: status = %d, se esperaba 401", recorder.Code)
	}
}

func TestDashboardAPIRejectsNonGET(t *testing.T) {
	api, _, cookie, _ := newDashboardTestAPI(t)
	for _, method := range []string{
		http.MethodPost, http.MethodPut, http.MethodPatch,
		http.MethodDelete, http.MethodHead,
	} {
		for _, target := range dashboardRoutes() {
			recorder := dashboardDo(api, method, target, cookie)
			if recorder.Code != http.StatusMethodNotAllowed {
				t.Fatalf("%s %s: status = %d, se esperaba 405 (cuerpo %q)",
					method, target, recorder.Code, recorder.Body.String())
			}
			if got := recorder.Header().Get("Allow"); got != http.MethodGet {
				t.Fatalf("%s %s: Allow = %q, se esperaba GET", method, target, got)
			}
			assertDashboardJSONHeaders(t, recorder)
			if status := decodeDashboardStatus(t, recorder); status != "method_not_allowed" {
				t.Fatalf("%s %s: status = %q", method, target, status)
			}
		}
	}
}

func TestDashboardAPIRejectsUnknownRoutes(t *testing.T) {
	api, _, cookie, _ := newDashboardTestAPI(t)
	for _, target := range []string{
		"/api/dashboard/", "/api/dashboard/extra", "/api/live",
		"/api/live/own-offers/", "/api/live/own-offers/extra",
		"/api/live/balance/", "/api/live/unknown", "/api/mobile/overview",
	} {
		recorder := dashboardDo(api, http.MethodGet, target, cookie)
		if recorder.Code != http.StatusNotFound {
			t.Fatalf("%s: status = %d, se esperaba 404 (cuerpo %q)",
				target, recorder.Code, recorder.Body.String())
		}
		assertDashboardJSONHeaders(t, recorder)
		if status := decodeDashboardStatus(t, recorder); status != "not_found" {
			t.Fatalf("%s: status = %q", target, status)
		}
	}

	// La ruta se resuelve antes que el método: una ruta desconocida es 404.
	recorder := dashboardDo(api, http.MethodPost, "/api/live/unknown", cookie)
	if recorder.Code != http.StatusNotFound {
		t.Fatalf("POST desconocido: status = %d, se esperaba 404", recorder.Code)
	}
}

func TestDashboardAPIClampsLimit(t *testing.T) {
	api, store, cookie, _ := newDashboardTestAPI(t)
	cases := []struct {
		query          string
		wantOffers     int
		wantOperations int
	}{
		{"", 50, 20},
		{"?limit=1", 1, 1},
		{"?limit=20", 20, 20},
		{"?limit=55", 55, 55},
		{"?limit=100", 100, 100},
		{"?limit=0", 1, 1},
		{"?limit=-7", 1, 1},
		{"?limit=101", 100, 100},
		{"?limit=99999", 100, 100},
		{"?limit=abc", 50, 20},
		{"?limit=1.5", 50, 20},
	}

	for _, testCase := range cases {
		store.offerLimits = nil
		recorder := dashboardDo(api, http.MethodGet, liveOwnOffersPath+testCase.query, cookie)
		if recorder.Code != http.StatusOK {
			t.Fatalf("own-offers%s: status = %d", testCase.query, recorder.Code)
		}
		if len(store.offerLimits) != 1 || store.offerLimits[0] != testCase.wantOffers {
			t.Fatalf("own-offers%s: límites = %v, se esperaba %d",
				testCase.query, store.offerLimits, testCase.wantOffers)
		}

		store.operationLimits = nil
		recorder = dashboardDo(api, http.MethodGet, liveOperationsPath+testCase.query, cookie)
		if recorder.Code != http.StatusOK {
			t.Fatalf("operations%s: status = %d", testCase.query, recorder.Code)
		}
		if len(store.operationLimits) != 1 ||
			store.operationLimits[0] != testCase.wantOperations {
			t.Fatalf("operations%s: límites = %v, se esperaba %d",
				testCase.query, store.operationLimits, testCase.wantOperations)
		}
	}
}

func TestDashboardAPIEmitsEmptyArrays(t *testing.T) {
	api, store, cookie, _ := newDashboardTestAPI(t)
	store.offers = nil
	store.operations = nil

	for _, target := range []string{liveOwnOffersPath, liveOperationsPath} {
		recorder := dashboardDo(api, http.MethodGet, target, cookie)
		if recorder.Code != http.StatusOK {
			t.Fatalf("%s: status = %d", target, recorder.Code)
		}
		if body := recorder.Body.String(); !strings.Contains(body, `"data":[]`) {
			t.Fatalf("%s: cuerpo = %q, se esperaba data vacío", target, body)
		}
	}
}

func TestDashboardAPIBalanceWithoutSnapshot(t *testing.T) {
	api, store, cookie, _ := newDashboardTestAPI(t)
	store.summary = DashboardSummary{HunterEvents: 1}

	recorder := dashboardDo(api, http.MethodGet, liveBalancePath, cookie)
	if recorder.Code != http.StatusOK {
		t.Fatalf("balance: status = %d (cuerpo %q)", recorder.Code, recorder.Body.String())
	}
	want := DashboardBalance{Balance: "", CapturedAt: 0}
	if got := decodeDashboardData[DashboardBalance](t, recorder); got != want {
		t.Fatalf("balance = %+v, se esperaba %+v", got, want)
	}
}

func TestDashboardAPIMapsStoreErrorsToUnavailable(t *testing.T) {
	api, store, cookie, _ := newDashboardTestAPI(t)
	store.err = fmt.Errorf("fuente caída")

	for _, target := range dashboardRoutes() {
		recorder := dashboardDo(api, http.MethodGet, target, cookie)
		if recorder.Code != http.StatusServiceUnavailable {
			t.Fatalf("%s: status = %d, se esperaba 503 (cuerpo %q)",
				target, recorder.Code, recorder.Body.String())
		}
		assertDashboardJSONHeaders(t, recorder)
		if status := decodeDashboardStatus(t, recorder); status != "unavailable" {
			t.Fatalf("%s: status = %q", target, status)
		}
	}
}

func TestDashboardAPINilStoreIsUnavailable(t *testing.T) {
	api, _, cookie, _ := newDashboardTestAPI(t)
	api.Store = nil

	for _, target := range dashboardRoutes() {
		recorder := dashboardDo(api, http.MethodGet, target, cookie)
		if recorder.Code != http.StatusServiceUnavailable {
			t.Fatalf("%s: status = %d, se esperaba 503", target, recorder.Code)
		}
		if status := decodeDashboardStatus(t, recorder); status != "unavailable" {
			t.Fatalf("%s: status = %q", target, status)
		}
	}
}

// dashboardPostgresTestSetup abre el pool de pruebas y registra una limpieza
// limitada al prefijo del test, sin truncar tablas compartidas.
func dashboardPostgresTestSetup(
	t *testing.T,
) (*pgxpool.Pool, *PostgresDashboardStore, string) {
	t.Helper()
	dsn := os.Getenv("TEST_POSTGRES_URL")
	if dsn == "" {
		t.Skip("TEST_POSTGRES_URL no configurado")
	}
	pool, err := pgxpool.New(context.Background(), dsn)
	if err != nil {
		t.Fatal(err)
	}
	prefix := fmt.Sprintf("dashboard-api-test-%d", time.Now().UnixNano())
	store := &PostgresDashboardStore{Pool: pool}
	t.Cleanup(func() {
		ctx := context.Background()
		_, _ = pool.Exec(ctx,
			`DELETE FROM shadow.qvapay_offers WHERE run_id = $1`, prefix)
		_, _ = pool.Exec(ctx,
			`DELETE FROM shadow.qvapay_snapshots WHERE run_id = $1`, prefix)
		_, _ = pool.Exec(ctx,
			`DELETE FROM shadow.core_operations WHERE operation_id LIKE $1`, prefix+"%")
		_, _ = pool.Exec(ctx,
			`DELETE FROM shadow.core_decisions WHERE event_id LIKE $1`, prefix+"%")
		_, _ = pool.Exec(ctx,
			`DELETE FROM shadow.hunter_events WHERE event_id LIKE $1`, prefix+"%")
		pool.Close()
	})
	return pool, store, prefix
}

func dashboardInsertHunterEvent(t *testing.T, pool *pgxpool.Pool, eventID, state string) {
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

func dashboardInsertDecision(
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

func dashboardInsertSnapshot(
	t *testing.T,
	pool *pgxpool.Pool,
	runID string,
	balance string,
	offers int,
	capturedAt int64,
) {
	t.Helper()
	_, err := pool.Exec(context.Background(), `
		INSERT INTO shadow.qvapay_snapshots
			(run_id, user_uuid, balance, offers, averages, captured_at)
		VALUES ($1, 'dashboard-test-user', $2, $3, 0, $4)`,
		runID, balance, offers, capturedAt)
	if err != nil {
		t.Fatalf("insertar snapshot %s: %v", runID, err)
	}
}

func TestPostgresDashboardStoreSummary(t *testing.T) {
	pool, store, prefix := dashboardPostgresTestSetup(t)
	ctx := context.Background()

	before, err := store.Summary(ctx)
	if err != nil {
		t.Fatal(err)
	}

	dashboardInsertHunterEvent(t, pool, prefix+"-e1", "pending")
	dashboardInsertHunterEvent(t, pool, prefix+"-e2", "processed")
	dashboardInsertHunterEvent(t, pool, prefix+"-e3", "failed")
	dashboardInsertDecision(t, pool, prefix+"-e1", true, "auto_buy", "ok", 1000)
	dashboardInsertDecision(t, pool, prefix+"-e3", false, "blocked", "rate", 1000)

	// captured_at en nanosegundos garantiza que este snapshot es el último
	// frente a las filas de otros tests, que usan valores mucho menores.
	capturedAt := time.Now().UnixNano()
	dashboardInsertSnapshot(t, pool, prefix, "321.50", 7, capturedAt)

	after, err := store.Summary(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if got := after.HunterEvents - before.HunterEvents; got != 3 {
		t.Fatalf("hunter events = %d, delta = %d, se esperaba 3", after.HunterEvents, got)
	}
	if got := after.CoreAllowed - before.CoreAllowed; got != 1 {
		t.Fatalf("core allowed = %d, delta = %d, se esperaba 1", after.CoreAllowed, got)
	}
	if got := after.CoreBlocked - before.CoreBlocked; got != 1 {
		t.Fatalf("core blocked = %d, delta = %d, se esperaba 1", after.CoreBlocked, got)
	}
	if got := after.CorePending - before.CorePending; got != 2 {
		t.Fatalf("core pending = %d, delta = %d, se esperaba 2", after.CorePending, got)
	}
	if after.QvaBalance != "321.50" {
		t.Fatalf("balance = %q, se esperaba 321.50", after.QvaBalance)
	}
	if after.QvaOffers != 7 {
		t.Fatalf("ofertas = %d, se esperaba 7", after.QvaOffers)
	}
	if after.CapturedAt != capturedAt {
		t.Fatalf("capturedAt = %d, se esperaba %d", after.CapturedAt, capturedAt)
	}
}

func TestPostgresDashboardStoreOffers(t *testing.T) {
	pool, store, prefix := dashboardPostgresTestSetup(t)
	ctx := context.Background()
	// Los timestamps altos dejan las filas de este test al principio del
	// orden captured_at DESC, evitando que datos previos desplacen las
	// aserciones.
	base := time.Now().UnixNano()

	dashboardInsertSnapshot(t, pool, prefix, "0", 3, base)
	for index, capturedAt := range []int64{base, base + 2, base + 1} {
		if _, err := pool.Exec(ctx, `
			INSERT INTO shadow.qvapay_offers
				(run_id, offer_uuid, coin, type, amount, receive, rate, status, captured_at)
			VALUES ($1, $2, 'BANK_CUP', 'buy', '10', '18000', '1800', 'open', $3)`,
			prefix, fmt.Sprintf("%s-offer-%d", prefix, index), capturedAt); err != nil {
			t.Fatal(err)
		}
	}

	offers, err := store.Offers(ctx, 2)
	if err != nil {
		t.Fatal(err)
	}
	if len(offers) != 2 {
		t.Fatalf("offers = %+v, se esperaban 2", offers)
	}
	if offers[0].UUID != prefix+"-offer-1" || offers[1].UUID != prefix+"-offer-2" {
		t.Fatalf("orden de offers = %+v", offers)
	}
	want := LiveOffer{
		UUID: prefix + "-offer-1", Coin: "BANK_CUP", Type: "buy", Status: "open",
		Amount: "10", Receive: "18000", Rate: "1800", CapturedAt: base + 2,
	}
	if offers[0] != want {
		t.Fatalf("offer inesperada = %+v, se esperaba %+v", offers[0], want)
	}

	empty, err := store.Offers(ctx, 0)
	if err != nil {
		t.Fatal(err)
	}
	if empty == nil || len(empty) != 0 {
		t.Fatalf("Offers(0) = %#v, se esperaba slice vacío no nil", empty)
	}
}

func TestPostgresDashboardStoreOperations(t *testing.T) {
	pool, store, prefix := dashboardPostgresTestSetup(t)
	ctx := context.Background()
	base := time.Now().UnixNano()

	for index, updatedAt := range []int64{base, base + 2, base + 1} {
		if _, err := pool.Exec(ctx, `
			INSERT INTO shadow.core_operations
				(operation_id, state, qusd_amount, fiat_amount, updated_at, created_at)
			VALUES ($1, 'reserved', '12.5', '22500', $2, $3)`,
			fmt.Sprintf("%s-op-%d", prefix, index), updatedAt, base); err != nil {
			t.Fatal(err)
		}
	}

	operations, err := store.Operations(ctx, 2)
	if err != nil {
		t.Fatal(err)
	}
	if len(operations) != 2 {
		t.Fatalf("operations = %+v, se esperaban 2", operations)
	}
	if operations[0].OperationID != prefix+"-op-1" ||
		operations[1].OperationID != prefix+"-op-2" {
		t.Fatalf("orden de operations = %+v", operations)
	}
	if operations[0].State != "reserved" || operations[0].QusdAmount != "12.5" ||
		operations[0].FiatAmount != "22500" || operations[0].UpdatedAt != base+2 {
		t.Fatalf("operation inesperada = %+v", operations[0])
	}

	empty, err := store.Operations(ctx, 0)
	if err != nil {
		t.Fatal(err)
	}
	if empty == nil || len(empty) != 0 {
		t.Fatalf("Operations(0) = %#v, se esperaba slice vacío no nil", empty)
	}
}

func TestPostgresDashboardStoreWithoutPool(t *testing.T) {
	store := &PostgresDashboardStore{}
	ctx := context.Background()

	if _, err := store.Summary(ctx); err == nil {
		t.Fatal("Summary sin pool debe fallar")
	}
	if _, err := store.Offers(ctx, 10); err == nil {
		t.Fatal("Offers sin pool debe fallar")
	}
	if _, err := store.Operations(ctx, 10); err == nil {
		t.Fatal("Operations sin pool debe fallar")
	}

	var nilStore *PostgresDashboardStore
	if _, err := nilStore.Summary(ctx); err == nil {
		t.Fatal("Summary con receptor nil debe fallar")
	}
}
