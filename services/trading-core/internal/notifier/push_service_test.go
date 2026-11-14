package notifier

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

const pushServiceTestToken = "token-interno-push-send"

var errPushServiceTestStore = errors.New("fallo de almacén simulado")

// fakePushSender registra los envíos y permite fallar por endpoint.
type fakePushSender struct {
	mu      sync.Mutex
	calls   []PushSubscription
	payload [][]byte
	fail    map[string]error
}

func (sender *fakePushSender) Send(
	_ context.Context,
	subscription PushSubscription,
	payload []byte,
) error {
	sender.mu.Lock()
	defer sender.mu.Unlock()
	sender.calls = append(sender.calls, subscription)
	sender.payload = append(sender.payload, append([]byte(nil), payload...))
	if err := sender.fail[subscription.Endpoint]; err != nil {
		return err
	}
	return nil
}

func (sender *fakePushSender) snapshot() ([]PushSubscription, [][]byte) {
	sender.mu.Lock()
	defer sender.mu.Unlock()
	calls := append([]PushSubscription(nil), sender.calls...)
	payloads := make([][]byte, len(sender.payload))
	for index, payload := range sender.payload {
		payloads[index] = append([]byte(nil), payload...)
	}
	return calls, payloads
}

// fakePushServiceStore devuelve las suscripciones configuradas sin aplicar el
// límite, para comprobar que el servicio lo respeta por su cuenta.
type fakePushServiceStore struct {
	mu            sync.Mutex
	subscriptions []PushSubscription
	listCalls     int
	listLimit     int
	listNow       time.Time
	listErr       error
}

func (store *fakePushServiceStore) Upsert(
	_ context.Context,
	_ PushSubscription,
	_, _ time.Time,
) error {
	return nil
}

func (store *fakePushServiceStore) Delete(_ context.Context, _ string) (bool, error) {
	return false, nil
}

func (store *fakePushServiceStore) List(
	_ context.Context,
	now time.Time,
	limit int,
) ([]PushSubscription, error) {
	store.mu.Lock()
	defer store.mu.Unlock()
	store.listCalls++
	store.listLimit = limit
	store.listNow = now
	if store.listErr != nil {
		return nil, store.listErr
	}
	return append([]PushSubscription(nil), store.subscriptions...), nil
}

func (store *fakePushServiceStore) Count(_ context.Context, _ time.Time) (int, error) {
	store.mu.Lock()
	defer store.mu.Unlock()
	return len(store.subscriptions), nil
}

func (store *fakePushServiceStore) snapshot() (calls, limit int, now time.Time) {
	store.mu.Lock()
	defer store.mu.Unlock()
	return store.listCalls, store.listLimit, store.listNow
}

func pushServiceSubscriptions(count int) []PushSubscription {
	subscriptions := make([]PushSubscription, 0, count)
	for index := 0; index < count; index++ {
		subscriptions = append(subscriptions, PushSubscription{
			Endpoint: "https://push.example/sub-" + string(rune('a'+index)),
			P256DH:   "p256dh-de-prueba",
			Auth:     "auth-de-prueba",
		})
	}
	return subscriptions
}

func newPushService(sender PushSender, store PushSubscriptionStore) *PushService {
	return &PushService{
		Sender: sender,
		Store:  store,
		Now: func() time.Time {
			return time.Date(2026, 11, 14, 12, 0, 0, 0, time.UTC)
		},
	}
}

func servePushService(
	t *testing.T,
	service *PushService,
	method, target, body, token string,
) *httptest.ResponseRecorder {
	t.Helper()
	request := httptest.NewRequest(method, target, strings.NewReader(body))
	if body == "" {
		request.Body = http.NoBody
	}
	if token != "" {
		request.Header.Set("X-Notifier-Token", token)
	}
	recorder := httptest.NewRecorder()
	service.ServeHTTP(recorder, request)
	return recorder
}

func decodePushSendResponse(
	t *testing.T,
	response *httptest.ResponseRecorder,
) map[string]any {
	t.Helper()
	if contentType := response.Header().Get("Content-Type"); contentType != "application/json; charset=utf-8" {
		t.Fatalf("Content-Type = %q, se esperaba JSON", contentType)
	}
	var payload map[string]any
	if err := json.Unmarshal(response.Body.Bytes(), &payload); err != nil {
		t.Fatalf("respuesta no JSON: %v: %s", err, response.Body)
	}
	return payload
}

func assertPushSendStatus(
	t *testing.T,
	response *httptest.ResponseRecorder,
	code int,
	status string,
) map[string]any {
	t.Helper()
	if response.Code != code {
		t.Fatalf("código = %d, se esperaba %d: %s", response.Code, code, response.Body)
	}
	payload := decodePushSendResponse(t, response)
	if payload["status"] != status {
		t.Fatalf("status = %v, se esperaba %q: %s", payload["status"], status, response.Body)
	}
	return payload
}

func pushSendBody(t *testing.T, payload string) string {
	t.Helper()
	encoded, err := json.Marshal(struct {
		Payload string `json:"payload"`
	}{Payload: payload})
	if err != nil {
		t.Fatalf("no se pudo serializar el cuerpo: %v", err)
	}
	return string(encoded)
}

func TestPushServiceSendAllDisabledDoesNotList(t *testing.T) {
	store := &fakePushServiceStore{subscriptions: pushServiceSubscriptions(1)}
	payload := []byte(`{"title":"hola"}`)

	t.Run("sender nil", func(t *testing.T) {
		service := newPushService(nil, store)
		sent, failed, disabled, err := service.SendAll(context.Background(), payload)
		if err != nil {
			t.Fatalf("SendAll devolvió error: %v", err)
		}
		if sent != 0 || failed != 0 || !disabled {
			t.Fatalf("sent=%d failed=%d disabled=%v, se esperaba 0/0/true",
				sent, failed, disabled)
		}
		if calls, _, _ := store.snapshot(); calls != 0 {
			t.Fatalf("el almacén se consultó %d veces con el sender nil", calls)
		}
	})

	t.Run("web push deshabilitado", func(t *testing.T) {
		sender := &WebPushSender{}
		service := newPushService(sender, store)
		sent, failed, disabled, err := service.SendAll(context.Background(), payload)
		if err != nil {
			t.Fatalf("SendAll devolvió error: %v", err)
		}
		if sent != 0 || failed != 0 || !disabled {
			t.Fatalf("sent=%d failed=%d disabled=%v, se esperaba 0/0/true",
				sent, failed, disabled)
		}
		if calls, _, _ := store.snapshot(); calls != 0 {
			t.Fatalf("el almacén se consultó %d veces con WebPushSender deshabilitado", calls)
		}
	})
}

func TestPushServiceSendAllWithoutSubscriptions(t *testing.T) {
	sender := &fakePushSender{}
	store := &fakePushServiceStore{}
	service := newPushService(sender, store)

	sent, failed, disabled, err := service.SendAll(context.Background(), []byte("hola"))
	if err != nil {
		t.Fatalf("SendAll devolvió error: %v", err)
	}
	if sent != 0 || failed != 0 || disabled {
		t.Fatalf("sent=%d failed=%d disabled=%v, se esperaba 0/0/false",
			sent, failed, disabled)
	}
	calls, limit, _ := store.snapshot()
	if calls != 1 {
		t.Fatalf("llamadas a List = %d, se esperaba 1", calls)
	}
	if limit != defaultPushMaxSubscriptions {
		t.Fatalf("límite de List = %d, se esperaba %d", limit, defaultPushMaxSubscriptions)
	}
	if senderCalls, _ := sender.snapshot(); len(senderCalls) != 0 {
		t.Fatalf("se enviaron %d pushes sin suscripciones", len(senderCalls))
	}
}

func TestPushServiceSendAllPartialFailure(t *testing.T) {
	subscriptions := pushServiceSubscriptions(3)
	payload := []byte(`{"title":"resultado"}`)
	sender := &fakePushSender{
		fail: map[string]error{subscriptions[1].Endpoint: errors.New("rechazado")},
	}
	service := newPushService(sender, &fakePushServiceStore{subscriptions: subscriptions})

	sent, failed, disabled, err := service.SendAll(context.Background(), payload)
	if err != nil {
		t.Fatalf("SendAll devolvió error: %v", err)
	}
	if sent != 2 || failed != 1 || disabled {
		t.Fatalf("sent=%d failed=%d disabled=%v, se esperaba 2/1/false",
			sent, failed, disabled)
	}

	calls, payloads := sender.snapshot()
	if len(calls) != len(subscriptions) {
		t.Fatalf("envíos = %d, se esperaba %d", len(calls), len(subscriptions))
	}
	for index, call := range calls {
		if call.Endpoint != subscriptions[index].Endpoint {
			t.Fatalf("envío %d a %q, se esperaba %q",
				index, call.Endpoint, subscriptions[index].Endpoint)
		}
		if string(payloads[index]) != string(payload) {
			t.Fatalf("payload %d alterado: %q", index, payloads[index])
		}
	}
}

func TestPushServiceSendAllLimitsSubscriptions(t *testing.T) {
	tests := []struct {
		name      string
		configure int
		wantLimit int
		wantSent  int
	}{
		{name: "por defecto", configure: 0, wantLimit: 500, wantSent: 5},
		{name: "negativo usa el valor por defecto", configure: -1, wantLimit: 500, wantSent: 5},
		{name: "personalizado", configure: 2, wantLimit: 2, wantSent: 2},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			store := &fakePushServiceStore{subscriptions: pushServiceSubscriptions(5)}
			sender := &fakePushSender{}
			service := newPushService(sender, store)
			service.MaxSubscriptions = test.configure

			sent, failed, disabled, err := service.SendAll(context.Background(), []byte("x"))
			if err != nil {
				t.Fatalf("SendAll devolvió error: %v", err)
			}
			if sent != test.wantSent || failed != 0 || disabled {
				t.Fatalf("sent=%d failed=%d disabled=%v, se esperaba %d/0/false",
					sent, failed, disabled, test.wantSent)
			}
			if len(store.subscriptions) > test.wantSent {
				calls, _ := sender.snapshot()
				if len(calls) != test.wantSent {
					t.Fatalf("envíos = %d, se esperaba %d", len(calls), test.wantSent)
				}
			}
			_, limit, _ := store.snapshot()
			if limit != test.wantLimit {
				t.Fatalf("límite de List = %d, se esperaba %d", limit, test.wantLimit)
			}
		})
	}
}

func TestPushServiceSendAllStoreError(t *testing.T) {
	store := &fakePushServiceStore{listErr: errPushServiceTestStore}
	sender := &fakePushSender{}
	service := newPushService(sender, store)

	sent, failed, disabled, err := service.SendAll(context.Background(), []byte("x"))
	if !errors.Is(err, errPushServiceTestStore) {
		t.Fatalf("error = %v, se esperaba el fallo del almacén", err)
	}
	if sent != 0 || failed != 0 || disabled {
		t.Fatalf("sent=%d failed=%d disabled=%v, se esperaba 0/0/false",
			sent, failed, disabled)
	}
	if calls, _ := sender.snapshot(); len(calls) != 0 {
		t.Fatalf("se enviaron %d pushes pese al error del almacén", len(calls))
	}
}

func TestPushServiceSendAllValidatesPayloadBeforeDisabled(t *testing.T) {
	service := newPushService(nil, &fakePushServiceStore{})

	for name, payload := range map[string][]byte{
		"vacío":     {},
		"demasiado": bytesOfLength(maxPushSendPayload + 1),
	} {
		t.Run(name, func(t *testing.T) {
			_, _, disabled, err := service.SendAll(context.Background(), payload)
			if err == nil {
				t.Fatal("SendAll aceptó un payload inválido")
			}
			if disabled {
				t.Fatal("SendAll marcó disabled antes de validar el payload")
			}
		})
	}
}

func bytesOfLength(length int) []byte {
	payload := make([]byte, length)
	for index := range payload {
		payload[index] = 'a'
	}
	return payload
}

func TestPushServiceHTTPRequiresInternalToken(t *testing.T) {
	store := &fakePushServiceStore{subscriptions: pushServiceSubscriptions(1)}
	sender := &fakePushSender{}
	service := newPushService(sender, store)
	service.InternalToken = pushServiceTestToken
	body := pushSendBody(t, "hola")

	for name, token := range map[string]string{
		"sin token":        "",
		"token incorrecto": "otro-token",
	} {
		t.Run(name, func(t *testing.T) {
			response := servePushService(t, service, http.MethodPost, pushSendPath, body, token)
			assertPushSendStatus(t, response, http.StatusUnauthorized, "unauthorized")
		})
	}

	if calls, _, _ := store.snapshot(); calls != 0 {
		t.Fatalf("el almacén se consultó %d veces sin autorización", calls)
	}
	if calls, _ := sender.snapshot(); len(calls) != 0 {
		t.Fatalf("se enviaron %d pushes sin autorización", len(calls))
	}

	response := servePushService(t, service, http.MethodPost, pushSendPath, body,
		pushServiceTestToken)
	if response.Code != http.StatusAccepted {
		t.Fatalf("código = %d, se esperaba 202: %s", response.Code, response.Body)
	}
}

func TestPushServiceHTTPInvalidPayload(t *testing.T) {
	sender := &fakePushSender{}
	store := &fakePushServiceStore{subscriptions: pushServiceSubscriptions(1)}
	service := newPushService(sender, store)

	tests := []struct {
		name     string
		body     string
		wantCode int
		status   string
	}{
		{name: "vacío", body: `{"payload":""}`, wantCode: http.StatusBadRequest, status: "invalid_payload"},
		{
			name:     "demasiado grande",
			body:     pushSendBody(t, string(bytesOfLength(maxPushSendPayload+1))),
			wantCode: http.StatusBadRequest,
			status:   "invalid_payload",
		},
		{
			name:     "json inválido",
			body:     `{"payload":`,
			wantCode: http.StatusBadRequest,
			status:   "invalid_body",
		},
		{
			name:     "campo desconocido con segundo valor",
			body:     `{"payload":"hola"} {"payload":"otra"}`,
			wantCode: http.StatusBadRequest,
			status:   "invalid_body",
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			response := servePushService(t, service, http.MethodPost, pushSendPath,
				test.body, "")
			assertPushSendStatus(t, response, test.wantCode, test.status)
		})
	}

	if calls, _ := sender.snapshot(); len(calls) != 0 {
		t.Fatalf("se enviaron %d pushes con payload inválido", len(calls))
	}
	if calls, _, _ := store.snapshot(); calls != 0 {
		t.Fatalf("el almacén se consultó %d veces con payload inválido", calls)
	}
}

func TestPushServiceHTTPPayloadBoundary(t *testing.T) {
	sender := &fakePushSender{}
	store := &fakePushServiceStore{subscriptions: pushServiceSubscriptions(1)}
	service := newPushService(sender, store)

	response := servePushService(t, service, http.MethodPost, pushSendPath,
		pushSendBody(t, string(bytesOfLength(maxPushSendPayload))), "")
	if response.Code != http.StatusAccepted {
		t.Fatalf("payload de %d bytes: código = %d, se esperaba 202: %s",
			maxPushSendPayload, response.Code, response.Body)
	}
}

func TestPushServiceHTTPMethodAndPath(t *testing.T) {
	service := newPushService(nil, &fakePushServiceStore{})

	tests := []struct {
		name     string
		method   string
		target   string
		wantCode int
		status   string
	}{
		{name: "get", method: http.MethodGet, target: pushSendPath, wantCode: http.StatusMethodNotAllowed, status: "method_not_allowed"},
		{name: "put", method: http.MethodPut, target: pushSendPath, wantCode: http.StatusMethodNotAllowed, status: "method_not_allowed"},
		{name: "ruta desconocida", method: http.MethodPost, target: "/push/send/otra", wantCode: http.StatusNotFound, status: "not_found"},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			response := servePushService(t, service, test.method, test.target, "", "")
			assertPushSendStatus(t, response, test.wantCode, test.status)
			if test.wantCode == http.StatusMethodNotAllowed {
				if allow := response.Header().Get("Allow"); allow != http.MethodPost {
					t.Fatalf("Allow = %q, se esperaba POST", allow)
				}
			}
		})
	}
}

func TestPushServiceHTTPDisabledWithoutSender(t *testing.T) {
	store := &fakePushServiceStore{subscriptions: pushServiceSubscriptions(1)}
	service := newPushService(nil, store)

	response := servePushService(t, service, http.MethodPost, pushSendPath,
		pushSendBody(t, "hola"), "")
	if response.Code != http.StatusAccepted {
		t.Fatalf("código = %d, se esperaba 202: %s", response.Code, response.Body)
	}
	payload := decodePushSendResponse(t, response)
	if payload["disabled"] != true {
		t.Fatalf("disabled = %v, se esperaba true", payload["disabled"])
	}
	if payload["sent"] != float64(0) || payload["failed"] != float64(0) {
		t.Fatalf("sent=%v failed=%v, se esperaba 0/0", payload["sent"], payload["failed"])
	}
	if calls, _, _ := store.snapshot(); calls != 0 {
		t.Fatalf("el almacén se consultó %d veces sin sender", calls)
	}
}

func TestPushServiceHTTPReportsCounters(t *testing.T) {
	subscriptions := pushServiceSubscriptions(3)
	sender := &fakePushSender{
		fail: map[string]error{subscriptions[2].Endpoint: errors.New("rechazado")},
	}
	store := &fakePushServiceStore{subscriptions: subscriptions}
	service := newPushService(sender, store)
	service.InternalToken = pushServiceTestToken

	response := servePushService(t, service, http.MethodPost, pushSendPath,
		pushSendBody(t, "hola"), pushServiceTestToken)
	if response.Code != http.StatusAccepted {
		t.Fatalf("código = %d, se esperaba 202: %s", response.Code, response.Body)
	}
	payload := decodePushSendResponse(t, response)
	if payload["sent"] != float64(2) || payload["failed"] != float64(1) {
		t.Fatalf("sent=%v failed=%v, se esperaba 2/1", payload["sent"], payload["failed"])
	}
	if payload["disabled"] != false {
		t.Fatalf("disabled = %v, se esperaba false", payload["disabled"])
	}
}

func TestPushServiceHTTPStoreUnavailable(t *testing.T) {
	tests := []struct {
		name   string
		store  PushSubscriptionStore
		status string
	}{
		{name: "sin almacén", store: nil, status: "not_configured"},
		{name: "fallo del almacén", store: &fakePushServiceStore{listErr: errPushServiceTestStore}, status: "internal_error"},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			service := newPushService(&fakePushSender{}, test.store)
			response := servePushService(t, service, http.MethodPost, pushSendPath,
				pushSendBody(t, "hola"), "")
			assertPushSendStatus(t, response, http.StatusServiceUnavailable, test.status)
		})
	}
}

func TestPushServiceHTTPBodyTooLarge(t *testing.T) {
	sender := &fakePushSender{}
	service := newPushService(sender, &fakePushServiceStore{})
	body := pushSendBody(t, string(bytesOfLength(maxPushSubscriptionBody)))

	response := servePushService(t, service, http.MethodPost, pushSendPath, body, "")
	assertPushSendStatus(t, response, http.StatusRequestEntityTooLarge, "payload_too_large")
	if calls, _ := sender.snapshot(); len(calls) != 0 {
		t.Fatalf("se enviaron %d pushes con cuerpo demasiado grande", len(calls))
	}
}
