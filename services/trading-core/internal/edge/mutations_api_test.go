package edge

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/AGR55/QvaApp/services/trading-core/internal/runtimeconfig"
)

const mutationsTestNowMS int64 = 1_700_000_000_000

type mutationsTestRecord struct {
	action  string
	target  string
	payload []byte
	actor   string
	now     int64
}

// mutationsTestStore implementa MutationStore en memoria con errores
// inyectables para comprobar el 503 sin base de datos.
type mutationsTestStore struct {
	records    []mutationsTestRecord
	messages   map[string][]ChatMessage
	listLimits []int
	recordErr  error
	saveErr    error
	listErr    error
}

func newMutationsTestStore() *mutationsTestStore {
	return &mutationsTestStore{messages: make(map[string][]ChatMessage)}
}

func (store *mutationsTestStore) Record(
	_ context.Context,
	action, target string,
	payload []byte,
	actor string,
	now int64,
) error {
	if store.recordErr != nil {
		return store.recordErr
	}
	store.records = append(store.records, mutationsTestRecord{
		action: action, target: target, payload: append([]byte(nil), payload...),
		actor: actor, now: now,
	})
	return nil
}

func (store *mutationsTestStore) SaveMessage(_ context.Context, message ChatMessage) error {
	if store.saveErr != nil {
		return store.saveErr
	}
	store.messages[message.OperationUUID] = append(store.messages[message.OperationUUID], message)
	return nil
}

func (store *mutationsTestStore) ListMessages(
	_ context.Context,
	operationUUID string,
	limit int,
) ([]ChatMessage, error) {
	store.listLimits = append(store.listLimits, limit)
	if store.listErr != nil {
		return nil, store.listErr
	}
	messages := store.messages[operationUUID]
	return append([]ChatMessage(nil), messages...), nil
}

func mutationsTestHash(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}

// newMutationsTestAPI construye la API con sesión web válida y un snapshot
// móvil privado que contiene un operador con scope read.
func newMutationsTestAPI(
	t *testing.T,
) (*MutationsAPI, *mutationsTestStore, *http.Cookie, string, string) {
	t.Helper()
	now := time.UnixMilli(mutationsTestNowMS)
	manager := newSessionTestManager(t, 15*time.Minute)
	token, csrf, err := manager.Issue(now)
	if err != nil {
		t.Fatalf("Issue: %v", err)
	}

	mobileToken := strings.Repeat("m", 48)
	snapshot, err := json.Marshal(map[string]any{
		"devices": []any{},
		"operators": []any{
			map[string]any{
				"id": "op-1", "tokenHash": mutationsTestHash(mobileToken),
				"scopes": []string{"read"}, "revokedAt": nil,
			},
		},
	})
	if err != nil {
		t.Fatalf("Marshal snapshot móvil: %v", err)
	}
	file := filepath.Join(t.TempDir(), "mobile-auth.json")
	if err := os.WriteFile(file, snapshot, 0o600); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}

	store := newMutationsTestStore()
	api := &MutationsAPI{
		Enabled:       true,
		Sessions:      manager,
		MobileAuth:    &MobileAuthAPI{File: file, Now: func() time.Time { return now }},
		Store:         store,
		Cooperative:   mutationsTestCooperative{},
		Runtime:       mutationsTestConfig{},
		TrustedOrigin: "https://panel.example",
		Now:           func() time.Time { return now },
	}
	return api, store, &http.Cookie{Name: CookieName, Value: token}, csrf, mobileToken
}

type mutationsTestCall struct {
	method  string
	target  string
	body    string
	cookie  *http.Cookie
	csrf    string
	origin  string
	bearer  string
	headers map[string]string
}

func mutationsTestDo(api http.Handler, call mutationsTestCall) *httptest.ResponseRecorder {
	request := httptest.NewRequest(call.method, call.target, strings.NewReader(call.body))
	if call.cookie != nil {
		request.AddCookie(call.cookie)
	}
	if call.csrf != "" {
		request.Header.Set("X-CSRF-Token", call.csrf)
	}
	if call.origin != "" {
		request.Header.Set("Origin", call.origin)
	}
	if call.bearer != "" {
		request.Header.Set("Authorization", "Bearer "+call.bearer)
	}
	for name, value := range call.headers {
		request.Header.Set(name, value)
	}
	if call.body != "" {
		if request.Header.Get("Content-Type") == "" {
			request.Header.Set("Content-Type", "application/json")
		}
	}
	recorder := httptest.NewRecorder()
	api.ServeHTTP(recorder, request)
	return recorder
}

func mutationsTestWeb(
	api http.Handler,
	method, target, body, csrf string,
	cookie *http.Cookie,
) *httptest.ResponseRecorder {
	return mutationsTestDo(api, mutationsTestCall{
		method: method, target: target, body: body, cookie: cookie,
		csrf: csrf, origin: "https://panel.example",
	})
}

func mutationsTestMobile(
	api http.Handler,
	method, target, body, bearer string,
) *httptest.ResponseRecorder {
	return mutationsTestDo(api, mutationsTestCall{
		method: method, target: target, body: body, bearer: bearer,
	})
}

func decodeMutationsBody[T any](t *testing.T, recorder *httptest.ResponseRecorder) T {
	t.Helper()
	var value T
	if err := json.Unmarshal(recorder.Body.Bytes(), &value); err != nil {
		t.Fatalf("JSON inválido: %v (cuerpo %q)", err, recorder.Body.String())
	}
	return value
}

func assertMutationsHeaders(t *testing.T, recorder *httptest.ResponseRecorder, jsonBody bool) {
	t.Helper()
	if got := recorder.Header().Get("Cache-Control"); got != "no-store" {
		t.Fatalf("Cache-Control = %q, se esperaba no-store", got)
	}
	if got := recorder.Header().Get("X-Content-Type-Options"); got != "nosniff" {
		t.Fatalf("X-Content-Type-Options = %q, se esperaba nosniff", got)
	}
	if got := recorder.Header().Get("Access-Control-Allow-Origin"); got != "" {
		t.Fatalf("no debe emitirse CORS, Access-Control-Allow-Origin = %q", got)
	}
	if jsonBody {
		if got := recorder.Header().Get("Content-Type"); !strings.HasPrefix(got, "application/json") {
			t.Fatalf("Content-Type = %q, se esperaba JSON", got)
		}
	}
	if len(recorder.Result().Cookies()) != 0 {
		t.Fatal("la superficie de mutaciones no debe emitir cookies")
	}
}

func mutationsLastRecord(t *testing.T, store *mutationsTestStore) mutationsTestRecord {
	t.Helper()
	if len(store.records) == 0 {
		t.Fatal("no se registró ningún evento")
	}
	return store.records[len(store.records)-1]
}

func TestMutationsDisabled(t *testing.T) {
	api, store, cookie, csrf, mobileToken := newMutationsTestAPI(t)
	api.Enabled = false

	t.Run("web", func(t *testing.T) {
		recorder := mutationsTestWeb(api, http.MethodPost, "/api/offers",
			`{"coin":"BANK_CUP","type":"buy","amount":1,"rate":1}`, csrf, cookie)
		if recorder.Code != http.StatusServiceUnavailable {
			t.Fatalf("status = %d, quiero 503", recorder.Code)
		}
		assertMutationsHeaders(t, recorder, true)
		body := decodeMutationsBody[map[string]string](t, recorder)
		if body["error"] != mutationsDisabledError {
			t.Fatalf("error = %q", body["error"])
		}
	})

	t.Run("móvil", func(t *testing.T) {
		recorder := mutationsTestMobile(api, http.MethodPost,
			"/api/mobile/payment-receipts", `{}`, mobileToken)
		if recorder.Code != http.StatusServiceUnavailable {
			t.Fatalf("status = %d, quiero 503", recorder.Code)
		}
	})

	t.Run("lectura de chat", func(t *testing.T) {
		recorder := mutationsTestWeb(api, http.MethodGet, "/api/operations/op-1/chat", "", "", cookie)
		if recorder.Code != http.StatusServiceUnavailable {
			t.Fatalf("status = %d, quiero 503", recorder.Code)
		}
	})

	if len(store.records) != 0 {
		t.Fatalf("la bandera apagada no debe registrar eventos, hubo %d", len(store.records))
	}
}

func TestMutationsWebAuthAndCSRF(t *testing.T) {
	api, store, cookie, csrf, _ := newMutationsTestAPI(t)
	target := "/api/offers"
	body := `{"coin":"BANK_CUP","type":"buy","amount":10,"rate":2.5}`

	t.Run("sin cookie", func(t *testing.T) {
		recorder := mutationsTestWeb(api, http.MethodPost, target, body, csrf, nil)
		if recorder.Code != http.StatusUnauthorized {
			t.Fatalf("status = %d, quiero 401", recorder.Code)
		}
	})

	t.Run("cookie inválida", func(t *testing.T) {
		bad := &http.Cookie{Name: CookieName, Value: "no-es-una-sesion"}
		recorder := mutationsTestWeb(api, http.MethodPost, target, body, csrf, bad)
		if recorder.Code != http.StatusUnauthorized {
			t.Fatalf("status = %d, quiero 401", recorder.Code)
		}
	})

	t.Run("origen no permitido", func(t *testing.T) {
		recorder := mutationsTestDo(api, mutationsTestCall{
			method: http.MethodPost, target: target, body: body,
			cookie: cookie, csrf: csrf, origin: "https://atacante.example",
		})
		if recorder.Code != http.StatusForbidden {
			t.Fatalf("status = %d, quiero 403", recorder.Code)
		}
	})

	t.Run("sin csrf", func(t *testing.T) {
		recorder := mutationsTestDo(api, mutationsTestCall{
			method: http.MethodPost, target: target, body: body,
			cookie: cookie, origin: "https://panel.example",
		})
		if recorder.Code != http.StatusForbidden {
			t.Fatalf("status = %d, quiero 403", recorder.Code)
		}
	})

	t.Run("csrf incorrecto", func(t *testing.T) {
		recorder := mutationsTestWeb(api, http.MethodPost, target, body, "incorrecto", cookie)
		if recorder.Code != http.StatusForbidden {
			t.Fatalf("status = %d, quiero 403", recorder.Code)
		}
	})

	if len(store.records) != 0 {
		t.Fatalf("las peticiones rechazadas no deben registrar eventos, hubo %d", len(store.records))
	}

	t.Run("válida", func(t *testing.T) {
		recorder := mutationsTestWeb(api, http.MethodPost, target, body, csrf, cookie)
		if recorder.Code != http.StatusCreated {
			t.Fatalf("status = %d (cuerpo %q)", recorder.Code, recorder.Body.String())
		}
	})

	t.Run("lectura web sin cookie", func(t *testing.T) {
		recorder := mutationsTestWeb(api, http.MethodGet, "/api/operations/op-1/chat", "", "", nil)
		if recorder.Code != http.StatusUnauthorized {
			t.Fatalf("status = %d, quiero 401", recorder.Code)
		}
	})

	t.Run("lectura web con cookie", func(t *testing.T) {
		recorder := mutationsTestDo(api, mutationsTestCall{
			method: http.MethodGet, target: "/api/operations/op-1/chat", cookie: cookie,
		})
		if recorder.Code != http.StatusOK {
			t.Fatalf("status = %d (cuerpo %q)", recorder.Code, recorder.Body.String())
		}
	})
}

func TestMutationsWebRoutes(t *testing.T) {
	recoveryBody := `{"expectedUpdatedAt":1700000000000,"outcome":"not_applied",` +
		`"reason":"Verifiqué que no se aplicó","evidence":"Revisé la operación y no hay movimientos","confirmed":true}`

	cases := []struct {
		name       string
		method     string
		target     string
		body       string
		status     int
		action     string
		targetID   string
		jsonOutput bool
	}{
		{"aportación", http.MethodPut, "/api/cooperative-network/contributions",
			`{"coin":"BANK_CUP","minimal":10,"price":1.2}`, 204, "cooperative_contribution_set", "BANK_CUP", false},
		{"retirar aportación", http.MethodDelete, "/api/cooperative-network/contributions/BANK_CUP",
			"", 204, "cooperative_contribution_withdraw", "BANK_CUP", false},
		{"cacería", http.MethodPut, "/api/cooperative-network/hunting",
			`{"enabled":true}`, 204, "cooperative_hunting_set", "", false},
		{"reconciliar red", http.MethodPost, "/api/cooperative-network/reconcile",
			"", 204, "cooperative_network_reconcile", "", false},
		{"comprobar ejecuciones", http.MethodPost, "/api/cooperative-network/executions/check",
			"{}", 204, "cooperative_executions_check", "", false},
		{"reparto distribuido", http.MethodPost, "/api/cooperative-network/executions/ex-1/distributed",
			`{"confirmed":true}`, 204, "cooperative_execution_distributed", "ex-1", false},
		{"crear oferta", http.MethodPost, "/api/offers",
			`{"coin":"BANK_CUP","type":"buy","amount":10,"rate":2.5}`, 201, "offer_created", "-", true},
		{"editar oferta", http.MethodPut, "/api/offers/offer-1",
			`{"amount":5,"rate":2}`, 204, "offer_updated", "offer-1", false},
		{"cancelar oferta", http.MethodDelete, "/api/offers/offer-1",
			"", 204, "offer_cancelled", "offer-1", false},
		{"vista rebalanceo", http.MethodPost, "/api/offers/rebalance/preview",
			`{}`, 200, "offer_rebalance_preview", "", true},
		{"aplicar rebalanceo", http.MethodPost, "/api/offers/rebalance/apply",
			`{"adjustments":[{"uuid":"offer-1","amount":5}]}`, 202, "offer_rebalance_apply", "-", true},
		{"operación ack", http.MethodPost, "/api/operations/op-1/ack",
			"", 204, "operation_ack", "op-1", false},
		{"operación pagada", http.MethodPost, "/api/operations/op-1/paid",
			`{"reference":"REF-1"}`, 204, "operation_paid", "op-1", false},
		{"operación recibida", http.MethodPost, "/api/operations/op-1/received",
			"{}", 204, "operation_received", "op-1", false},
		{"operación cancelada", http.MethodPost, "/api/operations/op-1/cancel",
			"", 204, "operation_cancel", "op-1", false},
		{"reconciliar workflow", http.MethodPost, "/api/workflows/wf-1/reconcile",
			"", 200, "workflow_reconcile", "wf-1", true},
		{"vista bloqueada", http.MethodPost, "/api/blocked-offers/blocked-1/preview",
			`{}`, 200, "blocked_offer_preview", "blocked-1", true},
		{"aplicar bloqueada", http.MethodPost, "/api/blocked-offers/blocked-1/apply",
			`{"overridePriceGuard":true}`, 204, "blocked_offer_apply", "blocked-1", false},
		{"comprobar recuperación", http.MethodPost, "/api/recovery/intent-1/check",
			`{}`, 200, "recovery_check", "intent-1", true},
		{"resolver recuperación", http.MethodPost, "/api/recovery/intent-1/resolve",
			recoveryBody, 204, "recovery_resolve", "intent-1", false},
		{"leer chat", http.MethodGet, "/api/operations/op-1/chat",
			"", 200, "", "", true},
		{"estado de envío", http.MethodGet, "/api/operations/op-1/chat/sends/attempt-1234567890123456",
			"", 200, "", "", true},
		{"imagen inexistente", http.MethodGet, "/api/operations/op-1/chat/images/msg-1",
			"", 404, "", "", true},
		{"enviar chat", http.MethodPost, "/api/operations/op-1/chat",
			`{"message":"hola"}`, 201, "", "", true},
		{"marcar leído", http.MethodPost, "/api/operations/op-1/chat/read",
			`{}`, 200, "chat_read", "op-1", true},
		{"enviar imagen", http.MethodPost, "/api/operations/op-1/chat/images",
			"bytes-de-prueba", 201, "chat_image_uploaded", "op-1", true},
	}

	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			api, store, cookie, csrf, _ := newMutationsTestAPI(t)
			recorder := mutationsTestWeb(api, testCase.method, testCase.target,
				testCase.body, csrf, cookie)
			if recorder.Code != testCase.status {
				t.Fatalf("status = %d, quiero %d (cuerpo %q)",
					recorder.Code, testCase.status, recorder.Body.String())
			}
			assertMutationsHeaders(t, recorder, testCase.jsonOutput)
			if testCase.action != "" {
				record := mutationsLastRecord(t, store)
				if record.action != testCase.action {
					t.Fatalf("action = %q, quiero %q", record.action, testCase.action)
				}
				if testCase.targetID != "-" && record.target != testCase.targetID {
					t.Fatalf("target = %q, quiero %q", record.target, testCase.targetID)
				}
				if record.actor != "panel" {
					t.Fatalf("actor = %q, quiero panel", record.actor)
				}
				if record.now != mutationsTestNowMS {
					t.Fatalf("now = %d, quiero %d", record.now, mutationsTestNowMS)
				}
				if !json.Valid(record.payload) {
					t.Fatalf("payload no es JSON: %q", record.payload)
				}
			}
		})
	}
}

func TestMutationsOfferAndViews(t *testing.T) {
	api, _, cookie, csrf, _ := newMutationsTestAPI(t)

	type offerResponse struct {
		Data struct {
			UUID      string  `json:"uuid"`
			Coin      string  `json:"coin"`
			Type      string  `json:"type"`
			Amount    float64 `json:"amount"`
			Receive   float64 `json:"receive"`
			Rate      float64 `json:"rate"`
			Status    string  `json:"status"`
			Execution string  `json:"execution"`
		} `json:"data"`
	}
	recorder := mutationsTestWeb(api, http.MethodPost, "/api/offers",
		`{"coin":"BANK_CUP","type":"sell","amount":10,"rate":2.5}`, csrf, cookie)
	offer := decodeMutationsBody[offerResponse](t, recorder).Data
	if offer.UUID == "" || offer.Coin != "BANK_CUP" || offer.Type != "sell" ||
		offer.Amount != 10 || offer.Receive != 25 || offer.Rate != 2.5 ||
		offer.Status != "open" || offer.Execution != "shadow" {
		t.Fatalf("oferta inesperada: %+v", offer)
	}

	type previewResponse struct {
		Data struct {
			Plans     []any  `json:"plans"`
			Execution string `json:"execution"`
		} `json:"data"`
	}
	preview := decodeMutationsBody[previewResponse](t, mutationsTestWeb(
		api, http.MethodPost, "/api/offers/rebalance/preview", `{}`, csrf, cookie)).Data
	if preview.Plans == nil || len(preview.Plans) != 0 || preview.Execution != "shadow" {
		t.Fatalf("vista de rebalanceo inesperada: %+v", preview)
	}

	type applyResponse struct {
		Data struct {
			ID          string            `json:"id"`
			State       string            `json:"state"`
			Adjustments []json.RawMessage `json:"adjustments"`
			Execution   string            `json:"execution"`
		} `json:"data"`
	}
	apply := decodeMutationsBody[applyResponse](t, mutationsTestWeb(
		api, http.MethodPost, "/api/offers/rebalance/apply",
		`{"adjustments":[{"uuid":"o-1","amount":5}]}`, csrf, cookie)).Data
	if apply.ID == "" || apply.State != "pending" || apply.Execution != "shadow" ||
		len(apply.Adjustments) != 1 {
		t.Fatalf("aplicación de rebalanceo inesperada: %+v", apply)
	}

	type workflowResponse struct {
		Data struct {
			WorkflowID string `json:"workflowId"`
			State      string `json:"state"`
			Execution  string `json:"execution"`
		} `json:"data"`
	}
	workflow := decodeMutationsBody[workflowResponse](t, mutationsTestWeb(
		api, http.MethodPost, "/api/workflows/wf-9/reconcile", "", csrf, cookie)).Data
	if workflow.WorkflowID != "wf-9" || workflow.State != "shadow_reconciled" ||
		workflow.Execution != "shadow" {
		t.Fatalf("workflow inesperado: %+v", workflow)
	}

	type blockedResponse struct {
		Data struct {
			UUID                 string   `json:"uuid"`
			Coin                 string   `json:"coin"`
			OfferType            string   `json:"offerType"`
			Amount               float64  `json:"amount"`
			Receive              float64  `json:"receive"`
			Rate                 float64  `json:"rate"`
			ReferenceRate        *float64 `json:"referenceRate"`
			DeviationPercent     float64  `json:"deviationPercent"`
			PlannedCancellations []any    `json:"plannedCancellations"`
			LiquidityReason      string   `json:"liquidityReason"`
			Execution            string   `json:"execution"`
		} `json:"data"`
	}
	blocked := decodeMutationsBody[blockedResponse](t, mutationsTestWeb(
		api, http.MethodPost, "/api/blocked-offers/b-1/preview", `{}`, csrf, cookie)).Data
	if blocked.UUID != "b-1" || blocked.Coin != "" || blocked.OfferType != "" ||
		blocked.Amount != 0 || blocked.Receive != 0 || blocked.Rate != 0 ||
		blocked.ReferenceRate != nil || blocked.DeviationPercent != 0 ||
		blocked.PlannedCancellations == nil || len(blocked.PlannedCancellations) != 0 ||
		blocked.LiquidityReason != "Vista shadow sin QvaPay en vivo." ||
		blocked.Execution != "shadow" {
		t.Fatalf("vista bloqueada inesperada: %+v", blocked)
	}

	type recoveryResponse struct {
		Data struct {
			IntentID  string `json:"intentId"`
			CheckedAt int64  `json:"checkedAt"`
			Outcome   string `json:"outcome"`
			State     string `json:"state"`
			Message   string `json:"message"`
			Retry     any    `json:"retry"`
		} `json:"data"`
	}
	recovery := decodeMutationsBody[recoveryResponse](t, mutationsTestWeb(
		api, http.MethodPost, "/api/recovery/i-1/check", `{}`, csrf, cookie)).Data
	if recovery.IntentID != "i-1" || recovery.CheckedAt != mutationsTestNowMS ||
		recovery.Outcome != "shadow_review" || recovery.State != "uncertain" ||
		recovery.Message != "Comprobación shadow: no se ejecutaron compensaciones." ||
		recovery.Retry != nil {
		t.Fatalf("comprobación de recuperación inesperada: %+v", recovery)
	}
}

func TestMutationsMobileAuthAndRoutes(t *testing.T) {
	api, store, _, _, mobileToken := newMutationsTestAPI(t)

	t.Run("sin bearer", func(t *testing.T) {
		for _, call := range []struct {
			method string
			target string
		}{
			{http.MethodPost, "/api/mobile/operations/op-1/paid"},
			{http.MethodGet, "/api/mobile/operations/op-1/chat"},
			{http.MethodPost, "/api/mobile/payment-receipts"},
			{http.MethodGet, "/api/mobile/operations/op-1/payment-preview"},
		} {
			recorder := mutationsTestMobile(api, call.method, call.target, "{}", "")
			if recorder.Code != http.StatusUnauthorized {
				t.Fatalf("%s %s: status = %d, quiero 401",
					call.method, call.target, recorder.Code)
			}
		}
	})

	t.Run("acciones", func(t *testing.T) {
		cases := []struct {
			action string
			body   string
			status int
			record string
		}{
			{"paid", `{"reference":"REF-9"}`, 204, "operation_paid"},
			{"received", `{}`, 204, "operation_received"},
			{"cancel", "", 204, "operation_cancel"},
			{"ack", "", 400, ""},
		}
		for _, testCase := range cases {
			recorder := mutationsTestMobile(api, http.MethodPost,
				"/api/mobile/operations/op-1/"+testCase.action, testCase.body, mobileToken)
			if recorder.Code != testCase.status {
				t.Fatalf("%s: status = %d, quiero %d (cuerpo %q)",
					testCase.action, recorder.Code, testCase.status, recorder.Body.String())
			}
			assertMutationsHeaders(t, recorder, testCase.status != 204)
			if testCase.record != "" {
				record := mutationsLastRecord(t, store)
				if record.action != testCase.record || record.target != "op-1" {
					t.Fatalf("registro = %q/%q, quiero %q/op-1",
						record.action, record.target, testCase.record)
				}
				if record.actor != "op-1" {
					t.Fatalf("actor = %q, quiero op-1", record.actor)
				}
			}
		}
	})

	t.Run("chat", func(t *testing.T) {
		cases := []struct {
			name   string
			method string
			target string
			body   string
			status int
		}{
			{"leer", http.MethodGet, "/api/mobile/operations/op-1/chat", "", 200},
			{"estado", http.MethodGet, "/api/mobile/operations/op-1/chat/sends/attempt-1234567890123456", "", 200},
			{"imagen", http.MethodGet, "/api/mobile/operations/op-1/chat/images/msg-1", "", 404},
			{"enviar", http.MethodPost, "/api/mobile/operations/op-1/chat", `{"message":"hola"}`, 201},
			{"leído", http.MethodPost, "/api/mobile/operations/op-1/chat/read", `{}`, 200},
			{"subir imagen", http.MethodPost, "/api/mobile/operations/op-1/chat/images", "raw", 201},
		}
		for _, testCase := range cases {
			recorder := mutationsTestMobile(api, testCase.method, testCase.target,
				testCase.body, mobileToken)
			if recorder.Code != testCase.status {
				t.Fatalf("%s: status = %d, quiero %d (cuerpo %q)",
					testCase.name, recorder.Code, testCase.status, recorder.Body.String())
			}
			assertMutationsHeaders(t, recorder, testCase.status != 204)
		}
	})

	t.Run("comprobante", func(t *testing.T) {
		before := len(store.records)
		recorder := mutationsTestMobile(api, http.MethodPost,
			"/api/mobile/payment-receipts", `{"bank":"BPA","amount":10}`, mobileToken)
		if recorder.Code != http.StatusCreated {
			t.Fatalf("status = %d (cuerpo %q)", recorder.Code, recorder.Body.String())
		}
		assertMutationsHeaders(t, recorder, true)
		type receiptResponse struct {
			Data struct {
				Receipt struct {
					ID         string `json:"id"`
					Status     string `json:"status"`
					ReceivedAt int64  `json:"receivedAt"`
				} `json:"receipt"`
				Duplicate bool `json:"duplicate"`
			} `json:"data"`
		}
		response := decodeMutationsBody[receiptResponse](t, recorder).Data
		if response.Receipt.ID == "" || response.Receipt.Status != "pending" ||
			response.Receipt.ReceivedAt != mutationsTestNowMS || response.Duplicate {
			t.Fatalf("comprobante inesperado: %+v", response)
		}
		if got := len(store.records); got != before+1 {
			t.Fatalf("registros = %d, quiero %d", got, before+1)
		}
		record := mutationsLastRecord(t, store)
		if record.action != "payment_receipt_received" || record.target != response.Receipt.ID {
			t.Fatalf("registro = %q/%q", record.action, record.target)
		}
	})

	t.Run("vista previa de pago", func(t *testing.T) {
		before := len(store.records)
		recorder := mutationsTestMobile(api, http.MethodGet,
			"/api/mobile/operations/op-1/payment-preview", "", mobileToken)
		if recorder.Code != http.StatusServiceUnavailable {
			t.Fatalf("status = %d, quiero 503", recorder.Code)
		}
		assertMutationsHeaders(t, recorder, true)
		body := decodeMutationsBody[map[string]string](t, recorder)
		if body["error"] != mutationsPaymentError {
			t.Fatalf("error = %q, quiero %q", body["error"], mutationsPaymentError)
		}
		if got := len(store.records); got != before {
			t.Fatal("payment-preview no debe registrar eventos")
		}
	})
}

func TestMutationsChatPersistence(t *testing.T) {
	api, store, cookie, csrf, mobileToken := newMutationsTestAPI(t)

	type sendResponse struct {
		Data struct {
			Message ChatMessage `json:"message"`
		} `json:"data"`
	}
	recorder := mutationsTestWeb(api, http.MethodPost,
		"/api/operations/op-1/chat?order=ord-1",
		`{"message":"  hola  ","attemptId":"attempt-1"}`, csrf, cookie)
	if recorder.Code != http.StatusCreated {
		t.Fatalf("status = %d (cuerpo %q)", recorder.Code, recorder.Body.String())
	}
	sent := decodeMutationsBody[sendResponse](t, recorder).Data.Message
	if sent.ID == "" || sent.OperationUUID != "op-1" || sent.OrderUUID != "ord-1" ||
		sent.Message != "hola" || sent.AttemptID != "attempt-1" ||
		sent.Direction != "out" || sent.CreatedAt != mutationsTestNowMS {
		t.Fatalf("mensaje inesperado: %+v", sent)
	}
	if len(store.messages["op-1"]) != 1 {
		t.Fatalf("mensajes guardados = %d, quiero 1", len(store.messages["op-1"]))
	}

	type chatResponse struct {
		Data struct {
			Operation struct {
				UUID string `json:"uuid"`
			} `json:"operation"`
			Messages    []ChatMessage `json:"messages"`
			UnreadCount int           `json:"unreadCount"`
		} `json:"data"`
	}
	chat := decodeMutationsBody[chatResponse](t, mutationsTestWeb(
		api, http.MethodGet, "/api/operations/op-1/chat", "", "", cookie)).Data
	if chat.Operation.UUID != "op-1" || len(chat.Messages) != 1 ||
		chat.Messages[0].ID != sent.ID || chat.UnreadCount != 0 {
		t.Fatalf("chat inesperado: %+v", chat)
	}
	if len(store.listLimits) != 1 || store.listLimits[0] != mutationsChatListLimit {
		t.Fatalf("límites de listado = %v", store.listLimits)
	}

	// El chat móvil comparte el mismo almacenamiento.
	recorder = mutationsTestMobile(api, http.MethodPost,
		"/api/mobile/operations/op-1/chat", `{"message":"desde móvil"}`, mobileToken)
	if recorder.Code != http.StatusCreated {
		t.Fatalf("chat móvil: status = %d (cuerpo %q)", recorder.Code, recorder.Body.String())
	}
	recorder = mutationsTestMobile(api, http.MethodGet,
		"/api/mobile/operations/op-1/chat", "", mobileToken)
	chat = decodeMutationsBody[chatResponse](t, recorder).Data
	if len(chat.Messages) != 2 || chat.Messages[1].Message != "desde móvil" {
		t.Fatalf("chat móvil inesperado: %+v", chat)
	}

	// El chat vacío devuelve un array, no null.
	empty := decodeMutationsBody[chatResponse](t, mutationsTestWeb(
		api, http.MethodGet, "/api/operations/op-2/chat", "", "", cookie)).Data
	if empty.Messages == nil || len(empty.Messages) != 0 {
		t.Fatalf("messages = %#v, quiero []", empty.Messages)
	}

	t.Run("errores del store", func(t *testing.T) {
		store.saveErr = errors.New("fallo")
		recorder := mutationsTestWeb(api, http.MethodPost,
			"/api/operations/op-1/chat", `{"message":"hola"}`, csrf, cookie)
		if recorder.Code != http.StatusServiceUnavailable {
			t.Fatalf("save: status = %d, quiero 503", recorder.Code)
		}
		store.saveErr = nil

		store.listErr = errors.New("fallo")
		recorder = mutationsTestWeb(api, http.MethodGet,
			"/api/operations/op-1/chat", "", "", cookie)
		if recorder.Code != http.StatusServiceUnavailable {
			t.Fatalf("list: status = %d, quiero 503", recorder.Code)
		}
		store.listErr = nil
	})
}

func TestMutationsValidations(t *testing.T) {
	cases := []struct {
		name   string
		method string
		target string
		body   string
	}{
		{"json inválido", http.MethodPost, "/api/offers", `{`},
		{"cuerpo vacío", http.MethodPost, "/api/offers", ""},
		{"mercado inválido", http.MethodPost, "/api/offers",
			`{"coin":"cup","type":"buy","amount":1,"rate":1}`},
		{"tipo inválido", http.MethodPost, "/api/offers",
			`{"coin":"BANK_CUP","type":"hold","amount":1,"rate":1}`},
		{"importe cero", http.MethodPost, "/api/offers",
			`{"coin":"BANK_CUP","type":"buy","amount":0,"rate":1}`},
		{"tasa negativa", http.MethodPost, "/api/offers",
			`{"coin":"BANK_CUP","type":"buy","amount":1,"rate":-1}`},
		{"aportación inválida", http.MethodPut, "/api/cooperative-network/contributions",
			`{"coin":"BANK_CUP","minimal":0,"price":1}`},
		{"retirar mercado inválido", http.MethodDelete,
			"/api/cooperative-network/contributions/bank", ""},
		{"cacería sin enabled", http.MethodPut, "/api/cooperative-network/hunting", `{}`},
		{"reparto sin confirmar", http.MethodPost,
			"/api/cooperative-network/executions/ex-1/distributed", `{"confirmed":false}`},
		{"edición sin cambios", http.MethodPut, "/api/offers/o-1", `{}`},
		{"edición inválida", http.MethodPut, "/api/offers/o-1", `{"amount":0}`},
		{"rebalanceo vacío", http.MethodPost, "/api/offers/rebalance/apply",
			`{"adjustments":[]}`},
		{"rebalanceo inválido", http.MethodPost, "/api/offers/rebalance/apply",
			`{"adjustments":[{"uuid":"o-1","amount":0}]}`},
		{"referencia vacía", http.MethodPost, "/api/operations/op-1/paid",
			`{"reference":"   "}`},
		{"referencia larga", http.MethodPost, "/api/operations/op-1/paid",
			`{"reference":"` + strings.Repeat("r", 201) + `"}`},
		{"acción inválida", http.MethodPost, "/api/operations/op-1/unknown", `{}`},
		{"bloqueada sin override", http.MethodPost, "/api/blocked-offers/b-1/apply",
			`{"overridePriceGuard":false}`},
		{"resolver outcome inválido", http.MethodPost, "/api/recovery/i-1/resolve",
			`{"expectedUpdatedAt":1,"outcome":"otro","reason":"razón suficiente","evidence":"evidencia suficiente","confirmed":true}`},
		{"resolver razón corta", http.MethodPost, "/api/recovery/i-1/resolve",
			`{"expectedUpdatedAt":1,"outcome":"not_applied","reason":"corta","evidence":"evidencia suficiente","confirmed":true}`},
		{"resolver evidencia corta", http.MethodPost, "/api/recovery/i-1/resolve",
			`{"expectedUpdatedAt":1,"outcome":"not_applied","reason":"razón suficiente","evidence":"corta","confirmed":true}`},
		{"resolver sin confirmar", http.MethodPost, "/api/recovery/i-1/resolve",
			`{"expectedUpdatedAt":1,"outcome":"not_applied","reason":"razón suficiente","evidence":"evidencia suficiente","confirmed":false}`},
		{"resolver sin expected", http.MethodPost, "/api/recovery/i-1/resolve",
			`{"outcome":"not_applied","reason":"razón suficiente","evidence":"evidencia suficiente","confirmed":true}`},
		{"chat vacío", http.MethodPost, "/api/operations/op-1/chat", `{"message":"   "}`},
		{"chat largo", http.MethodPost, "/api/operations/op-1/chat",
			`{"message":"` + strings.Repeat("a", 600) + `"}`},
		{"chat read excesivo", http.MethodPost, "/api/operations/op-1/chat/read",
			`{"ids":["1","2","3","4","5","6","7","8","9","10","11","12","13","14","15","16","17","18","19","20","21","22","23","24","25","26","27","28","29","30","31","32","33","34","35","36","37","38","39","40","41","42","43","44","45","46","47","48","49","50","51","52","53","54","55","56","57","58","59","60","61","62","63","64","65","66","67","68","69","70","71","72","73","74","75","76","77","78","79","80","81","82","83","84","85","86","87","88","89","90","91","92","93","94","95","96","97","98","99","100","101"]}`},
	}

	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			api, store, cookie, csrf, _ := newMutationsTestAPI(t)
			recorder := mutationsTestWeb(api, testCase.method, testCase.target,
				testCase.body, csrf, cookie)
			if recorder.Code != http.StatusBadRequest {
				t.Fatalf("status = %d, quiero 400 (cuerpo %q)",
					recorder.Code, recorder.Body.String())
			}
			assertMutationsHeaders(t, recorder, true)
			if len(store.records) != 0 {
				t.Fatalf("una petición inválida no debe registrar, hubo %d", len(store.records))
			}
		})
	}

	t.Run("comprobante inválido", func(t *testing.T) {
		api, store, _, _, mobileToken := newMutationsTestAPI(t)
		recorder := mutationsTestMobile(api, http.MethodPost,
			"/api/mobile/payment-receipts", `{`, mobileToken)
		if recorder.Code != http.StatusBadRequest {
			t.Fatalf("status = %d, quiero 400", recorder.Code)
		}
		if len(store.records) != 0 {
			t.Fatal("un comprobante inválido no debe registrar")
		}
	})

	t.Run("cuerpo demasiado grande", func(t *testing.T) {
		api, _, cookie, csrf, _ := newMutationsTestAPI(t)
		body := `{"coin":"BANK_CUP","type":"buy","amount":1,"rate":1,"padding":"` +
			strings.Repeat("x", mutationsMaxBodyBytes) + `"}`
		recorder := mutationsTestWeb(api, http.MethodPost, "/api/offers", body, csrf, cookie)
		if recorder.Code != http.StatusRequestEntityTooLarge {
			t.Fatalf("status = %d, quiero 413", recorder.Code)
		}
	})
}

func TestMutationsRouting(t *testing.T) {
	api, _, cookie, csrf, _ := newMutationsTestAPI(t)

	t.Run("ruta desconocida", func(t *testing.T) {
		recorder := mutationsTestWeb(api, http.MethodPost, "/api/desconocida", "{}", csrf, cookie)
		if recorder.Code != http.StatusNotFound {
			t.Fatalf("status = %d, quiero 404", recorder.Code)
		}
	})

	cases := []struct {
		name   string
		method string
		target string
		allow  string
	}{
		{"ofertas get", http.MethodGet, "/api/offers", "POST"},
		{"oferta post", http.MethodPost, "/api/offers/o-1", "PUT, DELETE"},
		{"aportación get", http.MethodGet, "/api/cooperative-network/contributions", "PUT"},
		{"chat images post get", http.MethodGet, "/api/operations/op-1/chat/images", "POST"},
		{"recovery check get", http.MethodGet, "/api/recovery/i-1/check", "POST"},
		{"payment receipts get", http.MethodGet, "/api/mobile/payment-receipts", "POST"},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			recorder := mutationsTestWeb(api, testCase.method, testCase.target, "", csrf, cookie)
			if recorder.Code != http.StatusMethodNotAllowed {
				t.Fatalf("status = %d, quiero 405", recorder.Code)
			}
			if got := recorder.Header().Get("Allow"); got != testCase.allow {
				t.Fatalf("Allow = %q, quiero %q", got, testCase.allow)
			}
		})
	}
}

func TestMutationsStoreUnavailable(t *testing.T) {
	api, _, cookie, csrf, mobileToken := newMutationsTestAPI(t)
	api.Store = nil

	recorder := mutationsTestWeb(api, http.MethodPost, "/api/offers",
		`{"coin":"BANK_CUP","type":"buy","amount":1,"rate":1}`, csrf, cookie)
	if recorder.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, quiero 503", recorder.Code)
	}
	body := decodeMutationsBody[map[string]string](t, recorder)
	if body["error"] != mutationsStorageError {
		t.Fatalf("error = %q", body["error"])
	}

	// payment-preview no depende del store y conserva su mensaje propio.
	recorder = mutationsTestMobile(api, http.MethodGet,
		"/api/mobile/operations/op-1/payment-preview", "", mobileToken)
	if recorder.Code != http.StatusServiceUnavailable {
		t.Fatalf("preview: status = %d, quiero 503", recorder.Code)
	}
	preview := decodeMutationsBody[map[string]string](t, recorder)
	if preview["error"] != mutationsPaymentError {
		t.Fatalf("preview error = %q", preview["error"])
	}
}

func TestMutationsStoreErrors(t *testing.T) {
	api, store, cookie, csrf, _ := newMutationsTestAPI(t)
	store.recordErr = errors.New("fallo")

	recorder := mutationsTestWeb(api, http.MethodPost, "/api/offers",
		`{"coin":"BANK_CUP","type":"buy","amount":1,"rate":1}`, csrf, cookie)
	if recorder.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, quiero 503", recorder.Code)
	}
	assertMutationsHeaders(t, recorder, true)
	if len(store.records) != 0 {
		t.Fatalf("los eventos fallidos no deben acumularse, hubo %d", len(store.records))
	}
}

// mutationsTestCooperative simula un sincronizador conectado sin red.
type mutationsTestCooperative struct{}

func (mutationsTestCooperative) Enabled() bool { return true }

func (mutationsTestCooperative) Publish(context.Context, string, float64, float64, float64) error {
	return nil
}

func (mutationsTestCooperative) Withdraw(context.Context, string) error { return nil }

func (mutationsTestCooperative) Refresh(context.Context) error { return nil }

func (mutationsTestCooperative) EnsureBaseline(context.Context, string) error { return nil }

func (mutationsTestCooperative) SyncCapacity(context.Context) error { return nil }

// mutationsTestConfig devuelve un mercado con saldo suficiente para publicar.
type mutationsTestConfig struct{}

func (mutationsTestConfig) Load(context.Context) (runtimeconfig.Config, int64, error) {
	return runtimeconfig.Config{Markets: []runtimeconfig.Market{{
		Code: "BANK_CUP", Active: true, BuyMaxRate: 2, FiatBalance: 100, Currency: "CUP",
	}}}, 1, nil
}
