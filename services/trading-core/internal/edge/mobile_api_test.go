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

type fakeMobileStore struct {
	summary         MobileSummary
	markets         []MobileMarket
	alerts          []MobileAlert
	operations      []MobileOperation
	err             error
	alertLimits     []int
	operationLimits []int
}

func (store *fakeMobileStore) Overview(context.Context) (MobileSummary, error) {
	if store.err != nil {
		return MobileSummary{}, store.err
	}
	return store.summary, nil
}

func (store *fakeMobileStore) Markets(context.Context) ([]MobileMarket, error) {
	if store.err != nil {
		return nil, store.err
	}
	return store.markets, nil
}

func (store *fakeMobileStore) Alerts(_ context.Context, limit int) ([]MobileAlert, error) {
	if store.err != nil {
		return nil, store.err
	}
	store.alertLimits = append(store.alertLimits, limit)
	return store.alerts, nil
}

func (store *fakeMobileStore) Operations(_ context.Context, limit int) ([]MobileOperation, error) {
	if store.err != nil {
		return nil, store.err
	}
	store.operationLimits = append(store.operationLimits, limit)
	return store.operations, nil
}

func newMobileTestAPI(t *testing.T) (*MobileAPI, *fakeMobileStore, *http.Cookie, time.Time) {
	t.Helper()
	manager := newSessionTestManager(t, 15*time.Minute)
	now := time.Unix(1_700_000_000, 0)
	token, _, err := manager.Issue(now)
	if err != nil {
		t.Fatalf("Issue: %v", err)
	}
	store := &fakeMobileStore{
		summary: MobileSummary{
			HunterEvents: 11, CoreAllowed: 7, CoreBlocked: 3,
			CorePending: 4, SSEConnected: true,
		},
		markets: []MobileMarket{{Coin: "BANK_CUP", Buy: 2, Sell: 1}},
		alerts: []MobileAlert{{
			EventID: "event-1", Coin: "BANK_CUP", Side: "buy",
			Kind: "blocked", Reason: "rate", CreatedAt: 1000,
		}},
		operations: []MobileOperation{{
			OperationID: "op-1", State: "reserved",
			QusdAmount: "12.5", FiatAmount: "22500", UpdatedAt: 2000,
		}},
	}
	api := &MobileAPI{
		Sessions: manager,
		Store:    store,
		Now:      func() time.Time { return now },
	}
	cookie := &http.Cookie{Name: CookieName, Value: token}
	return api, store, cookie, now
}

func mobileDo(
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

func decodeMobileData[T any](t *testing.T, recorder *httptest.ResponseRecorder) T {
	t.Helper()
	var body struct {
		Data T `json:"data"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &body); err != nil {
		t.Fatalf("JSON inválido: %v (cuerpo %q)", err, recorder.Body.String())
	}
	return body.Data
}

func decodeMobileStatus(t *testing.T, recorder *httptest.ResponseRecorder) string {
	t.Helper()
	var body map[string]string
	if err := json.Unmarshal(recorder.Body.Bytes(), &body); err != nil {
		t.Fatalf("JSON inválido: %v (cuerpo %q)", err, recorder.Body.String())
	}
	return body["status"]
}

func assertMobileJSONHeaders(t *testing.T, recorder *httptest.ResponseRecorder) {
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

func TestMobileAPIServesAuthenticatedData(t *testing.T) {
	api, store, cookie, _ := newMobileTestAPI(t)

	overview := mobileDo(api, http.MethodGet, mobileOverviewPath, cookie)
	if overview.Code != http.StatusOK {
		t.Fatalf("overview: status = %d (cuerpo %q)", overview.Code, overview.Body.String())
	}
	assertMobileJSONHeaders(t, overview)
	if got := decodeMobileData[MobileSummary](t, overview); got != store.summary {
		t.Fatalf("overview = %+v, se esperaba %+v", got, store.summary)
	}

	markets := mobileDo(api, http.MethodGet, mobileMarketsPath, cookie)
	if markets.Code != http.StatusOK {
		t.Fatalf("markets: status = %d (cuerpo %q)", markets.Code, markets.Body.String())
	}
	assertMobileJSONHeaders(t, markets)
	if got := decodeMobileData[[]MobileMarket](t, markets); len(got) != 1 || got[0] != store.markets[0] {
		t.Fatalf("markets = %+v", got)
	}

	alerts := mobileDo(api, http.MethodGet, mobileAlertsPath+"?limit=20", cookie)
	if alerts.Code != http.StatusOK {
		t.Fatalf("alerts: status = %d (cuerpo %q)", alerts.Code, alerts.Body.String())
	}
	assertMobileJSONHeaders(t, alerts)
	if got := decodeMobileData[[]MobileAlert](t, alerts); len(got) != 1 || got[0] != store.alerts[0] {
		t.Fatalf("alerts = %+v", got)
	}

	operations := mobileDo(api, http.MethodGet, mobileOperationsPath+"?limit=20", cookie)
	if operations.Code != http.StatusOK {
		t.Fatalf("operations: status = %d (cuerpo %q)", operations.Code, operations.Body.String())
	}
	assertMobileJSONHeaders(t, operations)
	if got := decodeMobileData[[]MobileOperation](t, operations); len(got) != 1 ||
		got[0] != store.operations[0] {
		t.Fatalf("operations = %+v", got)
	}

	for _, recorder := range []*httptest.ResponseRecorder{
		overview, markets, alerts, operations,
	} {
		if strings.Contains(recorder.Body.String(), cookie.Value) {
			t.Fatal("la respuesta filtra el token de sesión")
		}
		if len(recorder.Result().Cookies()) != 0 {
			t.Fatal("la API móvil no debe emitir cookies")
		}
	}
}

func TestMobileAPIRejectsMissingOrInvalidSession(t *testing.T) {
	api, _, _, now := newMobileTestAPI(t)
	invalid := &http.Cookie{Name: CookieName, Value: "no-es-un-token"}
	expiredToken, _, err := api.Sessions.Issue(now.Add(-2 * time.Hour))
	if err != nil {
		t.Fatalf("Issue: %v", err)
	}
	expired := &http.Cookie{Name: CookieName, Value: expiredToken}

	for _, target := range []string{
		mobileOverviewPath, mobileMarketsPath, mobileAlertsPath, mobileOperationsPath,
	} {
		for name, cookie := range map[string]*http.Cookie{
			"sin cookie": nil,
			"inválida":   invalid,
			"expirada":   expired,
		} {
			recorder := mobileDo(api, http.MethodGet, target, cookie)
			if recorder.Code != http.StatusUnauthorized {
				t.Fatalf("%s %s: status = %d, se esperaba 401 (cuerpo %q)",
					target, name, recorder.Code, recorder.Body.String())
			}
			assertMobileJSONHeaders(t, recorder)
			if status := decodeMobileStatus(t, recorder); status != "unauthenticated" {
				t.Fatalf("%s %s: status = %q", target, name, status)
			}
		}
	}
}

func TestMobileAPIRejectsNonGET(t *testing.T) {
	api, _, cookie, _ := newMobileTestAPI(t)
	for _, method := range []string{
		http.MethodPost, http.MethodPut, http.MethodPatch,
		http.MethodDelete, http.MethodHead,
	} {
		for _, target := range []string{
			mobileOverviewPath, mobileMarketsPath,
			mobileAlertsPath, mobileOperationsPath,
		} {
			recorder := mobileDo(api, method, target, cookie)
			if recorder.Code != http.StatusMethodNotAllowed {
				t.Fatalf("%s %s: status = %d, se esperaba 405 (cuerpo %q)",
					method, target, recorder.Code, recorder.Body.String())
			}
			if got := recorder.Header().Get("Allow"); got != http.MethodGet {
				t.Fatalf("%s %s: Allow = %q, se esperaba GET", method, target, got)
			}
			assertMobileJSONHeaders(t, recorder)
			if status := decodeMobileStatus(t, recorder); status != "method_not_allowed" {
				t.Fatalf("%s %s: status = %q", method, target, status)
			}
		}
	}
}

func TestMobileAPIRejectsUnknownRoutes(t *testing.T) {
	api, _, cookie, _ := newMobileTestAPI(t)
	for _, target := range []string{
		"/api/mobile", "/api/mobile/unknown", "/api/mobile/overview/",
		"/api/mobile/alerts/extra", "/api/session",
	} {
		recorder := mobileDo(api, http.MethodGet, target, cookie)
		if recorder.Code != http.StatusNotFound {
			t.Fatalf("%s: status = %d, se esperaba 404 (cuerpo %q)",
				target, recorder.Code, recorder.Body.String())
		}
		assertMobileJSONHeaders(t, recorder)
		if status := decodeMobileStatus(t, recorder); status != "not_found" {
			t.Fatalf("%s: status = %q", target, status)
		}
	}

	// La ruta se resuelve antes que el método: una ruta desconocida es 404.
	recorder := mobileDo(api, http.MethodPost, "/api/mobile/unknown", cookie)
	if recorder.Code != http.StatusNotFound {
		t.Fatalf("POST desconocido: status = %d, se esperaba 404", recorder.Code)
	}
}

func TestMobileAPIClampsLimit(t *testing.T) {
	api, store, cookie, _ := newMobileTestAPI(t)
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
		store.alertLimits = nil
		recorder := mobileDo(api, http.MethodGet, mobileAlertsPath+testCase.query, cookie)
		if recorder.Code != http.StatusOK {
			t.Fatalf("alerts%s: status = %d", testCase.query, recorder.Code)
		}
		if len(store.alertLimits) != 1 || store.alertLimits[0] != testCase.want {
			t.Fatalf("alerts%s: límites = %v, se esperaba %d",
				testCase.query, store.alertLimits, testCase.want)
		}

		store.operationLimits = nil
		recorder = mobileDo(api, http.MethodGet, mobileOperationsPath+testCase.query, cookie)
		if recorder.Code != http.StatusOK {
			t.Fatalf("operations%s: status = %d", testCase.query, recorder.Code)
		}
		if len(store.operationLimits) != 1 || store.operationLimits[0] != testCase.want {
			t.Fatalf("operations%s: límites = %v, se esperaba %d",
				testCase.query, store.operationLimits, testCase.want)
		}
	}
}

func TestMobileAPIEmitsEmptyArrays(t *testing.T) {
	api, store, cookie, _ := newMobileTestAPI(t)
	store.markets = nil
	store.alerts = nil
	store.operations = nil

	for _, target := range []string{mobileMarketsPath, mobileAlertsPath, mobileOperationsPath} {
		recorder := mobileDo(api, http.MethodGet, target, cookie)
		if recorder.Code != http.StatusOK {
			t.Fatalf("%s: status = %d", target, recorder.Code)
		}
		if body := recorder.Body.String(); !strings.Contains(body, `"data":[]`) {
			t.Fatalf("%s: cuerpo = %q, se esperaba data vacío", target, body)
		}
	}
}

func TestMobileAPIMapsStoreErrorsToUnavailable(t *testing.T) {
	api, store, cookie, _ := newMobileTestAPI(t)
	store.err = fmt.Errorf("fuente caída")

	for _, target := range []string{
		mobileOverviewPath, mobileMarketsPath, mobileAlertsPath, mobileOperationsPath,
	} {
		recorder := mobileDo(api, http.MethodGet, target, cookie)
		if recorder.Code != http.StatusServiceUnavailable {
			t.Fatalf("%s: status = %d, se esperaba 503 (cuerpo %q)",
				target, recorder.Code, recorder.Body.String())
		}
		assertMobileJSONHeaders(t, recorder)
		if status := decodeMobileStatus(t, recorder); status != "unavailable" {
			t.Fatalf("%s: status = %q", target, status)
		}
	}
}

// mobilePostgresTestSetup abre el pool de pruebas y registra una limpieza
// limitada al prefijo del test, sin truncar tablas compartidas.
func mobilePostgresTestSetup(t *testing.T) (*pgxpool.Pool, *PostgresMobileStore, string) {
	t.Helper()
	dsn := os.Getenv("TEST_POSTGRES_URL")
	if dsn == "" {
		t.Skip("TEST_POSTGRES_URL no configurado")
	}
	pool, err := pgxpool.New(context.Background(), dsn)
	if err != nil {
		t.Fatal(err)
	}
	prefix := fmt.Sprintf("mobile-api-test-%d", time.Now().UnixNano())
	store := &PostgresMobileStore{Pool: pool}
	t.Cleanup(func() {
		ctx := context.Background()
		_, _ = pool.Exec(ctx,
			`DELETE FROM shadow.core_operations WHERE operation_id LIKE $1`, prefix+"%")
		_, _ = pool.Exec(ctx,
			`DELETE FROM shadow.core_decisions WHERE event_id LIKE $1`, prefix+"%")
		_, _ = pool.Exec(ctx,
			`DELETE FROM shadow.hunter_events WHERE event_id LIKE $1`, prefix+"%")
		_, _ = pool.Exec(ctx,
			`DELETE FROM shadow.qvapay_offers WHERE run_id = $1`, prefix)
		_, _ = pool.Exec(ctx,
			`DELETE FROM shadow.qvapay_snapshots WHERE run_id = $1`, prefix)
		pool.Close()
	})
	return pool, store, prefix
}

func mobileInsertHunterEvent(t *testing.T, pool *pgxpool.Pool, eventID, state string) {
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

func mobileInsertDecision(
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

func TestPostgresMobileStoreOverview(t *testing.T) {
	pool, store, prefix := mobilePostgresTestSetup(t)
	ctx := context.Background()

	before, err := store.Overview(ctx)
	if err != nil {
		t.Fatal(err)
	}

	mobileInsertHunterEvent(t, pool, prefix+"-e1", "pending")
	mobileInsertHunterEvent(t, pool, prefix+"-e2", "processed")
	mobileInsertHunterEvent(t, pool, prefix+"-e3", "failed")
	mobileInsertDecision(t, pool, prefix+"-e1", true, "auto_buy", "ok", 1000)
	mobileInsertDecision(t, pool, prefix+"-e3", false, "blocked", "rate", 1000)

	after, err := store.Overview(ctx)
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
	if after.SSEConnected {
		t.Fatal("PostgresMobileStore no puede consultar SSE; debe devolver false")
	}
}

func TestPostgresMobileStoreMarkets(t *testing.T) {
	pool, store, prefix := mobilePostgresTestSetup(t)
	ctx := context.Background()
	runID := prefix
	coinA := prefix + "-CUP-A"
	coinB := prefix + "-CUP-B"

	if _, err := pool.Exec(ctx, `
		INSERT INTO shadow.qvapay_snapshots
			(run_id, user_uuid, balance, offers, averages, captured_at)
		VALUES ($1, 'mobile-test-user', '0', 3, 0, 1000)`, runID); err != nil {
		t.Fatal(err)
	}
	for index, offer := range []struct {
		coin string
		typ  string
	}{
		{coinA, "buy"},
		{coinA, "sell"},
		{coinB, "sell"},
	} {
		if _, err := pool.Exec(ctx, `
			INSERT INTO shadow.qvapay_offers
				(run_id, offer_uuid, coin, type, amount, receive, rate, status, captured_at)
			VALUES ($1, $2, $3, $4, '10', '18000', '1800', 'open', 1000)`,
			runID, fmt.Sprintf("%s-offer-%d", prefix, index), offer.coin, offer.typ); err != nil {
			t.Fatal(err)
		}
	}

	markets, err := store.Markets(ctx)
	if err != nil {
		t.Fatal(err)
	}
	found := map[string]MobileMarket{}
	for _, market := range markets {
		found[market.Coin] = market
	}
	if got := found[coinA]; got.Buy != 1 || got.Sell != 1 {
		t.Fatalf("mercado %s = %+v, se esperaba buy=1 sell=1", coinA, got)
	}
	if got := found[coinB]; got.Buy != 0 || got.Sell != 1 {
		t.Fatalf("mercado %s = %+v, se esperaba buy=0 sell=1", coinB, got)
	}
}

func TestPostgresMobileStoreAlerts(t *testing.T) {
	pool, store, prefix := mobilePostgresTestSetup(t)
	ctx := context.Background()
	const base int64 = 9_000_000_000_000_000

	mobileInsertHunterEvent(t, pool, prefix+"-a1", "processed")
	mobileInsertHunterEvent(t, pool, prefix+"-a2", "processed")
	mobileInsertHunterEvent(t, pool, prefix+"-a3", "processed")
	mobileInsertDecision(t, pool, prefix+"-a3", true, "auto_buy", "allowed", base+10)
	mobileInsertDecision(t, pool, prefix+"-a1", false, "blocked", "rate-low", base+2)
	mobileInsertDecision(t, pool, prefix+"-a2", false, "blocked", "rate-high", base+1)

	alerts, err := store.Alerts(ctx, 2)
	if err != nil {
		t.Fatal(err)
	}
	if len(alerts) != 2 {
		t.Fatalf("alerts = %+v, se esperaban 2", alerts)
	}
	if alerts[0].EventID != prefix+"-a1" || alerts[1].EventID != prefix+"-a2" {
		t.Fatalf("orden de alerts = %+v", alerts)
	}
	if alerts[0].Coin != "BANK_CUP" || alerts[0].Side != "buy" ||
		alerts[0].Kind != "blocked" || alerts[0].Reason != "rate-low" ||
		alerts[0].CreatedAt != base+2 {
		t.Fatalf("alert inesperada = %+v", alerts[0])
	}

	empty, err := store.Alerts(ctx, 0)
	if err != nil {
		t.Fatal(err)
	}
	if empty == nil || len(empty) != 0 {
		t.Fatalf("Alerts(0) = %#v, se esperaba slice vacío no nil", empty)
	}
}

func TestPostgresMobileStoreOperations(t *testing.T) {
	pool, store, prefix := mobilePostgresTestSetup(t)
	ctx := context.Background()
	const base int64 = 9_000_000_000_000_000

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
