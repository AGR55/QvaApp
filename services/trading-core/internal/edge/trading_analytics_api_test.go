package edge

import (
	"encoding/json"
	"math"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

const tradingAnalyticsTestAccount = "account-1"

// tradingAnalyticsTestEnvelope replica el sobre de la respuesta.
type tradingAnalyticsTestEnvelope struct {
	Data   tradingAnalyticsReport `json:"data"`
	Source string                 `json:"source"`
}

func newTradingAnalyticsTestAPI(
	t *testing.T,
	now time.Time,
) (*TradingAnalyticsAPI, *http.Cookie) {
	t.Helper()
	manager := newSessionTestManager(t, 15*time.Minute)
	token, _, err := manager.Issue(now)
	if err != nil {
		t.Fatalf("Issue: %v", err)
	}
	api := &TradingAnalyticsAPI{
		Sessions: manager,
		File:     filepath.Join(t.TempDir(), "dashboard-snapshot.json"),
		Now:      func() time.Time { return now },
	}
	return api, &http.Cookie{Name: CookieName, Value: token}
}

func tradingAnalyticsDo(
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

func tradingAnalyticsWriteJSON(t *testing.T, path string, value any) {
	t.Helper()
	raw, err := json.Marshal(value)
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}
	if err := os.WriteFile(path, raw, 0o600); err != nil {
		t.Fatalf("WriteFile(%q): %v", path, err)
	}
}

func tradingAnalyticsWriteRaw(t *testing.T, path, content string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatalf("WriteFile(%q): %v", path, err)
	}
}

func tradingAnalyticsAssertHeaders(
	t *testing.T,
	recorder *httptest.ResponseRecorder,
) {
	t.Helper()
	if got := recorder.Header().Get("Content-Type"); !strings.HasPrefix(got, "application/json") {
		t.Fatalf("Content-Type = %q, se esperaba JSON", got)
	}
	if got := recorder.Header().Get("Cache-Control"); got != "no-store" {
		t.Fatalf("Cache-Control = %q, se esperaba no-store", got)
	}
	if got := recorder.Header().Get("X-Content-Type-Options"); got != "nosniff" {
		t.Fatalf("X-Content-Type-Options = %q, se esperaba nosniff", got)
	}
	if got := recorder.Header().Get("Access-Control-Allow-Origin"); got != "" {
		t.Fatalf("no debe emitirse CORS, Access-Control-Allow-Origin = %q", got)
	}
	if len(recorder.Result().Cookies()) != 0 {
		t.Fatal("la API de analítica no debe emitir cookies")
	}
}

func tradingAnalyticsDecode(
	t *testing.T,
	recorder *httptest.ResponseRecorder,
) (tradingAnalyticsTestEnvelope, map[string]json.RawMessage) {
	t.Helper()
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(recorder.Body.Bytes(), &fields); err != nil {
		t.Fatalf("JSON inválido: %v (cuerpo %q)", err, recorder.Body.String())
	}
	if len(fields) != 2 || fields["data"] == nil || fields["source"] == nil {
		t.Fatalf("el sobre debe tener data y source, claves = %v", fields)
	}
	var envelope tradingAnalyticsTestEnvelope
	if err := json.Unmarshal(recorder.Body.Bytes(), &envelope); err != nil {
		t.Fatalf("sobre: %v (cuerpo %q)", err, recorder.Body.String())
	}
	return envelope, fields
}

func tradingAnalyticsStatus(t *testing.T, recorder *httptest.ResponseRecorder) string {
	t.Helper()
	var body map[string]string
	if err := json.Unmarshal(recorder.Body.Bytes(), &body); err != nil {
		t.Fatalf("JSON inválido: %v (cuerpo %q)", err, recorder.Body.String())
	}
	return body["status"]
}

func tradingAnalyticsExpectStatus(
	t *testing.T,
	recorder *httptest.ResponseRecorder,
	want int,
	status string,
) {
	t.Helper()
	if recorder.Code != want {
		t.Fatalf("status = %d, se esperaba %d (cuerpo %q)",
			recorder.Code, want, recorder.Body.String())
	}
	tradingAnalyticsAssertHeaders(t, recorder)
	if status != "" {
		if got := tradingAnalyticsStatus(t, recorder); got != status {
			t.Fatalf("status = %q, se esperaba %q", got, status)
		}
	}
}

func tradingAnalyticsClose(t *testing.T, label string, got, want float64) {
	t.Helper()
	if math.Abs(got-want) > 1e-6 {
		t.Fatalf("%s = %v, se esperaba %v", label, got, want)
	}
}

func tradingAnalyticsAt(day, hour int) int64 {
	return time.Date(2026, time.January, day, hour, 0, 0, 0, time.UTC).UnixMilli()
}

// tradingAnalyticsFixture cubre compra con fee, compra sin fee, venta FIFO
// entre dos lotes, compra parcial, transacción desconocida, transacción
// futura, duplicado y una oferta completada en otro mercado.
func tradingAnalyticsFixture(now time.Time) map[string]any {
	buyOne := map[string]any{
		"uuid": "tx-buy-1", "amount": 10.0,
		"createdAt": tradingAnalyticsAt(15, 12), "updatedAt": tradingAnalyticsAt(15, 12),
		"payerUuid": "peer-1", "recipientUuid": tradingAnalyticsTestAccount,
		"p2p": map[string]any{
			"uuid": "buy-1", "coin": "CLASICA", "amount": 10.0,
			"receive": 100.0, "status": "completed",
		},
	}
	return map[string]any{
		"analytics": map[string]any{
			"accountUuid": tradingAnalyticsTestAccount,
			"markets": []any{
				map[string]any{"code": "CLASICA", "label": "Clásica", "currency": "CUP"},
				map[string]any{"code": "USD", "label": "Dólar", "currency": "USD"},
				// Mercado configurado sin operaciones: no debe aparecer.
				map[string]any{"code": "EUR", "label": "Euro", "currency": "EUR"},
			},
			"transactions": []any{
				buyOne,
				map[string]any{
					"uuid": "tx-buy-1b", "amount": 5.0,
					"createdAt": tradingAnalyticsAt(15, 20), "updatedAt": tradingAnalyticsAt(15, 20),
					"payerUuid": "peer-1", "recipientUuid": tradingAnalyticsTestAccount,
					"p2p": map[string]any{
						"uuid": "buy-1b", "coin": "CLASICA", "amount": 5.0,
						"receive": 60.0, "status": "completed",
					},
				},
				map[string]any{
					"uuid": "tx-sell-1", "amount": 12.0,
					"createdAt": tradingAnalyticsAt(16, 12), "updatedAt": tradingAnalyticsAt(16, 12),
					"payerUuid": tradingAnalyticsTestAccount, "recipientUuid": "peer-2",
					"p2p": map[string]any{
						"uuid": "sell-1", "coin": "CLASICA", "amount": 12.0,
						"receive": 180.0, "status": "completed",
					},
				},
				map[string]any{
					"uuid": "tx-buy-2", "amount": 20.0,
					"createdAt": tradingAnalyticsAt(17, 12), "updatedAt": tradingAnalyticsAt(17, 12),
					"payerUuid": "peer-1", "recipientUuid": tradingAnalyticsTestAccount,
					"p2p": map[string]any{
						"uuid": "buy-2", "coin": "CLASICA", "amount": 20.0,
						"receive": 200.0, "status": "completed",
					},
				},
				map[string]any{
					"uuid": "tx-unknown", "amount": 3.0,
					"createdAt": tradingAnalyticsAt(18, 12), "updatedAt": tradingAnalyticsAt(18, 12),
					"payerUuid": "someone", "recipientUuid": "other",
				},
				map[string]any{
					"uuid": "tx-future", "amount": 99.0,
					"createdAt": now.Add(24 * time.Hour).UnixMilli(),
					"updatedAt": now.Add(24 * time.Hour).UnixMilli(),
					"payerUuid": "peer-1", "recipientUuid": tradingAnalyticsTestAccount,
				},
				// Duplicado exacto: debe contar una sola vez.
				buyOne,
			},
			"fiatMovements": []any{
				map[string]any{"uuid": "buy-1", "direction": "debit", "amount": 100.0},
				map[string]any{"uuid": "buy-1b", "direction": "debit", "amount": 60.0},
				map[string]any{"uuid": "sell-1", "direction": "credit", "amount": 180.0},
				// Compra parcial: 50 < 200 nominales.
				map[string]any{"uuid": "buy-2", "direction": "debit", "amount": 50.0},
			},
			"fees": []any{
				map[string]any{
					"uuid": "buy-1", "grossQusd": 10.0, "feeQusd": 1.0,
					"evidence": "captura", "version": 1, "updatedAt": 1,
				},
				map[string]any{
					"uuid": "buy-1b", "grossQusd": 5.0, "feeQusd": 0.5,
					"evidence": "captura", "version": 1, "updatedAt": 1,
				},
			},
			"offers": []any{
				map[string]any{
					"uuid": "offer-usd-1", "coin": "USD", "amount": 2.0,
					"receive": 40.0, "side": "outgoing",
					"completedAt": tradingAnalyticsAt(19, 12),
				},
			},
		},
	}
}

func TestTradingAnalyticsAPIBuildsReport(t *testing.T) {
	now := time.Date(2026, time.January, 20, 18, 0, 0, 0, time.UTC)
	api, cookie := newTradingAnalyticsTestAPI(t, now)
	tradingAnalyticsWriteJSON(t, api.File, tradingAnalyticsFixture(now))

	recorder := tradingAnalyticsDo(
		api, http.MethodGet, tradingAnalyticsPath+"?days=7", cookie,
	)
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d (cuerpo %q)", recorder.Code, recorder.Body.String())
	}
	tradingAnalyticsAssertHeaders(t, recorder)

	envelope, fields := tradingAnalyticsDecode(t, recorder)
	if envelope.Source != "sqlite" {
		t.Fatalf("source = %q", envelope.Source)
	}
	report := envelope.Data

	if report.Days != 7 || report.Start != "2026-01-14" ||
		report.End != "2026-01-20" {
		t.Fatalf("periodo = %d %s..%s", report.Days, report.Start, report.End)
	}
	if report.GeneratedAt != now.UnixMilli() {
		t.Fatalf("generatedAt = %d, se esperaba %d",
			report.GeneratedAt, now.UnixMilli())
	}
	if len(report.Daily) != 7 {
		t.Fatalf("daily tiene %d filas", len(report.Daily))
	}

	daily := make(map[string]tradingAnalyticsDaily, len(report.Daily))
	for _, row := range report.Daily {
		daily[row.Date] = row
	}
	for _, date := range []string{
		"2026-01-14", "2026-01-15", "2026-01-16", "2026-01-17",
		"2026-01-18", "2026-01-19", "2026-01-20",
	} {
		if _, ok := daily[date]; !ok {
			t.Fatalf("falta el día %s en daily: %+v", date, report.Daily)
		}
	}
	jan15 := daily["2026-01-15"]
	tradingAnalyticsClose(t, "daily 15 incoming", jan15.Incoming, 15)
	tradingAnalyticsClose(t, "daily 15 bought", jan15.Bought, 15)
	if jan15.Count != 2 {
		t.Fatalf("daily 15 count = %d", jan15.Count)
	}
	jan16 := daily["2026-01-16"]
	tradingAnalyticsClose(t, "daily 16 outgoing", jan16.Outgoing, 12)
	tradingAnalyticsClose(t, "daily 16 sold", jan16.Sold, 12)
	if jan16.Count != 1 {
		t.Fatalf("daily 16 count = %d", jan16.Count)
	}
	jan17 := daily["2026-01-17"]
	tradingAnalyticsClose(t, "daily 17 incoming", jan17.Incoming, 20)
	tradingAnalyticsClose(t, "daily 17 bought", jan17.Bought, 20)
	jan18 := daily["2026-01-18"]
	tradingAnalyticsClose(t, "daily 18 unknown", jan18.Unknown, 3)
	if jan18.Count != 1 {
		t.Fatalf("daily 18 count = %d", jan18.Count)
	}
	jan19 := daily["2026-01-19"]
	tradingAnalyticsClose(t, "daily 19 sold", jan19.Sold, 2)
	if jan19.Count != 0 {
		t.Fatalf("daily 19 count = %d, las ofertas no cuentan como transacciones", jan19.Count)
	}

	if len(report.Markets) != 2 {
		t.Fatalf("markets = %+v, se esperaban CLASICA y USD", report.Markets)
	}
	clasica := report.Markets[0]
	if clasica.Code != "CLASICA" || clasica.Label != "Clásica" ||
		clasica.Currency != "CUP" {
		t.Fatalf("primer mercado = %+v", clasica)
	}
	if clasica.Count != 4 {
		t.Fatalf("CLASICA count = %d", clasica.Count)
	}
	tradingAnalyticsClose(t, "CLASICA volume", clasica.Volume, 47)
	tradingAnalyticsClose(t, "CLASICA bought", clasica.Bought, 35)
	tradingAnalyticsClose(t, "CLASICA sold", clasica.Sold, 12)
	tradingAnalyticsClose(t, "CLASICA fiatSpent", clasica.FiatSpent, 210)
	tradingAnalyticsClose(t, "CLASICA fiatReceived", clasica.FiatReceived, 180)
	// FIFO: 9 unidades del primer lote (100) y 3 del segundo (40).
	tradingAnalyticsClose(t, "CLASICA estimatedProfit", clasica.EstimatedProfit, 40)
	tradingAnalyticsClose(t, "CLASICA matchedQusd", clasica.MatchedQusd, 12)
	tradingAnalyticsClose(t, "CLASICA unmatchedSoldQusd", clasica.UnmatchedSoldQusd, 0)
	tradingAnalyticsClose(t, "CLASICA matchedCost", clasica.MatchedCost, 140)
	tradingAnalyticsClose(t, "CLASICA documentedProfit", clasica.DocumentedProfit, 40)
	tradingAnalyticsClose(t, "CLASICA documentedMatchedQusd", clasica.DocumentedMatchedQusd, 12)
	tradingAnalyticsClose(t, "CLASICA recordedFeesQusd", clasica.RecordedFeesQusd, 1.5)

	usd := report.Markets[1]
	if usd.Code != "USD" || usd.Label != "Dólar" || usd.Currency != "USD" {
		t.Fatalf("segundo mercado = %+v", usd)
	}
	if usd.Count != 1 {
		t.Fatalf("USD count = %d", usd.Count)
	}
	tradingAnalyticsClose(t, "USD volume", usd.Volume, 2)
	tradingAnalyticsClose(t, "USD sold", usd.Sold, 2)
	tradingAnalyticsClose(t, "USD fiatReceived", usd.FiatReceived, 40)
	tradingAnalyticsClose(t, "USD unmatchedSoldQusd", usd.UnmatchedSoldQusd, 2)
	tradingAnalyticsClose(t, "USD estimatedProfit", usd.EstimatedProfit, 0)
	for _, row := range report.Markets {
		if row.Code == "EUR" {
			t.Fatal("un mercado sin operaciones no debe aparecer")
		}
	}

	if len(report.Profits) != 2 {
		t.Fatalf("profits = %+v", report.Profits)
	}
	if report.Profits[0].Date != "2026-01-16" ||
		report.Profits[0].Currency != "CUP" {
		t.Fatalf("profits[0] = %+v", report.Profits[0])
	}
	tradingAnalyticsClose(t, "profits[0].profit", report.Profits[0].Profit, 40)
	if report.Profits[1].Date != "2026-01-19" ||
		report.Profits[1].Currency != "USD" {
		t.Fatalf("profits[1] = %+v", report.Profits[1])
	}
	tradingAnalyticsClose(t, "profits[1].profit", report.Profits[1].Profit, 0)

	if len(report.Currencies) != 2 {
		t.Fatalf("currencies = %+v", report.Currencies)
	}
	if report.Currencies[0].Currency != "CUP" ||
		report.Currencies[1].Currency != "USD" {
		t.Fatalf("orden de currencies = %+v", report.Currencies)
	}
	tradingAnalyticsClose(t, "CUP profit", report.Currencies[0].Profit, 40)
	tradingAnalyticsClose(t, "CUP matchedQusd", report.Currencies[0].MatchedQusd, 12)
	tradingAnalyticsClose(t, "CUP documentedProfit", report.Currencies[0].DocumentedProfit, 40)
	tradingAnalyticsClose(t, "CUP documentedMatchedQusd", report.Currencies[0].DocumentedMatchedQusd, 12)
	for _, value := range []float64{
		report.Currencies[1].Profit,
		report.Currencies[1].MatchedQusd,
		report.Currencies[1].DocumentedProfit,
		report.Currencies[1].DocumentedMatchedQusd,
	} {
		tradingAnalyticsClose(t, "USD currency", value, 0)
	}

	if report.Totals.Count != 5 {
		t.Fatalf("totals.count = %d", report.Totals.Count)
	}
	tradingAnalyticsClose(t, "totals.incoming", report.Totals.Incoming, 35)
	tradingAnalyticsClose(t, "totals.outgoing", report.Totals.Outgoing, 12)
	tradingAnalyticsClose(t, "totals.unknown", report.Totals.Unknown, 3)

	tradingAnalyticsClose(t, "volume", report.Volume, 49)
	if report.Completed != 5 {
		t.Fatalf("completed = %d", report.Completed)
	}

	if report.Coverage.Transactions != 5 {
		t.Fatalf("coverage.transactions = %d, se esperaban 5 tras deduplicar y filtrar el futuro",
			report.Coverage.Transactions)
	}
	if report.Coverage.OldestAt == nil ||
		*report.Coverage.OldestAt != tradingAnalyticsAt(15, 12) {
		t.Fatalf("coverage.oldestAt = %v", report.Coverage.OldestAt)
	}
	if report.Coverage.UnknownDirection != 1 {
		t.Fatalf("coverage.unknownDirection = %d", report.Coverage.UnknownDirection)
	}
	tradingAnalyticsClose(t, "coverage.unmatchedSoldQusd",
		report.Coverage.UnmatchedSoldQusd, 2)
	tradingAnalyticsClose(t, "coverage.partialPurchaseQusd",
		report.Coverage.PartialPurchaseQusd, 20)

	if !report.Sync.AccountKnown || report.Sync.Complete ||
		report.Sync.Limited || report.Sync.OffersComplete ||
		report.Sync.OfferPages != 0 || report.Sync.Pages != 0 {
		t.Fatalf("sync = %+v", report.Sync)
	}
	if report.Sync.UpdatedAt != nil {
		t.Fatalf("sync.updatedAt = %v, se esperaba null", report.Sync.UpdatedAt)
	}
	if report.PortfolioStatus != nil {
		t.Fatalf("portfolioStatus = %v, se esperaba null", report.PortfolioStatus)
	}

	data := string(fields["data"])
	for _, fragment := range []string{
		`"balanceHistory":[]`,
		`"portfolioHistory":[]`,
		`"portfolioStatus":null`,
		`"updatedAt":null`,
	} {
		if !strings.Contains(data, fragment) {
			t.Fatalf("la respuesta no contiene %s: %s", fragment, data)
		}
	}
}

func TestTradingAnalyticsAPIRequiresSession(t *testing.T) {
	now := time.Date(2026, time.January, 20, 18, 0, 0, 0, time.UTC)
	api, _ := newTradingAnalyticsTestAPI(t, now)
	tradingAnalyticsWriteJSON(t, api.File, tradingAnalyticsFixture(now))

	expiredToken, _, err := api.Sessions.Issue(now.Add(-2 * time.Hour))
	if err != nil {
		t.Fatalf("Issue: %v", err)
	}
	for name, cookie := range map[string]*http.Cookie{
		"sin cookie": nil,
		"inválida":   {Name: CookieName, Value: "no-es-un-token"},
		"expirada":   {Name: CookieName, Value: expiredToken},
		"vacía":      {Name: CookieName, Value: ""},
	} {
		t.Run(name, func(t *testing.T) {
			recorder := tradingAnalyticsDo(
				api, http.MethodGet, tradingAnalyticsPath, cookie,
			)
			tradingAnalyticsExpectStatus(
				t, recorder, http.StatusUnauthorized, "unauthenticated",
			)
			if strings.Contains(recorder.Body.String(), "CLASICA") {
				t.Fatal("una petición no autenticada no debe ver el informe")
			}
		})
	}

	t.Run("sin manejador de sesión", func(t *testing.T) {
		withoutSessions := &TradingAnalyticsAPI{
			File: api.File,
			Now:  func() time.Time { return now },
		}
		recorder := tradingAnalyticsDo(
			withoutSessions, http.MethodGet, tradingAnalyticsPath,
			&http.Cookie{Name: CookieName, Value: "cualquiera"},
		)
		tradingAnalyticsExpectStatus(
			t, recorder, http.StatusUnauthorized, "unauthenticated",
		)
	})
}

func TestTradingAnalyticsAPIRejectsNonGET(t *testing.T) {
	now := time.Date(2026, time.January, 20, 18, 0, 0, 0, time.UTC)
	api, cookie := newTradingAnalyticsTestAPI(t, now)
	tradingAnalyticsWriteJSON(t, api.File, tradingAnalyticsFixture(now))

	for _, method := range []string{
		http.MethodPost, http.MethodPut, http.MethodPatch,
		http.MethodDelete, http.MethodHead, http.MethodOptions,
	} {
		recorder := tradingAnalyticsDo(api, method, tradingAnalyticsPath, cookie)
		if recorder.Code != http.StatusMethodNotAllowed {
			t.Fatalf("%s: status = %d, se esperaba 405 (cuerpo %q)",
				method, recorder.Code, recorder.Body.String())
		}
		if got := recorder.Header().Get("Allow"); got != http.MethodGet {
			t.Fatalf("%s: Allow = %q", method, got)
		}
		tradingAnalyticsAssertHeaders(t, recorder)
		if got := tradingAnalyticsStatus(t, recorder); got != "method_not_allowed" {
			t.Fatalf("%s: status = %q", method, got)
		}
	}

	// La ruta se resuelve antes que el método: una ruta desconocida es 404.
	recorder := tradingAnalyticsDo(api, http.MethodPost, "/api/desconocida", cookie)
	tradingAnalyticsExpectStatus(t, recorder, http.StatusNotFound, "not_found")
}

func TestTradingAnalyticsAPIRejectsUnknownRoutes(t *testing.T) {
	now := time.Date(2026, time.January, 20, 18, 0, 0, 0, time.UTC)
	api, cookie := newTradingAnalyticsTestAPI(t, now)
	tradingAnalyticsWriteJSON(t, api.File, tradingAnalyticsFixture(now))

	for _, target := range []string{
		"/api",
		"/api/trading-analytics/",
		"/api/trading-analytic",
		"/api/trading-analytics/extra",
		"/api/trading-analytics/extra?days=7",
		"/api/trading",
	} {
		recorder := tradingAnalyticsDo(api, http.MethodGet, target, cookie)
		if recorder.Code != http.StatusNotFound {
			t.Fatalf("%s: status = %d, se esperaba 404 (cuerpo %q)",
				target, recorder.Code, recorder.Body.String())
		}
		tradingAnalyticsAssertHeaders(t, recorder)
		if got := tradingAnalyticsStatus(t, recorder); got != "not_found" {
			t.Fatalf("%s: status = %q", target, got)
		}
	}
}

func TestTradingAnalyticsNormalizesDays(t *testing.T) {
	now := time.Date(2026, time.January, 20, 18, 0, 0, 0, time.UTC)
	api, cookie := newTradingAnalyticsTestAPI(t, now)
	tradingAnalyticsWriteJSON(t, api.File, map[string]any{"analytics": map[string]any{}})

	for query, want := range map[string]int{
		"":          tradingAnalyticsDefaultDays,
		"?days=":    tradingAnalyticsDefaultDays,
		"?days=7":   7,
		"?days=07":  7,
		"?days=30":  30,
		"?days=90":  90,
		"?days=365": tradingAnalyticsDefaultDays,
		"?days=0":   tradingAnalyticsDefaultDays,
		"?days=-7":  tradingAnalyticsDefaultDays,
		"?days=7.5": tradingAnalyticsDefaultDays,
		"?days=abc": tradingAnalyticsDefaultDays,
		"?days=1e1": tradingAnalyticsDefaultDays,
	} {
		recorder := tradingAnalyticsDo(
			api, http.MethodGet, tradingAnalyticsPath+query, cookie,
		)
		if recorder.Code != http.StatusOK {
			t.Fatalf("%q: status = %d (cuerpo %q)",
				query, recorder.Code, recorder.Body.String())
		}
		envelope, _ := tradingAnalyticsDecode(t, recorder)
		if envelope.Data.Days != want {
			t.Fatalf("%q: days = %d, se esperaba %d",
				query, envelope.Data.Days, want)
		}
		if len(envelope.Data.Daily) != want {
			t.Fatalf("%q: daily tiene %d filas, se esperaban %d",
				query, len(envelope.Data.Daily), want)
		}
	}
}

func TestTradingAnalyticsServesEmptySnapshot(t *testing.T) {
	now := time.Date(2026, time.January, 20, 18, 0, 0, 0, time.UTC)

	cases := []struct {
		name    string
		file    string
		content string
	}{
		{"ruta vacía", "", ""},
		{"archivo inexistente", filepath.Join(t.TempDir(), "no-existe.json"), ""},
		{"contenido en blanco", filepath.Join(t.TempDir(), "blanco.json"), " \n\t "},
		{"sin bloque analytics", filepath.Join(t.TempDir(), "sin-analytics.json"), `{"devices":[]}`},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			api, cookie := newTradingAnalyticsTestAPI(t, now)
			api.File = testCase.file
			if testCase.content != "" {
				tradingAnalyticsWriteRaw(t, api.File, testCase.content)
			}

			recorder := tradingAnalyticsDo(
				api, http.MethodGet, tradingAnalyticsPath, cookie,
			)
			if recorder.Code != http.StatusOK {
				t.Fatalf("status = %d (cuerpo %q)",
					recorder.Code, recorder.Body.String())
			}
			tradingAnalyticsAssertHeaders(t, recorder)
			envelope, fields := tradingAnalyticsDecode(t, recorder)
			report := envelope.Data
			if report.Days != tradingAnalyticsDefaultDays ||
				len(report.Daily) != tradingAnalyticsDefaultDays {
				t.Fatalf("periodo vacío = %d/%d", report.Days, len(report.Daily))
			}
			if len(report.Markets) != 0 || len(report.Profits) != 0 ||
				len(report.Currencies) != 0 {
				t.Fatalf("listas no vacías: %+v", report)
			}
			if report.Volume != 0 || report.Completed != 0 {
				t.Fatalf("volume/completed = %v/%d", report.Volume, report.Completed)
			}
			if report.Totals != (tradingAnalyticsTotals{}) {
				t.Fatalf("totals = %+v", report.Totals)
			}
			if report.Coverage.Transactions != 0 ||
				report.Coverage.OldestAt != nil ||
				report.Coverage.UnknownDirection != 0 ||
				report.Coverage.UnmatchedSoldQusd != 0 ||
				report.Coverage.PartialPurchaseQusd != 0 {
				t.Fatalf("coverage = %+v", report.Coverage)
			}
			if report.Sync.AccountKnown {
				t.Fatalf("sync.accountKnown debe ser false: %+v", report.Sync)
			}
			data := string(fields["data"])
			for _, fragment := range []string{
				`"markets":[]`,
				`"profits":[]`,
				`"currencies":[]`,
				`"oldestAt":null`,
				`"balanceHistory":[]`,
				`"portfolioHistory":[]`,
				`"portfolioStatus":null`,
				`"updatedAt":null`,
			} {
				if !strings.Contains(data, fragment) {
					t.Fatalf("respuesta vacía sin %s: %s", fragment, data)
				}
			}
		})
	}
}

func TestTradingAnalyticsRejectsInvalidSnapshot(t *testing.T) {
	now := time.Date(2026, time.January, 20, 18, 0, 0, 0, time.UTC)
	api, cookie := newTradingAnalyticsTestAPI(t, now)

	for name, content := range map[string]string{
		"truncado":        `{"analytics":{"transactions":[`,
		"arreglo":         `[]`,
		"null":            `null`,
		"texto":           `no es json`,
		"basura final":    `{"analytics":{}} extra`,
		"solo apertura":   `{`,
		"coma final":      `{"analytics":{},}`,
		"tipo incorrecto": `{"analytics":{"transactions":"no"}}`,
		"analytics array": `{"analytics":[]}`,
	} {
		t.Run(name, func(t *testing.T) {
			tradingAnalyticsWriteRaw(t, api.File, content)
			recorder := tradingAnalyticsDo(
				api, http.MethodGet, tradingAnalyticsPath, cookie,
			)
			tradingAnalyticsExpectStatus(
				t, recorder, http.StatusServiceUnavailable, "unavailable",
			)
			body := recorder.Body.String()
			if strings.Contains(body, api.File) {
				t.Fatalf("la respuesta expone la ruta del archivo: %q", body)
			}
			if strings.Contains(body, "transactions") {
				t.Fatalf("la respuesta expone el contenido: %q", body)
			}
		})
	}

	t.Run("directorio", func(t *testing.T) {
		api.File = t.TempDir()
		recorder := tradingAnalyticsDo(
			api, http.MethodGet, tradingAnalyticsPath, cookie,
		)
		tradingAnalyticsExpectStatus(
			t, recorder, http.StatusServiceUnavailable, "unavailable",
		)
	})
}

func TestTradingAnalyticsRejectsOversizedSnapshot(t *testing.T) {
	now := time.Date(2026, time.January, 20, 18, 0, 0, 0, time.UTC)
	api, cookie := newTradingAnalyticsTestAPI(t, now)
	valid := []byte(`{"analytics":{}}`)

	t.Run("tamaño máximo exacto", func(t *testing.T) {
		raw := make([]byte, maxTradingAnalyticsSnapshotBytes)
		copy(raw, valid)
		for i := len(valid); i < len(raw); i++ {
			raw[i] = ' '
		}
		if err := os.WriteFile(api.File, raw, 0o600); err != nil {
			t.Fatalf("WriteFile: %v", err)
		}
		recorder := tradingAnalyticsDo(
			api, http.MethodGet, tradingAnalyticsPath, cookie,
		)
		if recorder.Code != http.StatusOK {
			t.Fatalf("status = %d (cuerpo %q)",
				recorder.Code, recorder.Body.String())
		}
	})

	t.Run("un byte de más", func(t *testing.T) {
		raw := make([]byte, maxTradingAnalyticsSnapshotBytes+1)
		copy(raw, valid)
		for i := len(valid); i < len(raw); i++ {
			raw[i] = ' '
		}
		if err := os.WriteFile(api.File, raw, 0o600); err != nil {
			t.Fatalf("WriteFile: %v", err)
		}
		recorder := tradingAnalyticsDo(
			api, http.MethodGet, tradingAnalyticsPath, cookie,
		)
		tradingAnalyticsExpectStatus(
			t, recorder, http.StatusServiceUnavailable, "unavailable",
		)
		if strings.Contains(recorder.Body.String(), api.File) {
			t.Fatal("la respuesta no debe exponer la ruta del archivo")
		}
	})
}

func TestTradingAnalyticsAPIHeaders(t *testing.T) {
	now := time.Date(2026, time.January, 20, 18, 0, 0, 0, time.UTC)
	api, cookie := newTradingAnalyticsTestAPI(t, now)
	tradingAnalyticsWriteJSON(t, api.File, tradingAnalyticsFixture(now))

	cases := []struct {
		name   string
		method string
		target string
		cookie *http.Cookie
		want   int
	}{
		{"ok", http.MethodGet, tradingAnalyticsPath, cookie, http.StatusOK},
		{"no autenticado", http.MethodGet, tradingAnalyticsPath, nil, http.StatusUnauthorized},
		{"ruta desconocida", http.MethodGet, "/api/desconocida", cookie, http.StatusNotFound},
		{"método", http.MethodPost, tradingAnalyticsPath, cookie, http.StatusMethodNotAllowed},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			recorder := tradingAnalyticsDo(
				api, testCase.method, testCase.target, testCase.cookie,
			)
			if recorder.Code != testCase.want {
				t.Fatalf("status = %d, se esperaba %d (cuerpo %q)",
					recorder.Code, testCase.want, recorder.Body.String())
			}
			tradingAnalyticsAssertHeaders(t, recorder)
		})
	}

	t.Run("snapshot inválido", func(t *testing.T) {
		tradingAnalyticsWriteRaw(t, api.File, "roto")
		recorder := tradingAnalyticsDo(
			api, http.MethodGet, tradingAnalyticsPath, cookie,
		)
		if recorder.Code != http.StatusServiceUnavailable {
			t.Fatalf("status = %d, se esperaba 503", recorder.Code)
		}
		tradingAnalyticsAssertHeaders(t, recorder)
	})
}

func TestTradingAnalyticsGroupsByHavanaDay(t *testing.T) {
	// 06:00 UTC equivale a la 01:00 en La Habana. Los dos instantes están en
	// el mismo día UTC, pero pertenecen a días distintos en America/Havana.
	now := time.Date(2026, time.January, 15, 6, 0, 0, 0, time.UTC)
	api, cookie := newTradingAnalyticsTestAPI(t, now)

	late := time.Date(2026, time.January, 15, 4, 30, 0, 0, time.UTC)
	early := time.Date(2026, time.January, 15, 5, 30, 0, 0, time.UTC)

	if got := tradingAnalyticsDay(late.UnixMilli()); got != "2026-01-14" {
		t.Fatalf("medianoche: analyticsDay = %q, se esperaba 2026-01-14", got)
	}
	if got := tradingAnalyticsDay(early.UnixMilli()); got != "2026-01-15" {
		t.Fatalf("medianoche: analyticsDay = %q, se esperaba 2026-01-15", got)
	}

	tradingAnalyticsWriteJSON(t, api.File, map[string]any{
		"analytics": map[string]any{
			"accountUuid": tradingAnalyticsTestAccount,
			"transactions": []any{
				map[string]any{
					"uuid": "tx-late", "amount": 1.0,
					"createdAt": late.UnixMilli(), "updatedAt": late.UnixMilli(),
					"payerUuid": tradingAnalyticsTestAccount, "recipientUuid": "peer",
				},
				map[string]any{
					"uuid": "tx-early", "amount": 2.0,
					"createdAt": early.UnixMilli(), "updatedAt": early.UnixMilli(),
					"payerUuid": "peer", "recipientUuid": tradingAnalyticsTestAccount,
				},
			},
		},
	})

	recorder := tradingAnalyticsDo(
		api, http.MethodGet, tradingAnalyticsPath+"?days=7", cookie,
	)
	envelope, _ := tradingAnalyticsDecode(t, recorder)
	report := envelope.Data
	if report.End != "2026-01-15" || report.Start != "2026-01-09" {
		t.Fatalf("periodo = %s..%s", report.Start, report.End)
	}

	daily := make(map[string]tradingAnalyticsDaily)
	for _, row := range report.Daily {
		daily[row.Date] = row
	}
	jan14 := daily["2026-01-14"]
	tradingAnalyticsClose(t, "14 outgoing", jan14.Outgoing, 1)
	if jan14.Count != 1 {
		t.Fatalf("14 count = %d", jan14.Count)
	}
	jan15 := daily["2026-01-15"]
	tradingAnalyticsClose(t, "15 incoming", jan15.Incoming, 2)
	tradingAnalyticsClose(t, "15 outgoing", jan15.Outgoing, 0)
	if jan15.Count != 1 {
		t.Fatalf("15 count = %d", jan15.Count)
	}
}

func TestTradingAnalyticsIgnoresFlexibleParentTransactions(t *testing.T) {
	now := time.Date(2026, time.January, 20, 18, 0, 0, 0, time.UTC)
	api, cookie := newTradingAnalyticsTestAPI(t, now)

	completedAt := now.Add(-time.Hour).UnixMilli()
	createdAt := now.Add(-2 * time.Hour).UnixMilli()
	tradingAnalyticsWriteJSON(t, api.File, map[string]any{
		"analytics": map[string]any{
			"accountUuid": tradingAnalyticsTestAccount,
			"markets": []any{
				map[string]any{"code": "CLASICA", "label": "Clásica", "currency": "CUP"},
			},
			// La oferta hija declara al padre flexible como inventario.
			"offers": []any{
				map[string]any{
					"uuid": "child-1", "parentUuid": "flex-1",
					"coin": "CLASICA", "amount": 1.0, "receive": 20.0,
					"side": "incoming", "completedAt": completedAt,
				},
			},
			// Su transacción de escrow no debe convertirse en una operación.
			"transactions": []any{
				map[string]any{
					"uuid": "tx-flex", "amount": 10.0,
					"createdAt": createdAt, "updatedAt": createdAt,
					"payerUuid": "peer", "recipientUuid": tradingAnalyticsTestAccount,
					"p2p": map[string]any{
						"uuid": "flex-1", "coin": "CLASICA", "amount": 10.0,
						"receive": 100.0, "status": "completed",
					},
				},
			},
		},
	})

	recorder := tradingAnalyticsDo(
		api, http.MethodGet, tradingAnalyticsPath+"?days=7", cookie,
	)
	envelope, _ := tradingAnalyticsDecode(t, recorder)
	report := envelope.Data
	if len(report.Markets) != 1 {
		t.Fatalf("markets = %+v", report.Markets)
	}
	market := report.Markets[0]
	if market.Code != "CLASICA" || market.Count != 1 {
		t.Fatalf("mercado = %+v", market)
	}
	tradingAnalyticsClose(t, "volume", market.Volume, 1)
	tradingAnalyticsClose(t, "bought", market.Bought, 1)
	if report.Coverage.Transactions != 1 {
		t.Fatalf("coverage.transactions = %d", report.Coverage.Transactions)
	}
}
