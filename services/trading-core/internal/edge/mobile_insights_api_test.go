package edge

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strconv"
	"strings"
	"testing"
	"time"
)

const mobileInsightsTestNowUnix = 1_700_000_000

var mobileInsightsTestToken = strings.Repeat("i", 48)

func mobileInsightsTestHash(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}

func mobileInsightsTestNow() time.Time {
	return time.Unix(mobileInsightsTestNowUnix, 0)
}

func mobileInsightsTestWriteAuth(t *testing.T, path string) {
	t.Helper()
	raw, err := json.Marshal(map[string]any{
		"devices": []any{},
		"operators": []any{
			map[string]any{
				"id":        "insights-op",
				"tokenHash": mobileInsightsTestHash(mobileInsightsTestToken),
				"scopes":    []string{"read"},
				"revokedAt": nil,
			},
		},
	})
	if err != nil {
		t.Fatalf("Marshal auth: %v", err)
	}
	if err := os.WriteFile(path, raw, 0o600); err != nil {
		t.Fatalf("WriteFile(%q): %v", path, err)
	}
}

func newMobileInsightsTestAPI(t *testing.T) (*MobileInsightsAPI, string) {
	t.Helper()
	dir := t.TempDir()
	authPath := filepath.Join(dir, "mobile-auth.json")
	snapshotPath := filepath.Join(dir, "dashboard-snapshot.json")
	mobileInsightsTestWriteAuth(t, authPath)

	now := mobileInsightsTestNow()
	auth := &MobileAuthAPI{File: authPath, Now: func() time.Time { return now }}
	api := &MobileInsightsAPI{
		Auth: auth,
		File: snapshotPath,
		Now:  func() time.Time { return now },
	}
	return api, snapshotPath
}

func mobileInsightsTestWriteJSON(t *testing.T, path string, value any) {
	t.Helper()
	raw, err := json.Marshal(value)
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}
	mobileInsightsTestWriteRaw(t, path, raw)
}

func mobileInsightsTestWriteRaw(t *testing.T, path string, raw []byte) {
	t.Helper()
	if err := os.WriteFile(path, raw, 0o600); err != nil {
		t.Fatalf("WriteFile(%q): %v", path, err)
	}
}

func mobileInsightsTestDo(
	handler http.Handler,
	method string,
	target string,
	bearer string,
) *httptest.ResponseRecorder {
	request := httptest.NewRequest(method, target, nil)
	if bearer != "" {
		request.Header.Set("Authorization", "Bearer "+bearer)
	}
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)
	return recorder
}

func mobileInsightsTestDecodeData[T any](
	t *testing.T,
	recorder *httptest.ResponseRecorder,
) T {
	t.Helper()
	var envelope struct {
		Data T `json:"data"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &envelope); err != nil {
		t.Fatalf("JSON inválido: %v (cuerpo %q)", err, recorder.Body.String())
	}
	return envelope.Data
}

func mobileInsightsTestBody(
	t *testing.T,
	recorder *httptest.ResponseRecorder,
) map[string]json.RawMessage {
	t.Helper()
	var body map[string]json.RawMessage
	if err := json.Unmarshal(recorder.Body.Bytes(), &body); err != nil {
		t.Fatalf("JSON inválido: %v (cuerpo %q)", err, recorder.Body.String())
	}
	return body
}

func mobileInsightsTestStatus(
	t *testing.T,
	recorder *httptest.ResponseRecorder,
) string {
	t.Helper()
	var body map[string]string
	if err := json.Unmarshal(recorder.Body.Bytes(), &body); err != nil {
		t.Fatalf("JSON inválido: %v (cuerpo %q)", err, recorder.Body.String())
	}
	return body["status"]
}

func mobileInsightsTestAssertHeaders(
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
		t.Fatal("los insights móviles no deben emitir cookies")
	}
}

func mobileInsightsTestExpectStatus(
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
	mobileInsightsTestAssertHeaders(t, recorder)
	if status != "" {
		if got := mobileInsightsTestStatus(t, recorder); got != status {
			t.Fatalf("status = %q, se esperaba %q", got, status)
		}
	}
}

func mobileInsightsTestHealthSnapshot(health any) map[string]any {
	return map[string]any{"operationalHealth": health}
}

func TestMobileInsightsHealth(t *testing.T) {
	api, path := newMobileInsightsTestAPI(t)

	t.Run("null", func(t *testing.T) {
		mobileInsightsTestWriteJSON(t, path, mobileInsightsTestHealthSnapshot(nil))
		recorder := mobileInsightsTestDo(api, http.MethodGet, mobileInsightsPath+"?kind=health", mobileInsightsTestToken)
		mobileInsightsTestExpectStatus(t, recorder, http.StatusOK, "")
		body := mobileInsightsTestBody(t, recorder)
		if got := string(body["data"]); got != "null" {
			t.Fatalf("data = %s, se esperaba null", got)
		}
	})

	t.Run("objeto", func(t *testing.T) {
		health := map[string]any{
			"status":    "degraded",
			"checkedAt": int64(1234),
			"checks":    []any{map[string]any{"name": "db", "ok": true}},
		}
		mobileInsightsTestWriteJSON(t, path, mobileInsightsTestHealthSnapshot(health))
		recorder := mobileInsightsTestDo(api, http.MethodGet, mobileInsightsPath+"?kind=health", mobileInsightsTestToken)
		mobileInsightsTestExpectStatus(t, recorder, http.StatusOK, "")

		var data map[string]any
		if err := json.Unmarshal(mobileInsightsTestBody(t, recorder)["data"], &data); err != nil {
			t.Fatalf("data: %v", err)
		}
		if data["status"] != "degraded" {
			t.Fatalf("status = %v, se esperaba degraded", data["status"])
		}
	})

	t.Run("ausente", func(t *testing.T) {
		mobileInsightsTestWriteJSON(t, path, map[string]any{})
		recorder := mobileInsightsTestDo(api, http.MethodGet, mobileInsightsPath+"?kind=health", mobileInsightsTestToken)
		mobileInsightsTestExpectStatus(t, recorder, http.StatusOK, "")
		if got := string(mobileInsightsTestBody(t, recorder)["data"]); got != "null" {
			t.Fatalf("data = %s, se esperaba null", got)
		}
	})
}

func mobileInsightsTestProfitabilityFixture(now time.Time) map[string]any {
	account := "account-1"
	buyAt := now.Add(-48 * time.Hour).UnixMilli()
	sellAt := now.Add(-24 * time.Hour).UnixMilli()
	return map[string]any{
		"operationalHealth": nil,
		"analytics": map[string]any{
			"accountUuid": account,
			"markets": []any{
				map[string]any{"code": "CLASICA", "label": "Clásica", "currency": "CUP"},
				map[string]any{"code": "USD", "label": "Dólar", "currency": "USD"},
			},
			"transactions": []any{
				map[string]any{
					"uuid": "tx-buy", "amount": 10.0,
					"createdAt": buyAt, "updatedAt": buyAt,
					"payerUuid": "peer-1", "recipientUuid": account,
					"p2p": map[string]any{
						"uuid": "offer-buy", "coin": "CLASICA", "amount": 10.0,
						"receive": 100.0, "status": "completed",
					},
				},
				map[string]any{
					"uuid": "tx-sell", "amount": 4.0,
					"createdAt": sellAt, "updatedAt": sellAt,
					"payerUuid": account, "recipientUuid": "peer-2",
					"p2p": map[string]any{
						"uuid": "offer-sell", "coin": "CLASICA", "amount": 4.0,
						"receive": 40.0, "status": "completed",
					},
				},
			},
			"offers":        []any{},
			"fees":          []any{},
			"fiatMovements": []any{},
		},
	}
}

func TestMobileInsightsProfitability(t *testing.T) {
	api, path := newMobileInsightsTestAPI(t)
	now := mobileInsightsTestNow()
	mobileInsightsTestWriteJSON(t, path, mobileInsightsTestProfitabilityFixture(now))

	t.Run("por defecto 30 días", func(t *testing.T) {
		recorder := mobileInsightsTestDo(api, http.MethodGet, mobileInsightsPath+"?kind=profitability", mobileInsightsTestToken)
		mobileInsightsTestExpectStatus(t, recorder, http.StatusOK, "")
		report := mobileInsightsTestDecodeData[mobileInsightsProfitability](t, recorder)

		if report.Days != 30 {
			t.Fatalf("days = %d, se esperaba 30", report.Days)
		}
		if report.GeneratedAt != now.UnixMilli() {
			t.Fatalf("generatedAt = %d, se esperaba %d", report.GeneratedAt, now.UnixMilli())
		}
		if report.Limited {
			t.Fatal("limited = true, se esperaba false")
		}
		if report.Note != mobileInsightsLocalNote {
			t.Fatalf("note = %q, se esperaba %q", report.Note, mobileInsightsLocalNote)
		}
		if report.Coverage.Transactions != 2 {
			t.Fatalf("coverage.transactions = %d, se esperaba 2", report.Coverage.Transactions)
		}
		if len(report.Currencies) != 1 || report.Currencies[0].Currency != "CUP" {
			t.Fatalf("currencies = %+v, se esperaba solo CUP", report.Currencies)
		}

		// La proyección móvil no debe incluir el informe completo.
		body := mobileInsightsTestBody(t, recorder)
		var data map[string]json.RawMessage
		if err := json.Unmarshal(body["data"], &data); err != nil {
			t.Fatalf("data: %v", err)
		}
		want := []string{"days", "generatedAt", "currencies", "coverage", "limited", "note"}
		if len(data) != len(want) {
			t.Fatalf("data tiene %d claves (%v), se esperaban %d", len(data), data, len(want))
		}
		for _, key := range want {
			if _, ok := data[key]; !ok {
				t.Fatalf("falta la clave %q en data", key)
			}
		}
	})

	t.Run("días admitidos", func(t *testing.T) {
		recorder := mobileInsightsTestDo(api, http.MethodGet, mobileInsightsPath+"?kind=profitability&days=7", mobileInsightsTestToken)
		mobileInsightsTestExpectStatus(t, recorder, http.StatusOK, "")
		if got := mobileInsightsTestDecodeData[mobileInsightsProfitability](t, recorder).Days; got != 7 {
			t.Fatalf("days = %d, se esperaba 7", got)
		}
	})

	t.Run("días no admitidos usan 30", func(t *testing.T) {
		for _, target := range []string{
			mobileInsightsPath + "?kind=profitability&days=11",
			mobileInsightsPath + "?kind=profitability&days=abc",
		} {
			recorder := mobileInsightsTestDo(api, http.MethodGet, target, mobileInsightsTestToken)
			mobileInsightsTestExpectStatus(t, recorder, http.StatusOK, "")
			if got := mobileInsightsTestDecodeData[mobileInsightsProfitability](t, recorder).Days; got != 30 {
				t.Fatalf("%s: days = %d, se esperaba 30", target, got)
			}
		}
	})
}

func TestMobileInsightsProfitabilityLimited(t *testing.T) {
	api, path := newMobileInsightsTestAPI(t)
	now := mobileInsightsTestNow()
	transactions := make([]any, 0, mobileInsightsLimitedTransactions+1)
	for i := 0; i < mobileInsightsLimitedTransactions+1; i++ {
		transactions = append(transactions, map[string]any{
			"uuid":      "tx-" + strconv.Itoa(i),
			"amount":    1.0,
			"createdAt": now.UnixMilli(),
			"updatedAt": now.UnixMilli(),
		})
	}
	mobileInsightsTestWriteJSON(t, path, map[string]any{
		"analytics": map[string]any{
			"markets":      []any{},
			"transactions": transactions,
			"offers":       []any{},
		},
	})

	recorder := mobileInsightsTestDo(api, http.MethodGet, mobileInsightsPath+"?kind=profitability", mobileInsightsTestToken)
	mobileInsightsTestExpectStatus(t, recorder, http.StatusOK, "")
	report := mobileInsightsTestDecodeData[mobileInsightsProfitability](t, recorder)
	if !report.Limited {
		t.Fatal("limited = false, se esperaba true")
	}
	if report.Note != mobileInsightsLimitedNote {
		t.Fatalf("note = %q, se esperaba %q", report.Note, mobileInsightsLimitedNote)
	}
}

func mobileInsightsTestFiatEntry(id, coin string, createdAt, origin, sequence int64) map[string]any {
	return map[string]any{
		"id":        id,
		"coin":      coin,
		"before":    nil,
		"after":     nil,
		"amount":    float64(sequence),
		"uuid":      nil,
		"source":    "ledger",
		"kind":      "movement",
		"createdAt": createdAt,
		"origin":    origin,
		"sequence":  sequence,
	}
}

func TestMobileInsightsHistoryPagination(t *testing.T) {
	api, path := newMobileInsightsTestAPI(t)
	base := mobileInsightsTestNow().Add(-time.Hour).UnixMilli()
	entries := make([]any, 0, 26)
	for i := 0; i < 25; i++ {
		entries = append(entries, mobileInsightsTestFiatEntry(
			"fiat-"+strconv.Itoa(i), "CLASICA", base+int64(i), 0, int64(i)))
	}
	entries = append(entries, mobileInsightsTestFiatEntry("fiat-usd", "USD", base+100, 0, 100))
	mobileInsightsTestWriteJSON(t, path, map[string]any{
		"fiatHistory": entries,
		"analytics": map[string]any{
			"markets": []any{
				map[string]any{"code": "CLASICA", "label": "Clásica", "currency": "CUP"},
				map[string]any{"code": "USD", "label": "Dólar", "currency": "USD"},
			},
		},
	})

	decode := func(recorder *httptest.ResponseRecorder) dashboardReadPageEnvelope[dashboardReadFiatEntry] {
		return mobileInsightsTestDecodeData[dashboardReadPageEnvelope[dashboardReadFiatEntry]](t, recorder)
	}

	first := mobileInsightsTestDo(api, http.MethodGet,
		mobileInsightsPath+"?kind=history&coin=CLASICA&page=1", mobileInsightsTestToken)
	mobileInsightsTestExpectStatus(t, first, http.StatusOK, "")
	pageOne := decode(first)
	if pageOne.Page != 1 || !pageOne.HasMore || len(pageOne.Items) != 20 {
		t.Fatalf("page 1 = %+v, se esperaban 20 elementos y hasMore", pageOne)
	}
	if pageOne.Items[0].ID != "fiat-24" || pageOne.Items[19].ID != "fiat-5" {
		t.Fatalf("orden de page 1 = %q..%q", pageOne.Items[0].ID, pageOne.Items[19].ID)
	}

	second := mobileInsightsTestDo(api, http.MethodGet,
		mobileInsightsPath+"?kind=history&coin=CLASICA&page=2", mobileInsightsTestToken)
	mobileInsightsTestExpectStatus(t, second, http.StatusOK, "")
	pageTwo := decode(second)
	if pageTwo.Page != 2 || pageTwo.HasMore || len(pageTwo.Items) != 5 {
		t.Fatalf("page 2 = %+v, se esperaban 5 elementos sin hasMore", pageTwo)
	}
	if pageTwo.Items[0].ID != "fiat-4" || pageTwo.Items[4].ID != "fiat-0" {
		t.Fatalf("orden de page 2 = %q..%q", pageTwo.Items[0].ID, pageTwo.Items[4].ID)
	}

	third := mobileInsightsTestDo(api, http.MethodGet,
		mobileInsightsPath+"?kind=history&coin=CLASICA&page=3", mobileInsightsTestToken)
	mobileInsightsTestExpectStatus(t, third, http.StatusOK, "")
	pageThree := decode(third)
	if pageThree.Page != 3 || pageThree.HasMore || len(pageThree.Items) != 0 {
		t.Fatalf("page 3 = %+v, se esperaba vacía", pageThree)
	}

	// Una página fuera de rango se normaliza a 1.
	invalid := mobileInsightsTestDo(api, http.MethodGet,
		mobileInsightsPath+"?kind=history&coin=CLASICA&page=1001", mobileInsightsTestToken)
	mobileInsightsTestExpectStatus(t, invalid, http.StatusOK, "")
	if got := decode(invalid).Page; got != 1 {
		t.Fatalf("page = %d, se esperaba 1", got)
	}

	// Otra moneda no se mezcla.
	usd := mobileInsightsTestDo(api, http.MethodGet,
		mobileInsightsPath+"?kind=history&coin=USD", mobileInsightsTestToken)
	mobileInsightsTestExpectStatus(t, usd, http.StatusOK, "")
	usdPage := decode(usd)
	if len(usdPage.Items) != 1 || usdPage.Items[0].ID != "fiat-usd" {
		t.Fatalf("historial USD = %+v", usdPage.Items)
	}
}

func TestMobileInsightsHistoryOrderTiebreakers(t *testing.T) {
	api, path := newMobileInsightsTestAPI(t)
	createdAt := mobileInsightsTestNow().UnixMilli()
	mobileInsightsTestWriteJSON(t, path, map[string]any{
		"fiatHistory": []any{
			mobileInsightsTestFiatEntry("origin-1-seq-1", "CLASICA", createdAt, 1, 1),
			mobileInsightsTestFiatEntry("origin-2-seq-0", "CLASICA", createdAt, 2, 0),
			mobileInsightsTestFiatEntry("origin-1-seq-5", "CLASICA", createdAt, 1, 5),
		},
		"analytics": map[string]any{
			"markets": []any{map[string]any{"code": "CLASICA"}},
		},
	})

	recorder := mobileInsightsTestDo(api, http.MethodGet,
		mobileInsightsPath+"?kind=history&coin=CLASICA", mobileInsightsTestToken)
	mobileInsightsTestExpectStatus(t, recorder, http.StatusOK, "")
	page := mobileInsightsTestDecodeData[dashboardReadPageEnvelope[dashboardReadFiatEntry]](t, recorder)
	got := []string{page.Items[0].ID, page.Items[1].ID, page.Items[2].ID}
	want := []string{"origin-2-seq-0", "origin-1-seq-5", "origin-1-seq-1"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("orden = %v, se esperaba %v", got, want)
	}
}

func TestMobileInsightsDiagnostics(t *testing.T) {
	api, path := newMobileInsightsTestAPI(t)
	now := mobileInsightsTestNow()
	recent := now.Add(-time.Hour).UnixMilli()
	old := now.Add(-48 * time.Hour).UnixMilli()

	mobileInsightsTestWriteJSON(t, path, map[string]any{
		"analytics": map[string]any{
			"markets": []any{
				map[string]any{"code": "CLASICA", "label": "Clásica", "currency": "CUP"},
				map[string]any{"code": "USD", "label": "Dólar", "currency": "USD"},
			},
		},
		"auditLog": []any{
			map[string]any{
				"id": 1, "createdAt": recent, "action": "market_feed_processed",
				"uuid": "offer-1",
				"detail": "Evento p2p.created de oferta offer-1 (CLASICA) procesado desde el feed: " +
					"aplicada correctamente.",
			},
			map[string]any{
				"id": 2, "createdAt": recent, "action": "market_feed_processed",
				"uuid": "offer-2",
				"detail": "Evento p2p.created de oferta offer-2 (CLASICA) procesado desde el feed: " +
					"tasa fuera del objetivo.",
			},
			map[string]any{
				"id": 3, "createdAt": recent, "action": "market_feed_processed",
				"uuid": "offer-3",
				"detail": "Evento p2p.created de oferta offer-3 (USD) procesado desde el feed: " +
					"aplicada correctamente.",
			},
			map[string]any{
				"id": 4, "createdAt": old, "action": "market_feed_processed",
				"uuid": "offer-old",
				"detail": "Evento p2p.created de oferta offer-old (CLASICA) procesado desde el feed: " +
					"aplicada correctamente.",
			},
			map[string]any{
				"id": 5, "createdAt": recent, "action": "offer_apply_timing",
				"uuid":   "offer-2",
				"detail": `{"dispatchedAt":1000,"finishedAt":1250,"outcome":"rejected"}`,
			},
		},
	})

	recorder := mobileInsightsTestDo(api, http.MethodGet,
		mobileInsightsPath+"?kind=diagnostics&coin=CLASICA", mobileInsightsTestToken)
	mobileInsightsTestExpectStatus(t, recorder, http.StatusOK, "")
	report := mobileInsightsTestDecodeData[huntingDiagnosticsData](t, recorder)

	if report.Hours != 24 {
		t.Fatalf("hours = %d, se esperaba 24", report.Hours)
	}
	if report.Coin == nil || *report.Coin != "CLASICA" {
		t.Fatalf("coin = %v, se esperaba CLASICA", report.Coin)
	}
	if report.GeneratedAt != now.UnixMilli() {
		t.Fatalf("generatedAt = %d, se esperaba %d", report.GeneratedAt, now.UnixMilli())
	}
	if report.Observations != 2 || report.UniqueOffers != 2 || report.AcceptedObservations != 1 {
		t.Fatalf("observaciones = %+v", report)
	}
	if len(report.Reasons) != 1 || report.Reasons[0].Code != "price" || report.Reasons[0].Count != 1 {
		t.Fatalf("reasons = %+v", report.Reasons)
	}
	if report.Applications.Sent != 1 || report.Applications.Rejected != 1 {
		t.Fatalf("applications = %+v", report.Applications)
	}
	if report.Applications.ResponseP50Ms == nil || *report.Applications.ResponseP50Ms != 250 {
		t.Fatalf("p50 = %v, se esperaba 250", report.Applications.ResponseP50Ms)
	}
}

func TestMobileInsightsInvalidKind(t *testing.T) {
	api, path := newMobileInsightsTestAPI(t)
	mobileInsightsTestWriteJSON(t, path, map[string]any{})

	for _, target := range []string{
		mobileInsightsPath,
		mobileInsightsPath + "?kind=",
		mobileInsightsPath + "?kind=unknown",
		mobileInsightsPath + "?kind=Health",
	} {
		recorder := mobileInsightsTestDo(api, http.MethodGet, target, mobileInsightsTestToken)
		mobileInsightsTestExpectStatus(t, recorder, http.StatusBadRequest, "invalid_kind")
	}
}

func TestMobileInsightsUnknownMarket(t *testing.T) {
	api, path := newMobileInsightsTestAPI(t)
	mobileInsightsTestWriteJSON(t, path, map[string]any{
		"analytics": map[string]any{
			"markets": []any{map[string]any{"code": "CLASICA"}},
		},
	})

	for _, target := range []string{
		mobileInsightsPath + "?kind=history",
		mobileInsightsPath + "?kind=history&coin=",
		mobileInsightsPath + "?kind=history&coin=UNKNOWN",
		mobileInsightsPath + "?kind=diagnostics",
		mobileInsightsPath + "?kind=diagnostics&coin=UNKNOWN",
	} {
		recorder := mobileInsightsTestDo(api, http.MethodGet, target, mobileInsightsTestToken)
		mobileInsightsTestExpectStatus(t, recorder, http.StatusBadRequest, "unknown_market")
	}

	// profitability no exige coin.
	recorder := mobileInsightsTestDo(api, http.MethodGet,
		mobileInsightsPath+"?kind=profitability&coin=UNKNOWN", mobileInsightsTestToken)
	mobileInsightsTestExpectStatus(t, recorder, http.StatusOK, "")
}

func TestMobileInsightsUnauthorized(t *testing.T) {
	api, path := newMobileInsightsTestAPI(t)
	mobileInsightsTestWriteJSON(t, path, map[string]any{})

	for _, target := range []string{
		mobileInsightsPath + "?kind=health",
		mobileInsightsPath + "?kind=profitability",
	} {
		recorder := mobileInsightsTestDo(api, http.MethodGet, target, "")
		mobileInsightsTestExpectStatus(t, recorder, http.StatusUnauthorized, "")
		var body map[string]string
		if err := json.Unmarshal(recorder.Body.Bytes(), &body); err != nil {
			t.Fatalf("JSON inválido: %v", err)
		}
		if body["error"] != mobileOperatorCredentialError {
			t.Fatalf("error = %q, se esperaba %q", body["error"], mobileOperatorCredentialError)
		}
		if _, ok := body["data"]; ok {
			t.Fatal("una respuesta 401 no debe incluir data")
		}
	}

	// Un token con formato válido pero desconocido también es 401.
	recorder := mobileInsightsTestDo(api, http.MethodGet,
		mobileInsightsPath+"?kind=health", strings.Repeat("x", 48))
	mobileInsightsTestExpectStatus(t, recorder, http.StatusUnauthorized, "")

	// Auth nil no entra en pánico y responde 401.
	withoutAuth := &MobileInsightsAPI{File: path, Now: mobileInsightsTestNow}
	recorder = mobileInsightsTestDo(withoutAuth, http.MethodGet,
		mobileInsightsPath+"?kind=health", mobileInsightsTestToken)
	mobileInsightsTestExpectStatus(t, recorder, http.StatusUnauthorized, "")
}

func TestMobileInsightsMethods(t *testing.T) {
	api, _ := newMobileInsightsTestAPI(t)

	for _, method := range []string{http.MethodPost, http.MethodPut, http.MethodDelete, http.MethodPatch} {
		recorder := mobileInsightsTestDo(api, method,
			mobileInsightsPath+"?kind=health", mobileInsightsTestToken)
		mobileInsightsTestExpectStatus(t, recorder, http.StatusMethodNotAllowed, "method_not_allowed")
		if got := recorder.Header().Get("Allow"); got != http.MethodGet {
			t.Fatalf("Allow = %q, se esperaba GET", got)
		}
	}

	recorder := mobileInsightsTestDo(api, http.MethodGet,
		mobileInsightsPath+"/extra?kind=health", mobileInsightsTestToken)
	mobileInsightsTestExpectStatus(t, recorder, http.StatusNotFound, "not_found")

	// La ruta se comprueba antes del método: una ruta desconocida es 404.
	recorder = mobileInsightsTestDo(api, http.MethodPost, mobileInsightsPath+"/extra", mobileInsightsTestToken)
	mobileInsightsTestExpectStatus(t, recorder, http.StatusNotFound, "not_found")
}

func TestMobileInsightsSnapshotStates(t *testing.T) {
	api, path := newMobileInsightsTestAPI(t)

	t.Run("ausente produce datos vacíos", func(t *testing.T) {
		recorder := mobileInsightsTestDo(api, http.MethodGet,
			mobileInsightsPath+"?kind=health", mobileInsightsTestToken)
		mobileInsightsTestExpectStatus(t, recorder, http.StatusOK, "")
		if got := string(mobileInsightsTestBody(t, recorder)["data"]); got != "null" {
			t.Fatalf("data = %s, se esperaba null", got)
		}

		recorder = mobileInsightsTestDo(api, http.MethodGet,
			mobileInsightsPath+"?kind=profitability", mobileInsightsTestToken)
		mobileInsightsTestExpectStatus(t, recorder, http.StatusOK, "")
		report := mobileInsightsTestDecodeData[mobileInsightsProfitability](t, recorder)
		if report.Days != 30 || report.Currencies == nil || len(report.Currencies) != 0 {
			t.Fatalf("informe vacío = %+v", report)
		}
		if report.Note != mobileInsightsLocalNote {
			t.Fatalf("note = %q", report.Note)
		}
	})

	t.Run("vacío produce datos vacíos", func(t *testing.T) {
		mobileInsightsTestWriteRaw(t, path, []byte(" \n\t "))
		recorder := mobileInsightsTestDo(api, http.MethodGet,
			mobileInsightsPath+"?kind=health", mobileInsightsTestToken)
		mobileInsightsTestExpectStatus(t, recorder, http.StatusOK, "")
		if got := string(mobileInsightsTestBody(t, recorder)["data"]); got != "null" {
			t.Fatalf("data = %s, se esperaba null", got)
		}
	})

	t.Run("JSON inválido es 503", func(t *testing.T) {
		for _, content := range []string{"{invalid", "[]", `"texto"`, "null"} {
			mobileInsightsTestWriteRaw(t, path, []byte(content))
			recorder := mobileInsightsTestDo(api, http.MethodGet,
				mobileInsightsPath+"?kind=health", mobileInsightsTestToken)
			mobileInsightsTestExpectStatus(t, recorder, http.StatusServiceUnavailable, "unavailable")
			if strings.Contains(recorder.Body.String(), path) {
				t.Fatal("la respuesta no debe exponer la ruta del snapshot")
			}
		}
	})

	t.Run("más de 8 MiB es 503", func(t *testing.T) {
		mobileInsightsTestWriteRaw(t, path, bytes.Repeat([]byte(" "), maxMobileInsightsSnapshotBytes+1))
		recorder := mobileInsightsTestDo(api, http.MethodGet,
			mobileInsightsPath+"?kind=health", mobileInsightsTestToken)
		mobileInsightsTestExpectStatus(t, recorder, http.StatusServiceUnavailable, "unavailable")
		if strings.Contains(recorder.Body.String(), path) ||
			strings.Contains(recorder.Body.String(), "grande") {
			t.Fatalf("la respuesta no debe exponer detalles: %q", recorder.Body.String())
		}
	})

	t.Run("un directorio es 503", func(t *testing.T) {
		directory := filepath.Join(t.TempDir(), "snapshot-dir")
		if err := os.Mkdir(directory, 0o700); err != nil {
			t.Fatalf("Mkdir: %v", err)
		}
		api.File = directory
		recorder := mobileInsightsTestDo(api, http.MethodGet,
			mobileInsightsPath+"?kind=health", mobileInsightsTestToken)
		mobileInsightsTestExpectStatus(t, recorder, http.StatusServiceUnavailable, "unavailable")
	})
}

func TestMobileInsightsHeaders(t *testing.T) {
	api, path := newMobileInsightsTestAPI(t)
	mobileInsightsTestWriteJSON(t, path, mobileInsightsTestProfitabilityFixture(mobileInsightsTestNow()))

	t.Run("éxito", func(t *testing.T) {
		recorder := mobileInsightsTestDo(api, http.MethodGet,
			mobileInsightsPath+"?kind=profitability", mobileInsightsTestToken)
		mobileInsightsTestExpectStatus(t, recorder, http.StatusOK, "")
	})

	t.Run("error de parámetro", func(t *testing.T) {
		recorder := mobileInsightsTestDo(api, http.MethodGet,
			mobileInsightsPath+"?kind=bogus", mobileInsightsTestToken)
		mobileInsightsTestExpectStatus(t, recorder, http.StatusBadRequest, "invalid_kind")
	})

	t.Run("método", func(t *testing.T) {
		recorder := mobileInsightsTestDo(api, http.MethodPost,
			mobileInsightsPath+"?kind=health", mobileInsightsTestToken)
		mobileInsightsTestExpectStatus(t, recorder, http.StatusMethodNotAllowed, "method_not_allowed")
	})

	t.Run("ruta", func(t *testing.T) {
		recorder := mobileInsightsTestDo(api, http.MethodGet, "/api/mobile/other", mobileInsightsTestToken)
		mobileInsightsTestExpectStatus(t, recorder, http.StatusNotFound, "not_found")
	})
}
