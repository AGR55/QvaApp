package edge

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"
)

const analyticsFeesTestNowMS int64 = 1_700_000_000_000

type analyticsFeesFakeStore struct {
	records         map[string]map[string]FeeRecord
	loadErr         error
	saveErr         error
	loadCalls       int
	saveCalls       int
	lastLoadAccount string
	lastSaveAccount string
	lastSaved       FeeRecord
}

func (store *analyticsFeesFakeStore) Load(_ context.Context, account string) (map[string]FeeRecord, error) {
	store.loadCalls++
	store.lastLoadAccount = account
	if store.loadErr != nil {
		return nil, store.loadErr
	}
	records := make(map[string]FeeRecord)
	for uuid, record := range store.records[account] {
		records[uuid] = record
	}
	return records, nil
}

func (store *analyticsFeesFakeStore) Save(_ context.Context, account string, record FeeRecord) (int, error) {
	store.saveCalls++
	store.lastSaveAccount = account
	if store.saveErr != nil {
		return 0, store.saveErr
	}
	prior := 0
	if existing, ok := store.records[account][record.OfferUUID]; ok {
		prior = existing.Version
	}
	record.Version = prior + 1
	if store.records == nil {
		store.records = make(map[string]map[string]FeeRecord)
	}
	if store.records[account] == nil {
		store.records[account] = make(map[string]FeeRecord)
	}
	store.records[account][record.OfferUUID] = record
	store.lastSaved = record
	return record.Version, nil
}

func analyticsFeesTestSnapshot(t *testing.T, count int, account string) string {
	t.Helper()
	fees := make([]map[string]any, 0, count)
	for index := 1; index <= count; index++ {
		fees = append(fees, map[string]any{
			"uuid":        fmt.Sprintf("offer-%02d", index),
			"coin":        "CLASICA",
			"amount":      float64(index + 10),
			"receive":     float64(index + 20),
			"completedAt": analyticsFeesTestNowMS - int64(index),
			"feeQusd":     nil,
			"evidence":    "",
			"version":     0,
			"stale":       false,
		})
	}
	raw, err := json.Marshal(map[string]any{
		"analyticsFees": fees,
		"simulation":    map[string]any{"accountUuid": account},
	})
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}
	return string(raw)
}

func analyticsFeesWriteSnapshot(t *testing.T, content string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "web-extras.json")
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}
	return path
}

func newAnalyticsFeesTestAPI(
	t *testing.T,
	snapshot string,
	store FeeStore,
) (*AnalyticsFeesAPI, *http.Cookie, string) {
	t.Helper()
	manager := newSessionTestManager(t, 15*time.Minute)
	now := time.UnixMilli(analyticsFeesTestNowMS)
	token, csrf, err := manager.Issue(now)
	if err != nil {
		t.Fatalf("Issue: %v", err)
	}
	api := &AnalyticsFeesAPI{
		Sessions:      manager,
		Store:         store,
		TrustedOrigin: "https://panel.example",
		Now:           func() time.Time { return now },
	}
	if snapshot != "" {
		api.File = analyticsFeesWriteSnapshot(t, snapshot)
	}
	return api, &http.Cookie{Name: CookieName, Value: token}, csrf
}

func analyticsFeesDo(
	api *AnalyticsFeesAPI,
	method, target, body string,
	cookie *http.Cookie,
	csrf, origin string,
) *httptest.ResponseRecorder {
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

func analyticsFeesDecode[T any](t *testing.T, recorder *httptest.ResponseRecorder) T {
	t.Helper()
	var value T
	if err := json.Unmarshal(recorder.Body.Bytes(), &value); err != nil {
		t.Fatalf("JSON inválido: %v (cuerpo %q)", err, recorder.Body.String())
	}
	return value
}

func analyticsFeesBody(t *testing.T, value any) string {
	t.Helper()
	raw, err := json.Marshal(value)
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}
	return string(raw)
}

func analyticsFeesUUIDs(page analyticsFeePage) []string {
	uuids := make([]string, 0, len(page.Items))
	for _, item := range page.Items {
		uuids = append(uuids, item.UUID)
	}
	return uuids
}

func analyticsFeesStatus(t *testing.T, recorder *httptest.ResponseRecorder) string {
	t.Helper()
	var body map[string]string
	if err := json.Unmarshal(recorder.Body.Bytes(), &body); err != nil {
		t.Fatalf("JSON inválido: %v (cuerpo %q)", err, recorder.Body.String())
	}
	return body["status"]
}

func analyticsFeesError(t *testing.T, recorder *httptest.ResponseRecorder) string {
	t.Helper()
	var body map[string]any
	if err := json.Unmarshal(recorder.Body.Bytes(), &body); err != nil {
		t.Fatalf("JSON inválido: %v (cuerpo %q)", err, recorder.Body.String())
	}
	message, _ := body["error"].(string)
	return message
}

func analyticsFeesCheckHeaders(t *testing.T, recorder *httptest.ResponseRecorder) {
	t.Helper()
	if got := recorder.Header().Get("Cache-Control"); got != "no-store" {
		t.Fatalf("Cache-Control = %q", got)
	}
	if got := recorder.Header().Get("X-Content-Type-Options"); got != "nosniff" {
		t.Fatalf("X-Content-Type-Options = %q", got)
	}
	if values := recorder.Header().Values("Access-Control-Allow-Origin"); len(values) != 0 {
		t.Fatalf("CORS inesperado: %v", values)
	}
	if got := recorder.Header().Get("Content-Type"); got != "application/json; charset=utf-8" {
		t.Fatalf("Content-Type = %q", got)
	}
}

func analyticsFeesCheckFee(t *testing.T, item analyticsFeeItem, want float64) {
	t.Helper()
	if item.FeeQusd == nil {
		t.Fatalf("%s: feeQusd = nil, quiero %v", item.UUID, want)
	}
	if *item.FeeQusd != want {
		t.Fatalf("%s: feeQusd = %v, quiero %v", item.UUID, *item.FeeQusd, want)
	}
}

func TestAnalyticsFeesListPaginationAndOverride(t *testing.T) {
	store := &analyticsFeesFakeStore{records: map[string]map[string]FeeRecord{
		"account-1": {
			"offer-01": {
				OfferUUID: "offer-01", GrossQusd: 11, FeeQusd: 2.5,
				Evidence: "evidencia nueva", Version: 3, UpdatedAt: 10,
			},
			"offer-02": {
				OfferUUID: "offer-02", GrossQusd: 999, FeeQusd: 0.5,
				Evidence: "evidencia vieja", Version: 1, UpdatedAt: 11,
			},
		},
	}}
	api, cookie, _ := newAnalyticsFeesTestAPI(t, analyticsFeesTestSnapshot(t, 25, "account-1"), store)

	recorder := analyticsFeesDo(api, http.MethodGet, "/api/analytics/fees", "", cookie, "", "")
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d (cuerpo %q)", recorder.Code, recorder.Body.String())
	}
	analyticsFeesCheckHeaders(t, recorder)

	response := analyticsFeesDecode[analyticsFeesResponse](t, recorder)
	page := response.Data
	if page.Page != 1 || !page.HasMore || len(page.Items) != 20 {
		t.Fatalf("page=%d hasMore=%v items=%d", page.Page, page.HasMore, len(page.Items))
	}
	want := make([]string, 0, 20)
	for index := 1; index <= 20; index++ {
		want = append(want, fmt.Sprintf("offer-%02d", index))
	}
	if got := analyticsFeesUUIDs(page); !slices.Equal(got, want) {
		t.Fatalf("uuids = %v, quiero %v", got, want)
	}

	first := page.Items[0]
	analyticsFeesCheckFee(t, first, 2.5)
	if first.Evidence != "evidencia nueva" || first.Version != 3 || first.Stale {
		t.Fatalf("override = %+v", first)
	}
	second := page.Items[1]
	analyticsFeesCheckFee(t, second, 0.5)
	if !second.Stale {
		t.Fatalf("offer-02 debe quedar stale: %+v", second)
	}
	third := page.Items[2]
	if third.FeeQusd != nil || third.Evidence != "" || third.Version != 0 || third.Stale {
		t.Fatalf("sin registro debe conservar el snapshot: %+v", third)
	}
	if store.lastLoadAccount != "account-1" {
		t.Fatalf("cuenta cargada = %q", store.lastLoadAccount)
	}

	recorder = analyticsFeesDo(api, http.MethodGet, "/api/analytics/fees?page=2", "", cookie, "", "")
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d (cuerpo %q)", recorder.Code, recorder.Body.String())
	}
	response = analyticsFeesDecode[analyticsFeesResponse](t, recorder)
	page = response.Data
	want = []string{"offer-21", "offer-22", "offer-23", "offer-24", "offer-25"}
	if page.Page != 2 || page.HasMore || !slices.Equal(analyticsFeesUUIDs(page), want) {
		t.Fatalf("page=%d hasMore=%v uuids=%v", page.Page, page.HasMore, analyticsFeesUUIDs(page))
	}
}

func TestAnalyticsFeesListPageBounds(t *testing.T) {
	api, cookie, _ := newAnalyticsFeesTestAPI(t, analyticsFeesTestSnapshot(t, 25, "account-1"), nil)

	for _, target := range []string{
		"/api/analytics/fees?page=0",
		"/api/analytics/fees?page=-1",
		"/api/analytics/fees?page=1001",
		"/api/analytics/fees?page=abc",
		"/api/analytics/fees?page=1.5",
	} {
		recorder := analyticsFeesDo(api, http.MethodGet, target, "", cookie, "", "")
		if recorder.Code != http.StatusBadRequest {
			t.Fatalf("%s: status = %d (cuerpo %q)", target, recorder.Code, recorder.Body.String())
		}
	}

	recorder := analyticsFeesDo(api, http.MethodGet, "/api/analytics/fees?page=1000", "", cookie, "", "")
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d (cuerpo %q)", recorder.Code, recorder.Body.String())
	}
	response := analyticsFeesDecode[analyticsFeesResponse](t, recorder)
	if response.Data.Page != 1000 || response.Data.HasMore || response.Data.Items == nil ||
		len(response.Data.Items) != 0 {
		t.Fatalf("data = %+v", response.Data)
	}
}

func TestAnalyticsFeesListEmptyAndMissingSnapshot(t *testing.T) {
	cases := []struct {
		name     string
		snapshot string
		missing  bool
	}{
		{name: "archivo vacío de configuración"},
		{name: "snapshot inexistente", missing: true},
		{name: "objeto vacío", snapshot: "{}"},
		{name: "listas nulas", snapshot: `{"analyticsFees":null,"simulation":null}`},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			api, cookie, _ := newAnalyticsFeesTestAPI(t, testCase.snapshot, nil)
			if testCase.missing {
				api.File = filepath.Join(t.TempDir(), "no-existe.json")
			}
			recorder := analyticsFeesDo(api, http.MethodGet, "/api/analytics/fees", "", cookie, "", "")
			if recorder.Code != http.StatusOK {
				t.Fatalf("status = %d (cuerpo %q)", recorder.Code, recorder.Body.String())
			}
			analyticsFeesCheckHeaders(t, recorder)
			response := analyticsFeesDecode[analyticsFeesResponse](t, recorder)
			if response.Data.Page != 1 || response.Data.HasMore || response.Data.Items == nil ||
				len(response.Data.Items) != 0 {
				t.Fatalf("data = %+v", response.Data)
			}
		})
	}
}

func TestAnalyticsFeesListSnapshotUnavailable(t *testing.T) {
	cases := []struct {
		name     string
		snapshot string
		dir      bool
	}{
		{name: "JSON inválido", snapshot: `{"analyticsFees":`},
		{name: "snapshot grande", snapshot: strings.Repeat("x", analyticsFeesMaxSnapshotBytes+1)},
		{name: "ruta de directorio", dir: true},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			api, cookie, _ := newAnalyticsFeesTestAPI(t, `{}`, nil)
			if testCase.dir {
				api.File = t.TempDir()
			} else {
				api.File = analyticsFeesWriteSnapshot(t, testCase.snapshot)
			}
			recorder := analyticsFeesDo(api, http.MethodGet, "/api/analytics/fees", "", cookie, "", "")
			if recorder.Code != http.StatusServiceUnavailable {
				t.Fatalf("status = %d (cuerpo %q)", recorder.Code, recorder.Body.String())
			}
			if got := analyticsFeesStatus(t, recorder); got != "unavailable" {
				t.Fatalf("status body = %q", got)
			}
		})
	}

	t.Run("error del store", func(t *testing.T) {
		store := &analyticsFeesFakeStore{loadErr: errors.New("db caída")}
		api, cookie, _ := newAnalyticsFeesTestAPI(t, `{}`, store)
		recorder := analyticsFeesDo(api, http.MethodGet, "/api/analytics/fees", "", cookie, "", "")
		if recorder.Code != http.StatusServiceUnavailable {
			t.Fatalf("status = %d (cuerpo %q)", recorder.Code, recorder.Body.String())
		}
		if got := analyticsFeesStatus(t, recorder); got != "unavailable" {
			t.Fatalf("status body = %q", got)
		}
	})
}

func TestAnalyticsFeesAuthAndRoutes(t *testing.T) {
	store := &analyticsFeesFakeStore{}
	api, _, csrf := newAnalyticsFeesTestAPI(t, analyticsFeesTestSnapshot(t, 1, "account-1"), store)
	body := analyticsFeesBody(t, map[string]any{
		"uuid": "offer-01", "feeQusd": 2, "evidence": "evidencia válida", "expectedVersion": 0,
	})

	recorder := analyticsFeesDo(api, http.MethodGet, "/api/analytics/fees", "", nil, "", "")
	if recorder.Code != http.StatusUnauthorized {
		t.Fatalf("GET status = %d", recorder.Code)
	}
	recorder = analyticsFeesDo(api, http.MethodPost, "/api/analytics/fees", body, nil, csrf, "https://panel.example")
	if recorder.Code != http.StatusUnauthorized {
		t.Fatalf("POST status = %d", recorder.Code)
	}

	recorder = analyticsFeesDo(api, http.MethodGet, "/api/analytics/otra", "", nil, "", "")
	if recorder.Code != http.StatusNotFound || analyticsFeesStatus(t, recorder) != "not_found" {
		t.Fatalf("ruta GET desconocida: %d %q", recorder.Code, recorder.Body.String())
	}
	analyticsFeesCheckHeaders(t, recorder)
	recorder = analyticsFeesDo(api, http.MethodPost, "/api/analytics/otra", body, nil, "", "")
	if recorder.Code != http.StatusNotFound || analyticsFeesStatus(t, recorder) != "not_found" {
		t.Fatalf("ruta POST desconocida: %d %q", recorder.Code, recorder.Body.String())
	}

	for _, method := range []string{http.MethodPut, http.MethodDelete, http.MethodPatch, http.MethodHead} {
		recorder = analyticsFeesDo(api, method, "/api/analytics/fees", "", nil, "", "")
		if recorder.Code != http.StatusMethodNotAllowed {
			t.Fatalf("%s status = %d", method, recorder.Code)
		}
		if got := recorder.Header().Get("Allow"); got != "GET, POST" {
			t.Fatalf("%s Allow = %q", method, got)
		}
		analyticsFeesCheckHeaders(t, recorder)
	}
}

func TestAnalyticsFeesSaveVersions(t *testing.T) {
	store := &analyticsFeesFakeStore{}
	api, cookie, csrf := newAnalyticsFeesTestAPI(t, analyticsFeesTestSnapshot(t, 1, "account-1"), store)

	firstBody := analyticsFeesBody(t, map[string]any{
		"uuid": "offer-01", "feeQusd": 2.5,
		"evidence": "evidencia válida", "expectedVersion": 0,
	})
	recorder := analyticsFeesDo(api, http.MethodPost, "/api/analytics/fees", firstBody, cookie, csrf, "https://panel.example")
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d (cuerpo %q)", recorder.Code, recorder.Body.String())
	}
	analyticsFeesCheckHeaders(t, recorder)
	saved := analyticsFeesDecode[analyticsFeesSaveResponse](t, recorder)
	if saved.Data.Version != 1 {
		t.Fatalf("version = %d", saved.Data.Version)
	}
	if store.lastSaveAccount != "account-1" || store.lastSaved.OfferUUID != "offer-01" ||
		store.lastSaved.GrossQusd != 11 || store.lastSaved.FeeQusd != 2.5 ||
		store.lastSaved.Evidence != "evidencia válida" ||
		store.lastSaved.UpdatedAt != analyticsFeesTestNowMS {
		t.Fatalf("guardado = %+v cuenta=%q", store.lastSaved, store.lastSaveAccount)
	}

	secondBody := analyticsFeesBody(t, map[string]any{
		"uuid": "offer-01", "feeQusd": 3,
		"evidence": "evidencia segunda", "expectedVersion": 1,
	})
	recorder = analyticsFeesDo(api, http.MethodPost, "/api/analytics/fees", secondBody, cookie, csrf, "https://panel.example")
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d (cuerpo %q)", recorder.Code, recorder.Body.String())
	}
	saved = analyticsFeesDecode[analyticsFeesSaveResponse](t, recorder)
	if saved.Data.Version != 2 {
		t.Fatalf("version = %d", saved.Data.Version)
	}
	if store.lastSaved.FeeQusd != 3 || store.lastSaved.Evidence != "evidencia segunda" {
		t.Fatalf("guardado = %+v", store.lastSaved)
	}

	recorder = analyticsFeesDo(api, http.MethodGet, "/api/analytics/fees", "", cookie, "", "")
	if recorder.Code != http.StatusOK {
		t.Fatalf("GET status = %d (cuerpo %q)", recorder.Code, recorder.Body.String())
	}
	response := analyticsFeesDecode[analyticsFeesResponse](t, recorder)
	if len(response.Data.Items) != 1 {
		t.Fatalf("items = %d", len(response.Data.Items))
	}
	item := response.Data.Items[0]
	analyticsFeesCheckFee(t, item, 3)
	if item.Evidence != "evidencia segunda" || item.Version != 2 || item.Stale {
		t.Fatalf("item = %+v", item)
	}
}

func TestAnalyticsFeesSaveConflict(t *testing.T) {
	store := &analyticsFeesFakeStore{records: map[string]map[string]FeeRecord{
		"account-1": {
			"offer-01": {
				OfferUUID: "offer-01", GrossQusd: 11, FeeQusd: 2,
				Evidence: "evidencia previa", Version: 2, UpdatedAt: 1,
			},
		},
	}}
	api, cookie, csrf := newAnalyticsFeesTestAPI(t, analyticsFeesTestSnapshot(t, 1, "account-1"), store)
	body := analyticsFeesBody(t, map[string]any{
		"uuid": "offer-01", "feeQusd": 2, "evidence": "evidencia válida", "expectedVersion": 1,
	})

	recorder := analyticsFeesDo(api, http.MethodPost, "/api/analytics/fees", body, cookie, csrf, "https://panel.example")
	if recorder.Code != http.StatusConflict {
		t.Fatalf("status = %d (cuerpo %q)", recorder.Code, recorder.Body.String())
	}
	if got := analyticsFeesError(t, recorder); got != "El registro cambió; actualiza la lista antes de guardar." {
		t.Fatalf("error = %q", got)
	}
	if store.saveCalls != 0 {
		t.Fatalf("saveCalls = %d", store.saveCalls)
	}
}

func TestAnalyticsFeesSaveMissingOffer(t *testing.T) {
	api, cookie, csrf := newAnalyticsFeesTestAPI(t, analyticsFeesTestSnapshot(t, 1, "account-1"), &analyticsFeesFakeStore{})
	uuids := []string{"", "offer-99", strings.Repeat("a", analyticsFeesMaxUUIDRunes+1)}
	for _, uuid := range uuids {
		body := analyticsFeesBody(t, map[string]any{
			"uuid": uuid, "feeQusd": 2, "evidence": "evidencia válida", "expectedVersion": 0,
		})
		recorder := analyticsFeesDo(api, http.MethodPost, "/api/analytics/fees", body, cookie, csrf, "https://panel.example")
		if recorder.Code != http.StatusBadRequest {
			t.Fatalf("uuid %q: status = %d (cuerpo %q)", uuid, recorder.Code, recorder.Body.String())
		}
		if got := analyticsFeesError(t, recorder); got != "La compra completada no está en el historial." {
			t.Fatalf("uuid %q: error = %q", uuid, got)
		}
	}

	recorder := analyticsFeesDo(api, http.MethodPost, "/api/analytics/fees",
		`{"feeQusd":2,"evidence":"evidencia válida","expectedVersion":0}`,
		cookie, csrf, "https://panel.example")
	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("sin uuid: status = %d (cuerpo %q)", recorder.Code, recorder.Body.String())
	}
}

func TestAnalyticsFeesSaveInvalidFee(t *testing.T) {
	api, cookie, csrf := newAnalyticsFeesTestAPI(t, analyticsFeesTestSnapshot(t, 1, "account-1"), &analyticsFeesFakeStore{})
	bodies := []string{
		analyticsFeesBody(t, map[string]any{"uuid": "offer-01", "feeQusd": -1, "evidence": "evidencia válida", "expectedVersion": 0}),
		analyticsFeesBody(t, map[string]any{"uuid": "offer-01", "feeQusd": 11, "evidence": "evidencia válida", "expectedVersion": 0}),
		analyticsFeesBody(t, map[string]any{"uuid": "offer-01", "feeQusd": 12, "evidence": "evidencia válida", "expectedVersion": 0}),
		analyticsFeesBody(t, map[string]any{"uuid": "offer-01", "feeQusd": nil, "evidence": "evidencia válida", "expectedVersion": 0}),
		analyticsFeesBody(t, map[string]any{"uuid": "offer-01", "evidence": "evidencia válida", "expectedVersion": 0}),
		`{"uuid":"offer-01","feeQusd":1e999,"evidence":"evidencia válida","expectedVersion":0}`,
	}
	for _, body := range bodies {
		recorder := analyticsFeesDo(api, http.MethodPost, "/api/analytics/fees", body, cookie, csrf, "https://panel.example")
		if recorder.Code != http.StatusBadRequest {
			t.Fatalf("body %q: status = %d (cuerpo %q)", body, recorder.Code, recorder.Body.String())
		}
	}
}

func TestAnalyticsFeesSaveInvalidEvidence(t *testing.T) {
	api, cookie, csrf := newAnalyticsFeesTestAPI(t, analyticsFeesTestSnapshot(t, 1, "account-1"), &analyticsFeesFakeStore{})
	bodies := []string{
		analyticsFeesBody(t, map[string]any{"uuid": "offer-01", "feeQusd": 2, "evidence": strings.Repeat("a", 9), "expectedVersion": 0}),
		analyticsFeesBody(t, map[string]any{"uuid": "offer-01", "feeQusd": 2, "evidence": strings.Repeat("a", 501), "expectedVersion": 0}),
		analyticsFeesBody(t, map[string]any{"uuid": "offer-01", "feeQusd": 2, "evidence": nil, "expectedVersion": 0}),
		analyticsFeesBody(t, map[string]any{"uuid": "offer-01", "feeQusd": 2, "expectedVersion": 0}),
	}
	for _, body := range bodies {
		recorder := analyticsFeesDo(api, http.MethodPost, "/api/analytics/fees", body, cookie, csrf, "https://panel.example")
		if recorder.Code != http.StatusBadRequest {
			t.Fatalf("body %q: status = %d (cuerpo %q)", body, recorder.Code, recorder.Body.String())
		}
	}

	body := analyticsFeesBody(t, map[string]any{
		"uuid": "offer-01", "feeQusd": 2,
		"evidence": strings.Repeat("é", analyticsFeesMaxEvidenceRunes), "expectedVersion": 0,
	})
	recorder := analyticsFeesDo(api, http.MethodPost, "/api/analytics/fees", body, cookie, csrf, "https://panel.example")
	if recorder.Code != http.StatusOK {
		t.Fatalf("500 runes: status = %d (cuerpo %q)", recorder.Code, recorder.Body.String())
	}
}

func TestAnalyticsFeesSaveInvalidVersion(t *testing.T) {
	api, cookie, csrf := newAnalyticsFeesTestAPI(t, analyticsFeesTestSnapshot(t, 1, "account-1"), &analyticsFeesFakeStore{})
	bodies := []string{
		analyticsFeesBody(t, map[string]any{"uuid": "offer-01", "feeQusd": 2, "evidence": "evidencia válida", "expectedVersion": -1}),
		analyticsFeesBody(t, map[string]any{"uuid": "offer-01", "feeQusd": 2, "evidence": "evidencia válida", "expectedVersion": nil}),
		analyticsFeesBody(t, map[string]any{"uuid": "offer-01", "feeQusd": 2, "evidence": "evidencia válida"}),
		`{"uuid":"offer-01","feeQusd":2,"evidence":"evidencia válida","expectedVersion":1.5}`,
	}
	for _, body := range bodies {
		recorder := analyticsFeesDo(api, http.MethodPost, "/api/analytics/fees", body, cookie, csrf, "https://panel.example")
		if recorder.Code != http.StatusBadRequest {
			t.Fatalf("body %q: status = %d (cuerpo %q)", body, recorder.Code, recorder.Body.String())
		}
	}
}

func TestAnalyticsFeesSaveCSRFAndOrigin(t *testing.T) {
	store := &analyticsFeesFakeStore{}
	api, cookie, csrf := newAnalyticsFeesTestAPI(t, analyticsFeesTestSnapshot(t, 1, "account-1"), store)
	body := analyticsFeesBody(t, map[string]any{
		"uuid": "offer-01", "feeQusd": 2, "evidence": "evidencia válida", "expectedVersion": 0,
	})
	cases := []struct {
		name   string
		csrf   string
		origin string
	}{
		{name: "sin origin", csrf: csrf},
		{name: "origin ajeno", csrf: csrf, origin: "https://evil.example"},
		{name: "sin csrf", origin: "https://panel.example"},
		{name: "csrf inválido", csrf: "csrf-falso", origin: "https://panel.example"},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			recorder := analyticsFeesDo(api, http.MethodPost, "/api/analytics/fees", body, cookie, testCase.csrf, testCase.origin)
			if recorder.Code != http.StatusForbidden {
				t.Fatalf("status = %d (cuerpo %q)", recorder.Code, recorder.Body.String())
			}
		})
	}
	if store.saveCalls != 0 {
		t.Fatalf("saveCalls = %d", store.saveCalls)
	}
}

func TestAnalyticsFeesSaveUnavailable(t *testing.T) {
	t.Run("sin store", func(t *testing.T) {
		api, cookie, csrf := newAnalyticsFeesTestAPI(t, analyticsFeesTestSnapshot(t, 1, "account-1"), nil)
		body := analyticsFeesBody(t, map[string]any{
			"uuid": "offer-01", "feeQusd": 2, "evidence": "evidencia válida", "expectedVersion": 0,
		})
		recorder := analyticsFeesDo(api, http.MethodPost, "/api/analytics/fees", body, cookie, csrf, "https://panel.example")
		if recorder.Code != http.StatusServiceUnavailable {
			t.Fatalf("status = %d (cuerpo %q)", recorder.Code, recorder.Body.String())
		}
		if got := analyticsFeesStatus(t, recorder); got != "unavailable" {
			t.Fatalf("status body = %q", got)
		}
	})

	t.Run("error al cargar", func(t *testing.T) {
		store := &analyticsFeesFakeStore{loadErr: errors.New("db caída")}
		api, cookie, csrf := newAnalyticsFeesTestAPI(t, analyticsFeesTestSnapshot(t, 1, "account-1"), store)
		body := analyticsFeesBody(t, map[string]any{
			"uuid": "offer-01", "feeQusd": 2, "evidence": "evidencia válida", "expectedVersion": 0,
		})
		recorder := analyticsFeesDo(api, http.MethodPost, "/api/analytics/fees", body, cookie, csrf, "https://panel.example")
		if recorder.Code != http.StatusServiceUnavailable {
			t.Fatalf("status = %d (cuerpo %q)", recorder.Code, recorder.Body.String())
		}
	})

	t.Run("error al guardar", func(t *testing.T) {
		store := &analyticsFeesFakeStore{saveErr: errors.New("db caída")}
		api, cookie, csrf := newAnalyticsFeesTestAPI(t, analyticsFeesTestSnapshot(t, 1, "account-1"), store)
		body := analyticsFeesBody(t, map[string]any{
			"uuid": "offer-01", "feeQusd": 2, "evidence": "evidencia válida", "expectedVersion": 0,
		})
		recorder := analyticsFeesDo(api, http.MethodPost, "/api/analytics/fees", body, cookie, csrf, "https://panel.example")
		if recorder.Code != http.StatusServiceUnavailable {
			t.Fatalf("status = %d (cuerpo %q)", recorder.Code, recorder.Body.String())
		}
	})
}

func TestAnalyticsFeesSaveRejectsMalformedBody(t *testing.T) {
	api, cookie, csrf := newAnalyticsFeesTestAPI(t, analyticsFeesTestSnapshot(t, 1, "account-1"), &analyticsFeesFakeStore{})
	bodies := []string{
		"",
		"null",
		"{",
		`{"uuid":"offer-01","feeQusd":2,"evidence":"evidencia válida","expectedVersion":0,"extra":true}`,
		`{"uuid":"offer-01","feeQusd":2,"evidence":"evidencia válida","expectedVersion":0} {"otro":1}`,
		strings.Repeat("a", analyticsFeesMaxBodyBytes+1),
	}
	for _, body := range bodies {
		recorder := analyticsFeesDo(api, http.MethodPost, "/api/analytics/fees", body, cookie, csrf, "https://panel.example")
		if recorder.Code != http.StatusBadRequest {
			t.Fatalf("body %q: status = %d (cuerpo %q)", body, recorder.Code, recorder.Body.String())
		}
	}
}
