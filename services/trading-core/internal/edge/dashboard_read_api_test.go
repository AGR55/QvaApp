package edge

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// dashboardReadTestPage replica el sobre paginado para decodificar respuestas.
type dashboardReadTestPage[T any] struct {
	Page    int  `json:"page"`
	HasMore bool `json:"hasMore"`
	Items   []T  `json:"items"`
}

// dashboardReadTestFiat es la vista mínima de un movimiento fiat usada para
// comprobar el orden y la paginación.
type dashboardReadTestFiat struct {
	ID        string `json:"id"`
	Coin      string `json:"coin"`
	CreatedAt int64  `json:"createdAt"`
	Origin    int64  `json:"origin"`
	Sequence  int64  `json:"sequence"`
}

// dashboardReadTestPoint es la vista mínima de una observación de mercado.
type dashboardReadTestPoint struct {
	CreatedAt int64  `json:"createdAt"`
	Coin      string `json:"coin"`
}

// dashboardReadTestFee es la vista mínima de una evidencia de comisión.
type dashboardReadTestFee struct {
	UUID string `json:"uuid"`
}

func newDashboardReadTestAPI(
	t *testing.T,
	now time.Time,
) (*DashboardReadAPI, *http.Cookie) {
	t.Helper()
	manager := newSessionTestManager(t, 15*time.Minute)
	token, _, err := manager.Issue(now)
	if err != nil {
		t.Fatalf("Issue: %v", err)
	}
	api := &DashboardReadAPI{
		Sessions: manager,
		File:     filepath.Join(t.TempDir(), "dashboard_read.json"),
		Now:      func() time.Time { return now },
	}
	return api, &http.Cookie{Name: CookieName, Value: token}
}

func dashboardReadDo(
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

func dashboardReadWriteJSON(t *testing.T, path string, value any) {
	t.Helper()
	raw, err := json.Marshal(value)
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}
	if err := os.WriteFile(path, raw, 0o600); err != nil {
		t.Fatalf("WriteFile(%q): %v", path, err)
	}
}

func dashboardReadWriteRaw(t *testing.T, path, content string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatalf("WriteFile(%q): %v", path, err)
	}
}

// dashboardReadDecodeDataOnly exige que el sobre tenga exactamente la clave
// data.
func dashboardReadDecodeDataOnly(t *testing.T, recorder *httptest.ResponseRecorder) json.RawMessage {
	t.Helper()
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(recorder.Body.Bytes(), &fields); err != nil {
		t.Fatalf("JSON inválido: %v (cuerpo %q)", err, recorder.Body.String())
	}
	if len(fields) != 1 {
		t.Fatalf("el sobre solo debe tener data, claves = %v", fields)
	}
	data, ok := fields["data"]
	if !ok {
		t.Fatalf("respuesta sin clave data (cuerpo %q)", recorder.Body.String())
	}
	return data
}

func dashboardReadDecodeStatus(t *testing.T, recorder *httptest.ResponseRecorder) string {
	t.Helper()
	var body map[string]string
	if err := json.Unmarshal(recorder.Body.Bytes(), &body); err != nil {
		t.Fatalf("JSON inválido: %v (cuerpo %q)", err, recorder.Body.String())
	}
	return body["status"]
}

func dashboardReadAssertHeaders(t *testing.T, recorder *httptest.ResponseRecorder) {
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
		t.Fatal("la API de lectura no debe emitir cookies")
	}
}

func dashboardReadExpectStatus(
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
	dashboardReadAssertHeaders(t, recorder)
	if status != "" {
		if got := dashboardReadDecodeStatus(t, recorder); got != status {
			t.Fatalf("status = %q, se esperaba %q", got, status)
		}
	}
}

// dashboardReadSmokeSnapshot construye un snapshot completo con todas las
// listas pobladas, incluidos campos opcionales en null.
func dashboardReadSmokeSnapshot(now time.Time) map[string]any {
	nowMS := now.UnixMilli()
	return map[string]any{
		"generatedAt": nowMS,
		"devices": []any{
			map[string]any{
				"id": "dev-1", "label": "Android",
				"createdAt": int64(1), "revokedAt": nil,
			},
			map[string]any{
				"id": "dev-2", "label": "iPhone",
				"createdAt": int64(2), "revokedAt": int64(3),
			},
		},
		"receipts": []any{
			map[string]any{
				"id": "receipt-1", "status": "paid", "receivedAt": int64(1),
				"operationUuid": nil, "reason": nil,
			},
		},
		"fiatHistory": []any{
			map[string]any{
				"id": "history:1", "coin": "CUP", "before": 1.0, "after": 2.0,
				"amount": 1.0, "uuid": nil, "source": "bot", "kind": "trade",
				"createdAt": int64(1), "origin": int64(1), "sequence": int64(1),
			},
			map[string]any{
				"id": "history:2", "coin": "CUP", "before": nil, "after": nil,
				"amount": 3.0, "uuid": "op-1", "source": "api", "kind": "legacy",
				"createdAt": int64(2), "origin": int64(0), "sequence": int64(2),
			},
			map[string]any{
				"id": "history:3", "coin": "USD", "before": 1.0, "after": 1.0,
				"amount": 0.0, "uuid": nil, "source": "bot", "kind": "trade",
				"createdAt": int64(3), "origin": int64(1), "sequence": int64(3),
			},
		},
		"rebalanceJobs": []any{
			map[string]any{
				"id": "job-1", "state": "done",
				"adjustments": []any{
					map[string]any{"uuid": "op-1", "amount": 1.0},
				},
				"error":     "opcional",
				"createdAt": int64(1), "updatedAt": int64(2),
			},
			map[string]any{
				"id": "job-2", "state": "pending",
				"adjustments": []any{},
				"createdAt":   int64(3), "updatedAt": int64(4),
			},
		},
		"marketObservations": []any{
			map[string]any{
				"createdAt": nowMS - 3_600_000, "coin": "CUP",
				"averageBuy": 1.0, "averageSell": 2.0, "medianBuy": 1.0,
				"medianSell": 2.0, "bestBuy": 1.0, "bestSell": 2.0,
				"openOffers": int64(3), "eligible": int64(2),
			},
			map[string]any{
				"createdAt": nowMS - 60_000, "coin": "CUP",
				// Precios opcionales ausentes a propósito.
				"openOffers": int64(1), "eligible": int64(1),
			},
			map[string]any{
				"createdAt": nowMS - 30_000, "coin": "USD",
				"openOffers": int64(1), "eligible": int64(1),
			},
		},
		"analyticsFees": []any{
			map[string]any{
				"uuid": "fee-1", "coin": "CUP", "amount": 1.0, "receive": 2.0,
				"completedAt": int64(1), "feeQusd": 0.1, "evidence": "texto",
				"version": int64(1), "stale": false,
			},
			map[string]any{
				"uuid": "fee-2", "coin": "USD", "amount": nil, "receive": nil,
				"completedAt": int64(2), "feeQusd": nil, "evidence": "",
				"version": int64(0), "stale": true,
			},
		},
	}
}

func TestDashboardReadAPIServesAllRoutes(t *testing.T) {
	now := time.UnixMilli(1_700_000_000_000)
	api, cookie := newDashboardReadTestAPI(t, now)
	dashboardReadWriteJSON(t, api.File, dashboardReadSmokeSnapshot(now))

	t.Run("devices", func(t *testing.T) {
		recorder := dashboardReadDo(api, http.MethodGet, dashboardReadDevicesPath, cookie)
		if recorder.Code != http.StatusOK {
			t.Fatalf("status = %d (cuerpo %q)", recorder.Code, recorder.Body.String())
		}
		dashboardReadAssertHeaders(t, recorder)
		data := dashboardReadDecodeDataOnly(t, recorder)
		var devices []map[string]any
		if err := json.Unmarshal(data, &devices); err != nil {
			t.Fatalf("devices: %v", err)
		}
		if len(devices) != 2 || devices[0]["id"] != "dev-1" ||
			devices[1]["id"] != "dev-2" {
			t.Fatalf("devices = %+v", devices)
		}
		if _, ok := devices[0]["revokedAt"]; !ok {
			t.Fatal("revokedAt debe viajar como null")
		}
		if devices[0]["revokedAt"] != nil {
			t.Fatalf("revokedAt = %v, se esperaba null", devices[0]["revokedAt"])
		}
	})

	t.Run("fiat history", func(t *testing.T) {
		recorder := dashboardReadDo(api, http.MethodGet, dashboardReadFiatHistoryPath+"?coin=CUP", cookie)
		if recorder.Code != http.StatusOK {
			t.Fatalf("status = %d (cuerpo %q)", recorder.Code, recorder.Body.String())
		}
		dashboardReadAssertHeaders(t, recorder)
		data := dashboardReadDecodeDataOnly(t, recorder)
		var page dashboardReadTestPage[dashboardReadTestFiat]
		if err := json.Unmarshal(data, &page); err != nil {
			t.Fatalf("fiat page: %v", err)
		}
		if page.Page != 1 || page.HasMore || len(page.Items) != 2 {
			t.Fatalf("page = %+v", page)
		}
		for _, item := range page.Items {
			if item.Coin != "CUP" {
				t.Fatalf("movimiento de otra moneda: %+v", item)
			}
		}
		if page.Items[0].ID != "history:2" {
			t.Fatalf("orden inesperado: %+v", page.Items)
		}
	})

	t.Run("rebalance", func(t *testing.T) {
		recorder := dashboardReadDo(api, http.MethodGet, dashboardReadRebalancePrefix+"job-1", cookie)
		if recorder.Code != http.StatusOK {
			t.Fatalf("status = %d (cuerpo %q)", recorder.Code, recorder.Body.String())
		}
		dashboardReadAssertHeaders(t, recorder)
		data := dashboardReadDecodeDataOnly(t, recorder)
		var job map[string]any
		if err := json.Unmarshal(data, &job); err != nil {
			t.Fatalf("job: %v", err)
		}
		if job["id"] != "job-1" || job["state"] != "done" {
			t.Fatalf("job = %+v", job)
		}
		adjustments, ok := job["adjustments"].([]any)
		if !ok || len(adjustments) != 1 {
			t.Fatalf("adjustments = %+v", job["adjustments"])
		}
	})

	t.Run("market analytics", func(t *testing.T) {
		recorder := dashboardReadDo(api, http.MethodGet, dashboardReadMarketAnalyticsPath+"?coin=CUP", cookie)
		if recorder.Code != http.StatusOK {
			t.Fatalf("status = %d (cuerpo %q)", recorder.Code, recorder.Body.String())
		}
		dashboardReadAssertHeaders(t, recorder)
		data := dashboardReadDecodeDataOnly(t, recorder)
		var analytics struct {
			Coin    string                   `json:"coin"`
			History []dashboardReadTestPoint `json:"history"`
		}
		if err := json.Unmarshal(data, &analytics); err != nil {
			t.Fatalf("analytics: %v", err)
		}
		if analytics.Coin != "CUP" || len(analytics.History) != 2 {
			t.Fatalf("analytics = %+v", analytics)
		}
		for _, point := range analytics.History {
			if point.Coin != "CUP" {
				t.Fatalf("observación de otra moneda: %+v", point)
			}
		}
	})

	t.Run("analytics fees", func(t *testing.T) {
		recorder := dashboardReadDo(api, http.MethodGet, dashboardReadAnalyticsFeesPath, cookie)
		if recorder.Code != http.StatusOK {
			t.Fatalf("status = %d (cuerpo %q)", recorder.Code, recorder.Body.String())
		}
		dashboardReadAssertHeaders(t, recorder)
		data := dashboardReadDecodeDataOnly(t, recorder)
		var page dashboardReadTestPage[dashboardReadTestFee]
		if err := json.Unmarshal(data, &page); err != nil {
			t.Fatalf("fees page: %v", err)
		}
		if page.Page != 1 || page.HasMore || len(page.Items) != 2 ||
			page.Items[0].UUID != "fee-1" {
			t.Fatalf("page = %+v", page)
		}
	})
}

func TestDashboardReadAPIRequiresSession(t *testing.T) {
	now := time.UnixMilli(1_700_000_000_000)
	api, _ := newDashboardReadTestAPI(t, now)
	dashboardReadWriteJSON(t, api.File, dashboardReadSmokeSnapshot(now))

	invalid := &http.Cookie{Name: CookieName, Value: "no-es-un-token"}
	expiredToken, _, err := api.Sessions.Issue(now.Add(-2 * time.Hour))
	if err != nil {
		t.Fatalf("Issue: %v", err)
	}
	expired := &http.Cookie{Name: CookieName, Value: expiredToken}

	targets := []string{
		dashboardReadDevicesPath,
		dashboardReadFiatHistoryPath + "?coin=CUP",
		dashboardReadRebalancePrefix + "job-1",
		dashboardReadMarketAnalyticsPath + "?coin=CUP",
		dashboardReadAnalyticsFeesPath,
	}
	for name, cookie := range map[string]*http.Cookie{
		"sin cookie": nil,
		"inválida":   invalid,
		"expirada":   expired,
		"vacía":      {Name: CookieName, Value: ""},
	} {
		for _, target := range targets {
			t.Run(name+" "+target, func(t *testing.T) {
				recorder := dashboardReadDo(api, http.MethodGet, target, cookie)
				dashboardReadExpectStatus(t, recorder, http.StatusUnauthorized, "unauthenticated")
				if strings.Contains(recorder.Body.String(), "dev-1") {
					t.Fatal("una petición no autenticada no debe ver el snapshot")
				}
			})
		}
	}

	t.Run("sin manejador de sesión", func(t *testing.T) {
		withoutSessions := &DashboardReadAPI{
			File: api.File,
			Now:  func() time.Time { return now },
		}
		recorder := dashboardReadDo(
			withoutSessions, http.MethodGet, dashboardReadDevicesPath,
			&http.Cookie{Name: CookieName, Value: "cualquiera"},
		)
		dashboardReadExpectStatus(t, recorder, http.StatusUnauthorized, "unauthenticated")
	})
}

func TestDashboardReadAPIRejectsNonGET(t *testing.T) {
	now := time.UnixMilli(1_700_000_000_000)
	api, cookie := newDashboardReadTestAPI(t, now)
	dashboardReadWriteJSON(t, api.File, dashboardReadSmokeSnapshot(now))

	for _, method := range []string{
		http.MethodPost, http.MethodPut, http.MethodPatch,
		http.MethodDelete, http.MethodHead, http.MethodOptions,
	} {
		for _, target := range []string{
			dashboardReadDevicesPath,
			dashboardReadFiatHistoryPath + "?coin=CUP",
			dashboardReadRebalancePrefix + "job-1",
			dashboardReadMarketAnalyticsPath + "?coin=CUP",
			dashboardReadAnalyticsFeesPath,
		} {
			recorder := dashboardReadDo(api, method, target, cookie)
			if recorder.Code != http.StatusMethodNotAllowed {
				t.Fatalf("%s %s: status = %d, se esperaba 405 (cuerpo %q)",
					method, target, recorder.Code, recorder.Body.String())
			}
			if got := recorder.Header().Get("Allow"); got != http.MethodGet {
				t.Fatalf("%s %s: Allow = %q", method, target, got)
			}
			dashboardReadAssertHeaders(t, recorder)
			if got := dashboardReadDecodeStatus(t, recorder); got != "method_not_allowed" {
				t.Fatalf("%s %s: status = %q", method, target, got)
			}
		}
	}

	// La ruta se resuelve antes que el método: una ruta desconocida es 404.
	recorder := dashboardReadDo(api, http.MethodPost, "/api/desconocida", cookie)
	dashboardReadExpectStatus(t, recorder, http.StatusNotFound, "not_found")
}

func TestDashboardReadAPIRejectsUnknownRoutes(t *testing.T) {
	now := time.UnixMilli(1_700_000_000_000)
	api, cookie := newDashboardReadTestAPI(t, now)
	dashboardReadWriteJSON(t, api.File, dashboardReadSmokeSnapshot(now))

	for _, target := range []string{
		"/api",
		"/api/mobile",
		"/api/mobile/devices/",
		"/api/mobile/devices/dev-1",
		dashboardReadFiatHistoryPath + "/",
		dashboardReadMarketAnalyticsPath + "/",
		dashboardReadAnalyticsFeesPath + "/",
		"/api/offers/rebalance",
		"/api/offers/rebalance/",
		"/api/offers/rebalance/job/1",
		"/api/offers/rebalance/" + strings.Repeat("a", dashboardReadMaxRebalanceID+1),
		"/api/mobile/operators",
	} {
		recorder := dashboardReadDo(api, http.MethodGet, target, cookie)
		if recorder.Code != http.StatusNotFound {
			t.Fatalf("%s: status = %d, se esperaba 404 (cuerpo %q)",
				target, recorder.Code, recorder.Body.String())
		}
		dashboardReadAssertHeaders(t, recorder)
		if got := dashboardReadDecodeStatus(t, recorder); got != "not_found" {
			t.Fatalf("%s: status = %q", target, got)
		}
	}

	// El identificador máximo sí resuelve la ruta (y no existe en el snapshot).
	maxID := strings.Repeat("a", dashboardReadMaxRebalanceID)
	recorder := dashboardReadDo(api, http.MethodGet, dashboardReadRebalancePrefix+maxID, cookie)
	if recorder.Code != http.StatusNotFound {
		t.Fatalf("id máximo: status = %d (cuerpo %q)", recorder.Code, recorder.Body.String())
	}
	if got := dashboardReadDecodeStatus(t, recorder); got != "not_found" {
		t.Fatalf("id máximo: status = %q", got)
	}
}

func TestDashboardReadFiatHistoryValidatesCoin(t *testing.T) {
	now := time.UnixMilli(1_700_000_000_000)
	api, cookie := newDashboardReadTestAPI(t, now)
	dashboardReadWriteJSON(t, api.File, dashboardReadSmokeSnapshot(now))

	for name, coin := range map[string]string{
		"ausente":         "",
		"minúsculas":      "cup",
		"un carácter":     "C",
		"con guion":       "CUP-1",
		"con espacio":     "CU P",
		"demasiado largo": strings.Repeat("A", 41),
	} {
		t.Run(name, func(t *testing.T) {
			target := dashboardReadFiatHistoryPath
			if coin != "" {
				target += "?coin=" + url.QueryEscape(coin)
			}
			recorder := dashboardReadDo(api, http.MethodGet, target, cookie)
			dashboardReadExpectStatus(t, recorder, http.StatusBadRequest, "invalid_coin")
		})
	}
}

func TestDashboardReadFiatHistoryOrdersAndPaginates(t *testing.T) {
	now := time.UnixMilli(1_700_000_000_000)
	api, cookie := newDashboardReadTestAPI(t, now)

	// Se generan 25 movimientos de CUP con createdAt creciente: el orden
	// servido debe ser descendente.
	history := make([]any, 0, 26)
	base := int64(1_000_000)
	for i := 0; i < 25; i++ {
		history = append(history, map[string]any{
			"id": fmt.Sprintf("history:%d", i), "coin": "CUP",
			"before": 1.0, "after": 2.0, "amount": 1.0, "uuid": nil,
			"source": "bot", "kind": "trade",
			"createdAt": base + int64(i), "origin": int64(1), "sequence": int64(i),
		})
	}
	history = append(history, map[string]any{
		"id": "history:usd", "coin": "USD", "before": 1.0, "after": 2.0,
		"amount": 1.0, "uuid": nil, "source": "bot", "kind": "trade",
		"createdAt": base + 100, "origin": int64(9), "sequence": int64(99),
	})
	dashboardReadWriteJSON(t, api.File, map[string]any{"fiatHistory": history})

	page1 := dashboardReadDo(api, http.MethodGet, dashboardReadFiatHistoryPath+"?coin=CUP&page=1", cookie)
	if page1.Code != http.StatusOK {
		t.Fatalf("page 1: status = %d (cuerpo %q)", page1.Code, page1.Body.String())
	}
	var first dashboardReadTestPage[dashboardReadTestFiat]
	if err := json.Unmarshal(dashboardReadDecodeDataOnly(t, page1), &first); err != nil {
		t.Fatalf("page 1: %v", err)
	}
	if first.Page != 1 || !first.HasMore || len(first.Items) != 20 {
		t.Fatalf("page 1 = %+v", first)
	}
	for i, item := range first.Items {
		want := base + int64(24-i)
		if item.CreatedAt != want || item.Coin != "CUP" {
			t.Fatalf("orden página 1 [%d] = %+v, se esperaba createdAt %d", i, item, want)
		}
	}

	page2 := dashboardReadDo(api, http.MethodGet, dashboardReadFiatHistoryPath+"?coin=CUP&page=2", cookie)
	if page2.Code != http.StatusOK {
		t.Fatalf("page 2: status = %d (cuerpo %q)", page2.Code, page2.Body.String())
	}
	var second dashboardReadTestPage[dashboardReadTestFiat]
	if err := json.Unmarshal(dashboardReadDecodeDataOnly(t, page2), &second); err != nil {
		t.Fatalf("page 2: %v", err)
	}
	if second.Page != 2 || second.HasMore || len(second.Items) != 5 {
		t.Fatalf("page 2 = %+v", second)
	}
	for i, item := range second.Items {
		want := base + int64(4-i)
		if item.CreatedAt != want {
			t.Fatalf("orden página 2 [%d] = %+v, se esperaba createdAt %d", i, item, want)
		}
	}

	// Una página fuera de 1..1000 se normaliza a la primera.
	for _, page := range []string{"0", "-5", "1001", "abc", "1.5", ""} {
		target := dashboardReadFiatHistoryPath + "?coin=CUP"
		if page != "" {
			target += "&page=" + page
		}
		recorder := dashboardReadDo(api, http.MethodGet, target, cookie)
		var normalized dashboardReadTestPage[dashboardReadTestFiat]
		if err := json.Unmarshal(dashboardReadDecodeDataOnly(t, recorder), &normalized); err != nil {
			t.Fatalf("page %q: %v", page, err)
		}
		if normalized.Page != 1 || len(normalized.Items) != 20 {
			t.Fatalf("page %q se normalizó a %+v", page, normalized)
		}
	}

	// Una página válida muy alta devuelve una lista vacía, no null.
	last := dashboardReadDo(api, http.MethodGet, dashboardReadFiatHistoryPath+"?coin=CUP&page=1000", cookie)
	var empty dashboardReadTestPage[dashboardReadTestFiat]
	raw := dashboardReadDecodeDataOnly(t, last)
	if err := json.Unmarshal(raw, &empty); err != nil {
		t.Fatalf("page 1000: %v", err)
	}
	if empty.Page != 1000 || empty.HasMore || len(empty.Items) != 0 {
		t.Fatalf("page 1000 = %+v", empty)
	}
	if !strings.Contains(string(raw), `"items":[]`) {
		t.Fatalf("items debe ser un arreglo vacío: %s", raw)
	}
}

func TestDashboardReadFiatHistoryBreaksTiesByOriginAndSequence(t *testing.T) {
	now := time.UnixMilli(1_700_000_000_000)
	api, cookie := newDashboardReadTestAPI(t, now)

	entry := func(id string, createdAt, origin, sequence int64) map[string]any {
		return map[string]any{
			"id": id, "coin": "CUP", "before": 1.0, "after": 2.0,
			"amount": 1.0, "uuid": nil, "source": "bot", "kind": "trade",
			"createdAt": createdAt, "origin": origin, "sequence": sequence,
		}
	}
	dashboardReadWriteJSON(t, api.File, map[string]any{
		"fiatHistory": []any{
			entry("tie-a", 5_000, 1, 5),
			entry("tie-b", 5_000, 2, 1),
			entry("tie-c", 5_000, 1, 9),
			entry("nuevo", 6_000, 0, 0),
			entry("viejo", 4_000, 9, 99),
		},
	})

	recorder := dashboardReadDo(api, http.MethodGet, dashboardReadFiatHistoryPath+"?coin=CUP", cookie)
	var page dashboardReadTestPage[dashboardReadTestFiat]
	if err := json.Unmarshal(dashboardReadDecodeDataOnly(t, recorder), &page); err != nil {
		t.Fatalf("page: %v", err)
	}
	want := []string{"nuevo", "tie-b", "tie-c", "tie-a", "viejo"}
	if len(page.Items) != len(want) {
		t.Fatalf("items = %+v", page.Items)
	}
	for i, id := range want {
		if page.Items[i].ID != id {
			t.Fatalf("orden[%d] = %q, se esperaba %q (items %+v)",
				i, page.Items[i].ID, id, page.Items)
		}
	}
}

func TestDashboardReadRebalanceJob(t *testing.T) {
	now := time.UnixMilli(1_700_000_000_000)
	api, cookie := newDashboardReadTestAPI(t, now)
	dashboardReadWriteJSON(t, api.File, dashboardReadSmokeSnapshot(now))

	t.Run("encontrado", func(t *testing.T) {
		recorder := dashboardReadDo(api, http.MethodGet, dashboardReadRebalancePrefix+"job-1", cookie)
		if recorder.Code != http.StatusOK {
			t.Fatalf("status = %d (cuerpo %q)", recorder.Code, recorder.Body.String())
		}
		dashboardReadAssertHeaders(t, recorder)
		data := dashboardReadDecodeDataOnly(t, recorder)
		var job map[string]any
		if err := json.Unmarshal(data, &job); err != nil {
			t.Fatalf("job: %v", err)
		}
		if job["error"] != "opcional" {
			t.Fatalf("error = %v", job["error"])
		}
		if job["createdAt"] != float64(1) || job["updatedAt"] != float64(2) {
			t.Fatalf("job = %+v", job)
		}
	})

	t.Run("sin error opcional", func(t *testing.T) {
		recorder := dashboardReadDo(api, http.MethodGet, dashboardReadRebalancePrefix+"job-2", cookie)
		if recorder.Code != http.StatusOK {
			t.Fatalf("status = %d (cuerpo %q)", recorder.Code, recorder.Body.String())
		}
		var job map[string]any
		if err := json.Unmarshal(dashboardReadDecodeDataOnly(t, recorder), &job); err != nil {
			t.Fatalf("job: %v", err)
		}
		if _, ok := job["error"]; ok {
			t.Fatalf("un job sin error no debe exponer la clave: %+v", job)
		}
	})

	t.Run("ausente", func(t *testing.T) {
		recorder := dashboardReadDo(api, http.MethodGet, dashboardReadRebalancePrefix+"no-existe", cookie)
		dashboardReadExpectStatus(t, recorder, http.StatusNotFound, "not_found")
	})
}

func TestDashboardReadMarketAnalyticsFiltersWindow(t *testing.T) {
	now := time.UnixMilli(1_700_000_000_000)
	api, cookie := newDashboardReadTestAPI(t, now)
	nowMS := now.UnixMilli()

	dashboardReadWriteJSON(t, api.File, map[string]any{
		"marketObservations": []any{
			map[string]any{"createdAt": nowMS - int64((25 * time.Hour).Milliseconds()), "coin": "CUP", "openOffers": 1, "eligible": 0},
			map[string]any{"createdAt": nowMS - int64((23 * time.Hour).Milliseconds()), "coin": "CUP", "openOffers": 1, "eligible": 1},
			map[string]any{"createdAt": nowMS, "coin": "CUP", "openOffers": 2, "eligible": 2},
			map[string]any{"createdAt": nowMS - 30_000, "coin": "CUP", "openOffers": 3, "eligible": 3},
			// Fuera de la ventana por el futuro.
			map[string]any{"createdAt": nowMS + 60_000, "coin": "CUP", "openOffers": 4, "eligible": 4},
			map[string]any{"createdAt": nowMS - 60_000, "coin": "USD", "openOffers": 5, "eligible": 5},
		},
	})

	recorder := dashboardReadDo(api, http.MethodGet, dashboardReadMarketAnalyticsPath+"?coin=CUP", cookie)
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d (cuerpo %q)", recorder.Code, recorder.Body.String())
	}
	dashboardReadAssertHeaders(t, recorder)
	var analytics struct {
		Coin    string                   `json:"coin"`
		History []dashboardReadTestPoint `json:"history"`
	}
	if err := json.Unmarshal(dashboardReadDecodeDataOnly(t, recorder), &analytics); err != nil {
		t.Fatalf("analytics: %v", err)
	}
	if analytics.Coin != "CUP" || len(analytics.History) != 3 {
		t.Fatalf("analytics = %+v", analytics)
	}
	want := []int64{
		nowMS - int64((23 * time.Hour).Milliseconds()),
		nowMS - 30_000,
		nowMS,
	}
	for i, createdAt := range want {
		if analytics.History[i].CreatedAt != createdAt {
			t.Fatalf("history[%d].createdAt = %d, se esperaba %d",
				i, analytics.History[i].CreatedAt, createdAt)
		}
	}
}

func TestDashboardReadMarketAnalyticsCompactsTo240Points(t *testing.T) {
	now := time.UnixMilli(1_700_000_000_000)
	api, cookie := newDashboardReadTestAPI(t, now)
	nowMS := now.UnixMilli()

	// 300 observaciones separadas por 4 minutos caben en 20 h.
	const total = 300
	const step = int64(4 * time.Minute / time.Millisecond)
	start := nowMS - int64(20*time.Hour/time.Millisecond)
	points := make([]any, 0, total)
	for i := 0; i < total; i++ {
		points = append(points, map[string]any{
			"createdAt": start + int64(i)*step, "coin": "CUP",
			"openOffers": 1, "eligible": 1,
		})
	}
	dashboardReadWriteJSON(t, api.File, map[string]any{"marketObservations": points})

	recorder := dashboardReadDo(api, http.MethodGet, dashboardReadMarketAnalyticsPath+"?coin=CUP", cookie)
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d (cuerpo %q)", recorder.Code, recorder.Body.String())
	}
	var analytics struct {
		Coin    string                   `json:"coin"`
		History []dashboardReadTestPoint `json:"history"`
	}
	if err := json.Unmarshal(dashboardReadDecodeDataOnly(t, recorder), &analytics); err != nil {
		t.Fatalf("analytics: %v", err)
	}
	if len(analytics.History) != dashboardReadMaxMarketPoints {
		t.Fatalf("history tiene %d puntos, se esperaban %d",
			len(analytics.History), dashboardReadMaxMarketPoints)
	}

	last := total - 1
	for i := 0; i < dashboardReadMaxMarketPoints; i++ {
		index := int(float64(i)*float64(last)/float64(dashboardReadMaxMarketPoints-1) + 0.5)
		want := start + int64(index)*step
		if analytics.History[i].CreatedAt != want {
			t.Fatalf("history[%d].createdAt = %d, se esperaba el índice %d (%d)",
				i, analytics.History[i].CreatedAt, index, want)
		}
	}
}

func TestDashboardReadMarketAnalyticsKeepsSmallSeries(t *testing.T) {
	now := time.UnixMilli(1_700_000_000_000)
	api, cookie := newDashboardReadTestAPI(t, now)
	nowMS := now.UnixMilli()

	points := make([]any, 0, 240)
	for i := 0; i < 240; i++ {
		points = append(points, map[string]any{
			"createdAt": nowMS - int64(240-i)*1_000, "coin": "CUP",
			"openOffers": 1, "eligible": 1,
		})
	}
	dashboardReadWriteJSON(t, api.File, map[string]any{"marketObservations": points})

	recorder := dashboardReadDo(api, http.MethodGet, dashboardReadMarketAnalyticsPath+"?coin=CUP", cookie)
	var analytics struct {
		History []dashboardReadTestPoint `json:"history"`
	}
	if err := json.Unmarshal(dashboardReadDecodeDataOnly(t, recorder), &analytics); err != nil {
		t.Fatalf("analytics: %v", err)
	}
	if len(analytics.History) != len(points) {
		t.Fatalf("history tiene %d puntos, se esperaban %d",
			len(analytics.History), len(points))
	}
}

func TestDashboardReadMarketAnalyticsValidatesCoin(t *testing.T) {
	now := time.UnixMilli(1_700_000_000_000)
	api, cookie := newDashboardReadTestAPI(t, now)
	dashboardReadWriteJSON(t, api.File, dashboardReadSmokeSnapshot(now))

	for name, target := range map[string]string{
		"ausente":    dashboardReadMarketAnalyticsPath,
		"minúsculas": dashboardReadMarketAnalyticsPath + "?coin=cup",
		"con guion":  dashboardReadMarketAnalyticsPath + "?coin=CUP-1",
		"muy largo":  dashboardReadMarketAnalyticsPath + "?coin=" + strings.Repeat("A", 41),
	} {
		t.Run(name, func(t *testing.T) {
			recorder := dashboardReadDo(api, http.MethodGet, target, cookie)
			dashboardReadExpectStatus(t, recorder, http.StatusBadRequest, "invalid_coin")
		})
	}
}

func TestDashboardReadAnalyticsFeesPaginatesInSnapshotOrder(t *testing.T) {
	now := time.UnixMilli(1_700_000_000_000)
	api, cookie := newDashboardReadTestAPI(t, now)

	fees := make([]any, 0, 25)
	for i := 0; i < 25; i++ {
		fees = append(fees, map[string]any{
			"uuid": fmt.Sprintf("fee-%02d", i), "coin": "CUP",
			"amount": 1.0, "receive": 2.0, "completedAt": int64(i),
			"feeQusd": 0.1, "evidence": "texto", "version": int64(1),
			"stale": false,
		})
	}
	dashboardReadWriteJSON(t, api.File, map[string]any{"analyticsFees": fees})

	page1 := dashboardReadDo(api, http.MethodGet, dashboardReadAnalyticsFeesPath+"?page=1", cookie)
	if page1.Code != http.StatusOK {
		t.Fatalf("page 1: status = %d (cuerpo %q)", page1.Code, page1.Body.String())
	}
	var first dashboardReadTestPage[dashboardReadTestFee]
	if err := json.Unmarshal(dashboardReadDecodeDataOnly(t, page1), &first); err != nil {
		t.Fatalf("page 1: %v", err)
	}
	if first.Page != 1 || !first.HasMore || len(first.Items) != 20 ||
		first.Items[0].UUID != "fee-00" || first.Items[19].UUID != "fee-19" {
		t.Fatalf("page 1 = %+v", first)
	}

	page2 := dashboardReadDo(api, http.MethodGet, dashboardReadAnalyticsFeesPath+"?page=2", cookie)
	var second dashboardReadTestPage[dashboardReadTestFee]
	if err := json.Unmarshal(dashboardReadDecodeDataOnly(t, page2), &second); err != nil {
		t.Fatalf("page 2: %v", err)
	}
	if second.Page != 2 || second.HasMore || len(second.Items) != 5 ||
		second.Items[0].UUID != "fee-20" || second.Items[4].UUID != "fee-24" {
		t.Fatalf("page 2 = %+v", second)
	}

	for _, page := range []string{"0", "-1", "1001", "abc"} {
		recorder := dashboardReadDo(
			api, http.MethodGet, dashboardReadAnalyticsFeesPath+"?page="+page, cookie,
		)
		var normalized dashboardReadTestPage[dashboardReadTestFee]
		if err := json.Unmarshal(dashboardReadDecodeDataOnly(t, recorder), &normalized); err != nil {
			t.Fatalf("page %q: %v", page, err)
		}
		if normalized.Page != 1 {
			t.Fatalf("page %q se normalizó a %d", page, normalized.Page)
		}
	}

	last := dashboardReadDo(api, http.MethodGet, dashboardReadAnalyticsFeesPath+"?page=1000", cookie)
	var empty dashboardReadTestPage[dashboardReadTestFee]
	raw := dashboardReadDecodeDataOnly(t, last)
	if err := json.Unmarshal(raw, &empty); err != nil {
		t.Fatalf("page 1000: %v", err)
	}
	if empty.Page != 1000 || empty.HasMore || len(empty.Items) != 0 {
		t.Fatalf("page 1000 = %+v", empty)
	}
	if !strings.Contains(string(raw), `"items":[]`) {
		t.Fatalf("items debe ser un arreglo vacío: %s", raw)
	}
}

func TestDashboardReadAPIServesEmptySnapshot(t *testing.T) {
	now := time.UnixMilli(1_700_000_000_000)

	cases := []struct {
		name    string
		file    string
		content string
	}{
		{"archivo vacío", "", ""},
		{"ruta inexistente", filepath.Join(t.TempDir(), "no-existe.json"), ""},
		{"contenido en blanco", filepath.Join(t.TempDir(), "blanco.json"), " \n\t "},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			api, cookie := newDashboardReadTestAPI(t, now)
			api.File = testCase.file
			if testCase.content != "" {
				dashboardReadWriteRaw(t, api.File, testCase.content)
			}

			devices := dashboardReadDo(api, http.MethodGet, dashboardReadDevicesPath, cookie)
			if devices.Code != http.StatusOK {
				t.Fatalf("devices: status = %d (cuerpo %q)", devices.Code, devices.Body.String())
			}
			if got := string(dashboardReadDecodeDataOnly(t, devices)); got != "[]" {
				t.Fatalf("devices = %q, se esperaba []", got)
			}

			history := dashboardReadDo(api, http.MethodGet, dashboardReadFiatHistoryPath+"?coin=CUP", cookie)
			var historyPage dashboardReadTestPage[dashboardReadTestFiat]
			historyRaw := dashboardReadDecodeDataOnly(t, history)
			if err := json.Unmarshal(historyRaw, &historyPage); err != nil {
				t.Fatalf("history: %v", err)
			}
			if historyPage.Page != 1 || historyPage.HasMore || len(historyPage.Items) != 0 {
				t.Fatalf("history = %+v", historyPage)
			}
			if !strings.Contains(string(historyRaw), `"items":[]`) {
				t.Fatalf("history items debe ser []: %s", historyRaw)
			}

			analytics := dashboardReadDo(api, http.MethodGet, dashboardReadMarketAnalyticsPath+"?coin=CUP", cookie)
			analyticsRaw := dashboardReadDecodeDataOnly(t, analytics)
			var market struct {
				Coin    string `json:"coin"`
				History []any  `json:"history"`
			}
			if err := json.Unmarshal(analyticsRaw, &market); err != nil {
				t.Fatalf("analytics: %v", err)
			}
			if market.Coin != "CUP" || market.History == nil || len(market.History) != 0 {
				t.Fatalf("analytics = %+v (crudo %s)", market, analyticsRaw)
			}
			if !strings.Contains(string(analyticsRaw), `"history":[]`) {
				t.Fatalf("history debe ser []: %s", analyticsRaw)
			}

			fees := dashboardReadDo(api, http.MethodGet, dashboardReadAnalyticsFeesPath, cookie)
			var feesPage dashboardReadTestPage[dashboardReadTestFee]
			feesRaw := dashboardReadDecodeDataOnly(t, fees)
			if err := json.Unmarshal(feesRaw, &feesPage); err != nil {
				t.Fatalf("fees: %v", err)
			}
			if feesPage.Page != 1 || feesPage.HasMore || len(feesPage.Items) != 0 {
				t.Fatalf("fees = %+v", feesPage)
			}
			if !strings.Contains(string(feesRaw), `"items":[]`) {
				t.Fatalf("fees items debe ser []: %s", feesRaw)
			}

			rebalance := dashboardReadDo(api, http.MethodGet, dashboardReadRebalancePrefix+"cualquiera", cookie)
			dashboardReadExpectStatus(t, rebalance, http.StatusNotFound, "not_found")
		})
	}
}

func TestDashboardReadAPIRejectsInvalidSnapshot(t *testing.T) {
	now := time.UnixMilli(1_700_000_000_000)
	api, cookie := newDashboardReadTestAPI(t, now)

	for name, content := range map[string]string{
		"truncado":      `{"devices":[{"id":"dev-1"}`,
		"arreglo":       `[]`,
		"null":          `null`,
		"texto":         `no es json`,
		"basura final":  `{"devices":[]} extra`,
		"solo apertura": `{`,
		"coma final":    `{"devices":[],}`,
	} {
		t.Run(name, func(t *testing.T) {
			dashboardReadWriteRaw(t, api.File, content)
			recorder := dashboardReadDo(api, http.MethodGet, dashboardReadDevicesPath, cookie)
			dashboardReadExpectStatus(t, recorder, http.StatusServiceUnavailable, "unavailable")
			body := recorder.Body.String()
			if strings.Contains(body, api.File) {
				t.Fatalf("la respuesta expone la ruta del archivo: %q", body)
			}
			if strings.Contains(body, "devices") {
				t.Fatalf("la respuesta expone el contenido: %q", body)
			}
		})
	}

	t.Run("directorio", func(t *testing.T) {
		api.File = t.TempDir()
		recorder := dashboardReadDo(api, http.MethodGet, dashboardReadDevicesPath, cookie)
		dashboardReadExpectStatus(t, recorder, http.StatusServiceUnavailable, "unavailable")
	})
}

func TestDashboardReadAPIRejectsOversizedSnapshot(t *testing.T) {
	now := time.UnixMilli(1_700_000_000_000)
	api, cookie := newDashboardReadTestAPI(t, now)

	t.Run("tamaño máximo exacto", func(t *testing.T) {
		// Un JSON válido rellenado con espacios hasta exactamente el límite.
		raw := make([]byte, maxDashboardReadSnapshotBytes)
		copy(raw, `{"devices":[]}`)
		for i := len(`{"devices":[]}`); i < len(raw); i++ {
			raw[i] = ' '
		}
		if err := os.WriteFile(api.File, raw, 0o600); err != nil {
			t.Fatalf("WriteFile: %v", err)
		}
		recorder := dashboardReadDo(api, http.MethodGet, dashboardReadDevicesPath, cookie)
		if recorder.Code != http.StatusOK {
			t.Fatalf("status = %d (cuerpo %q)", recorder.Code, recorder.Body.String())
		}
		if got := string(dashboardReadDecodeDataOnly(t, recorder)); got != "[]" {
			t.Fatalf("devices = %q", got)
		}
	})

	t.Run("un byte de más", func(t *testing.T) {
		raw := make([]byte, maxDashboardReadSnapshotBytes+1)
		copy(raw, `{"devices":[]}`)
		for i := len(`{"devices":[]}`); i < len(raw); i++ {
			raw[i] = ' '
		}
		if err := os.WriteFile(api.File, raw, 0o600); err != nil {
			t.Fatalf("WriteFile: %v", err)
		}
		recorder := dashboardReadDo(api, http.MethodGet, dashboardReadDevicesPath, cookie)
		dashboardReadExpectStatus(t, recorder, http.StatusServiceUnavailable, "unavailable")
		if strings.Contains(recorder.Body.String(), api.File) {
			t.Fatal("la respuesta no debe exponer la ruta del archivo")
		}
	})
}

func TestDashboardReadAPIHeadersAndNoCORS(t *testing.T) {
	now := time.UnixMilli(1_700_000_000_000)
	api, cookie := newDashboardReadTestAPI(t, now)
	dashboardReadWriteJSON(t, api.File, dashboardReadSmokeSnapshot(now))

	cases := []struct {
		name   string
		method string
		target string
		cookie *http.Cookie
		want   int
	}{
		{"ok", http.MethodGet, dashboardReadDevicesPath, cookie, http.StatusOK},
		{"coin inválido", http.MethodGet, dashboardReadFiatHistoryPath, cookie, http.StatusBadRequest},
		{"no autenticado", http.MethodGet, dashboardReadDevicesPath, nil, http.StatusUnauthorized},
		{"ruta desconocida", http.MethodGet, "/api/desconocida", cookie, http.StatusNotFound},
		{"método", http.MethodPost, dashboardReadDevicesPath, cookie, http.StatusMethodNotAllowed},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			recorder := dashboardReadDo(api, testCase.method, testCase.target, testCase.cookie)
			if recorder.Code != testCase.want {
				t.Fatalf("status = %d, se esperaba %d (cuerpo %q)",
					recorder.Code, testCase.want, recorder.Body.String())
			}
			dashboardReadAssertHeaders(t, recorder)
		})
	}

	// Un snapshot inválido también conserva las cabeceras JSON.
	dashboardReadWriteRaw(t, api.File, "roto")
	recorder := dashboardReadDo(api, http.MethodGet, dashboardReadDevicesPath, cookie)
	if recorder.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, se esperaba 503", recorder.Code)
	}
	dashboardReadAssertHeaders(t, recorder)
}
