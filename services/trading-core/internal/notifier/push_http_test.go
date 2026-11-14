package notifier

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"
)

const (
	pushAPITestToken  = "token-interno-push-super-secreto"
	pushAPITestSecret = "clave-que-nunca-debe-salir"
)

// pushAPIStore es un almacén falso que registra las llamadas del handler.
type pushAPIStore struct {
	mu          sync.Mutex
	data        map[string]PushSubscription
	upserts     int
	deletes     []string
	lastNow     time.Time
	lastExpires time.Time
	listLimit   int
	err         error
}

func newPushAPIStore(subscriptions ...PushSubscription) *pushAPIStore {
	store := &pushAPIStore{data: make(map[string]PushSubscription)}
	for _, subscription := range subscriptions {
		store.data[subscription.Endpoint] = subscription
	}
	return store
}

func (store *pushAPIStore) Upsert(
	_ context.Context,
	subscription PushSubscription,
	now time.Time,
	expiresAt time.Time,
) error {
	store.mu.Lock()
	defer store.mu.Unlock()
	if store.err != nil {
		return store.err
	}
	store.upserts++
	store.lastNow = now
	store.lastExpires = expiresAt
	store.data[subscription.Endpoint] = subscription
	return nil
}

func (store *pushAPIStore) Delete(_ context.Context, endpoint string) (bool, error) {
	store.mu.Lock()
	defer store.mu.Unlock()
	if store.err != nil {
		return false, store.err
	}
	store.deletes = append(store.deletes, endpoint)
	if _, exists := store.data[endpoint]; !exists {
		return false, nil
	}
	delete(store.data, endpoint)
	return true, nil
}

func (store *pushAPIStore) List(
	_ context.Context,
	_ time.Time,
	limit int,
) ([]PushSubscription, error) {
	store.mu.Lock()
	defer store.mu.Unlock()
	if store.err != nil {
		return nil, store.err
	}
	store.listLimit = limit
	subscriptions := make([]PushSubscription, 0, len(store.data))
	for _, subscription := range store.data {
		subscriptions = append(subscriptions, subscription)
	}
	sort.Slice(subscriptions, func(left, right int) bool {
		return subscriptions[left].Endpoint < subscriptions[right].Endpoint
	})
	return subscriptions, nil
}

func (store *pushAPIStore) Count(_ context.Context, _ time.Time) (int, error) {
	store.mu.Lock()
	defer store.mu.Unlock()
	if store.err != nil {
		return 0, store.err
	}
	return len(store.data), nil
}

func (store *pushAPIStore) snapshot() (int, []string, time.Time, time.Time) {
	store.mu.Lock()
	defer store.mu.Unlock()
	deletes := append([]string(nil), store.deletes...)
	return store.upserts, deletes, store.lastNow, store.lastExpires
}

func servePushAPI(
	t *testing.T,
	api *PushAPI,
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
	api.ServeHTTP(recorder, request)
	return recorder
}

func decodePushJSONResponse(
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

func assertPushStatus(
	t *testing.T,
	response *httptest.ResponseRecorder,
	code int,
	status string,
) map[string]any {
	t.Helper()
	if response.Code != code {
		t.Fatalf("código = %d, se esperaba %d: %s", response.Code, code, response.Body)
	}
	payload := decodePushJSONResponse(t, response)
	if payload["status"] != status {
		t.Fatalf("status = %v, se esperaba %q: %s", payload["status"], status, response.Body)
	}
	return payload
}

func assertPushResponseHidesSubscription(
	t *testing.T,
	response *httptest.ResponseRecorder,
	subscription PushSubscription,
) {
	t.Helper()
	body := response.Body.String()
	for name, value := range map[string]string{
		"endpoint": subscription.Endpoint,
		"p256dh":   subscription.P256DH,
		"auth":     subscription.Auth,
		"label":    subscription.Label,
	} {
		if value != "" && strings.Contains(body, value) {
			t.Fatalf("la respuesta expone %s: %s", name, body)
		}
	}
}

func TestPushAPIMutationsRequireInternalToken(t *testing.T) {
	subscription := validPushSubscription()
	payload, err := json.Marshal(subscription)
	if err != nil {
		t.Fatal(err)
	}

	for _, test := range []struct {
		name   string
		method string
		target string
		body   string
		token  string
	}{
		{
			name:   "POST sin token",
			method: http.MethodPost,
			target: pushSubscriptionsPath,
			body:   string(payload),
		},
		{
			name:   "POST con token incorrecto",
			method: http.MethodPost,
			target: pushSubscriptionsPath,
			body:   string(payload),
			token:  "otro-token",
		},
		{
			name:   "DELETE sin token",
			method: http.MethodDelete,
			target: pushSubscriptionsPath + "?endpoint=" + url.QueryEscape(subscription.Endpoint),
			token:  "",
		},
		{
			name:   "DELETE con token incorrecto",
			method: http.MethodDelete,
			target: pushSubscriptionsPath + "?endpoint=" + url.QueryEscape(subscription.Endpoint),
			token:  "otro-token",
		},
	} {
		t.Run(test.name, func(t *testing.T) {
			store := newPushAPIStore(subscription)
			api := &PushAPI{Store: store, InternalToken: pushAPITestToken}
			response := servePushAPI(t, api, test.method, test.target, test.body, test.token)
			assertPushStatus(t, response, http.StatusUnauthorized, "unauthorized")

			upserts, deletes, _, _ := store.snapshot()
			if upserts != 0 || len(deletes) != 0 {
				t.Fatalf("una petición no autorizada tocó el store: %d, %v", upserts, deletes)
			}
		})
	}
}

func TestPushAPIPostAccepted(t *testing.T) {
	subscription := validPushSubscription()
	now := time.Date(2026, 11, 14, 12, 0, 0, 0, time.UTC)
	store := newPushAPIStore()
	api := &PushAPI{
		Store:         store,
		InternalToken: pushAPITestToken,
		Now:           func() time.Time { return now },
	}

	for _, test := range []struct {
		name    string
		payload string
	}{
		{
			name: "campos Go",
			payload: func() string {
				raw, err := json.Marshal(subscription)
				if err != nil {
					t.Fatal(err)
				}
				return string(raw)
			}(),
		},
		{
			name: "campos minúsculas",
			payload: fmt.Sprintf(
				`{"endpoint":%q,"p256dh":%q,"auth":%q,"label":%q}`,
				subscription.Endpoint, subscription.P256DH,
				subscription.Auth, subscription.Label,
			),
		},
	} {
		t.Run(test.name, func(t *testing.T) {
			store := newPushAPIStore()
			api.Store = store
			response := servePushAPI(t, api, http.MethodPost, pushSubscriptionsPath,
				test.payload, pushAPITestToken)
			assertPushStatus(t, response, http.StatusAccepted, "accepted")
			assertPushResponseHidesSubscription(t, response, subscription)

			upserts, _, storedNow, expiresAt := store.snapshot()
			if upserts != 1 {
				t.Fatalf("upserts = %d, quiero 1", upserts)
			}
			if !storedNow.Equal(now) {
				t.Fatalf("now = %v, quiero %v", storedNow, now)
			}
			if want := now.Add(pushSubscriptionTTL); !expiresAt.Equal(want) {
				t.Fatalf("expiresAt = %v, quiero %v", expiresAt, want)
			}
		})
	}
}

func TestPushAPIPostRejectsInvalidBody(t *testing.T) {
	valid := validPushSubscription()
	shortKey := valid
	shortKey.P256DH = pushTestKey(8)
	badEndpoint := valid
	badEndpoint.Endpoint = "http://push.example/subscriptions/abc"
	longLabel := valid
	longLabel.Label = strings.Repeat("á", maxPushLabel+1)

	tests := []struct {
		name string
		body string
	}{
		{name: "cuerpo vacío", body: ""},
		{name: "JSON inválido", body: `{"endpoint":`},
		{name: "datos extra", body: `{"endpoint":"https://push.example/a"} {}`},
		{name: "sin endpoint", body: mustJSON(t, PushSubscription{
			P256DH: valid.P256DH, Auth: valid.Auth,
		})},
		{name: "endpoint http remoto", body: mustJSON(t, badEndpoint)},
		{name: "p256dh corta", body: mustJSON(t, shortKey)},
		{name: "auth inválido", body: mustJSON(t, PushSubscription{
			Endpoint: valid.Endpoint, P256DH: valid.P256DH, Auth: "no-es-base64url!",
		})},
		{name: "etiqueta larga", body: mustJSON(t, longLabel)},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			store := newPushAPIStore()
			api := &PushAPI{Store: store, InternalToken: pushAPITestToken}
			response := servePushAPI(t, api, http.MethodPost, pushSubscriptionsPath,
				test.body, pushAPITestToken)
			if response.Code != http.StatusBadRequest {
				t.Fatalf("código = %d, se esperaba 400: %s", response.Code, response.Body)
			}
			decodePushJSONResponse(t, response)
			assertPushResponseHidesSubscription(t, response, valid)

			upserts, _, _, _ := store.snapshot()
			if upserts != 0 {
				t.Fatalf("un cuerpo inválido llegó al store: %d", upserts)
			}
		})
	}
}

func TestPushAPIPostRejectsTooLargeBody(t *testing.T) {
	subscription := validPushSubscription()
	validJSON := mustJSON(t, subscription)

	tests := []struct {
		name string
		body string
	}{
		{
			name: "JSON válido con relleno",
			body: validJSON + strings.Repeat(" ", maxPushSubscriptionBody),
		},
		{
			name: "campo gigante",
			body: fmt.Sprintf(`{"endpoint":%q,"p256dh":%q,"auth":%q,"label":%q}`,
				subscription.Endpoint, strings.Repeat("a", maxPushSubscriptionBody),
				subscription.Auth, subscription.Label),
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			store := newPushAPIStore()
			api := &PushAPI{Store: store, InternalToken: pushAPITestToken}
			response := servePushAPI(t, api, http.MethodPost, pushSubscriptionsPath,
				test.body, pushAPITestToken)
			assertPushStatus(t, response, http.StatusRequestEntityTooLarge, "payload_too_large")

			upserts, _, _, _ := store.snapshot()
			if upserts != 0 {
				t.Fatalf("un cuerpo demasiado grande llegó al store: %d", upserts)
			}
		})
	}
}

func TestPushAPIDelete(t *testing.T) {
	subscription := validPushSubscription()

	t.Run("por cuerpo", func(t *testing.T) {
		store := newPushAPIStore(subscription)
		api := &PushAPI{Store: store, InternalToken: pushAPITestToken}
		body := fmt.Sprintf(`{"endpoint":%q}`, subscription.Endpoint)
		response := servePushAPI(t, api, http.MethodDelete, pushSubscriptionsPath,
			body, pushAPITestToken)
		if response.Code != http.StatusNoContent {
			t.Fatalf("código = %d, se esperaba 204: %s", response.Code, response.Body)
		}
		if response.Body.Len() != 0 {
			t.Fatalf("204 con cuerpo: %s", response.Body)
		}
		_, deletes, _, _ := store.snapshot()
		if len(deletes) != 1 || deletes[0] != subscription.Endpoint {
			t.Fatalf("deletes = %v", deletes)
		}
	})

	t.Run("por query", func(t *testing.T) {
		store := newPushAPIStore(subscription)
		api := &PushAPI{Store: store, InternalToken: pushAPITestToken}
		target := pushSubscriptionsPath + "?endpoint=" + url.QueryEscape(subscription.Endpoint)
		response := servePushAPI(t, api, http.MethodDelete, target, "", pushAPITestToken)
		if response.Code != http.StatusNoContent {
			t.Fatalf("código = %d, se esperaba 204: %s", response.Code, response.Body)
		}
		_, deletes, _, _ := store.snapshot()
		if len(deletes) != 1 || deletes[0] != subscription.Endpoint {
			t.Fatalf("deletes = %v", deletes)
		}
	})

	t.Run("cuerpo sin endpoint usa query", func(t *testing.T) {
		store := newPushAPIStore(subscription)
		api := &PushAPI{Store: store, InternalToken: pushAPITestToken}
		target := pushSubscriptionsPath + "?endpoint=" + url.QueryEscape(subscription.Endpoint)
		response := servePushAPI(t, api, http.MethodDelete, target, `{}`, pushAPITestToken)
		if response.Code != http.StatusNoContent {
			t.Fatalf("código = %d, se esperaba 204: %s", response.Code, response.Body)
		}
		_, deletes, _, _ := store.snapshot()
		if len(deletes) != 1 || deletes[0] != subscription.Endpoint {
			t.Fatalf("deletes = %v", deletes)
		}
	})

	t.Run("inexistente", func(t *testing.T) {
		store := newPushAPIStore()
		api := &PushAPI{Store: store, InternalToken: pushAPITestToken}
		body := fmt.Sprintf(`{"endpoint":%q}`, subscription.Endpoint)
		response := servePushAPI(t, api, http.MethodDelete, pushSubscriptionsPath,
			body, pushAPITestToken)
		assertPushStatus(t, response, http.StatusNotFound, "not_found")
		assertPushResponseHidesSubscription(t, response, subscription)
	})

	t.Run("sin endpoint", func(t *testing.T) {
		store := newPushAPIStore()
		api := &PushAPI{Store: store, InternalToken: pushAPITestToken}
		response := servePushAPI(t, api, http.MethodDelete, pushSubscriptionsPath,
			`{}`, pushAPITestToken)
		assertPushStatus(t, response, http.StatusBadRequest, "invalid_endpoint")
	})

	t.Run("JSON inválido", func(t *testing.T) {
		store := newPushAPIStore()
		api := &PushAPI{Store: store, InternalToken: pushAPITestToken}
		response := servePushAPI(t, api, http.MethodDelete, pushSubscriptionsPath,
			`{"endpoint":`, pushAPITestToken)
		assertPushStatus(t, response, http.StatusBadRequest, "invalid_body")
	})

	t.Run("datos extra", func(t *testing.T) {
		store := newPushAPIStore()
		api := &PushAPI{Store: store, InternalToken: pushAPITestToken}
		body := fmt.Sprintf(`{"endpoint":%q}{"endpoint":%q}`,
			subscription.Endpoint, subscription.Endpoint)
		response := servePushAPI(t, api, http.MethodDelete, pushSubscriptionsPath,
			body, pushAPITestToken)
		assertPushStatus(t, response, http.StatusBadRequest, "invalid_body")
	})

	t.Run("cuerpo demasiado grande", func(t *testing.T) {
		store := newPushAPIStore(subscription)
		api := &PushAPI{Store: store, InternalToken: pushAPITestToken}
		body := fmt.Sprintf(`{"endpoint":%q}`, subscription.Endpoint) +
			strings.Repeat(" ", maxPushSubscriptionBody)
		response := servePushAPI(t, api, http.MethodDelete, pushSubscriptionsPath,
			body, pushAPITestToken)
		assertPushStatus(t, response, http.StatusRequestEntityTooLarge, "payload_too_large")
		_, deletes, _, _ := store.snapshot()
		if len(deletes) != 0 {
			t.Fatalf("un cuerpo demasiado grande llegó al store: %v", deletes)
		}
	})
}

func TestPushAPIGetReturnsOnlyCount(t *testing.T) {
	first := validPushSubscription()
	second := validPushSubscription()
	second.Endpoint = "https://push.example/subscriptions/def"
	store := newPushAPIStore(first, second)
	api := &PushAPI{Store: store, InternalToken: pushAPITestToken}

	// GET no exige token y no debe listar endpoints ni claves.
	response := servePushAPI(t, api, http.MethodGet, pushSubscriptionsPath, "", "")
	if response.Code != http.StatusOK {
		t.Fatalf("código = %d, se esperaba 200: %s", response.Code, response.Body)
	}
	payload := decodePushJSONResponse(t, response)
	if payload["count"] != float64(2) {
		t.Fatalf("count = %v, quiero 2: %s", payload["count"], response.Body)
	}
	assertPushResponseHidesSubscription(t, response, first)
	assertPushResponseHidesSubscription(t, response, second)
	if _, exists := payload["subscriptions"]; exists {
		t.Fatalf("GET expuso listado: %s", response.Body)
	}
}

func TestPushAPIRouting(t *testing.T) {
	store := newPushAPIStore()
	api := &PushAPI{Store: store, InternalToken: pushAPITestToken}

	for _, method := range []string{
		http.MethodPut, http.MethodPatch, http.MethodHead, http.MethodOptions,
	} {
		t.Run(method, func(t *testing.T) {
			response := servePushAPI(t, api, method, pushSubscriptionsPath, "", "")
			if response.Code != http.StatusMethodNotAllowed {
				t.Fatalf("código = %d, se esperaba 405: %s", response.Code, response.Body)
			}
			if allow := response.Header().Get("Allow"); allow != pushSubscriptionsAllow {
				t.Fatalf("Allow = %q, se esperaba %q", allow, pushSubscriptionsAllow)
			}
			assertPushStatus(t, response, http.StatusMethodNotAllowed, "method_not_allowed")
		})
	}

	for _, test := range []struct {
		name   string
		method string
		path   string
	}{
		{name: "ruta desconocida", method: http.MethodGet, path: "/push/otra"},
		{name: "barra final", method: http.MethodGet, path: pushSubscriptionsPath + "/"},
		{name: "subruta", method: http.MethodPost, path: pushSubscriptionsPath + "/abc"},
	} {
		t.Run(test.name, func(t *testing.T) {
			response := servePushAPI(t, api, test.method, test.path, "", pushAPITestToken)
			assertPushStatus(t, response, http.StatusNotFound, "not_found")
		})
	}
}

func TestPushAPIStoreErrors(t *testing.T) {
	subscription := validPushSubscription()
	storeErr := fmt.Errorf("fallo con %s", pushAPITestSecret)

	t.Run("POST", func(t *testing.T) {
		store := newPushAPIStore()
		store.err = storeErr
		api := &PushAPI{Store: store, InternalToken: pushAPITestToken}
		response := servePushAPI(t, api, http.MethodPost, pushSubscriptionsPath,
			mustJSON(t, subscription), pushAPITestToken)
		assertPushStatus(t, response, http.StatusInternalServerError, "internal_error")
		if strings.Contains(response.Body.String(), pushAPITestSecret) {
			t.Fatalf("la respuesta filtró el error del store: %s", response.Body)
		}
	})

	t.Run("DELETE", func(t *testing.T) {
		store := newPushAPIStore(subscription)
		store.err = storeErr
		api := &PushAPI{Store: store, InternalToken: pushAPITestToken}
		response := servePushAPI(t, api, http.MethodDelete, pushSubscriptionsPath,
			mustJSON(t, map[string]string{"endpoint": subscription.Endpoint}),
			pushAPITestToken)
		assertPushStatus(t, response, http.StatusInternalServerError, "internal_error")
		if strings.Contains(response.Body.String(), pushAPITestSecret) {
			t.Fatalf("la respuesta filtró el error del store: %s", response.Body)
		}
	})

	t.Run("GET", func(t *testing.T) {
		store := newPushAPIStore()
		store.err = storeErr
		api := &PushAPI{Store: store, InternalToken: pushAPITestToken}
		response := servePushAPI(t, api, http.MethodGet, pushSubscriptionsPath, "", "")
		assertPushStatus(t, response, http.StatusInternalServerError, "internal_error")
		if strings.Contains(response.Body.String(), pushAPITestSecret) {
			t.Fatalf("la respuesta filtró el error del store: %s", response.Body)
		}
	})
}

func TestPushAPINilStore(t *testing.T) {
	api := &PushAPI{InternalToken: pushAPITestToken}
	for _, method := range []string{http.MethodGet, http.MethodPost, http.MethodDelete} {
		t.Run(method, func(t *testing.T) {
			response := servePushAPI(t, api, method, pushSubscriptionsPath, "", pushAPITestToken)
			assertPushStatus(t, response, http.StatusServiceUnavailable, "not_configured")
		})
	}
}

func TestPushAPIWithoutInternalTokenAllowsMutations(t *testing.T) {
	subscription := validPushSubscription()
	store := newPushAPIStore()
	api := &PushAPI{Store: store}
	response := servePushAPI(t, api, http.MethodPost, pushSubscriptionsPath,
		mustJSON(t, subscription), "")
	assertPushStatus(t, response, http.StatusAccepted, "accepted")
}

func mustJSON(t *testing.T, value any) string {
	t.Helper()
	raw, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return string(raw)
}
