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

type fakeLiveStore struct {
	market            LiveMarket
	transactions      []LiveTransaction
	err               error
	marketCoins       []string
	transactionLimits []int
}

func (store *fakeLiveStore) Market(_ context.Context, coin string) (LiveMarket, error) {
	store.marketCoins = append(store.marketCoins, coin)
	if store.err != nil {
		return LiveMarket{}, store.err
	}
	return store.market, nil
}

func (store *fakeLiveStore) Transactions(
	_ context.Context,
	limit int,
) ([]LiveTransaction, error) {
	store.transactionLimits = append(store.transactionLimits, limit)
	if store.err != nil {
		return nil, store.err
	}
	return store.transactions, nil
}

func newLiveTestAPI(t *testing.T) (*LiveAPI, *fakeLiveStore, *http.Cookie, time.Time) {
	t.Helper()
	manager := newSessionTestManager(t, 15*time.Minute)
	now := time.Unix(1_700_000_000, 0)
	token, _, err := manager.Issue(now)
	if err != nil {
		t.Fatalf("Issue: %v", err)
	}
	store := &fakeLiveStore{
		market: LiveMarket{
			Coin: "BANK_CUP",
			Offers: []LiveMarketOffer{{
				UUID: "offer-1", Type: "sell", Status: "open",
				Amount: "10", Receive: "18000", Rate: "1800",
				CapturedAt: 4000,
			}},
		},
		transactions: []LiveTransaction{{
			UUID: "tx-1", Amount: "5.00", Status: "completed",
			Description: "Pago", CreatedAt: "2026-11-14T10:00:00Z",
			UpdatedAt: "2026-11-14T10:05:00Z", CapturedAt: 5000,
		}},
	}
	api := &LiveAPI{
		Sessions: manager,
		Store:    store,
		Now:      func() time.Time { return now },
	}
	cookie := &http.Cookie{Name: CookieName, Value: token}
	return api, store, cookie, now
}

func liveDo(
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

func decodeLiveData[T any](t *testing.T, recorder *httptest.ResponseRecorder) T {
	t.Helper()
	var body struct {
		Data T `json:"data"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &body); err != nil {
		t.Fatalf("JSON inválido: %v (cuerpo %q)", err, recorder.Body.String())
	}
	return body.Data
}

func decodeLiveStatus(t *testing.T, recorder *httptest.ResponseRecorder) string {
	t.Helper()
	var body map[string]string
	if err := json.Unmarshal(recorder.Body.Bytes(), &body); err != nil {
		t.Fatalf("JSON inválido: %v (cuerpo %q)", err, recorder.Body.String())
	}
	return body["status"]
}

func assertLiveJSONHeaders(t *testing.T, recorder *httptest.ResponseRecorder) {
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

func liveRoutes() []string {
	return []string{liveMarketsPrefix + "BANK_CUP", liveTransactionsPath}
}

func TestParseLiveRoute(t *testing.T) {
	cases := []struct {
		path  string
		route int
		coin  string
		ok    bool
	}{
		{liveTransactionsPath, liveRouteTransactions, "", true},
		{liveMarketsPrefix + "BANK_CUP", liveRouteMarket, "BANK_CUP", true},
		{liveMarketsPrefix + "a-b_c", liveRouteMarket, "a-b_c", true},
		{liveMarketsPrefix, liveRouteNone, "", false},
		{"/api/live/markets", liveRouteNone, "", false},
		{liveMarketsPrefix + "a/b", liveRouteNone, "", false},
		{liveTransactionsPath + "/", liveRouteNone, "", false},
		{liveTransactionsPath + "/extra", liveRouteNone, "", false},
	}

	for _, testCase := range cases {
		route, coin, ok := parseLiveRoute(testCase.path)
		if route != testCase.route || coin != testCase.coin || ok != testCase.ok {
			t.Fatalf("parseLiveRoute(%q) = (%d, %q, %t), se esperaba (%d, %q, %t)",
				testCase.path, route, coin, ok, testCase.route, testCase.coin, testCase.ok)
		}
	}
}

func TestLiveAPIServesAuthenticatedData(t *testing.T) {
	api, store, cookie, _ := newLiveTestAPI(t)

	marketRecorder := liveDo(api, http.MethodGet, liveMarketsPrefix+"BANK_CUP", cookie)
	if marketRecorder.Code != http.StatusOK {
		t.Fatalf("market: status = %d (cuerpo %q)",
			marketRecorder.Code, marketRecorder.Body.String())
	}
	assertLiveJSONHeaders(t, marketRecorder)
	gotMarket := decodeLiveData[LiveMarket](t, marketRecorder)
	if gotMarket.Coin != store.market.Coin ||
		len(gotMarket.Offers) != 1 || gotMarket.Offers[0] != store.market.Offers[0] {
		t.Fatalf("market = %+v, se esperaba %+v", gotMarket, store.market)
	}
	if len(store.marketCoins) != 1 || store.marketCoins[0] != "BANK_CUP" {
		t.Fatalf("coins consultados = %v, se esperaba [BANK_CUP]", store.marketCoins)
	}

	transactions := liveDo(api, http.MethodGet, liveTransactionsPath+"?limit=20", cookie)
	if transactions.Code != http.StatusOK {
		t.Fatalf("transactions: status = %d (cuerpo %q)",
			transactions.Code, transactions.Body.String())
	}
	assertLiveJSONHeaders(t, transactions)
	gotTransactions := decodeLiveData[[]LiveTransaction](t, transactions)
	if len(gotTransactions) != 1 || gotTransactions[0] != store.transactions[0] {
		t.Fatalf("transactions = %+v", gotTransactions)
	}

	for _, recorder := range []*httptest.ResponseRecorder{marketRecorder, transactions} {
		if strings.Contains(recorder.Body.String(), cookie.Value) {
			t.Fatal("la respuesta filtra el token de sesión")
		}
		if len(recorder.Result().Cookies()) != 0 {
			t.Fatal("la API live no debe emitir cookies")
		}
	}
}

func TestLiveAPIRejectsMissingOrInvalidSession(t *testing.T) {
	api, _, _, now := newLiveTestAPI(t)
	invalid := &http.Cookie{Name: CookieName, Value: "no-es-un-token"}
	expiredToken, _, err := api.Sessions.Issue(now.Add(-2 * time.Hour))
	if err != nil {
		t.Fatalf("Issue: %v", err)
	}
	expired := &http.Cookie{Name: CookieName, Value: expiredToken}
	empty := &http.Cookie{Name: CookieName, Value: ""}

	for _, target := range liveRoutes() {
		for name, cookie := range map[string]*http.Cookie{
			"sin cookie": nil,
			"inválida":   invalid,
			"expirada":   expired,
			"vacía":      empty,
		} {
			recorder := liveDo(api, http.MethodGet, target, cookie)
			if recorder.Code != http.StatusUnauthorized {
				t.Fatalf("%s %s: status = %d, se esperaba 401 (cuerpo %q)",
					target, name, recorder.Code, recorder.Body.String())
			}
			assertLiveJSONHeaders(t, recorder)
			if status := decodeLiveStatus(t, recorder); status != "unauthenticated" {
				t.Fatalf("%s %s: status = %q", target, name, status)
			}
		}
	}

	noSessions := &LiveAPI{Store: &fakeLiveStore{}}
	recorder := liveDo(noSessions, http.MethodGet, liveTransactionsPath, nil)
	if recorder.Code != http.StatusUnauthorized {
		t.Fatalf("sin SessionManager: status = %d, se esperaba 401", recorder.Code)
	}
}

func TestLiveAPIRejectsNonGET(t *testing.T) {
	api, _, cookie, _ := newLiveTestAPI(t)
	for _, method := range []string{
		http.MethodPost, http.MethodPut, http.MethodPatch,
		http.MethodDelete, http.MethodHead,
	} {
		for _, target := range liveRoutes() {
			recorder := liveDo(api, method, target, cookie)
			if recorder.Code != http.StatusMethodNotAllowed {
				t.Fatalf("%s %s: status = %d, se esperaba 405 (cuerpo %q)",
					method, target, recorder.Code, recorder.Body.String())
			}
			if got := recorder.Header().Get("Allow"); got != http.MethodGet {
				t.Fatalf("%s %s: Allow = %q, se esperaba GET", method, target, got)
			}
			assertLiveJSONHeaders(t, recorder)
			if status := decodeLiveStatus(t, recorder); status != "method_not_allowed" {
				t.Fatalf("%s %s: status = %q", method, target, status)
			}
		}
	}
}

func TestLiveAPIRejectsUnknownRoutes(t *testing.T) {
	api, _, cookie, _ := newLiveTestAPI(t)
	for _, target := range []string{
		"/api/live", "/api/live/", "/api/live/unknown",
		"/api/live/markets", "/api/live/markets/",
		"/api/live/markets/BANK_CUP/", "/api/live/markets/BANK_CUP/extra",
		"/api/live/transactions/", "/api/live/transactions/extra",
		"/api/dashboard", "/api/mobile/overview",
	} {
		recorder := liveDo(api, http.MethodGet, target, cookie)
		if recorder.Code != http.StatusNotFound {
			t.Fatalf("%s: status = %d, se esperaba 404 (cuerpo %q)",
				target, recorder.Code, recorder.Body.String())
		}
		assertLiveJSONHeaders(t, recorder)
		if status := decodeLiveStatus(t, recorder); status != "not_found" {
			t.Fatalf("%s: status = %q", target, status)
		}
	}

	// La ruta se resuelve antes que el método: una ruta desconocida es 404.
	recorder := liveDo(api, http.MethodPost, "/api/live/unknown", cookie)
	if recorder.Code != http.StatusNotFound {
		t.Fatalf("POST desconocido: status = %d, se esperaba 404", recorder.Code)
	}
}

func TestLiveAPIRejectsInvalidCoin(t *testing.T) {
	api, store, cookie, _ := newLiveTestAPI(t)
	for _, coin := range []string{
		"BANK.CUP",
		"BANK%20CUP",
		"coin!",
		"coin%2Bplus",
		strings.Repeat("A", 33),
	} {
		store.marketCoins = nil
		recorder := liveDo(api, http.MethodGet, liveMarketsPrefix+coin, cookie)
		if recorder.Code != http.StatusBadRequest {
			t.Fatalf("%q: status = %d, se esperaba 400 (cuerpo %q)",
				coin, recorder.Code, recorder.Body.String())
		}
		assertLiveJSONHeaders(t, recorder)
		if status := decodeLiveStatus(t, recorder); status != "invalid_coin" {
			t.Fatalf("%q: status = %q", coin, status)
		}
		if len(store.marketCoins) != 0 {
			t.Fatalf("%q: no debe consultarse el store, coins = %v", coin, store.marketCoins)
		}
	}
}

func TestLiveAPIAcceptsValidCoins(t *testing.T) {
	api, store, cookie, _ := newLiveTestAPI(t)
	store.market = LiveMarket{}

	for _, coin := range []string{"A", "bank-cup_1", strings.Repeat("Z", 32)} {
		store.marketCoins = nil
		recorder := liveDo(api, http.MethodGet, liveMarketsPrefix+coin, cookie)
		if recorder.Code != http.StatusOK {
			t.Fatalf("%q: status = %d (cuerpo %q)",
				coin, recorder.Code, recorder.Body.String())
		}
		got := decodeLiveData[LiveMarket](t, recorder)
		if got.Coin != coin {
			t.Fatalf("%q: coin = %q", coin, got.Coin)
		}
		if got.Offers == nil || len(got.Offers) != 0 {
			t.Fatalf("%q: offers = %#v, se esperaba slice vacío no nil", coin, got.Offers)
		}
		if len(store.marketCoins) != 1 || store.marketCoins[0] != coin {
			t.Fatalf("%q: coins consultados = %v", coin, store.marketCoins)
		}
	}
}

func TestLiveAPIClampsTransactionsLimit(t *testing.T) {
	api, store, cookie, _ := newLiveTestAPI(t)
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
		store.transactionLimits = nil
		recorder := liveDo(api, http.MethodGet, liveTransactionsPath+testCase.query, cookie)
		if recorder.Code != http.StatusOK {
			t.Fatalf("transactions%s: status = %d", testCase.query, recorder.Code)
		}
		if len(store.transactionLimits) != 1 ||
			store.transactionLimits[0] != testCase.want {
			t.Fatalf("transactions%s: límites = %v, se esperaba %d",
				testCase.query, store.transactionLimits, testCase.want)
		}
	}
}

func TestLiveAPIEmitsEmptyArrays(t *testing.T) {
	api, store, cookie, _ := newLiveTestAPI(t)
	store.market = LiveMarket{Coin: "BANK_CUP"}
	store.transactions = nil

	marketRecorder := liveDo(api, http.MethodGet, liveMarketsPrefix+"BANK_CUP", cookie)
	if marketRecorder.Code != http.StatusOK {
		t.Fatalf("market: status = %d", marketRecorder.Code)
	}
	if body := marketRecorder.Body.String(); !strings.Contains(body, `"offers":[]`) {
		t.Fatalf("market: cuerpo = %q, se esperaba offers vacío", body)
	}
	if got := decodeLiveData[LiveMarket](t, marketRecorder); got.Offers == nil {
		t.Fatal("market: offers no debe ser nil tras decodificar")
	}

	transactions := liveDo(api, http.MethodGet, liveTransactionsPath, cookie)
	if transactions.Code != http.StatusOK {
		t.Fatalf("transactions: status = %d", transactions.Code)
	}
	if body := transactions.Body.String(); !strings.Contains(body, `"data":[]`) {
		t.Fatalf("transactions: cuerpo = %q, se esperaba data vacío", body)
	}
}

func TestLiveAPIMapsStoreErrorsToUnavailable(t *testing.T) {
	api, store, cookie, _ := newLiveTestAPI(t)
	store.err = fmt.Errorf("fuente caída")

	for _, target := range liveRoutes() {
		recorder := liveDo(api, http.MethodGet, target, cookie)
		if recorder.Code != http.StatusServiceUnavailable {
			t.Fatalf("%s: status = %d, se esperaba 503 (cuerpo %q)",
				target, recorder.Code, recorder.Body.String())
		}
		assertLiveJSONHeaders(t, recorder)
		if status := decodeLiveStatus(t, recorder); status != "unavailable" {
			t.Fatalf("%s: status = %q", target, status)
		}
	}
}

func TestLiveAPINilStoreIsUnavailable(t *testing.T) {
	api, _, cookie, _ := newLiveTestAPI(t)
	api.Store = nil

	for _, target := range liveRoutes() {
		recorder := liveDo(api, http.MethodGet, target, cookie)
		if recorder.Code != http.StatusServiceUnavailable {
			t.Fatalf("%s: status = %d, se esperaba 503", target, recorder.Code)
		}
	}
}

// livePostgresTestSetup abre el pool de pruebas y registra una limpieza
// limitada al prefijo del test, sin truncar tablas compartidas.
func livePostgresTestSetup(t *testing.T) (*pgxpool.Pool, *PostgresLiveStore, string) {
	t.Helper()
	dsn := os.Getenv("TEST_POSTGRES_URL")
	if dsn == "" {
		t.Skip("TEST_POSTGRES_URL no configurado")
	}
	pool, err := pgxpool.New(context.Background(), dsn)
	if err != nil {
		t.Fatal(err)
	}
	prefix := fmt.Sprintf("live-api-test-%d", time.Now().UnixNano())
	store := &PostgresLiveStore{Pool: pool}
	t.Cleanup(func() {
		ctx := context.Background()
		_, _ = pool.Exec(ctx,
			`DELETE FROM shadow.qvapay_transactions WHERE run_id = $1`, prefix)
		_, _ = pool.Exec(ctx,
			`DELETE FROM shadow.qvapay_offers WHERE run_id = $1`, prefix)
		_, _ = pool.Exec(ctx,
			`DELETE FROM shadow.qvapay_snapshots WHERE run_id = $1`, prefix)
		pool.Close()
	})
	return pool, store, prefix
}

func liveInsertSnapshot(t *testing.T, pool *pgxpool.Pool, runID string) {
	t.Helper()
	if _, err := pool.Exec(context.Background(), `
		INSERT INTO shadow.qvapay_snapshots
			(run_id, user_uuid, balance, offers, averages, captured_at)
		VALUES ($1, $2, '0', 4, 0, 1000)`, runID, runID+"-user"); err != nil {
		t.Fatalf("insertar snapshot %s: %v", runID, err)
	}
}

func liveInsertOffer(
	t *testing.T,
	pool *pgxpool.Pool,
	runID, offerID, coin, side string,
	capturedAt int64,
) {
	t.Helper()
	if _, err := pool.Exec(context.Background(), `
		INSERT INTO shadow.qvapay_offers
			(run_id, offer_uuid, coin, type, amount, receive, rate, status, captured_at)
		VALUES ($1, $2, $3, $4, '10', '18000', '1800', 'open', $5)`,
		runID, offerID, coin, side, capturedAt); err != nil {
		t.Fatalf("insertar oferta %s: %v", offerID, err)
	}
}

func TestPostgresLiveStoreMarket(t *testing.T) {
	pool, store, prefix := livePostgresTestSetup(t)
	ctx := context.Background()
	const base int64 = 9_000_000_000_000_000
	coin := prefix + "-CUP"

	liveInsertSnapshot(t, pool, prefix)
	liveInsertOffer(t, pool, prefix, prefix+"-offer-0", coin, "buy", base)
	liveInsertOffer(t, pool, prefix, prefix+"-offer-1", coin, "sell", base+2)
	liveInsertOffer(t, pool, prefix, prefix+"-offer-2", coin, "buy", base+1)
	liveInsertOffer(t, pool, prefix, prefix+"-other", prefix+"-OTHER", "sell", base+10)

	market, err := store.Market(ctx, coin)
	if err != nil {
		t.Fatal(err)
	}
	if market.Coin != coin {
		t.Fatalf("coin = %q, se esperaba %q", market.Coin, coin)
	}
	if len(market.Offers) != 3 {
		t.Fatalf("offers = %+v, se esperaban 3", market.Offers)
	}
	if market.Offers[0].UUID != prefix+"-offer-1" ||
		market.Offers[1].UUID != prefix+"-offer-2" ||
		market.Offers[2].UUID != prefix+"-offer-0" {
		t.Fatalf("orden de offers = %+v", market.Offers)
	}
	first := market.Offers[0]
	if first.Type != "sell" || first.Status != "open" ||
		first.Amount != "10" || first.Receive != "18000" ||
		first.Rate != "1800" || first.CapturedAt != base+2 {
		t.Fatalf("offer inesperada = %+v", first)
	}

	empty, err := store.Market(ctx, prefix+"-UNKNOWN")
	if err != nil {
		t.Fatal(err)
	}
	if empty.Coin != prefix+"-UNKNOWN" || empty.Offers == nil || len(empty.Offers) != 0 {
		t.Fatalf("mercado sin datos = %#v, se esperaba offers vacío no nil", empty)
	}
}

func TestPostgresLiveStoreMarketLimit(t *testing.T) {
	pool, store, prefix := livePostgresTestSetup(t)
	ctx := context.Background()
	const base int64 = 9_100_000_000_000_000
	coin := prefix + "-BULK"

	liveInsertSnapshot(t, pool, prefix)
	if _, err := pool.Exec(ctx, `
		INSERT INTO shadow.qvapay_offers
			(run_id, offer_uuid, coin, type, amount, receive, rate, status, captured_at)
		SELECT $1, $2 || '-bulk-' || g, $3, 'buy', '10', '18000', '1800', 'open',
		       $4::bigint + g::bigint
		FROM generate_series(1, 105) AS g`, prefix, prefix, coin, base); err != nil {
		t.Fatal(err)
	}

	market, err := store.Market(ctx, coin)
	if err != nil {
		t.Fatal(err)
	}
	if len(market.Offers) != liveMarketOffersLimit {
		t.Fatalf("offers = %d, se esperaban %d",
			len(market.Offers), liveMarketOffersLimit)
	}
	if got := market.Offers[0].CapturedAt; got != base+105 {
		t.Fatalf("captured_at más reciente = %d, se esperaba %d", got, base+105)
	}
	if got := market.Offers[len(market.Offers)-1].CapturedAt; got != base+6 {
		t.Fatalf("captured_at menos reciente = %d, se esperaba %d", got, base+6)
	}
}

func TestPostgresLiveStoreTransactions(t *testing.T) {
	pool, store, prefix := livePostgresTestSetup(t)
	ctx := context.Background()
	const base int64 = 9_200_000_000_000_000

	liveInsertSnapshot(t, pool, prefix)
	for index, capturedAt := range []int64{base, base + 2, base + 1} {
		if _, err := pool.Exec(ctx, `
			INSERT INTO shadow.qvapay_transactions
				(run_id, transaction_uuid, amount, status, description,
				 remote_id, created_at, updated_at, captured_at)
			VALUES ($1, $2, $3, 'completed', $4, '', $5, $6, $7)`,
			prefix, fmt.Sprintf("%s-tx-%d", prefix, index),
			fmt.Sprintf("%d.50", index), fmt.Sprintf("Pago %d", index),
			"2026-11-14T10:00:00Z", "2026-11-14T10:05:00Z", capturedAt); err != nil {
			t.Fatalf("insertar transacción %d: %v", index, err)
		}
	}

	transactions, err := store.Transactions(ctx, 20)
	if err != nil {
		t.Fatal(err)
	}
	if len(transactions) != 3 {
		t.Fatalf("transactions = %+v, se esperaban 3", transactions)
	}
	if transactions[0].UUID != prefix+"-tx-1" ||
		transactions[1].UUID != prefix+"-tx-2" ||
		transactions[2].UUID != prefix+"-tx-0" {
		t.Fatalf("orden de transactions = %+v", transactions)
	}
	first := transactions[0]
	if first.Amount != "1.50" || first.Status != "completed" ||
		first.Description != "Pago 1" ||
		first.CreatedAt != "2026-11-14T10:00:00Z" ||
		first.UpdatedAt != "2026-11-14T10:05:00Z" ||
		first.CapturedAt != base+2 {
		t.Fatalf("transacción inesperada = %+v", first)
	}

	limited, err := store.Transactions(ctx, 2)
	if err != nil {
		t.Fatal(err)
	}
	if len(limited) != 2 || limited[0].UUID != prefix+"-tx-1" ||
		limited[1].UUID != prefix+"-tx-2" {
		t.Fatalf("transactions limitadas = %+v", limited)
	}

	empty, err := store.Transactions(ctx, 0)
	if err != nil {
		t.Fatal(err)
	}
	if empty == nil || len(empty) != 0 {
		t.Fatalf("Transactions(0) = %#v, se esperaba slice vacío no nil", empty)
	}
}
