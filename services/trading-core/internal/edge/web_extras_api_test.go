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
	"unicode/utf8"
)

const webExtrasTestNowMS int64 = 1_700_000_000_000

const webExtrasTestSnapshot = `{
 "logs":[
  {"id":1,"createdAt":1699999995000,"action":"scan_started","uuid":null,"detail":"scan uno"},
  {"id":2,"createdAt":1699999996000,"action":"operation_applied","uuid":"op-1","detail":"aplicada"},
  {"id":3,"createdAt":1699999997000,"action":"notification_failed","uuid":null,"detail":"falló token=abc"},
  {"id":4,"createdAt":1699999998000,"action":"nats_warning","uuid":"op-2","detail":"retry pendiente"},
  {"id":5,"createdAt":1699999999000,"action":"fiat_confirmed","uuid":null,"detail":"listo"}
 ],
 "notifications":[
  {"id":"n1","kind":"operation-applied","message":"op","operationUuid":"op-1","payload":{},"createdAt":10},
  {"id":"n2","kind":"informational-summary","message":"resumen","operationUuid":null,"payload":{},"createdAt":11},
  {"id":"n3","kind":"system-health","message":"salud","operationUuid":null,"payload":{},"createdAt":12},
  {"id":"n4","kind":"recovery-blocked","message":"recuperar","operationUuid":null,"payload":{"intentId":"intent 1/x"},"createdAt":13},
  {"id":"n5","kind":"rebalance-attention","message":"rebalanceo","operationUuid":null,"payload":{},"createdAt":14},
  {"id":"n6","kind":"own-offer-applied","message":"propia","operationUuid":"own op","payload":{},"createdAt":15},
  {"id":"n7","kind":"reconciliation-required","message":"conciliar","operationUuid":null,"payload":{},"createdAt":16},
  {"id":"n8","kind":"system-health","message":"ackeada","operationUuid":null,"payload":{},"createdAt":17},
  {"id":"n9","kind":"operation-applied","message":"alerta","operationUuid":"op-9","payload":{"alert":{"custom":true}},"createdAt":18},
  {"id":"n10","kind":"operation-applied","message":"datos","operationUuid":"op-10","payload":{"uuid":"u-10","coin":"BANK_CUP","amount":12.5},"createdAt":19}
 ],
 "recovery":{"items":[{"intentId":"i-1","kind":"apply","state":"uncertain","operationUuid":null,"workflowId":null,"createdAt":1,"updatedAt":2,"error":null,"acknowledged":false,"evidence":[],"manualEligible":false,"manualOutcomes":[],"manualBlockedReason":"solo lectura"}],"blocked":true}
}`

type webExtrasAckCall struct {
	id  string
	now int64
}

type webExtrasFakeAckStore struct {
	acked     map[string]struct{}
	ackedErr  error
	ackErr    error
	ackedHits int
	calls     []webExtrasAckCall
}

func (store *webExtrasFakeAckStore) Acked(context.Context) (map[string]struct{}, error) {
	store.ackedHits++
	if store.ackedErr != nil {
		return nil, store.ackedErr
	}
	if store.acked == nil {
		return map[string]struct{}{}, nil
	}
	return store.acked, nil
}

func (store *webExtrasFakeAckStore) Ack(_ context.Context, id string, now int64) error {
	if store.ackErr != nil {
		return store.ackErr
	}
	store.calls = append(store.calls, webExtrasAckCall{id: id, now: now})
	if store.acked == nil {
		store.acked = make(map[string]struct{})
	}
	store.acked[id] = struct{}{}
	return nil
}

func newWebExtrasTestAPI(
	t *testing.T,
	snapshot string,
) (*WebExtrasAPI, *webExtrasFakeAckStore, *http.Cookie, string) {
	t.Helper()
	file := filepath.Join(t.TempDir(), "web-extras.json")
	if err := os.WriteFile(file, []byte(snapshot), 0o600); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}
	manager := newSessionTestManager(t, 15*time.Minute)
	now := time.UnixMilli(webExtrasTestNowMS)
	token, csrf, err := manager.Issue(now)
	if err != nil {
		t.Fatalf("Issue: %v", err)
	}
	acks := &webExtrasFakeAckStore{}
	api := &WebExtrasAPI{
		Sessions: manager, File: file, Acks: acks,
		TrustedOrigin: "https://panel.example",
		Now:           func() time.Time { return now },
	}
	return api, acks, &http.Cookie{Name: CookieName, Value: token}, csrf
}

func webExtrasDo(
	api *WebExtrasAPI,
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

func decodeWebExtrasBody[T any](t *testing.T, recorder *httptest.ResponseRecorder) T {
	t.Helper()
	var value T
	if err := json.Unmarshal(recorder.Body.Bytes(), &value); err != nil {
		t.Fatalf("JSON inválido: %v (cuerpo %q)", err, recorder.Body.String())
	}
	return value
}

func webExtrasLogIDs(page webExtrasLogPage) []int64 {
	ids := make([]int64, 0, len(page.Items))
	for _, item := range page.Items {
		ids = append(ids, item.ID)
	}
	return ids
}

func TestWebExtrasLogsFiltersAndPagination(t *testing.T) {
	api, _, cookie, _ := newWebExtrasTestAPI(t, webExtrasTestSnapshot)

	type logsResponse struct {
		Data   webExtrasLogPage `json:"data"`
		Source string           `json:"source"`
	}
	get := func(target string) logsResponse {
		t.Helper()
		recorder := webExtrasDo(api, http.MethodGet, target, "", cookie, "", "")
		if recorder.Code != http.StatusOK {
			t.Fatalf("%s: status = %d (cuerpo %q)", target, recorder.Code, recorder.Body.String())
		}
		response := decodeWebExtrasBody[logsResponse](t, recorder)
		if response.Source != "sqlite" {
			t.Fatalf("%s: source = %q", target, response.Source)
		}
		if response.Data.Items == nil {
			t.Fatalf("%s: items debe ser un array", target)
		}
		return response
	}

	t.Run("default desc", func(t *testing.T) {
		page := get("/api/logs").Data
		if got, want := webExtrasLogIDs(page), []int64{5, 4, 3, 2, 1}; !slices.Equal(got, want) {
			t.Fatalf("ids = %v, quiero %v", got, want)
		}
		if page.HasMore || page.NewestID != 5 {
			t.Fatalf("hasMore=%v newestId=%d", page.HasMore, page.NewestID)
		}
	})

	t.Run("after asc and hasMore", func(t *testing.T) {
		page := get("/api/logs?after=2&limit=2").Data
		if got, want := webExtrasLogIDs(page), []int64{3, 4}; !slices.Equal(got, want) {
			t.Fatalf("ids = %v, quiero %v", got, want)
		}
		if !page.HasMore || page.NewestID != 4 {
			t.Fatalf("hasMore=%v newestId=%d", page.HasMore, page.NewestID)
		}
	})

	t.Run("after sin hasMore usa maximo global", func(t *testing.T) {
		page := get("/api/logs?after=2&limit=3").Data
		if got, want := webExtrasLogIDs(page), []int64{3, 4, 5}; !slices.Equal(got, want) {
			t.Fatalf("ids = %v, quiero %v", got, want)
		}
		if page.HasMore || page.NewestID != 5 {
			t.Fatalf("hasMore=%v newestId=%d", page.HasMore, page.NewestID)
		}
	})

	t.Run("limit desc", func(t *testing.T) {
		page := get("/api/logs?limit=2").Data
		if got, want := webExtrasLogIDs(page), []int64{5, 4}; !slices.Equal(got, want) {
			t.Fatalf("ids = %v, quiero %v", got, want)
		}
		if !page.HasMore || page.NewestID != 5 {
			t.Fatalf("hasMore=%v newestId=%d", page.HasMore, page.NewestID)
		}
	})

	cases := []struct {
		target string
		want   []int64
	}{
		{"/api/logs?level=error", []int64{3}},
		{"/api/logs?level=warning", []int64{4}},
		{"/api/logs?level=success", []int64{5, 2}},
		{"/api/logs?level=info", []int64{1}},
		{"/api/logs?component=qvapay", []int64{5, 2}},
		{"/api/logs?component=trading", []int64{1}},
		{"/api/logs?component=notifications", []int64{3}},
		{"/api/logs?component=network", []int64{4}},
		{"/api/logs?component=system", []int64{}},
		{"/api/logs?query=APPLIED", []int64{2}},
		{"/api/logs?query=op-2", []int64{4}},
		{"/api/logs?query=pendiente", []int64{4}},
		{"/api/logs?query=fall%C3%B3", []int64{3}},
		{"/api/logs?since=3000", []int64{5, 4, 3}},
		{"/api/logs?since=1000", []int64{5}},
		{"/api/logs?after=4", []int64{5}},
	}
	for _, testCase := range cases {
		t.Run(testCase.target, func(t *testing.T) {
			page := get(testCase.target).Data
			if got := webExtrasLogIDs(page); !slices.Equal(got, testCase.want) {
				t.Fatalf("ids = %v, quiero %v", got, testCase.want)
			}
		})
	}
}

func TestWebExtrasLogsRedaction(t *testing.T) {
	long := strings.Repeat("a", 2200)
	detail := "Bearer super-secret 42|opaque-token password=hunter2 api_key: shh " + long
	snapshot := fmt.Sprintf(
		`{"logs":[{"id":1,"createdAt":%d,"action":"scan_error","uuid":null,"detail":%q}],"notifications":[],"recovery":null}`,
		webExtrasTestNowMS, detail,
	)
	api, _, cookie, _ := newWebExtrasTestAPI(t, snapshot)

	recorder := webExtrasDo(api, http.MethodGet, "/api/logs", "", cookie, "", "")
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d (cuerpo %q)", recorder.Code, recorder.Body.String())
	}
	type logsResponse struct {
		Data webExtrasLogPage `json:"data"`
	}
	response := decodeWebExtrasBody[logsResponse](t, recorder)
	if len(response.Data.Items) != 1 {
		t.Fatalf("items = %d", len(response.Data.Items))
	}
	redacted := response.Data.Items[0].Detail
	for _, secret := range []string{"super-secret", "42|opaque-token", "hunter2", "shh"} {
		if strings.Contains(redacted, secret) {
			t.Fatalf("detalle sin redactar %q en %q", secret, redacted)
		}
	}
	for _, expected := range []string{"Bearer [redacted]", "[redacted]", "password=[redacted]", "api_key:[redacted]"} {
		if !strings.Contains(redacted, expected) {
			t.Fatalf("detalle sin %q: %q", expected, redacted)
		}
	}
	if got := utf8.RuneCountInString(redacted); got != webExtrasMaxDetailRunes {
		t.Fatalf("longitud = %d, quiero %d", got, webExtrasMaxDetailRunes)
	}
	if level := response.Data.Items[0].Level; level != "error" {
		t.Fatalf("level = %q", level)
	}
	if component := response.Data.Items[0].Component; component != "trading" {
		t.Fatalf("component = %q", component)
	}
}

func TestWebExtrasLogsRejectsInvalidFilters(t *testing.T) {
	api, _, cookie, _ := newWebExtrasTestAPI(t, webExtrasTestSnapshot)
	targets := []string{
		"/api/logs?after=-1",
		"/api/logs?after=abc",
		"/api/logs?limit=0",
		"/api/logs?limit=201",
		"/api/logs?limit=abc",
		"/api/logs?level=bogus",
		"/api/logs?component=bogus",
		"/api/logs?since=999",
		"/api/logs?since=604800001",
		"/api/logs?since=abc",
		"/api/logs?query=" + strings.Repeat("a", webExtrasMaxQueryRunes+1),
	}
	for _, target := range targets {
		recorder := webExtrasDo(api, http.MethodGet, target, "", cookie, "", "")
		if recorder.Code != http.StatusBadRequest {
			t.Fatalf("%s: status = %d (cuerpo %q)", target, recorder.Code, recorder.Body.String())
		}
	}

	valid := []string{
		"/api/logs?after=0",
		"/api/logs?limit=1",
		"/api/logs?limit=200",
		"/api/logs?since=1000",
		"/api/logs?since=604800000",
		"/api/logs?query=" + strings.Repeat("a", webExtrasMaxQueryRunes),
	}
	for _, target := range valid {
		recorder := webExtrasDo(api, http.MethodGet, target, "", cookie, "", "")
		if recorder.Code != http.StatusOK {
			t.Fatalf("%s: status = %d (cuerpo %q)", target, recorder.Code, recorder.Body.String())
		}
	}
}

func TestWebExtrasNotifications(t *testing.T) {
	api, acks, cookie, _ := newWebExtrasTestAPI(t, webExtrasTestSnapshot)
	acks.acked = map[string]struct{}{"n8": {}}

	recorder := webExtrasDo(api, http.MethodGet, "/api/notifications", "", cookie, "", "")
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d (cuerpo %q)", recorder.Code, recorder.Body.String())
	}
	if got := recorder.Header().Get("Cache-Control"); got != "no-store" {
		t.Fatalf("Cache-Control = %q", got)
	}
	type notificationsResponse struct {
		Data []webExtrasNotificationItem `json:"data"`
	}
	response := decodeWebExtrasBody[notificationsResponse](t, recorder)
	if len(response.Data) != 9 {
		t.Fatalf("notificaciones = %d", len(response.Data))
	}
	byID := make(map[string]webExtrasNotificationItem, len(response.Data))
	for _, item := range response.Data {
		byID[item.ID] = item
	}
	if _, present := byID["n8"]; present {
		t.Fatal("la notificación ackeada no debe aparecer")
	}

	urls := map[string]string{
		"n1":  "/?view=operaciones&operation=op-1",
		"n2":  "/?view=ofertas",
		"n3":  "/?view=caceria",
		"n4":  "/?view=auditoria&intent=intent%201%2Fx",
		"n5":  "/?view=ofertas",
		"n6":  "/?view=operaciones&operation=own%20op",
		"n7":  "/?view=auditoria",
		"n9":  "/?view=operaciones&operation=op-9",
		"n10": "/?view=operaciones&operation=op-10",
	}
	for id, want := range urls {
		if got := byID[id].URL; got != want {
			t.Fatalf("%s: url = %q, quiero %q", id, got, want)
		}
	}

	types := map[string]string{
		"n1": "operation-applied", "n2": "informational-summary",
		"n3": "system-health", "n4": "recovery-blocked",
		"n5": "rebalance-attention", "n6": "own-offer-applied",
		"n7": "reconciliation-required",
	}
	for id, want := range types {
		if got := byID[id].Type; got != want {
			t.Fatalf("%s: type = %q, quiero %q", id, got, want)
		}
	}

	fallback, ok := byID["n1"].Alert.(map[string]any)
	if !ok {
		t.Fatalf("n1 alert = %#v", byID["n1"].Alert)
	}
	if fallback["uuid"] != "" || fallback["coin"] != "" || fallback["amount"] != float64(0) {
		t.Fatalf("n1 alert = %#v", fallback)
	}

	data, ok := byID["n10"].Alert.(map[string]any)
	if !ok {
		t.Fatalf("n10 alert = %#v", byID["n10"].Alert)
	}
	if data["uuid"] != "u-10" || data["coin"] != "BANK_CUP" || data["amount"] != 12.5 {
		t.Fatalf("n10 alert = %#v", data)
	}

	custom, ok := byID["n9"].Alert.(map[string]any)
	if !ok || custom["custom"] != true {
		t.Fatalf("n9 alert = %#v", byID["n9"].Alert)
	}
}

func TestWebExtrasNotificationsAckStoreError(t *testing.T) {
	api, acks, cookie, _ := newWebExtrasTestAPI(t, webExtrasTestSnapshot)
	acks.ackedErr = errors.New("boom")
	recorder := webExtrasDo(api, http.MethodGet, "/api/notifications", "", cookie, "", "")
	if recorder.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d (cuerpo %q)", recorder.Code, recorder.Body.String())
	}
}

func TestWebExtrasAckAndMutationGuards(t *testing.T) {
	api, acks, cookie, csrf := newWebExtrasTestAPI(t, webExtrasTestSnapshot)
	path := "/api/notifications/n1/ack"

	recorder := webExtrasDo(api, http.MethodPost, path, "", cookie, csrf, "https://panel.example")
	if recorder.Code != http.StatusNoContent {
		t.Fatalf("ack vacío: status = %d (cuerpo %q)", recorder.Code, recorder.Body.String())
	}
	if len(acks.calls) != 1 || acks.calls[0].id != "n1" || acks.calls[0].now != webExtrasTestNowMS {
		t.Fatalf("calls = %+v", acks.calls)
	}

	recorder = webExtrasDo(api, http.MethodPost, path, "{}", cookie, csrf, "https://panel.example")
	if recorder.Code != http.StatusNoContent {
		t.Fatalf("ack {}: status = %d (cuerpo %q)", recorder.Code, recorder.Body.String())
	}
	if len(acks.calls) != 2 {
		t.Fatalf("calls = %+v", acks.calls)
	}

	recorder = webExtrasDo(api, http.MethodGet, "/api/notifications", "", cookie, "", "")
	if recorder.Code != http.StatusOK {
		t.Fatalf("notificaciones tras ack: status = %d", recorder.Code)
	}
	pending := decodeWebExtrasBody[struct {
		Data []webExtrasNotificationItem `json:"data"`
	}](t, recorder)
	for _, item := range pending.Data {
		if item.ID == "n1" {
			t.Fatal("la notificación confirmada no debe reaparecer")
		}
	}

	if recorder = webExtrasDo(api, http.MethodPost, path, `{"x":1}`, cookie, csrf, "https://panel.example"); recorder.Code != http.StatusBadRequest {
		t.Fatalf("cuerpo inválido: status = %d", recorder.Code)
	}
	if recorder = webExtrasDo(api, http.MethodPost, path, "null", cookie, csrf, "https://panel.example"); recorder.Code != http.StatusBadRequest {
		t.Fatalf("cuerpo null: status = %d", recorder.Code)
	}
	longID := "/api/notifications/" + strings.Repeat("a", webExtrasMaxAckIDRunes+1) + "/ack"
	if recorder = webExtrasDo(api, http.MethodPost, longID, "", cookie, csrf, "https://panel.example"); recorder.Code != http.StatusBadRequest {
		t.Fatalf("id largo: status = %d", recorder.Code)
	}

	if recorder = webExtrasDo(api, http.MethodPost, path, "", nil, csrf, "https://panel.example"); recorder.Code != http.StatusUnauthorized {
		t.Fatalf("sin sesión: status = %d", recorder.Code)
	}
	if recorder = webExtrasDo(api, http.MethodPost, path, "", cookie, csrf, "https://evil.example"); recorder.Code != http.StatusForbidden {
		t.Fatalf("origen inválido: status = %d", recorder.Code)
	}
	if recorder = webExtrasDo(api, http.MethodPost, path, "", cookie, "", "https://panel.example"); recorder.Code != http.StatusForbidden {
		t.Fatalf("sin CSRF: status = %d", recorder.Code)
	}
	if recorder = webExtrasDo(api, http.MethodPost, path, "", cookie, "incorrecto", "https://panel.example"); recorder.Code != http.StatusForbidden {
		t.Fatalf("CSRF inválido: status = %d", recorder.Code)
	}

	sameOrigin := httptest.NewRequest(http.MethodPost, path, strings.NewReader(""))
	sameOrigin.Host = "panel.local"
	sameOrigin.AddCookie(cookie)
	sameOrigin.Header.Set("X-CSRF-Token", csrf)
	sameOrigin.Header.Set("Origin", "https://panel.local")
	recorder = httptest.NewRecorder()
	api.ServeHTTP(recorder, sameOrigin)
	if recorder.Code != http.StatusNoContent {
		t.Fatalf("same-origin: status = %d (cuerpo %q)", recorder.Code, recorder.Body.String())
	}

	if len(acks.calls) != 3 {
		t.Fatalf("calls = %+v", acks.calls)
	}

	acks.ackErr = errors.New("boom")
	if recorder = webExtrasDo(api, http.MethodPost, path, "", cookie, csrf, "https://panel.example"); recorder.Code != http.StatusServiceUnavailable {
		t.Fatalf("error de store: status = %d", recorder.Code)
	}
}

func TestWebExtrasRecovery(t *testing.T) {
	api, _, cookie, _ := newWebExtrasTestAPI(t, webExtrasTestSnapshot)
	recorder := webExtrasDo(api, http.MethodGet, "/api/recovery", "", cookie, "", "")
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d (cuerpo %q)", recorder.Code, recorder.Body.String())
	}
	var response struct {
		Data json.RawMessage `json:"data"`
	}
	response = decodeWebExtrasBody[struct {
		Data json.RawMessage `json:"data"`
	}](t, recorder)
	var recovery struct {
		Items   []map[string]any `json:"items"`
		Blocked bool             `json:"blocked"`
	}
	if err := json.Unmarshal(response.Data, &recovery); err != nil {
		t.Fatalf("recovery: %v", err)
	}
	if len(recovery.Items) != 1 || !recovery.Blocked {
		t.Fatalf("recovery = %+v", recovery)
	}
	if recovery.Items[0]["intentId"] != "i-1" {
		t.Fatalf("intentId = %v", recovery.Items[0]["intentId"])
	}

	api, _, cookie, _ = newWebExtrasTestAPI(t, `{"logs":[],"notifications":[]}`)
	recorder = webExtrasDo(api, http.MethodGet, "/api/recovery", "", cookie, "", "")
	if recorder.Code != http.StatusOK {
		t.Fatalf("sin recovery: status = %d", recorder.Code)
	}
	response = decodeWebExtrasBody[struct {
		Data json.RawMessage `json:"data"`
	}](t, recorder)
	recovery = struct {
		Items   []map[string]any `json:"items"`
		Blocked bool             `json:"blocked"`
	}{}
	if err := json.Unmarshal(response.Data, &recovery); err != nil {
		t.Fatalf("recovery vacío: %v", err)
	}
	if recovery.Items == nil || len(recovery.Items) != 0 || recovery.Blocked {
		t.Fatalf("recovery vacío = %+v", recovery)
	}
}

func TestWebExtrasSnapshotMissingAndEmptyFile(t *testing.T) {
	api, _, cookie, _ := newWebExtrasTestAPI(t, webExtrasTestSnapshot)

	missing := filepath.Join(t.TempDir(), "no-existe.json")
	api.File = missing
	recorder := webExtrasDo(api, http.MethodGet, "/api/logs", "", cookie, "", "")
	if recorder.Code != http.StatusOK {
		t.Fatalf("archivo ausente: status = %d (cuerpo %q)", recorder.Code, recorder.Body.String())
	}
	type logsResponse struct {
		Data webExtrasLogPage `json:"data"`
	}
	logs := decodeWebExtrasBody[logsResponse](t, recorder)
	if logs.Data.Items == nil || len(logs.Data.Items) != 0 || logs.Data.HasMore || logs.Data.NewestID != 0 {
		t.Fatalf("logs vacíos = %+v", logs.Data)
	}

	api.File = ""
	recorder = webExtrasDo(api, http.MethodGet, "/api/notifications", "", cookie, "", "")
	if recorder.Code != http.StatusOK {
		t.Fatalf("file vacío: status = %d", recorder.Code)
	}
	notifications := decodeWebExtrasBody[struct {
		Data []webExtrasNotificationItem `json:"data"`
	}](t, recorder)
	if notifications.Data == nil || len(notifications.Data) != 0 {
		t.Fatalf("notificaciones vacías = %+v", notifications.Data)
	}

	recorder = webExtrasDo(api, http.MethodGet, "/api/recovery", "", cookie, "", "")
	if recorder.Code != http.StatusOK {
		t.Fatalf("recovery sin snapshot: status = %d", recorder.Code)
	}
}

func TestWebExtrasSnapshotUnavailable(t *testing.T) {
	t.Run("json inválido", func(t *testing.T) {
		api, _, cookie, _ := newWebExtrasTestAPI(t, "{no es json")
		for _, target := range []string{"/api/logs", "/api/notifications", "/api/recovery"} {
			recorder := webExtrasDo(api, http.MethodGet, target, "", cookie, "", "")
			if recorder.Code != http.StatusServiceUnavailable {
				t.Fatalf("%s: status = %d (cuerpo %q)", target, recorder.Code, recorder.Body.String())
			}
			var payload map[string]string
			if err := json.Unmarshal(recorder.Body.Bytes(), &payload); err != nil {
				t.Fatalf("%s: JSON: %v", target, err)
			}
			if payload["status"] != "unavailable" {
				t.Fatalf("%s: payload = %v", target, payload)
			}
			if strings.Contains(recorder.Body.String(), "web-extras.json") {
				t.Fatalf("%s: la respuesta expone la ruta", target)
			}
		}
	})

	t.Run("demasiado grande", func(t *testing.T) {
		large := `{"logs":[]}` + strings.Repeat(" ", webExtrasMaxSnapshotBytes)
		api, _, cookie, _ := newWebExtrasTestAPI(t, large)
		recorder := webExtrasDo(api, http.MethodGet, "/api/logs", "", cookie, "", "")
		if recorder.Code != http.StatusServiceUnavailable {
			t.Fatalf("status = %d (cuerpo %q)", recorder.Code, recorder.Body.String())
		}
	})
}

func TestWebExtrasRoutingHeadersAndAuth(t *testing.T) {
	api, _, cookie, csrf := newWebExtrasTestAPI(t, webExtrasTestSnapshot)

	for _, target := range []string{
		"/api/nope",
		"/api/notifications/abc",
		"/api/notifications/ack",
		"/api/notifications/a/b/ack",
		"/api/notifications/n1/other",
	} {
		recorder := webExtrasDo(api, http.MethodGet, target, "", cookie, "", "")
		if recorder.Code != http.StatusNotFound {
			t.Fatalf("%s: status = %d", target, recorder.Code)
		}
	}

	methodCases := []struct {
		method, target, allow string
	}{
		{http.MethodPost, "/api/logs", http.MethodGet},
		{http.MethodDelete, "/api/notifications", http.MethodGet},
		{http.MethodPut, "/api/recovery", http.MethodGet},
		{http.MethodGet, "/api/notifications/n1/ack", http.MethodPost},
	}
	for _, testCase := range methodCases {
		recorder := webExtrasDo(api, testCase.method, testCase.target, "", cookie, csrf, "")
		if recorder.Code != http.StatusMethodNotAllowed {
			t.Fatalf("%s %s: status = %d", testCase.method, testCase.target, recorder.Code)
		}
		if got := recorder.Header().Get("Allow"); got != testCase.allow {
			t.Fatalf("%s %s: Allow = %q", testCase.method, testCase.target, got)
		}
	}

	recorder := webExtrasDo(api, http.MethodGet, "/api/logs", "", cookie, "", "")
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d", recorder.Code)
	}
	if got := recorder.Header().Get("Cache-Control"); got != "no-store" {
		t.Fatalf("Cache-Control = %q", got)
	}
	if got := recorder.Header().Get("X-Content-Type-Options"); got != "nosniff" {
		t.Fatalf("X-Content-Type-Options = %q", got)
	}
	if got := recorder.Header().Get("Content-Type"); !strings.HasPrefix(got, "application/json") {
		t.Fatalf("Content-Type = %q", got)
	}
	if got := recorder.Header().Get("Access-Control-Allow-Origin"); got != "" {
		t.Fatalf("CORS inesperado: %q", got)
	}

	for _, target := range []string{"/api/logs", "/api/notifications", "/api/recovery"} {
		recorder := webExtrasDo(api, http.MethodGet, target, "", nil, "", "")
		if recorder.Code != http.StatusUnauthorized {
			t.Fatalf("%s sin sesión: status = %d", target, recorder.Code)
		}
		var payload map[string]string
		if err := json.Unmarshal(recorder.Body.Bytes(), &payload); err != nil {
			t.Fatalf("%s: JSON: %v", target, err)
		}
		if payload["error"] != "Autenticación requerida." {
			t.Fatalf("%s: error = %q", target, payload["error"])
		}
	}
}

func TestPostgresAckStoreNilPool(t *testing.T) {
	var store *PostgresAckStore
	if _, err := store.Acked(context.Background()); err == nil {
		t.Fatal("Acked con pool nil debe fallar")
	}
	if err := store.Ack(context.Background(), "id", 1); err == nil {
		t.Fatal("Ack con pool nil debe fallar")
	}
}

type webExtrasSettingPut struct {
	key   string
	value []byte
	now   int64
}

type webExtrasFakeSettings struct {
	values map[string][]byte
	getErr error
	putErr error
	puts   []webExtrasSettingPut
}

func (settings *webExtrasFakeSettings) GetSetting(_ context.Context, key string) ([]byte, bool, error) {
	if settings.getErr != nil {
		return nil, false, settings.getErr
	}
	value, ok := settings.values[key]
	return value, ok, nil
}

func (settings *webExtrasFakeSettings) PutSetting(_ context.Context, key string, value []byte, now int64) error {
	settings.puts = append(settings.puts, webExtrasSettingPut{key: key, value: value, now: now})
	if settings.putErr != nil {
		return settings.putErr
	}
	if settings.values == nil {
		settings.values = map[string][]byte{}
	}
	settings.values[key] = value
	return nil
}

const webExtrasRecoveryTestSnapshot = `{
 "logs":[],
 "notifications":[],
 "recovery":{"items":[
  {"intentId":"i-1","kind":"apply","state":"uncertain","operationUuid":null,"workflowId":null,"createdAt":1,"updatedAt":2,"error":null,"acknowledged":false,"evidence":[],"manualEligible":false,"manualOutcomes":[],"manualBlockedReason":"solo lectura"},
  {"intentId":"i-2","kind":"rollback","state":"blocked","operationUuid":"op-2","createdAt":3,"updatedAt":4,"acknowledged":false,"evidence":[{"text":"nota previa","actor":"system","at":5}]}
 ],"blocked":true,"checkedAt":9}
}`

type webExtrasRecoveryTestEvidence struct {
	Text  string `json:"text"`
	Actor string `json:"actor"`
	At    int64  `json:"at"`
}

type webExtrasRecoveryTestItem struct {
	IntentID            string                          `json:"intentId"`
	Kind                string                          `json:"kind"`
	State               string                          `json:"state"`
	Acknowledged        bool                            `json:"acknowledged"`
	Evidence            []webExtrasRecoveryTestEvidence `json:"evidence"`
	ManualBlockedReason string                          `json:"manualBlockedReason"`
}

type webExtrasRecoveryTestPayload struct {
	Data struct {
		Items     []webExtrasRecoveryTestItem `json:"items"`
		Blocked   bool                        `json:"blocked"`
		CheckedAt int64                       `json:"checkedAt"`
	} `json:"data"`
}

func newWebExtrasRecoveryTestAPI(
	t *testing.T,
	snapshot string,
) (*WebExtrasAPI, *webExtrasFakeSettings, *http.Cookie, string) {
	t.Helper()
	file := filepath.Join(t.TempDir(), "web-extras.json")
	if err := os.WriteFile(file, []byte(snapshot), 0o600); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}
	manager := newSessionTestManager(t, 15*time.Minute)
	now := time.UnixMilli(webExtrasTestNowMS)
	token, csrf, err := manager.Issue(now)
	if err != nil {
		t.Fatalf("Issue: %v", err)
	}
	settings := &webExtrasFakeSettings{values: map[string][]byte{}}
	api := &WebExtrasAPI{
		Sessions: manager, File: file, Acks: &webExtrasFakeAckStore{},
		Settings: settings, TrustedOrigin: "https://panel.example",
		Now: func() time.Time { return now },
	}
	return api, settings, &http.Cookie{Name: CookieName, Value: token}, csrf
}

func decodeWebExtrasRecoveryItem(
	t *testing.T,
	recorder *httptest.ResponseRecorder,
) webExtrasRecoveryTestItem {
	t.Helper()
	response := decodeWebExtrasBody[struct {
		Data webExtrasRecoveryTestItem `json:"data"`
	}](t, recorder)
	return response.Data
}

func TestWebExtrasRecoveryMergesPersistedState(t *testing.T) {
	api, settings, cookie, _ := newWebExtrasRecoveryTestAPI(t, webExtrasRecoveryTestSnapshot)
	settings.values[webExtrasRecoveryAckPrefix+"i-1"] = []byte("1700000000000")
	settings.values[webExtrasRecoveryEvidencePrefix+"i-1"] = []byte(
		`[{"text":"revisado a mano","actor":"panel","at":1700000000500}]`)
	settings.values[webExtrasRecoveryEvidencePrefix+"i-2"] = []byte(`{no es json`)

	recorder := webExtrasDo(api, http.MethodGet, "/api/recovery", "", cookie, "", "")
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d (cuerpo %q)", recorder.Code, recorder.Body.String())
	}
	payload := decodeWebExtrasBody[webExtrasRecoveryTestPayload](t, recorder)
	if !payload.Data.Blocked || payload.Data.CheckedAt != 9 || len(payload.Data.Items) != 2 {
		t.Fatalf("payload = %+v", payload.Data)
	}
	byID := make(map[string]webExtrasRecoveryTestItem, len(payload.Data.Items))
	for _, item := range payload.Data.Items {
		byID[item.IntentID] = item
	}

	first := byID["i-1"]
	if !first.Acknowledged {
		t.Fatal("i-1 debe quedar reconocida")
	}
	if len(first.Evidence) != 1 || first.Evidence[0].Text != "revisado a mano" ||
		first.Evidence[0].Actor != "panel" || first.Evidence[0].At != 1700000000500 {
		t.Fatalf("i-1 evidence = %+v", first.Evidence)
	}
	if first.Kind != "apply" || first.State != "uncertain" || first.ManualBlockedReason != "solo lectura" {
		t.Fatalf("i-1 perdió campos del snapshot: %+v", first)
	}

	second := byID["i-2"]
	if second.Acknowledged {
		t.Fatal("i-2 no tiene ack persistido")
	}
	if len(second.Evidence) != 1 || second.Evidence[0].Text != "nota previa" ||
		second.Evidence[0].Actor != "system" || second.Evidence[0].At != 5 {
		t.Fatalf("i-2 debe conservar la evidencia del snapshot: %+v", second.Evidence)
	}
}

func TestWebExtrasRecoverySettingsError(t *testing.T) {
	api, settings, cookie, _ := newWebExtrasRecoveryTestAPI(t, webExtrasRecoveryTestSnapshot)
	settings.getErr = errors.New("boom")
	recorder := webExtrasDo(api, http.MethodGet, "/api/recovery", "", cookie, "", "")
	if recorder.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d (cuerpo %q)", recorder.Code, recorder.Body.String())
	}
	var payload map[string]string
	if err := json.Unmarshal(recorder.Body.Bytes(), &payload); err != nil {
		t.Fatalf("JSON: %v", err)
	}
	if payload["status"] != "unavailable" {
		t.Fatalf("payload = %v", payload)
	}
}

func TestWebExtrasRecoveryEvidenceAppends(t *testing.T) {
	api, settings, cookie, csrf := newWebExtrasRecoveryTestAPI(t, webExtrasRecoveryTestSnapshot)
	path := "/api/recovery/i-2/evidence"

	recorder := webExtrasDo(api, http.MethodPost, path,
		`{"evidence":"  comprobante revisado  "}`, cookie, csrf, "https://panel.example")
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d (cuerpo %q)", recorder.Code, recorder.Body.String())
	}
	if got := recorder.Header().Get("Cache-Control"); got != "no-store" {
		t.Fatalf("Cache-Control = %q", got)
	}
	if got := recorder.Header().Get("X-Content-Type-Options"); got != "nosniff" {
		t.Fatalf("X-Content-Type-Options = %q", got)
	}
	if got := recorder.Header().Get("Content-Type"); !strings.HasPrefix(got, "application/json") {
		t.Fatalf("Content-Type = %q", got)
	}
	if got := recorder.Header().Get("Access-Control-Allow-Origin"); got != "" {
		t.Fatalf("CORS inesperado: %q", got)
	}

	item := decodeWebExtrasRecoveryItem(t, recorder)
	if item.IntentID != "i-2" || item.Acknowledged {
		t.Fatalf("item = %+v", item)
	}
	if len(item.Evidence) != 2 {
		t.Fatalf("evidence = %+v", item.Evidence)
	}
	if got := item.Evidence[1]; got.Text != "comprobante revisado" ||
		got.Actor != "panel" || got.At != webExtrasTestNowMS {
		t.Fatalf("entrada añadida = %+v", got)
	}
	if got := item.Evidence[0]; got.Text != "nota previa" {
		t.Fatalf("entrada previa = %+v", got)
	}

	key := webExtrasRecoveryEvidencePrefix + "i-2"
	var stored []webExtrasRecoveryTestEvidence
	if err := json.Unmarshal(settings.values[key], &stored); err != nil {
		t.Fatalf("setting guardado: %v", err)
	}
	if len(stored) != 2 || stored[1].Text != "comprobante revisado" {
		t.Fatalf("setting = %+v", stored)
	}
	if len(settings.puts) != 1 || settings.puts[0].key != key ||
		settings.puts[0].now != webExtrasTestNowMS {
		t.Fatalf("puts = %+v", settings.puts)
	}

	recorder = webExtrasDo(api, http.MethodPost, path,
		`{"evidence":"segunda nota valida"}`, cookie, csrf, "https://panel.example")
	if recorder.Code != http.StatusOK {
		t.Fatalf("segundo status = %d (cuerpo %q)", recorder.Code, recorder.Body.String())
	}
	item = decodeWebExtrasRecoveryItem(t, recorder)
	if len(item.Evidence) != 3 || item.Evidence[2].Text != "segunda nota valida" {
		t.Fatalf("segunda evidence = %+v", item.Evidence)
	}
	if err := json.Unmarshal(settings.values[key], &stored); err != nil {
		t.Fatalf("setting guardado: %v", err)
	}
	if len(stored) != 3 || stored[0].Text != "nota previa" || stored[1].Text != "comprobante revisado" {
		t.Fatalf("setting acumulado = %+v", stored)
	}
}

func TestWebExtrasRecoveryEvidenceFromEmptySnapshot(t *testing.T) {
	api, settings, cookie, csrf := newWebExtrasRecoveryTestAPI(t, webExtrasRecoveryTestSnapshot)
	recorder := webExtrasDo(api, http.MethodPost, "/api/recovery/i-1/evidence",
		`{"evidence":"primera nota manual"}`, cookie, csrf, "https://panel.example")
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d (cuerpo %q)", recorder.Code, recorder.Body.String())
	}
	item := decodeWebExtrasRecoveryItem(t, recorder)
	if len(item.Evidence) != 1 || item.Evidence[0].Text != "primera nota manual" {
		t.Fatalf("evidence = %+v", item.Evidence)
	}
	if _, ok := settings.values[webExtrasRecoveryEvidencePrefix+"i-1"]; !ok {
		t.Fatal("falta el setting de evidencia")
	}
}

func TestWebExtrasRecoveryAcknowledge(t *testing.T) {
	api, settings, cookie, csrf := newWebExtrasRecoveryTestAPI(t, webExtrasRecoveryTestSnapshot)
	recorder := webExtrasDo(api, http.MethodPost, "/api/recovery/i-1/acknowledge",
		"", cookie, csrf, "https://panel.example")
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d (cuerpo %q)", recorder.Code, recorder.Body.String())
	}
	item := decodeWebExtrasRecoveryItem(t, recorder)
	if item.IntentID != "i-1" || !item.Acknowledged {
		t.Fatalf("item = %+v", item)
	}
	if item.Kind != "apply" || item.State != "uncertain" {
		t.Fatalf("item perdió campos: %+v", item)
	}
	stamp, ok := settings.values[webExtrasRecoveryAckPrefix+"i-1"]
	if !ok {
		t.Fatal("falta el setting de ack")
	}
	if string(stamp) != "1700000000000" {
		t.Fatalf("stamp = %q", stamp)
	}

	recorder = webExtrasDo(api, http.MethodGet, "/api/recovery", "", cookie, "", "")
	if recorder.Code != http.StatusOK {
		t.Fatalf("GET status = %d", recorder.Code)
	}
	payload := decodeWebExtrasBody[webExtrasRecoveryTestPayload](t, recorder)
	if len(payload.Data.Items) != 2 || !payload.Data.Items[0].Acknowledged {
		t.Fatalf("payload = %+v", payload.Data.Items)
	}
}

func TestWebExtrasRecoveryMutationGuards(t *testing.T) {
	api, settings, cookie, csrf := newWebExtrasRecoveryTestAPI(t, webExtrasRecoveryTestSnapshot)
	const evidencePath = "/api/recovery/i-1/evidence"
	const ackPath = "/api/recovery/i-1/acknowledge"
	const origin = "https://panel.example"

	t.Run("intención inexistente", func(t *testing.T) {
		for _, path := range []string{
			"/api/recovery/nope/evidence",
			"/api/recovery/nope/acknowledge",
		} {
			recorder := webExtrasDo(api, http.MethodPost, path,
				`{"evidence":"nota suficientemente larga"}`, cookie, csrf, origin)
			if recorder.Code != http.StatusNotFound {
				t.Fatalf("%s: status = %d (cuerpo %q)", path, recorder.Code, recorder.Body.String())
			}
			var payload map[string]string
			if err := json.Unmarshal(recorder.Body.Bytes(), &payload); err != nil {
				t.Fatalf("%s: JSON: %v", path, err)
			}
			if payload["error"] != "Intención no encontrada." {
				t.Fatalf("%s: error = %q", path, payload["error"])
			}
		}
	})

	t.Run("cuerpo inválido", func(t *testing.T) {
		bodies := []string{
			"",
			"{}",
			"no es json",
			`{"evidence":12}`,
			`{"evidence":""}`,
			`{"evidence":"corto"}`,
			`{"evidence":"` + strings.Repeat("a", 11) + `"}`,
			`{"evidence":"` + strings.Repeat("a", webExtrasRecoveryEvidenceMaxRune+1) + `"}`,
			`{"evidence":"` + strings.Repeat("á", webExtrasRecoveryEvidenceMaxRune+1) + `"}`,
		}
		for _, body := range bodies {
			recorder := webExtrasDo(api, http.MethodPost, evidencePath, body, cookie, csrf, origin)
			if recorder.Code != http.StatusBadRequest {
				t.Fatalf("cuerpo %q: status = %d (cuerpo %q)", body, recorder.Code, recorder.Body.String())
			}
		}
		long := `{"evidence":"` + strings.Repeat("a", webExtrasRecoveryBodyBytes) + `"}`
		recorder := webExtrasDo(api, http.MethodPost, evidencePath, long, cookie, csrf, origin)
		if recorder.Code != http.StatusRequestEntityTooLarge {
			t.Fatalf("cuerpo enorme: status = %d (cuerpo %q)", recorder.Code, recorder.Body.String())
		}
	})

	t.Run("límites válidos", func(t *testing.T) {
		for _, body := range []string{
			`{"evidence":"` + strings.Repeat("a", webExtrasRecoveryEvidenceMinRune) + `"}`,
			`{"evidence":"` + strings.Repeat("a", webExtrasRecoveryEvidenceMaxRune) + `"}`,
		} {
			recorder := webExtrasDo(api, http.MethodPost, evidencePath, body, cookie, csrf, origin)
			if recorder.Code != http.StatusOK {
				t.Fatalf("status = %d (cuerpo %q)", recorder.Code, recorder.Body.String())
			}
		}
	})

	t.Run("sin sesión", func(t *testing.T) {
		for _, path := range []string{evidencePath, ackPath} {
			recorder := webExtrasDo(api, http.MethodPost, path,
				`{"evidence":"nota suficientemente larga"}`, nil, csrf, origin)
			if recorder.Code != http.StatusUnauthorized {
				t.Fatalf("%s: status = %d", path, recorder.Code)
			}
		}
	})

	t.Run("origen y csrf", func(t *testing.T) {
		cases := []struct {
			name, csrf, origin string
		}{
			{"origen ajeno", csrf, "https://evil.example"},
			{"sin origen", csrf, ""},
			{"sin csrf", "", origin},
			{"csrf incorrecto", "incorrecto", origin},
		}
		for _, testCase := range cases {
			for _, path := range []string{evidencePath, ackPath} {
				recorder := webExtrasDo(api, http.MethodPost, path,
					`{"evidence":"nota suficientemente larga"}`,
					cookie, testCase.csrf, testCase.origin)
				if recorder.Code != http.StatusForbidden {
					t.Fatalf("%s %s: status = %d (cuerpo %q)",
						testCase.name, path, recorder.Code, recorder.Body.String())
				}
			}
		}
	})

	t.Run("método incorrecto", func(t *testing.T) {
		for _, path := range []string{
			evidencePath, ackPath,
			"/api/recovery/nope/evidence", "/api/recovery/nope/acknowledge",
		} {
			for _, method := range []string{http.MethodGet, http.MethodPut, http.MethodDelete} {
				recorder := webExtrasDo(api, method, path, "", cookie, csrf, "")
				if recorder.Code != http.StatusMethodNotAllowed {
					t.Fatalf("%s %s: status = %d", method, path, recorder.Code)
				}
				if got := recorder.Header().Get("Allow"); got != http.MethodPost {
					t.Fatalf("%s %s: Allow = %q", method, path, got)
				}
			}
		}
	})

	t.Run("rutas desconocidas", func(t *testing.T) {
		for _, path := range []string{
			"/api/recovery/",
			"/api/recovery/i-1",
			"/api/recovery/i-1/other",
			"/api/recovery/i-1/evidence/x",
			"/api/recovery/i-1/acknowledge/",
			"/api/recovery//evidence",
		} {
			recorder := webExtrasDo(api, http.MethodPost, path,
				`{"evidence":"nota suficientemente larga"}`, cookie, csrf, origin)
			if recorder.Code != http.StatusNotFound {
				t.Fatalf("%s: status = %d (cuerpo %q)", path, recorder.Code, recorder.Body.String())
			}
		}
	})

	t.Run("error al guardar", func(t *testing.T) {
		settings.putErr = errors.New("boom")
		for _, path := range []string{evidencePath, ackPath} {
			recorder := webExtrasDo(api, http.MethodPost, path,
				`{"evidence":"nota suficientemente larga"}`, cookie, csrf, origin)
			if recorder.Code != http.StatusServiceUnavailable {
				t.Fatalf("%s: status = %d (cuerpo %q)", path, recorder.Code, recorder.Body.String())
			}
			var payload map[string]string
			if err := json.Unmarshal(recorder.Body.Bytes(), &payload); err != nil {
				t.Fatalf("%s: JSON: %v", path, err)
			}
			if payload["status"] != "unavailable" {
				t.Fatalf("%s: payload = %v", path, payload)
			}
		}
	})
}

func TestWebExtrasRecoveryWithoutSettings(t *testing.T) {
	api, _, cookie, csrf := newWebExtrasTestAPI(t, webExtrasRecoveryTestSnapshot)

	recorder := webExtrasDo(api, http.MethodGet, "/api/recovery", "", cookie, "", "")
	if recorder.Code != http.StatusOK {
		t.Fatalf("GET status = %d (cuerpo %q)", recorder.Code, recorder.Body.String())
	}
	payload := decodeWebExtrasBody[webExtrasRecoveryTestPayload](t, recorder)
	if len(payload.Data.Items) != 2 || !payload.Data.Blocked {
		t.Fatalf("payload = %+v", payload.Data)
	}
	for _, item := range payload.Data.Items {
		if item.Acknowledged {
			t.Fatalf("%s no debe quedar reconocida sin Settings", item.IntentID)
		}
	}
	if len(payload.Data.Items[1].Evidence) != 1 ||
		payload.Data.Items[1].Evidence[0].Text != "nota previa" {
		t.Fatalf("i-2 evidence = %+v", payload.Data.Items[1].Evidence)
	}

	for _, path := range []string{
		"/api/recovery/i-1/evidence",
		"/api/recovery/i-1/acknowledge",
	} {
		recorder = webExtrasDo(api, http.MethodPost, path,
			`{"evidence":"nota suficientemente larga"}`, cookie, csrf, "https://panel.example")
		if recorder.Code != http.StatusServiceUnavailable {
			t.Fatalf("%s: status = %d (cuerpo %q)", path, recorder.Code, recorder.Body.String())
		}
		var body map[string]string
		if err := json.Unmarshal(recorder.Body.Bytes(), &body); err != nil {
			t.Fatalf("%s: JSON: %v", path, err)
		}
		if body["status"] != "unavailable" {
			t.Fatalf("%s: payload = %v", path, body)
		}
	}
}
