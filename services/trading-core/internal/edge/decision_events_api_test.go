package edge

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"
)

const decisionEventsTestNowMS int64 = 1_700_000_000_000

const decisionEventsTestSnapshot = `{
 "decisionEvents":[
  {"id":1,"version":"v1","uuid":"offer-1","coin":"CLASICA","offerType":"sell","amount":1,"receive":2,"rate":2,"decision":"applied","reason":"aplicada","checks":[{"code":"price","ok":true,"detail":"ok"}],"referenceRate":2.1,"resolution":"applied","createdAt":10,"updatedAt":100,"resolvedAt":200},
  {"id":2,"version":"v2","uuid":"offer-2","coin":"CLASICA","offerType":"buy","amount":2,"receive":4,"rate":2,"decision":"blocked","reason":"bloqueada","checks":[{"code":"price","ok":false,"detail":"desvío"}],"referenceRate":2.1,"resolution":null,"createdAt":20,"updatedAt":300,"resolvedAt":null},
  {"id":3,"version":"v3","uuid":"offer-3","coin":"BANK_CUP","offerType":"sell","amount":3,"receive":6,"rate":2,"decision":"manual_review","reason":"revisar","checks":[],"createdAt":30,"updatedAt":500,"resolvedAt":null},
  {"id":4,"version":"v4","uuid":"offer-4","coin":"BANK_CUP","offerType":"buy","amount":4,"receive":8,"rate":2,"decision":"blocked","reason":"bloqueada","referenceRate":null,"resolution":null,"createdAt":40,"updatedAt":400,"resolvedAt":null},
  {"id":5,"version":"v5","uuid":"offer-5","coin":"CLASICA","offerType":"sell","amount":5,"receive":10,"rate":2,"decision":"applied","reason":"aplicada","checks":[{"code":"risk","ok":true,"detail":"ok"}],"referenceRate":2.1,"resolution":null,"createdAt":50,"updatedAt":600,"resolvedAt":null},
  {"id":6,"version":"v6","uuid":"offer-6","coin":"CLASICA","offerType":"buy","amount":6,"receive":12,"rate":2,"decision":"blocked","reason":"bloqueada","checks":[],"referenceRate":2.1,"resolution":"dismissed","createdAt":60,"updatedAt":200,"resolvedAt":250},
  {"id":7,"version":"v7","uuid":"offer-7","coin":"BANK_CUP","offerType":"sell","amount":7,"receive":14,"rate":2,"decision":"manual_review","reason":"revisada","checks":[],"referenceRate":2.1,"resolution":"resolved","createdAt":70,"updatedAt":600,"resolvedAt":700},
  {"id":8,"version":"v8","uuid":"offer-8","coin":"CLASICA","offerType":"sell","amount":8,"receive":16,"rate":2,"decision":"blocked","reason":"bloqueada","checks":null,"referenceRate":2.1,"resolution":null,"createdAt":80,"updatedAt":600,"resolvedAt":null}
 ]
}`

type decisionEventsDismissalCall struct {
	ids []int64
	now int64
}

type decisionEventsFakeDismissalStore struct {
	dismissed map[int64]struct{}
	allErr    error
	addErr    error
	allHits   int
	calls     []decisionEventsDismissalCall
}

func (store *decisionEventsFakeDismissalStore) All(context.Context) (map[int64]struct{}, error) {
	store.allHits++
	if store.allErr != nil {
		return nil, store.allErr
	}
	return store.dismissed, nil
}

func (store *decisionEventsFakeDismissalStore) Add(_ context.Context, ids []int64, now int64) error {
	if store.addErr != nil {
		return store.addErr
	}
	store.calls = append(store.calls, decisionEventsDismissalCall{
		ids: append([]int64(nil), ids...),
		now: now,
	})
	if store.dismissed == nil {
		store.dismissed = make(map[int64]struct{})
	}
	for _, id := range ids {
		store.dismissed[id] = struct{}{}
	}
	return nil
}

type decisionEventsTestItem struct {
	ID            int64           `json:"id"`
	Version       string          `json:"version"`
	UUID          string          `json:"uuid"`
	Coin          string          `json:"coin"`
	OfferType     string          `json:"offerType"`
	Amount        float64         `json:"amount"`
	Receive       float64         `json:"receive"`
	Rate          float64         `json:"rate"`
	Decision      string          `json:"decision"`
	Reason        string          `json:"reason"`
	Checks        json.RawMessage `json:"checks"`
	ReferenceRate *float64        `json:"referenceRate"`
	Resolution    *string         `json:"resolution"`
	CreatedAt     int64           `json:"createdAt"`
	UpdatedAt     int64           `json:"updatedAt"`
	ResolvedAt    *int64          `json:"resolvedAt"`
}

type decisionEventsTestPage struct {
	Items            []decisionEventsTestItem `json:"items"`
	Total            int                      `json:"total"`
	Pending          int                      `json:"pending"`
	Page             int                      `json:"page"`
	PageSize         int                      `json:"pageSize"`
	DismissThroughID int64                    `json:"dismissThroughId"`
}

type decisionEventsTestResponse struct {
	Data   decisionEventsTestPage `json:"data"`
	Source string                 `json:"source"`
}

func decisionEventsTestSession(t *testing.T) (*SessionManager, *http.Cookie, string, time.Time) {
	t.Helper()
	manager := newSessionTestManager(t, 15*time.Minute)
	now := time.UnixMilli(decisionEventsTestNowMS)
	token, csrf, err := manager.Issue(now)
	if err != nil {
		t.Fatalf("Issue: %v", err)
	}
	return manager, &http.Cookie{Name: CookieName, Value: token}, csrf, now
}

func newDecisionEventsTestAPIWithFile(
	t *testing.T,
	file string,
) (*DecisionEventsAPI, *decisionEventsFakeDismissalStore, *http.Cookie, string) {
	t.Helper()
	manager, cookie, csrf, now := decisionEventsTestSession(t)
	store := &decisionEventsFakeDismissalStore{}
	api := &DecisionEventsAPI{
		Sessions:      manager,
		File:          file,
		Dismissals:    store,
		TrustedOrigin: "https://panel.example",
		Now:           func() time.Time { return now },
	}
	return api, store, cookie, csrf
}

func newDecisionEventsTestAPI(
	t *testing.T,
	snapshot string,
) (*DecisionEventsAPI, *decisionEventsFakeDismissalStore, *http.Cookie, string) {
	t.Helper()
	file := filepath.Join(t.TempDir(), "web-extras.json")
	if err := os.WriteFile(file, []byte(snapshot), 0o600); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}
	return newDecisionEventsTestAPIWithFile(t, file)
}

func decisionEventsDo(
	api *DecisionEventsAPI,
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

func decodeDecisionEventsResponse[T any](t *testing.T, recorder *httptest.ResponseRecorder) T {
	t.Helper()
	var value T
	if err := json.Unmarshal(recorder.Body.Bytes(), &value); err != nil {
		t.Fatalf("JSON inválido: %v (cuerpo %q)", err, recorder.Body.String())
	}
	return value
}

func decisionEventsItemIDs(items []decisionEventsTestItem) []int64 {
	ids := make([]int64, 0, len(items))
	for _, item := range items {
		ids = append(ids, item.ID)
	}
	return ids
}

func decisionEventsGetPage(
	t *testing.T,
	api *DecisionEventsAPI,
	cookie *http.Cookie,
	target string,
) decisionEventsTestPage {
	t.Helper()
	recorder := decisionEventsDo(api, http.MethodGet, target, "", cookie, "", "")
	if recorder.Code != http.StatusOK {
		t.Fatalf("%s: status = %d (cuerpo %q)", target, recorder.Code, recorder.Body.String())
	}
	response := decodeDecisionEventsResponse[decisionEventsTestResponse](t, recorder)
	if response.Source != "sqlite" {
		t.Fatalf("%s: source = %q", target, response.Source)
	}
	if response.Data.Items == nil {
		t.Fatalf("%s: items debe ser un array", target)
	}
	return response.Data
}

func TestDecisionEventsListFiltersAndPagination(t *testing.T) {
	api, store, cookie, _ := newDecisionEventsTestAPI(t, decisionEventsTestSnapshot)

	cases := []struct {
		name     string
		target   string
		ids      []int64
		total    int
		pending  int
		page     int
		pageSize int
	}{
		{
			name: "default", target: "/api/decision-events",
			ids: []int64{8, 5, 3, 4, 2, 7, 6, 1}, total: 8, pending: 4,
			page: 1, pageSize: 20,
		},
		{
			name: "status all", target: "/api/decision-events?status=all",
			ids: []int64{8, 5, 3, 4, 2, 7, 6, 1}, total: 8, pending: 4,
			page: 1, pageSize: 20,
		},
		{
			name: "decision blocked", target: "/api/decision-events?decision=blocked",
			ids: []int64{8, 4, 2, 6}, total: 4, pending: 3,
			page: 1, pageSize: 20,
		},
		{
			name: "decision manual_review", target: "/api/decision-events?decision=manual_review",
			ids: []int64{3, 7}, total: 2, pending: 1,
			page: 1, pageSize: 20,
		},
		{
			name: "decision applied", target: "/api/decision-events?decision=applied",
			ids: []int64{5, 1}, total: 2, pending: 0,
			page: 1, pageSize: 20,
		},
		{
			name: "status pending", target: "/api/decision-events?status=pending",
			ids: []int64{8, 5, 3, 4, 2}, total: 5, pending: 4,
			page: 1, pageSize: 20,
		},
		{
			name: "status resolved", target: "/api/decision-events?status=resolved",
			ids: []int64{7, 6, 1}, total: 3, pending: 0,
			page: 1, pageSize: 20,
		},
		{
			name: "blocked pending", target: "/api/decision-events?decision=blocked&status=pending",
			ids: []int64{8, 4, 2}, total: 3, pending: 3,
			page: 1, pageSize: 20,
		},
		{
			name: "blocked resolved", target: "/api/decision-events?decision=blocked&status=resolved",
			ids: []int64{6}, total: 1, pending: 0,
			page: 1, pageSize: 20,
		},
		{
			name: "applied pending", target: "/api/decision-events?decision=applied&status=pending",
			ids: []int64{5}, total: 1, pending: 0,
			page: 1, pageSize: 20,
		},
		{
			name: "page 2 size 3", target: "/api/decision-events?page=2&pageSize=3",
			ids: []int64{4, 2, 7}, total: 8, pending: 4,
			page: 2, pageSize: 3,
		},
		{
			name: "page 3 size 3", target: "/api/decision-events?page=3&pageSize=3",
			ids: []int64{6, 1}, total: 8, pending: 4,
			page: 3, pageSize: 3,
		},
		{
			name: "page 8 size 1", target: "/api/decision-events?page=8&pageSize=1",
			ids: []int64{1}, total: 8, pending: 4,
			page: 8, pageSize: 1,
		},
		{
			name: "page beyond", target: "/api/decision-events?page=9&pageSize=1",
			ids: []int64{}, total: 8, pending: 4,
			page: 9, pageSize: 1,
		},
		{
			name: "max bounds", target: "/api/decision-events?page=100000&pageSize=100",
			ids: []int64{}, total: 8, pending: 4,
			page: 100_000, pageSize: 100,
		},
	}

	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			page := decisionEventsGetPage(t, api, cookie, testCase.target)
			if got := decisionEventsItemIDs(page.Items); !slices.Equal(got, testCase.ids) {
				t.Fatalf("ids = %v, quiero %v", got, testCase.ids)
			}
			if page.Total != testCase.total {
				t.Fatalf("total = %d, quiero %d", page.Total, testCase.total)
			}
			if page.Pending != testCase.pending {
				t.Fatalf("pending = %d, quiero %d", page.Pending, testCase.pending)
			}
			if page.Page != testCase.page || page.PageSize != testCase.pageSize {
				t.Fatalf("page=%d pageSize=%d", page.Page, page.PageSize)
			}
			if page.DismissThroughID != 8 {
				t.Fatalf("dismissThroughId = %d, quiero 8", page.DismissThroughID)
			}
		})
	}

	if store.allHits != len(cases) {
		t.Fatalf("All llamado %d veces, quiero %d", store.allHits, len(cases))
	}
}

func TestDecisionEventsListExcludesDismissals(t *testing.T) {
	api, store, cookie, _ := newDecisionEventsTestAPI(t, decisionEventsTestSnapshot)
	store.dismissed = map[int64]struct{}{4: {}, 8: {}}

	page := decisionEventsGetPage(t, api, cookie, "/api/decision-events")
	if got, want := decisionEventsItemIDs(page.Items), []int64{5, 3, 2, 7, 6, 1}; !slices.Equal(got, want) {
		t.Fatalf("ids = %v, quiero %v", got, want)
	}
	if page.Total != 6 || page.Pending != 2 {
		t.Fatalf("total=%d pending=%d", page.Total, page.Pending)
	}
	// dismissThroughId se calcula sobre el snapshot completo, no sobre la
	// vista ya filtrada por descartes.
	if page.DismissThroughID != 8 {
		t.Fatalf("dismissThroughId = %d, quiero 8", page.DismissThroughID)
	}

	blocked := decisionEventsGetPage(t, api, cookie, "/api/decision-events?decision=blocked")
	if got, want := decisionEventsItemIDs(blocked.Items), []int64{2, 6}; !slices.Equal(got, want) {
		t.Fatalf("ids = %v, quiero %v", got, want)
	}
	if blocked.Total != 2 || blocked.Pending != 1 {
		t.Fatalf("total=%d pending=%d", blocked.Total, blocked.Pending)
	}
}

func TestDecisionEventsListWithoutDismissalStore(t *testing.T) {
	api, _, cookie, _ := newDecisionEventsTestAPI(t, decisionEventsTestSnapshot)
	api.Dismissals = nil

	page := decisionEventsGetPage(t, api, cookie, "/api/decision-events")
	if page.Total != 8 || page.Pending != 4 {
		t.Fatalf("total=%d pending=%d", page.Total, page.Pending)
	}
}

func TestDecisionEventsListRejectsInvalidFilters(t *testing.T) {
	api, _, cookie, _ := newDecisionEventsTestAPI(t, decisionEventsTestSnapshot)

	decisionTargets := []string{
		"/api/decision-events?decision=bogus",
		"/api/decision-events?decision=ALL",
		"/api/decision-events?decision=blocked_",
	}
	for _, target := range decisionTargets {
		recorder := decisionEventsDo(api, http.MethodGet, target, "", cookie, "", "")
		if recorder.Code != http.StatusBadRequest {
			t.Fatalf("%s: status = %d (cuerpo %q)", target, recorder.Code, recorder.Body.String())
		}
		response := decodeDecisionEventsResponse[map[string]string](t, recorder)
		if response["error"] != "Filtro de decisión inválido." {
			t.Fatalf("%s: error = %q", target, response["error"])
		}
	}

	statusTargets := []string{
		"/api/decision-events?status=bogus",
		"/api/decision-events?status=PENDING",
	}
	for _, target := range statusTargets {
		recorder := decisionEventsDo(api, http.MethodGet, target, "", cookie, "", "")
		if recorder.Code != http.StatusBadRequest {
			t.Fatalf("%s: status = %d (cuerpo %q)", target, recorder.Code, recorder.Body.String())
		}
	}

	otherTargets := []string{
		"/api/decision-events?page=0",
		"/api/decision-events?page=-1",
		"/api/decision-events?page=100001",
		"/api/decision-events?page=abc",
		"/api/decision-events?page=1.5",
		"/api/decision-events?pageSize=0",
		"/api/decision-events?pageSize=101",
		"/api/decision-events?pageSize=abc",
		"/api/decision-events?pageSize=-2",
	}
	for _, target := range otherTargets {
		recorder := decisionEventsDo(api, http.MethodGet, target, "", cookie, "", "")
		if recorder.Code != http.StatusBadRequest {
			t.Fatalf("%s: status = %d (cuerpo %q)", target, recorder.Code, recorder.Body.String())
		}
	}

	validTargets := []string{
		"/api/decision-events?page=1&pageSize=1",
		"/api/decision-events?page=100000&pageSize=100",
		"/api/decision-events?decision=applied&status=all",
		"/api/decision-events?status=pending",
		"/api/decision-events?status=resolved",
	}
	for _, target := range validTargets {
		recorder := decisionEventsDo(api, http.MethodGet, target, "", cookie, "", "")
		if recorder.Code != http.StatusOK {
			t.Fatalf("%s: status = %d (cuerpo %q)", target, recorder.Code, recorder.Body.String())
		}
	}
}

func TestDecisionEventsListRequiresAuth(t *testing.T) {
	api, _, cookie, _ := newDecisionEventsTestAPI(t, decisionEventsTestSnapshot)

	for _, requestCookie := range []*http.Cookie{nil, {Name: CookieName, Value: "manipulada"}} {
		recorder := decisionEventsDo(api, http.MethodGet, "/api/decision-events", "", requestCookie, "", "")
		if recorder.Code != http.StatusUnauthorized {
			t.Fatalf("status = %d (cuerpo %q)", recorder.Code, recorder.Body.String())
		}
		response := decodeDecisionEventsResponse[map[string]string](t, recorder)
		if response["error"] != "Autenticación requerida." {
			t.Fatalf("error = %q", response["error"])
		}
	}

	_ = cookie
}

func TestDecisionEventsHeaders(t *testing.T) {
	api, _, cookie, _ := newDecisionEventsTestAPI(t, decisionEventsTestSnapshot)

	recorder := decisionEventsDo(api, http.MethodGet, "/api/decision-events", "", cookie, "", "")
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d", recorder.Code)
	}
	headers := recorder.Header()
	if got := headers.Get("Cache-Control"); got != "no-store" {
		t.Fatalf("Cache-Control = %q", got)
	}
	if got := headers.Get("Content-Type"); got != "application/json; charset=utf-8" {
		t.Fatalf("Content-Type = %q", got)
	}
	if got := headers.Get("X-Content-Type-Options"); got != "nosniff" {
		t.Fatalf("X-Content-Type-Options = %q", got)
	}
	if got := headers.Get("Access-Control-Allow-Origin"); got != "" {
		t.Fatalf("Access-Control-Allow-Origin = %q", got)
	}

	notFound := decisionEventsDo(api, http.MethodGet, "/api/decision-events/desconocida", "", cookie, "", "")
	if notFound.Code != http.StatusNotFound {
		t.Fatalf("status = %d", notFound.Code)
	}
	if got := notFound.Header().Get("Cache-Control"); got != "no-store" {
		t.Fatalf("404 Cache-Control = %q", got)
	}
	if got := notFound.Header().Get("X-Content-Type-Options"); got != "nosniff" {
		t.Fatalf("404 X-Content-Type-Options = %q", got)
	}
}

func TestDecisionEventsSnapshotEmpty(t *testing.T) {
	cases := []struct {
		name string
		file string
	}{
		{name: "file vacío", file: ""},
		{name: "archivo ausente", file: filepath.Join(t.TempDir(), "no-existe.json")},
		{name: "sin clave", file: ""},
		{name: "clave null", file: ""},
	}
	cases[2].file = decisionEventsWriteTestFile(t, `{}`)
	cases[3].file = decisionEventsWriteTestFile(t, `{"decisionEvents":null}`)

	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			api, store, cookie, _ := newDecisionEventsTestAPIWithFile(t, testCase.file)
			page := decisionEventsGetPage(t, api, cookie, "/api/decision-events")
			if len(page.Items) != 0 || page.Total != 0 || page.Pending != 0 {
				t.Fatalf("items=%d total=%d pending=%d", len(page.Items), page.Total, page.Pending)
			}
			if page.DismissThroughID != 0 {
				t.Fatalf("dismissThroughId = %d", page.DismissThroughID)
			}
			if page.Page != 1 || page.PageSize != 20 {
				t.Fatalf("page=%d pageSize=%d", page.Page, page.PageSize)
			}
			if store.allHits != 1 {
				t.Fatalf("All llamado %d veces", store.allHits)
			}
		})
	}
}

func decisionEventsWriteTestFile(t *testing.T, content string) string {
	t.Helper()
	file := filepath.Join(t.TempDir(), "web-extras.json")
	if err := os.WriteFile(file, []byte(content), 0o600); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}
	return file
}

func TestDecisionEventsSnapshotUnavailable(t *testing.T) {
	cases := []struct {
		name string
		file string
	}{
		{name: "json inválido", file: decisionEventsWriteTestFile(t, `{`)},
		{name: "tipo inválido", file: decisionEventsWriteTestFile(t, `{"decisionEvents":{}}`)},
		{name: "directorio", file: t.TempDir()},
		{
			name: "demasiado grande",
			file: decisionEventsWriteTestFile(t,
				`{"decisionEvents":[]}`+strings.Repeat(" ", decisionEventsMaxSnapshotBytes)),
		},
	}

	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			api, _, cookie, _ := newDecisionEventsTestAPIWithFile(t, testCase.file)
			recorder := decisionEventsDo(api, http.MethodGet, "/api/decision-events", "", cookie, "", "")
			if recorder.Code != http.StatusServiceUnavailable {
				t.Fatalf("status = %d (cuerpo %q)", recorder.Code, recorder.Body.String())
			}
			response := decodeDecisionEventsResponse[map[string]string](t, recorder)
			if response["status"] != "unavailable" {
				t.Fatalf("cuerpo = %q", recorder.Body.String())
			}
			if strings.Contains(recorder.Body.String(), testCase.file) {
				t.Fatalf("la respuesta expone la ruta: %q", recorder.Body.String())
			}
			if strings.Contains(strings.ToLower(recorder.Body.String()), "open") ||
				strings.Contains(recorder.Body.String(), "json") {
				t.Fatalf("la respuesta expone el error: %q", recorder.Body.String())
			}
		})
	}
}

func TestDecisionEventsStoreErrors(t *testing.T) {
	t.Run("All falla", func(t *testing.T) {
		api, store, cookie, _ := newDecisionEventsTestAPI(t, decisionEventsTestSnapshot)
		store.allErr = errors.New("boom")
		recorder := decisionEventsDo(api, http.MethodGet, "/api/decision-events", "", cookie, "", "")
		if recorder.Code != http.StatusServiceUnavailable {
			t.Fatalf("status = %d (cuerpo %q)", recorder.Code, recorder.Body.String())
		}
		if strings.Contains(recorder.Body.String(), "boom") {
			t.Fatalf("la respuesta expone el error: %q", recorder.Body.String())
		}
	})

	t.Run("Add falla al descartar", func(t *testing.T) {
		api, store, cookie, csrf := newDecisionEventsTestAPI(t, decisionEventsTestSnapshot)
		store.addErr = errors.New("boom")
		recorder := decisionEventsDo(api, http.MethodPost, "/api/decision-events/2/dismiss", "",
			cookie, csrf, "https://panel.example")
		if recorder.Code != http.StatusServiceUnavailable {
			t.Fatalf("status = %d (cuerpo %q)", recorder.Code, recorder.Body.String())
		}
	})

	t.Run("Add falla al descartar todo", func(t *testing.T) {
		api, store, cookie, csrf := newDecisionEventsTestAPI(t, decisionEventsTestSnapshot)
		store.addErr = errors.New("boom")
		recorder := decisionEventsDo(api, http.MethodPost, "/api/decision-events/dismiss-all",
			`{"throughId":8}`, cookie, csrf, "https://panel.example")
		if recorder.Code != http.StatusServiceUnavailable {
			t.Fatalf("status = %d (cuerpo %q)", recorder.Code, recorder.Body.String())
		}
	})
}

func TestDecisionEventsItemsFieldsAndChecks(t *testing.T) {
	api, _, cookie, _ := newDecisionEventsTestAPI(t, decisionEventsTestSnapshot)
	recorder := decisionEventsDo(api, http.MethodGet, "/api/decision-events?pageSize=100", "", cookie, "", "")
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d (cuerpo %q)", recorder.Code, recorder.Body.String())
	}

	type rawResponse struct {
		Data struct {
			Items []map[string]json.RawMessage `json:"items"`
		} `json:"data"`
	}
	response := decodeDecisionEventsResponse[rawResponse](t, recorder)
	if len(response.Data.Items) != 8 {
		t.Fatalf("items = %d", len(response.Data.Items))
	}

	baseKeys := []string{
		"id", "version", "uuid", "coin", "offerType", "amount", "receive", "rate",
		"decision", "reason", "checks", "createdAt", "updatedAt", "resolvedAt",
	}
	byID := make(map[int64]map[string]json.RawMessage, len(response.Data.Items))
	for _, item := range response.Data.Items {
		var id int64
		if err := json.Unmarshal(item["id"], &id); err != nil {
			t.Fatalf("id inválido: %v", err)
		}
		byID[id] = item
	}

	for id, item := range byID {
		wantKeys := len(baseKeys)
		if _, ok := item["referenceRate"]; ok {
			wantKeys++
		}
		if _, ok := item["resolution"]; ok {
			wantKeys++
		}
		if len(item) != wantKeys {
			t.Fatalf("id %d: claves = %d, quiero %d (%v)", id, len(item), wantKeys, item)
		}
		for _, key := range baseKeys {
			if _, ok := item[key]; !ok {
				t.Fatalf("id %d: falta %q", id, key)
			}
		}
		checks := strings.TrimSpace(string(item["checks"]))
		if checks == "" || checks == "null" || checks[0] != '[' {
			t.Fatalf("id %d: checks = %q", id, checks)
		}
		if resolvedAt := strings.TrimSpace(string(item["resolvedAt"])); resolvedAt == "" {
			t.Fatalf("id %d: resolvedAt vacío", id)
		}
	}

	applied := byID[1]
	if string(applied["version"]) != `"v1"` || string(applied["uuid"]) != `"offer-1"` ||
		string(applied["coin"]) != `"CLASICA"` || string(applied["offerType"]) != `"sell"` {
		t.Fatalf("id 1: campos = %v", applied)
	}
	if string(applied["amount"]) != "1" || string(applied["receive"]) != "2" || string(applied["rate"]) != "2" {
		t.Fatalf("id 1: números = %v", applied)
	}
	if string(applied["decision"]) != `"applied"` || string(applied["reason"]) != `"aplicada"` {
		t.Fatalf("id 1: decisión = %v", applied)
	}
	if string(applied["referenceRate"]) != "2.1" || string(applied["resolution"]) != `"applied"` {
		t.Fatalf("id 1: opcionales = %v", applied)
	}
	if got := strings.TrimSpace(string(applied["resolvedAt"])); got != "200" {
		t.Fatalf("id 1: resolvedAt = %q", got)
	}
	var appliedChecks []map[string]any
	if err := json.Unmarshal(applied["checks"], &appliedChecks); err != nil {
		t.Fatalf("id 1: checks inválidos: %v", err)
	}
	if len(appliedChecks) != 1 || appliedChecks[0]["code"] != "price" || appliedChecks[0]["ok"] != true {
		t.Fatalf("id 1: checks = %#v", appliedChecks)
	}

	blocked := byID[2]
	if _, ok := blocked["resolution"]; ok {
		t.Fatalf("id 2: resolution null no debe aparecer: %v", blocked)
	}
	if string(blocked["referenceRate"]) != "2.1" {
		t.Fatalf("id 2: referenceRate = %q", blocked["referenceRate"])
	}
	if got := strings.TrimSpace(string(blocked["resolvedAt"])); got != "null" {
		t.Fatalf("id 2: resolvedAt = %q", got)
	}

	noReference := byID[4]
	if _, ok := noReference["referenceRate"]; ok {
		t.Fatalf("id 4: referenceRate null no debe aparecer: %v", noReference)
	}
	if _, ok := noReference["resolution"]; ok {
		t.Fatalf("id 4: resolution null no debe aparecer: %v", noReference)
	}
	if got := strings.TrimSpace(string(noReference["checks"])); got != "[]" {
		t.Fatalf("id 4: checks ausente debe ser []: %q", got)
	}

	nullChecks := byID[8]
	if got := strings.TrimSpace(string(nullChecks["checks"])); got != "[]" {
		t.Fatalf("id 8: checks null debe ser []: %q", got)
	}
}

func TestDecisionEventsDismiss(t *testing.T) {
	api, store, cookie, csrf := newDecisionEventsTestAPI(t, decisionEventsTestSnapshot)

	recorder := decisionEventsDo(api, http.MethodPost, "/api/decision-events/2/dismiss", "",
		cookie, csrf, "https://panel.example")
	if recorder.Code != http.StatusNoContent {
		t.Fatalf("status = %d (cuerpo %q)", recorder.Code, recorder.Body.String())
	}
	if recorder.Body.Len() != 0 {
		t.Fatalf("cuerpo = %q", recorder.Body.String())
	}
	if len(store.calls) != 1 {
		t.Fatalf("llamadas = %d", len(store.calls))
	}
	if got, want := store.calls[0].ids, []int64{2}; !slices.Equal(got, want) {
		t.Fatalf("ids = %v, quiero %v", got, want)
	}
	if store.calls[0].now != decisionEventsTestNowMS {
		t.Fatalf("now = %d", store.calls[0].now)
	}

	page := decisionEventsGetPage(t, api, cookie, "/api/decision-events")
	if slices.Contains(decisionEventsItemIDs(page.Items), 2) {
		t.Fatalf("el evento descartado sigue apareciendo: %v", decisionEventsItemIDs(page.Items))
	}
	if page.Total != 7 || page.Pending != 3 {
		t.Fatalf("total=%d pending=%d", page.Total, page.Pending)
	}

	invalidIDs := []string{"0", "-1", "abc", "1.5", "999999999999999999999"}
	for _, id := range invalidIDs {
		recorder := decisionEventsDo(api, http.MethodPost, "/api/decision-events/"+id+"/dismiss", "",
			cookie, csrf, "https://panel.example")
		if recorder.Code != http.StatusBadRequest {
			t.Fatalf("id %q: status = %d (cuerpo %q)", id, recorder.Code, recorder.Body.String())
		}
	}
}

func TestDecisionEventsDismissRequiresAuthAndCSRF(t *testing.T) {
	api, store, cookie, csrf := newDecisionEventsTestAPI(t, decisionEventsTestSnapshot)

	cases := []struct {
		name       string
		cookie     *http.Cookie
		csrf       string
		origin     string
		wantStatus int
	}{
		{name: "sin cookie", cookie: nil, csrf: csrf, origin: "https://panel.example", wantStatus: http.StatusUnauthorized},
		{name: "sin origen", cookie: cookie, csrf: csrf, origin: "", wantStatus: http.StatusForbidden},
		{name: "origen ajeno", cookie: cookie, csrf: csrf, origin: "https://evil.example", wantStatus: http.StatusForbidden},
		{name: "sin csrf", cookie: cookie, csrf: "", origin: "https://panel.example", wantStatus: http.StatusForbidden},
		{name: "csrf inválido", cookie: cookie, csrf: "bogus", origin: "https://panel.example", wantStatus: http.StatusForbidden},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			recorder := decisionEventsDo(api, http.MethodPost, "/api/decision-events/2/dismiss", "",
				testCase.cookie, testCase.csrf, testCase.origin)
			if recorder.Code != testCase.wantStatus {
				t.Fatalf("status = %d, quiero %d (cuerpo %q)", recorder.Code, testCase.wantStatus, recorder.Body.String())
			}
		})
	}
	if len(store.calls) != 0 {
		t.Fatalf("no debe registrar descartes: %v", store.calls)
	}

	api.Dismissals = nil
	recorder := decisionEventsDo(api, http.MethodPost, "/api/decision-events/2/dismiss", "",
		cookie, csrf, "https://panel.example")
	if recorder.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d (cuerpo %q)", recorder.Code, recorder.Body.String())
	}
}

func TestDecisionEventsDismissAll(t *testing.T) {
	api, store, cookie, csrf := newDecisionEventsTestAPI(t, decisionEventsTestSnapshot)

	recorder := decisionEventsDo(api, http.MethodPost, "/api/decision-events/dismiss-all",
		`{"throughId":8}`, cookie, csrf, "https://panel.example")
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d (cuerpo %q)", recorder.Code, recorder.Body.String())
	}
	response := decodeDecisionEventsResponse[struct {
		Data struct {
			Dismissed int `json:"dismissed"`
		} `json:"data"`
	}](t, recorder)
	if response.Data.Dismissed != 3 {
		t.Fatalf("dismissed = %d, quiero 3", response.Data.Dismissed)
	}
	if len(store.calls) != 1 {
		t.Fatalf("llamadas = %d", len(store.calls))
	}
	if got, want := store.calls[0].ids, []int64{2, 4, 8}; !slices.Equal(got, want) {
		t.Fatalf("ids = %v, quiero %v", got, want)
	}
	if store.calls[0].now != decisionEventsTestNowMS {
		t.Fatalf("now = %d", store.calls[0].now)
	}

	page := decisionEventsGetPage(t, api, cookie, "/api/decision-events?decision=blocked&status=pending")
	if len(page.Items) != 0 || page.Total != 0 || page.Pending != 0 {
		t.Fatalf("items=%d total=%d pending=%d", len(page.Items), page.Total, page.Pending)
	}

	t.Run("throughId 4", func(t *testing.T) {
		api, store, cookie, csrf := newDecisionEventsTestAPI(t, decisionEventsTestSnapshot)
		recorder := decisionEventsDo(api, http.MethodPost, "/api/decision-events/dismiss-all",
			`{"throughId":4}`, cookie, csrf, "https://panel.example")
		if recorder.Code != http.StatusOK {
			t.Fatalf("status = %d (cuerpo %q)", recorder.Code, recorder.Body.String())
		}
		response := decodeDecisionEventsResponse[struct {
			Data struct {
				Dismissed int `json:"dismissed"`
			} `json:"data"`
		}](t, recorder)
		if response.Data.Dismissed != 2 {
			t.Fatalf("dismissed = %d, quiero 2", response.Data.Dismissed)
		}
		if got, want := store.calls[0].ids, []int64{2, 4}; !slices.Equal(got, want) {
			t.Fatalf("ids = %v, quiero %v", got, want)
		}
	})

	t.Run("throughId 1 sin eventos", func(t *testing.T) {
		api, store, cookie, csrf := newDecisionEventsTestAPI(t, decisionEventsTestSnapshot)
		recorder := decisionEventsDo(api, http.MethodPost, "/api/decision-events/dismiss-all",
			`{"throughId":1}`, cookie, csrf, "https://panel.example")
		if recorder.Code != http.StatusOK {
			t.Fatalf("status = %d (cuerpo %q)", recorder.Code, recorder.Body.String())
		}
		response := decodeDecisionEventsResponse[struct {
			Data struct {
				Dismissed int `json:"dismissed"`
			} `json:"data"`
		}](t, recorder)
		if response.Data.Dismissed != 0 {
			t.Fatalf("dismissed = %d, quiero 0", response.Data.Dismissed)
		}
		if len(store.calls) != 1 || len(store.calls[0].ids) != 0 {
			t.Fatalf("llamadas = %v", store.calls)
		}
	})

	t.Run("throughId fuera de rango", func(t *testing.T) {
		api, _, cookie, csrf := newDecisionEventsTestAPI(t, decisionEventsTestSnapshot)
		recorder := decisionEventsDo(api, http.MethodPost, "/api/decision-events/dismiss-all",
			`{"throughId":100}`, cookie, csrf, "https://panel.example")
		if recorder.Code != http.StatusOK {
			t.Fatalf("status = %d (cuerpo %q)", recorder.Code, recorder.Body.String())
		}
		response := decodeDecisionEventsResponse[struct {
			Data struct {
				Dismissed int `json:"dismissed"`
			} `json:"data"`
		}](t, recorder)
		if response.Data.Dismissed != 3 {
			t.Fatalf("dismissed = %d, quiero 3", response.Data.Dismissed)
		}
	})
}

func TestDecisionEventsDismissAllRejectsInvalidBody(t *testing.T) {
	api, store, cookie, csrf := newDecisionEventsTestAPI(t, decisionEventsTestSnapshot)

	bodies := []string{
		"",
		"{}",
		`{"throughId":0}`,
		`{"throughId":-1}`,
		`{"throughId":null}`,
		`{"throughId":"1"}`,
		`{"throughId":1.5}`,
		`{"throughId":1,"extra":true}`,
		`{"throughId":1} {}`,
		`{"throughId":1}x`,
		`[]`,
		`null`,
		`{"throughId":1}` + strings.Repeat(" ", decisionEventsMaxBodyBytes),
	}
	for _, body := range bodies {
		recorder := decisionEventsDo(api, http.MethodPost, "/api/decision-events/dismiss-all",
			body, cookie, csrf, "https://panel.example")
		if recorder.Code != http.StatusBadRequest {
			t.Fatalf("cuerpo %q: status = %d (respuesta %q)", body, recorder.Code, recorder.Body.String())
		}
	}
	if len(store.calls) != 0 {
		t.Fatalf("no debe registrar descartes: %v", store.calls)
	}
}

func TestDecisionEventsDismissAllRequiresAuthAndCSRF(t *testing.T) {
	api, store, cookie, csrf := newDecisionEventsTestAPI(t, decisionEventsTestSnapshot)

	cases := []struct {
		name       string
		cookie     *http.Cookie
		csrf       string
		origin     string
		wantStatus int
	}{
		{name: "sin cookie", cookie: nil, csrf: csrf, origin: "https://panel.example", wantStatus: http.StatusUnauthorized},
		{name: "sin origen", cookie: cookie, csrf: csrf, origin: "", wantStatus: http.StatusForbidden},
		{name: "origen ajeno", cookie: cookie, csrf: csrf, origin: "https://evil.example", wantStatus: http.StatusForbidden},
		{name: "sin csrf", cookie: cookie, csrf: "", origin: "https://panel.example", wantStatus: http.StatusForbidden},
		{name: "csrf inválido", cookie: cookie, csrf: "bogus", origin: "https://panel.example", wantStatus: http.StatusForbidden},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			recorder := decisionEventsDo(api, http.MethodPost, "/api/decision-events/dismiss-all",
				`{"throughId":8}`, testCase.cookie, testCase.csrf, testCase.origin)
			if recorder.Code != testCase.wantStatus {
				t.Fatalf("status = %d, quiero %d (cuerpo %q)", recorder.Code, testCase.wantStatus, recorder.Body.String())
			}
		})
	}
	if len(store.calls) != 0 {
		t.Fatalf("no debe registrar descartes: %v", store.calls)
	}

	api.Dismissals = nil
	recorder := decisionEventsDo(api, http.MethodPost, "/api/decision-events/dismiss-all",
		`{"throughId":8}`, cookie, csrf, "https://panel.example")
	if recorder.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d (cuerpo %q)", recorder.Code, recorder.Body.String())
	}
}

func TestDecisionEventsRoutingAndMethods(t *testing.T) {
	api, _, cookie, _ := newDecisionEventsTestAPI(t, decisionEventsTestSnapshot)

	notFound := []string{
		"/api/decision-events/",
		"/api/decision-events/desconocida",
		"/api/decision-events/1/otro",
		"/api/decision-events/1/dismiss/extra",
		"/api/decision-events/dismiss-all/",
		"/api/otra-cosa",
	}
	for _, target := range notFound {
		recorder := decisionEventsDo(api, http.MethodGet, target, "", cookie, "", "")
		if recorder.Code != http.StatusNotFound {
			t.Fatalf("%s: status = %d (cuerpo %q)", target, recorder.Code, recorder.Body.String())
		}
	}

	methods := []struct {
		method string
		target string
		allow  string
	}{
		{method: http.MethodPost, target: "/api/decision-events", allow: http.MethodGet},
		{method: http.MethodPut, target: "/api/decision-events", allow: http.MethodGet},
		{method: http.MethodGet, target: "/api/decision-events/1/dismiss", allow: http.MethodPost},
		{method: http.MethodPut, target: "/api/decision-events/1/dismiss", allow: http.MethodPost},
		{method: http.MethodGet, target: "/api/decision-events/dismiss-all", allow: http.MethodPost},
		{method: http.MethodDelete, target: "/api/decision-events/dismiss-all", allow: http.MethodPost},
	}
	for _, testCase := range methods {
		recorder := decisionEventsDo(api, testCase.method, testCase.target, "", cookie, "", "")
		if recorder.Code != http.StatusMethodNotAllowed {
			t.Fatalf("%s %s: status = %d (cuerpo %q)", testCase.method, testCase.target,
				recorder.Code, recorder.Body.String())
		}
		if got := recorder.Header().Get("Allow"); got != testCase.allow {
			t.Fatalf("%s %s: Allow = %q, quiero %q", testCase.method, testCase.target,
				got, testCase.allow)
		}
	}
}

func TestDecisionEventsBlockedOfferDismiss(t *testing.T) {
	api, store, cookie, csrf := newDecisionEventsTestAPI(t, decisionEventsTestSnapshot)
	recorder := decisionEventsDo(api, http.MethodPost, "/api/blocked-offers/offer-2/dismiss", "{}",
		cookie, csrf, "https://panel.example")
	if recorder.Code != http.StatusNoContent {
		t.Fatalf("status = %d (cuerpo %q)", recorder.Code, recorder.Body.String())
	}
	if len(store.calls) != 1 || !slices.Equal(store.calls[0].ids, []int64{2}) {
		t.Fatalf("dismissals = %+v", store.calls)
	}

	missing := decisionEventsDo(api, http.MethodPost, "/api/blocked-offers/offer-999/dismiss", "{}",
		cookie, csrf, "https://panel.example")
	if missing.Code != http.StatusNoContent {
		t.Fatalf("oferta ausente: %d", missing.Code)
	}
	if len(store.calls) != 1 {
		t.Fatalf("una oferta sin eventos no debe añadir descartes: %+v", store.calls)
	}

	anonymous := decisionEventsDo(api, http.MethodPost, "/api/blocked-offers/offer-2/dismiss", "{}",
		nil, "", "")
	if anonymous.Code != http.StatusUnauthorized {
		t.Fatalf("sin sesión: %d", anonymous.Code)
	}
	wrongMethod := decisionEventsDo(api, http.MethodGet, "/api/blocked-offers/offer-2/dismiss", "",
		cookie, "", "")
	if wrongMethod.Code != http.StatusMethodNotAllowed {
		t.Fatalf("método: %d", wrongMethod.Code)
	}
}
