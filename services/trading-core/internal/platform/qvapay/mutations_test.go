package qvapay

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/AGR55/QvaApp/services/shared/decimal"
)

const (
	mutationOfferUUID = "7c9e6679-7425-40de-944b-e07fc1f90ae7"
	mutationOrderUUID = "9c190663-340f-4b39-b237-bf0365f5cfe7"
)

type mutationCall struct {
	method      string
	path        string
	query       string
	auth        string
	contentType string
	body        string
}

func newMutationRecorder(t *testing.T, status int, response string) (*httptest.Server, func() []mutationCall) {
	t.Helper()

	var mu sync.Mutex
	calls := make([]mutationCall, 0, 2)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, err := io.ReadAll(r.Body)
		if err != nil {
			t.Errorf("leer cuerpo: %v", err)
		}
		mu.Lock()
		calls = append(calls, mutationCall{
			method:      r.Method,
			path:        r.URL.EscapedPath(),
			query:       r.URL.RawQuery,
			auth:        r.Header.Get("Authorization"),
			contentType: r.Header.Get("Content-Type"),
			body:        string(body),
		})
		mu.Unlock()

		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		io.WriteString(w, response)
	}))
	t.Cleanup(server.Close)

	return server, func() []mutationCall {
		mu.Lock()
		defer mu.Unlock()
		copied := make([]mutationCall, len(calls))
		copy(copied, calls)
		return copied
	}
}

func TestMutationClientDisabledDoesNotDispatch(t *testing.T) {
	var hits int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&hits, 1)
		w.WriteHeader(http.StatusOK)
	}))
	t.Cleanup(server.Close)

	client := NewMutationClient(server.URL, "test-token")
	if client.Enabled {
		t.Fatal("NewMutationClient debe crear el adaptador deshabilitado")
	}

	amount := decimal.MustParse("1.00000000")
	ctx := context.Background()

	if _, err := client.Apply(ctx, mutationOfferUUID, &amount); !errors.Is(err, ErrMutationsDisabled) {
		t.Fatalf("Apply deshabilitado: err=%v, se esperaba ErrMutationsDisabled", err)
	}
	if _, err := client.Cancel(ctx, mutationOfferUUID, mutationOrderUUID); !errors.Is(err, ErrMutationsDisabled) {
		t.Fatalf("Cancel deshabilitado: err=%v, se esperaba ErrMutationsDisabled", err)
	}
	// La comprobación de habilitación ocurre antes que cualquier validación.
	if _, err := client.Apply(ctx, "not-a-uuid", nil); !errors.Is(err, ErrMutationsDisabled) {
		t.Fatalf("Apply deshabilitado con UUID inválido: err=%v", err)
	}
	if got := atomic.LoadInt32(&hits); got != 0 {
		t.Fatalf("el servidor recibió %d peticiones con el adaptador deshabilitado", got)
	}
}

func TestMutationClientApply(t *testing.T) {
	server, calls := newMutationRecorder(t, http.StatusOK,
		`{"order":"`+mutationOrderUUID+`","amount":"1.25","receive":"1.25"}`)

	client := NewMutationClient(server.URL+"/", "test-token")
	client.Enable()

	amount := decimal.MustParse("1.25000000")
	result, err := client.Apply(context.Background(), mutationOfferUUID, &amount)
	if err != nil {
		t.Fatalf("Apply: %v", err)
	}
	if result.StatusCode != http.StatusOK {
		t.Fatalf("status=%d, se esperaba 200", result.StatusCode)
	}
	var payload struct {
		Order  string `json:"order"`
		Amount string `json:"amount"`
	}
	if err := json.Unmarshal(result.Body, &payload); err != nil {
		t.Fatalf("respuesta de Apply ilegible: %v (%s)", err, result.Body)
	}
	if payload.Order != mutationOrderUUID {
		t.Fatalf("order=%q, se esperaba %q", payload.Order, mutationOrderUUID)
	}

	recorded := calls()
	if len(recorded) != 1 {
		t.Fatalf("peticiones=%d, se esperaba 1", len(recorded))
	}
	call := recorded[0]
	if call.method != http.MethodPost {
		t.Fatalf("método=%q, se esperaba POST", call.method)
	}
	if call.path != "/p2p/"+mutationOfferUUID+"/apply" {
		t.Fatalf("ruta=%q", call.path)
	}
	if call.query != "" {
		t.Fatalf("query inesperada: %q", call.query)
	}
	if call.auth != "Bearer test-token" {
		t.Fatalf("Authorization=%q", call.auth)
	}
	if call.contentType != "application/json" {
		t.Fatalf("Content-Type=%q", call.contentType)
	}
	if call.body != `{"amount":"1.25"}` {
		t.Fatalf("cuerpo=%q", call.body)
	}
}

func TestMutationClientCancel(t *testing.T) {
	server, calls := newMutationRecorder(t, http.StatusOK, `{"status":"cancelled"}`)

	client := NewMutationClient(server.URL, "test-token")
	client.Enable()
	ctx := context.Background()

	result, err := client.Cancel(ctx, mutationOfferUUID, mutationOrderUUID)
	if err != nil {
		t.Fatalf("Cancel con orden: %v", err)
	}
	if result.StatusCode != http.StatusOK || !strings.Contains(string(result.Body), "cancelled") {
		t.Fatalf("resultado inesperado: %+v", result)
	}
	if _, err := client.Cancel(ctx, mutationOfferUUID, ""); err != nil {
		t.Fatalf("Cancel sin orden: %v", err)
	}

	recorded := calls()
	if len(recorded) != 2 {
		t.Fatalf("peticiones=%d, se esperaban 2", len(recorded))
	}
	for index, call := range recorded {
		if call.method != http.MethodPost {
			t.Errorf("llamada %d: método=%q, se esperaba POST", index, call.method)
		}
		if call.path != "/p2p/"+mutationOfferUUID+"/cancel" {
			t.Errorf("llamada %d: ruta=%q", index, call.path)
		}
		if call.auth != "Bearer test-token" {
			t.Errorf("llamada %d: Authorization=%q", index, call.auth)
		}
		if call.body != "" {
			t.Errorf("llamada %d: cuerpo inesperado %q", index, call.body)
		}
		if call.contentType != "" {
			t.Errorf("llamada %d: Content-Type inesperado %q", index, call.contentType)
		}
	}
	if recorded[0].query != "order="+mutationOrderUUID {
		t.Fatalf("query con orden=%q", recorded[0].query)
	}
	if recorded[1].query != "" {
		t.Fatalf("query sin orden=%q", recorded[1].query)
	}
}

func TestMutationClientAmountIsJSONString(t *testing.T) {
	cases := []struct {
		name        string
		amount      *decimal.Value
		wantBody    string
		wantPayLoad bool
	}{
		{
			name:        "decimal exacto",
			amount:      decimalValue("1.23456789"),
			wantBody:    `{"amount":"1.23456789"}`,
			wantPayLoad: true,
		},
		{
			name:        "sin ceros finales",
			amount:      decimalValue("10.25000000"),
			wantBody:    `{"amount":"10.25"}`,
			wantPayLoad: true,
		},
		{
			name:        "cero",
			amount:      decimalValue("0"),
			wantBody:    `{"amount":"0"}`,
			wantPayLoad: true,
		},
		{
			name:        "sin importe",
			amount:      nil,
			wantBody:    "",
			wantPayLoad: false,
		},
	}

	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			server, calls := newMutationRecorder(t, http.StatusOK, `{"status":"ok"}`)
			client := NewMutationClient(server.URL, "test-token")
			client.Enable()

			if _, err := client.Apply(context.Background(), mutationOfferUUID, testCase.amount); err != nil {
				t.Fatalf("Apply: %v", err)
			}

			recorded := calls()
			if len(recorded) != 1 {
				t.Fatalf("peticiones=%d, se esperaba 1", len(recorded))
			}
			if recorded[0].body != testCase.wantBody {
				t.Fatalf("cuerpo=%q, se esperaba %q", recorded[0].body, testCase.wantBody)
			}
			if !testCase.wantPayLoad {
				if recorded[0].contentType != "" {
					t.Fatalf("Content-Type inesperado sin importe: %q", recorded[0].contentType)
				}
				return
			}

			var payload map[string]any
			if err := json.Unmarshal([]byte(recorded[0].body), &payload); err != nil {
				t.Fatalf("cuerpo JSON inválido: %v", err)
			}
			if _, ok := payload["amount"].(string); !ok {
				t.Fatalf("amount no es string JSON: %#v", payload["amount"])
			}
		})
	}
}

func TestMutationClientPreservesExactPrecision(t *testing.T) {
	server, calls := newMutationRecorder(t, http.StatusOK, `{"status":"ok"}`)

	client := NewMutationClient(server.URL, "test-token")
	client.Enable()

	amount := decimal.MustParse("0.000000001")
	if _, err := client.Apply(context.Background(), mutationOfferUUID, &amount); err != nil {
		t.Fatalf("Apply: %v", err)
	}
	recorded := calls()
	if len(recorded) != 1 {
		t.Fatalf("peticiones=%d, se esperaba 1", len(recorded))
	}
	if recorded[0].body != `{"amount":"0.000000001"}` {
		t.Fatalf("cuerpo=%q", recorded[0].body)
	}
}

func TestMutationClientHTTPError(t *testing.T) {
	const token = "super-secret-token"
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Retry-After", "7")
		w.WriteHeader(http.StatusConflict)
		io.WriteString(w, `{"error":"oferta contendida para `+token+`"}`)
	}))
	t.Cleanup(server.Close)

	client := NewMutationClient(server.URL, token)
	client.Enable()

	_, err := client.Apply(context.Background(), mutationOfferUUID, nil)
	if err == nil {
		t.Fatal("se esperaba error HTTP")
	}
	var mutationErr *MutationError
	if !errors.As(err, &mutationErr) {
		t.Fatalf("error no tipado: %T %v", err, err)
	}
	if mutationErr.Status != http.StatusConflict {
		t.Fatalf("status=%d, se esperaba 409", mutationErr.Status)
	}
	if mutationErr.RetryAfter != 7*time.Second {
		t.Fatalf("RetryAfter=%v, se esperaba 7s", mutationErr.RetryAfter)
	}
	if strings.Contains(mutationErr.Body, token) || strings.Contains(err.Error(), token) {
		t.Fatalf("el error filtró el token: %q", err.Error())
	}
	if !strings.Contains(mutationErr.Body, "[redacted]") {
		t.Fatalf("cuerpo sin redactar: %q", mutationErr.Body)
	}
}

func TestMutationClientErrorBodyIsBounded(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
		io.WriteString(w, strings.Repeat("x", 4096))
	}))
	t.Cleanup(server.Close)

	client := NewMutationClient(server.URL, "test-token")
	client.Enable()

	_, err := client.Cancel(context.Background(), mutationOfferUUID, "")
	var mutationErr *MutationError
	if !errors.As(err, &mutationErr) {
		t.Fatalf("error no tipado: %T %v", err, err)
	}
	if len(mutationErr.Body) != int(maxMutationErrorBytes) {
		t.Fatalf("cuerpo=%d bytes, se esperaban %d", len(mutationErr.Body), maxMutationErrorBytes)
	}
}

func TestMutationClientTimeout(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		<-r.Context().Done()
	}))
	t.Cleanup(server.Close)

	client := NewMutationClient(server.URL, "test-token")
	client.HTTP = &http.Client{Timeout: 30 * time.Millisecond}
	client.Enable()

	_, err := client.Apply(context.Background(), mutationOfferUUID, nil)
	if err == nil {
		t.Fatal("se esperaba timeout")
	}
	var connectionErr *ConnectionError
	if !errors.As(err, &connectionErr) {
		t.Fatalf("error no tipado: %T %v", err, err)
	}
	if connectionErr.Reason != "timeout" {
		t.Fatalf("reason=%q, se esperaba timeout", connectionErr.Reason)
	}
}

func TestMutationClientValidationDoesNotDispatch(t *testing.T) {
	var hits int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&hits, 1)
	}))
	t.Cleanup(server.Close)

	valid := NewMutationClient(server.URL, "test-token")
	valid.Enable()
	ctx := context.Background()

	invalidUUIDs := []string{
		"",
		"not-a-uuid",
		"7c9e6679-7425-40de-944b-e07fc1f90ae",
		"7c9e6679-7425-40de-944b-e07fc1f90ae7z",
		"../../user",
		mutationOfferUUID + "/apply",
	}
	for _, uuid := range invalidUUIDs {
		if _, err := valid.Apply(ctx, uuid, nil); !errors.Is(err, ErrInvalidUUID) {
			t.Errorf("Apply(%q): err=%v, se esperaba ErrInvalidUUID", uuid, err)
		}
	}
	if _, err := valid.Cancel(ctx, mutationOfferUUID, "not-a-uuid"); !errors.Is(err, ErrInvalidUUID) {
		t.Errorf("Cancel con orden inválido: err=%v", err)
	}

	withoutToken := NewMutationClient(server.URL, "  ")
	withoutToken.Enable()
	if _, err := withoutToken.Apply(ctx, mutationOfferUUID, nil); !errors.Is(err, ErrMissingToken) {
		t.Errorf("Apply sin token: err=%v", err)
	}
	if _, err := withoutToken.Cancel(ctx, mutationOfferUUID, mutationOrderUUID); !errors.Is(err, ErrMissingToken) {
		t.Errorf("Cancel sin token: err=%v", err)
	}

	if got := atomic.LoadInt32(&hits); got != 0 {
		t.Fatalf("se enviaron %d peticiones inválidas", got)
	}
}

func TestMutationClientRejectsInvalidBaseURL(t *testing.T) {
	client := NewMutationClient("ftp://example.com", "test-token")
	client.Enable()
	if _, err := client.Apply(context.Background(), mutationOfferUUID, nil); err == nil {
		t.Fatal("se esperaba error por BaseURL no http/https")
	}
}

func TestMutationClientResponseLimit(t *testing.T) {
	t.Run("exactamente 8 KiB", func(t *testing.T) {
		prefix := `{"status":"`
		suffix := `"}`
		body := prefix + strings.Repeat("x", int(MaxMutationResponseBytes)-len(prefix)-len(suffix)) + suffix
		if int64(len(body)) != MaxMutationResponseBytes {
			t.Fatalf("cuerpo de prueba=%d, se esperaban %d", len(body), MaxMutationResponseBytes)
		}

		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			io.WriteString(w, body)
		}))
		t.Cleanup(server.Close)

		client := NewMutationClient(server.URL, "test-token")
		client.Enable()
		result, err := client.Cancel(context.Background(), mutationOfferUUID, "")
		if err != nil {
			t.Fatalf("Cancel: %v", err)
		}
		if int64(len(result.Body)) != MaxMutationResponseBytes {
			t.Fatalf("respuesta=%d bytes", len(result.Body))
		}
	})

	t.Run("por encima de 8 KiB", func(t *testing.T) {
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			io.WriteString(w, strings.Repeat("x", int(MaxMutationResponseBytes)+1))
		}))
		t.Cleanup(server.Close)

		client := NewMutationClient(server.URL, "test-token")
		client.Enable()
		_, err := client.Cancel(context.Background(), mutationOfferUUID, "")
		if err == nil || !strings.Contains(err.Error(), "demasiado grande") {
			t.Fatalf("err=%v, se esperaba respuesta demasiado grande", err)
		}
	})
}

func TestMutationClientEnableDisable(t *testing.T) {
	client := NewMutationClient("http://127.0.0.1:1", "test-token")
	client.Enable()
	if !client.Enabled {
		t.Fatal("Enable no habilitó el cliente")
	}
	client.Disable()
	if client.Enabled {
		t.Fatal("Disable no deshabilitó el cliente")
	}
	if _, err := client.Apply(context.Background(), mutationOfferUUID, nil); !errors.Is(err, ErrMutationsDisabled) {
		t.Fatalf("err=%v, se esperaba ErrMutationsDisabled", err)
	}
}

func TestMutationClientHasNoUnsupportedMutations(t *testing.T) {
	clientType := reflect.TypeOf((*MutationClient)(nil))
	want := map[string]bool{
		"Apply":           true,
		"Cancel":          true,
		"ConfirmReceived": true,
		"CreateOffer":     true,
		"Disable":         true,
		"EditOffer":       true,
		"Enable":          true,
		"MarkPaid":        true,
	}
	got := make(map[string]bool, clientType.NumMethod())
	for index := 0; index < clientType.NumMethod(); index++ {
		got[clientType.Method(index).Name] = true
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("API exportada inesperada: %v", got)
	}
}

func decimalValue(text string) *decimal.Value {
	value := decimal.MustParse(text)
	return &value
}

func TestMutationClientCreateOffer(t *testing.T) {
	server, calls := newMutationRecorder(t, http.StatusCreated, `{"p2p":{"uuid":"`+mutationOfferUUID+`"}}`)
	client := NewMutationClient(server.URL, "token")
	client.Enable()

	payload := map[string]any{
		"type": "sell", "coin": "CLASICA", "amount": 10, "receive": 11,
		"details":         []map[string]string{{"name": "Cuenta", "value": "123"}},
		"idempotency_key": "idem-1",
	}
	result, err := client.CreateOffer(context.Background(), payload)
	if err != nil {
		t.Fatalf("CreateOffer: %v", err)
	}
	if result.StatusCode != http.StatusCreated || !strings.Contains(string(result.Body), mutationOfferUUID) {
		t.Fatalf("resultado = %+v", result)
	}
	recorded := calls()
	if len(recorded) != 1 || recorded[0].path != "/p2p/create" || recorded[0].method != http.MethodPost {
		t.Fatalf("llamadas = %+v", recorded)
	}
	if !strings.Contains(recorded[0].body, `"idempotency_key":"idem-1"`) {
		t.Fatalf("cuerpo = %s", recorded[0].body)
	}
	if recorded[0].contentType != "application/json" {
		t.Fatalf("Content-Type = %q", recorded[0].contentType)
	}
}

func TestMutationClientEditOffer(t *testing.T) {
	server, calls := newMutationRecorder(t, http.StatusOK, `{"p2p":{"uuid":"`+mutationOfferUUID+`"}}`)
	client := NewMutationClient(server.URL, "token")
	client.Enable()

	if _, err := client.EditOffer(context.Background(), mutationOfferUUID, map[string]any{"amount": 5, "rate": 1.1}); err != nil {
		t.Fatalf("EditOffer: %v", err)
	}
	recorded := calls()
	if len(recorded) != 1 || recorded[0].path != "/p2p/"+mutationOfferUUID+"/edit" {
		t.Fatalf("llamadas = %+v", recorded)
	}
	if recorded[0].body != `{"amount":5,"rate":1.1}` {
		t.Fatalf("cuerpo = %s", recorded[0].body)
	}
}

func TestMutationClientMarkPaid(t *testing.T) {
	server, calls := newMutationRecorder(t, http.StatusOK, `{}`)
	client := NewMutationClient(server.URL, "token")
	client.Enable()

	if _, err := client.MarkPaid(context.Background(), mutationOfferUUID, mutationOrderUUID, "ref-123"); err != nil {
		t.Fatalf("MarkPaid: %v", err)
	}
	recorded := calls()
	if len(recorded) != 1 || recorded[0].path != "/p2p/"+mutationOfferUUID+"/paid" {
		t.Fatalf("llamadas = %+v", recorded)
	}
	if recorded[0].query != "order="+mutationOrderUUID {
		t.Fatalf("query = %q", recorded[0].query)
	}
	if recorded[0].body != `{"tx_id":"ref-123"}` {
		t.Fatalf("cuerpo = %s", recorded[0].body)
	}
}

func TestMutationClientConfirmReceived(t *testing.T) {
	server, calls := newMutationRecorder(t, http.StatusOK, `{}`)
	client := NewMutationClient(server.URL, "token")
	client.Enable()

	if _, err := client.ConfirmReceived(context.Background(), mutationOfferUUID, mutationOrderUUID); err != nil {
		t.Fatalf("ConfirmReceived: %v", err)
	}
	recorded := calls()
	if len(recorded) != 1 || recorded[0].path != "/p2p/"+mutationOfferUUID+"/received" {
		t.Fatalf("llamadas = %+v", recorded)
	}
	if recorded[0].body != "" || recorded[0].contentType != "" {
		t.Fatalf("cuerpo inesperado: %+v", recorded[0])
	}
}
