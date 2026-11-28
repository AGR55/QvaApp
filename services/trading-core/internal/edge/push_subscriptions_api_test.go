package edge

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"sort"
	"strings"
	"testing"
	"time"
)

const (
	pushTestEndpoint      = "https://push.example/send/abc123"
	pushTestOtherEndpoint = "https://push.example/send/def456"
	pushTestP256DH        = "BTestP256DHKeyMaterial0123456789abcdefghijklmnopqrstuvwxyz"
	pushTestAuth          = "test-auth-material"
	pushTestOrigin        = "https://panel.example"
	pushTestPublicKey     = "BTestVapidPublicKeyMaterial0123456789"
)

var (
	pushTestNow = time.Unix(1_700_000_000, 0)
	pushTestTTL = 30 * 24 * time.Hour
)

type pushTestStore struct {
	items     map[string]Subscription
	upserts   []Subscription
	deletes   []string
	upsertErr error
	deleteErr error
	listErr   error
}

func newPushTestStore(items ...Subscription) *pushTestStore {
	store := &pushTestStore{items: make(map[string]Subscription)}
	for _, item := range items {
		store.items[item.Endpoint] = item
	}
	return store
}

func (store *pushTestStore) Upsert(_ context.Context, subscription Subscription) error {
	if store.upsertErr != nil {
		return store.upsertErr
	}
	store.upserts = append(store.upserts, subscription)
	store.items[subscription.Endpoint] = subscription
	return nil
}

func (store *pushTestStore) Delete(_ context.Context, endpoint string) (bool, error) {
	if store.deleteErr != nil {
		return false, store.deleteErr
	}
	store.deletes = append(store.deletes, endpoint)
	_, found := store.items[endpoint]
	delete(store.items, endpoint)
	return found, nil
}

func (store *pushTestStore) List(context.Context) ([]Subscription, error) {
	if store.listErr != nil {
		return nil, store.listErr
	}
	endpoints := make([]string, 0, len(store.items))
	for endpoint := range store.items {
		endpoints = append(endpoints, endpoint)
	}
	sort.Strings(endpoints)

	subscriptions := make([]Subscription, 0, len(endpoints))
	for _, endpoint := range endpoints {
		subscriptions = append(subscriptions, store.items[endpoint])
	}
	return subscriptions, nil
}

func newPushTestAPI(
	t *testing.T,
	items ...Subscription,
) (*PushSubscriptionsAPI, *pushTestStore, *http.Cookie, string) {
	t.Helper()
	manager := newSessionTestManager(t, 15*time.Minute)
	token, csrf, err := manager.Issue(pushTestNow)
	if err != nil {
		t.Fatalf("Issue: %v", err)
	}
	store := newPushTestStore(items...)
	api := &PushSubscriptionsAPI{
		Sessions:      manager,
		Store:         store,
		TrustedOrigin: pushTestOrigin,
		Now:           func() time.Time { return pushTestNow },
		PublicKey:     pushTestPublicKey,
		TTL:           pushTestTTL,
	}
	return api, store, &http.Cookie{Name: CookieName, Value: token}, csrf
}

func pushTestDo(
	api *PushSubscriptionsAPI,
	method, target, body string,
	cookie *http.Cookie,
	csrf, origin string,
) *httptest.ResponseRecorder {
	var reader io.Reader
	if body != "" {
		reader = strings.NewReader(body)
	}
	request := httptest.NewRequest(method, target, reader)
	if body != "" {
		request.Header.Set("Content-Type", "application/json")
	}
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

func pushTestMutation(
	api *PushSubscriptionsAPI,
	method, body string,
	cookie *http.Cookie,
	csrf string,
) *httptest.ResponseRecorder {
	return pushTestDo(api, method, pushSubscriptionsPath, body, cookie, csrf, pushTestOrigin)
}

func pushTestDecode[T any](t *testing.T, recorder *httptest.ResponseRecorder) T {
	t.Helper()
	var value T
	if err := json.Unmarshal(recorder.Body.Bytes(), &value); err != nil {
		t.Fatalf("JSON inválido: %v (cuerpo %q)", err, recorder.Body.String())
	}
	return value
}

func pushTestNestedBody(endpoint, p256dh, auth, label string) string {
	return fmt.Sprintf(
		`{"endpoint":%q,"expirationTime":null,"keys":{"p256dh":%q,"auth":%q},"label":%q,"expiresAt":1}`,
		endpoint, p256dh, auth, label,
	)
}

func pushTestFlatBody(endpoint, p256dh, auth, label string) string {
	return fmt.Sprintf(
		`{"endpoint":%q,"p256dh":%q,"auth":%q,"label":%q}`,
		endpoint, p256dh, auth, label,
	)
}

// pushTestCheckHeaders comprueba los encabezados comunes a toda respuesta.
func pushTestCheckHeaders(t *testing.T, recorder *httptest.ResponseRecorder) {
	t.Helper()
	if got := recorder.Header().Get("Cache-Control"); got != "no-store" {
		t.Fatalf("Cache-Control = %q, quiero no-store", got)
	}
	if got := recorder.Header().Get("X-Content-Type-Options"); got != "nosniff" {
		t.Fatalf("X-Content-Type-Options = %q, quiero nosniff", got)
	}
	if got := recorder.Header().Get("Access-Control-Allow-Origin"); got != "" {
		t.Fatalf("Access-Control-Allow-Origin = %q, no debe haber CORS", got)
	}
}

func pushTestRequireJSON(t *testing.T, recorder *httptest.ResponseRecorder) {
	t.Helper()
	if got := recorder.Header().Get("Content-Type"); !strings.HasPrefix(got, "application/json") {
		t.Fatalf("Content-Type = %q, quiero JSON", got)
	}
}

// pushTestRequireNoKeys comprueba que una respuesta nunca filtre claves.
func pushTestRequireNoKeys(t *testing.T, recorder *httptest.ResponseRecorder, secrets ...string) {
	t.Helper()
	body := recorder.Body.String()
	for _, secret := range secrets {
		if secret == "" {
			continue
		}
		if strings.Contains(body, secret) {
			t.Fatalf("la respuesta filtró una clave: %q", body)
		}
	}
}

func TestPushSubscriptionsCreate(t *testing.T) {
	t.Run("cuerpo anidado", func(t *testing.T) {
		api, store, cookie, csrf := newPushTestAPI(t)
		body := pushTestNestedBody(pushTestEndpoint, pushTestP256DH, pushTestAuth, "  Panel  ")
		recorder := pushTestMutation(api, http.MethodPost, body, cookie, csrf)

		if recorder.Code != http.StatusCreated {
			t.Fatalf("status = %d (cuerpo %q)", recorder.Code, recorder.Body.String())
		}
		pushTestCheckHeaders(t, recorder)
		pushTestRequireJSON(t, recorder)

		response := pushTestDecode[pushSubscriptionEnvelope](t, recorder)
		if response.Data.Endpoint != pushTestEndpoint {
			t.Fatalf("endpoint = %q, quiero %q", response.Data.Endpoint, pushTestEndpoint)
		}
		if len(store.upserts) != 1 {
			t.Fatalf("upserts = %d, quiero 1", len(store.upserts))
		}
		saved := store.upserts[0]
		if saved.Endpoint != pushTestEndpoint || saved.P256DH != pushTestP256DH || saved.Auth != pushTestAuth {
			t.Fatalf("suscripción guardada inesperada: %+v", saved)
		}
		if saved.Label != "Panel" {
			t.Fatalf("label = %q, quiero Panel", saved.Label)
		}
		createdAt := pushTestNow.UnixMilli()
		if saved.CreatedAt != createdAt || saved.UpdatedAt != createdAt {
			t.Fatalf("createdAt=%d updatedAt=%d, quiero %d", saved.CreatedAt, saved.UpdatedAt, createdAt)
		}
		if want := pushTestNow.Add(pushTestTTL).UnixMilli(); saved.ExpiresAt != want {
			t.Fatalf("expiresAt = %d, quiero %d (el expiresAt del cliente se ignora)", saved.ExpiresAt, want)
		}
		pushTestRequireNoKeys(t, recorder, pushTestP256DH, pushTestAuth)
	})

	t.Run("claves planas y http", func(t *testing.T) {
		api, store, cookie, csrf := newPushTestAPI(t)
		endpoint := "http://push.example/send/plano"
		body := pushTestFlatBody(endpoint, pushTestP256DH, pushTestAuth, "")
		recorder := pushTestMutation(api, http.MethodPost, body, cookie, csrf)

		if recorder.Code != http.StatusCreated {
			t.Fatalf("status = %d (cuerpo %q)", recorder.Code, recorder.Body.String())
		}
		if len(store.upserts) != 1 {
			t.Fatalf("upserts = %d, quiero 1", len(store.upserts))
		}
		if store.upserts[0].Endpoint != endpoint || store.upserts[0].Label != "" {
			t.Fatalf("suscripción guardada inesperada: %+v", store.upserts[0])
		}
	})

	t.Run("ttl por defecto", func(t *testing.T) {
		api, store, cookie, csrf := newPushTestAPI(t)
		api.TTL = 0
		body := pushTestNestedBody(pushTestEndpoint, pushTestP256DH, pushTestAuth, "")
		recorder := pushTestMutation(api, http.MethodPost, body, cookie, csrf)

		if recorder.Code != http.StatusCreated {
			t.Fatalf("status = %d (cuerpo %q)", recorder.Code, recorder.Body.String())
		}
		if want := pushTestNow.Add(pushDefaultTTL).UnixMilli(); store.upserts[0].ExpiresAt != want {
			t.Fatalf("expiresAt = %d, quiero %d", store.upserts[0].ExpiresAt, want)
		}
	})

	t.Run("error del almacén", func(t *testing.T) {
		api, store, cookie, csrf := newPushTestAPI(t)
		store.upsertErr = errors.New("boom")
		body := pushTestNestedBody(pushTestEndpoint, pushTestP256DH, pushTestAuth, "")
		recorder := pushTestMutation(api, http.MethodPost, body, cookie, csrf)

		if recorder.Code != http.StatusServiceUnavailable {
			t.Fatalf("status = %d, quiero 503", recorder.Code)
		}
		pushTestCheckHeaders(t, recorder)
	})
}

func TestPushSubscriptionsCreateValidation(t *testing.T) {
	longEndpoint := "https://" + strings.Repeat("a", 2100)
	cases := []struct {
		name string
		body string
	}{
		{"endpoint vacío", pushTestNestedBody("", pushTestP256DH, pushTestAuth, "")},
		{"endpoint relativo", pushTestNestedBody("/api/push/subscriptions", pushTestP256DH, pushTestAuth, "")},
		{"esquema no permitido", pushTestNestedBody("ftp://push.example/send/x", pushTestP256DH, pushTestAuth, "")},
		{"endpoint corto", pushTestNestedBody("http://a", pushTestP256DH, pushTestAuth, "")},
		{"endpoint largo", pushTestNestedBody(longEndpoint, pushTestP256DH, pushTestAuth, "")},
		{"p256dh corto", pushTestNestedBody(pushTestEndpoint, strings.Repeat("p", 19), pushTestAuth, "")},
		{"p256dh largo", pushTestNestedBody(pushTestEndpoint, strings.Repeat("p", 301), pushTestAuth, "")},
		{"auth corto", pushTestNestedBody(pushTestEndpoint, pushTestP256DH, strings.Repeat("a", 7), "")},
		{"auth largo", pushTestNestedBody(pushTestEndpoint, pushTestP256DH, strings.Repeat("a", 201), "")},
		{"label largo", pushTestNestedBody(pushTestEndpoint, pushTestP256DH, pushTestAuth, strings.Repeat("l", 81))},
		{"json inválido", "{"},
		{"json con datos extra", pushTestNestedBody(pushTestEndpoint, pushTestP256DH, pushTestAuth, "") + " {}"},
		{"cuerpo vacío", ""},
	}

	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			api, store, cookie, csrf := newPushTestAPI(t)
			recorder := pushTestMutation(api, http.MethodPost, testCase.body, cookie, csrf)

			if recorder.Code != http.StatusBadRequest {
				t.Fatalf("status = %d, quiero 400 (cuerpo %q)", recorder.Code, recorder.Body.String())
			}
			pushTestCheckHeaders(t, recorder)
			pushTestRequireJSON(t, recorder)
			if len(store.upserts) != 0 {
				t.Fatalf("upserts = %d, quiero 0", len(store.upserts))
			}
		})
	}
}

func TestPushSubscriptionsBodyLimit(t *testing.T) {
	api, store, cookie, csrf := newPushTestAPI(t)
	body := pushTestNestedBody(
		pushTestEndpoint, pushTestP256DH, pushTestAuth, strings.Repeat("x", 9<<10),
	)
	recorder := pushTestMutation(api, http.MethodPost, body, cookie, csrf)

	if recorder.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("status = %d, quiero 413 (cuerpo %q)", recorder.Code, recorder.Body.String())
	}
	pushTestCheckHeaders(t, recorder)
	if len(store.upserts) != 0 {
		t.Fatalf("upserts = %d, quiero 0", len(store.upserts))
	}
}

func TestPushSubscriptionsDelete(t *testing.T) {
	t.Run("existente", func(t *testing.T) {
		api, store, cookie, csrf := newPushTestAPI(t, Subscription{
			Endpoint: pushTestEndpoint, P256DH: pushTestP256DH, Auth: pushTestAuth,
		})
		body := fmt.Sprintf(`{"endpoint":%q}`, pushTestEndpoint)
		recorder := pushTestMutation(api, http.MethodDelete, body, cookie, csrf)

		if recorder.Code != http.StatusNoContent {
			t.Fatalf("status = %d (cuerpo %q)", recorder.Code, recorder.Body.String())
		}
		pushTestCheckHeaders(t, recorder)
		if recorder.Body.Len() != 0 {
			t.Fatalf("cuerpo = %q, quiero vacío", recorder.Body.String())
		}
		if len(store.deletes) != 1 || store.deletes[0] != pushTestEndpoint {
			t.Fatalf("deletes = %v", store.deletes)
		}
		if _, stillThere := store.items[pushTestEndpoint]; stillThere {
			t.Fatalf("la suscripción no se eliminó")
		}
	})

	t.Run("inexistente", func(t *testing.T) {
		api, _, cookie, csrf := newPushTestAPI(t)
		body := fmt.Sprintf(`{"endpoint":%q}`, pushTestEndpoint)
		recorder := pushTestMutation(api, http.MethodDelete, body, cookie, csrf)

		if recorder.Code != http.StatusNotFound {
			t.Fatalf("status = %d, quiero 404", recorder.Code)
		}
		pushTestCheckHeaders(t, recorder)
		response := pushTestDecode[map[string]string](t, recorder)
		if response["error"] != "Suscripción no encontrada." {
			t.Fatalf("error = %q", response["error"])
		}
	})

	t.Run("endpoint inválido", func(t *testing.T) {
		api, store, cookie, csrf := newPushTestAPI(t)
		recorder := pushTestMutation(api, http.MethodDelete, `{"endpoint":"ftp://x"}`, cookie, csrf)

		if recorder.Code != http.StatusBadRequest {
			t.Fatalf("status = %d, quiero 400", recorder.Code)
		}
		if len(store.deletes) != 0 {
			t.Fatalf("deletes = %v, quiero ninguno", store.deletes)
		}
	})

	t.Run("cuerpo inválido", func(t *testing.T) {
		api, _, cookie, csrf := newPushTestAPI(t)
		recorder := pushTestMutation(api, http.MethodDelete, `{}`, cookie, csrf)

		if recorder.Code != http.StatusBadRequest {
			t.Fatalf("status = %d, quiero 400", recorder.Code)
		}
	})

	t.Run("error del almacén", func(t *testing.T) {
		api, store, cookie, csrf := newPushTestAPI(t)
		store.deleteErr = errors.New("boom")
		body := fmt.Sprintf(`{"endpoint":%q}`, pushTestEndpoint)
		recorder := pushTestMutation(api, http.MethodDelete, body, cookie, csrf)

		if recorder.Code != http.StatusServiceUnavailable {
			t.Fatalf("status = %d, quiero 503", recorder.Code)
		}
	})
}

func TestPushSubscriptionsList(t *testing.T) {
	first := Subscription{
		Endpoint: "https://push.example/send/aaa",
		P256DH:   "primer-p256dh-secreto-0123456789",
		Auth:     "primer-auth-secreto",
	}
	second := Subscription{
		Endpoint: "https://push.example/send/zzz",
		P256DH:   "segundo-p256dh-secreto-0123456789",
		Auth:     "segundo-auth-secreto",
	}

	t.Run("lista sin claves", func(t *testing.T) {
		api, _, cookie, _ := newPushTestAPI(t, second, first)
		recorder := pushTestDo(api, http.MethodGet, pushSubscriptionsPath, "", cookie, "", "")

		if recorder.Code != http.StatusOK {
			t.Fatalf("status = %d (cuerpo %q)", recorder.Code, recorder.Body.String())
		}
		pushTestCheckHeaders(t, recorder)
		pushTestRequireJSON(t, recorder)

		response := pushTestDecode[pushSubscriptionsEnvelope](t, recorder)
		if response.Data.Count != 2 {
			t.Fatalf("count = %d, quiero 2", response.Data.Count)
		}
		want := []string{first.Endpoint, second.Endpoint}
		if len(response.Data.Endpoints) != len(want) {
			t.Fatalf("endpoints = %v, quiero %v", response.Data.Endpoints, want)
		}
		for index := range want {
			if response.Data.Endpoints[index] != want[index] {
				t.Fatalf("endpoints = %v, quiero %v", response.Data.Endpoints, want)
			}
		}
		pushTestRequireNoKeys(t, recorder, first.P256DH, first.Auth, second.P256DH, second.Auth)
	})

	t.Run("vacía devuelve array", func(t *testing.T) {
		api, _, cookie, _ := newPushTestAPI(t)
		recorder := pushTestDo(api, http.MethodGet, pushSubscriptionsPath, "", cookie, "", "")

		if recorder.Code != http.StatusOK {
			t.Fatalf("status = %d", recorder.Code)
		}
		if !strings.Contains(recorder.Body.String(), `"endpoints":[]`) {
			t.Fatalf("cuerpo = %q, quiero endpoints vacío", recorder.Body.String())
		}
	})

	t.Run("sin store", func(t *testing.T) {
		api, _, cookie, _ := newPushTestAPI(t)
		api.Store = nil
		recorder := pushTestDo(api, http.MethodGet, pushSubscriptionsPath, "", cookie, "", "")

		if recorder.Code != http.StatusServiceUnavailable {
			t.Fatalf("status = %d, quiero 503", recorder.Code)
		}
	})

	t.Run("error del almacén", func(t *testing.T) {
		api, store, cookie, _ := newPushTestAPI(t)
		store.listErr = errors.New("boom")
		recorder := pushTestDo(api, http.MethodGet, pushSubscriptionsPath, "", cookie, "", "")

		if recorder.Code != http.StatusServiceUnavailable {
			t.Fatalf("status = %d, quiero 503", recorder.Code)
		}
	})
}

func TestPushSubscriptionsPublicKey(t *testing.T) {
	t.Run("configurada", func(t *testing.T) {
		api, _, cookie, _ := newPushTestAPI(t)
		recorder := pushTestDo(api, http.MethodGet, pushPublicKeyPath, "", cookie, "", "")

		if recorder.Code != http.StatusOK {
			t.Fatalf("status = %d (cuerpo %q)", recorder.Code, recorder.Body.String())
		}
		pushTestCheckHeaders(t, recorder)
		pushTestRequireJSON(t, recorder)
		response := pushTestDecode[pushPublicKeyEnvelope](t, recorder)
		if response.Data.PublicKey != pushTestPublicKey {
			t.Fatalf("publicKey = %q", response.Data.PublicKey)
		}
	})

	t.Run("no configurada", func(t *testing.T) {
		api, _, cookie, _ := newPushTestAPI(t)
		api.PublicKey = "   "
		recorder := pushTestDo(api, http.MethodGet, pushPublicKeyPath, "", cookie, "", "")

		if recorder.Code != http.StatusServiceUnavailable {
			t.Fatalf("status = %d, quiero 503", recorder.Code)
		}
		pushTestCheckHeaders(t, recorder)
		response := pushTestDecode[map[string]string](t, recorder)
		if response["status"] != "unavailable" {
			t.Fatalf("body = %v, quiero status unavailable", response)
		}
	})
}

func TestPushSubscriptionsAuthentication(t *testing.T) {
	badCookie := &http.Cookie{Name: CookieName, Value: "token-manipulado"}
	validBody := pushTestNestedBody(pushTestEndpoint, pushTestP256DH, pushTestAuth, "")
	deleteBody := fmt.Sprintf(`{"endpoint":%q}`, pushTestEndpoint)

	cases := []struct {
		name   string
		method string
		target string
		body   string
		cookie *http.Cookie
		csrf   string
		origin string
	}{
		{"GET sin cookie", http.MethodGet, pushSubscriptionsPath, "", nil, "", ""},
		{"GET cookie inválida", http.MethodGet, pushSubscriptionsPath, "", badCookie, "", ""},
		{"POST sin cookie", http.MethodPost, pushSubscriptionsPath, validBody, nil, "csrf", pushTestOrigin},
		{"POST cookie inválida", http.MethodPost, pushSubscriptionsPath, validBody, badCookie, "csrf", pushTestOrigin},
		{"DELETE sin cookie", http.MethodDelete, pushSubscriptionsPath, deleteBody, nil, "csrf", pushTestOrigin},
		{"public-key sin cookie", http.MethodGet, pushPublicKeyPath, "", nil, "", ""},
		{"public-key cookie inválida", http.MethodGet, pushPublicKeyPath, "", badCookie, "", ""},
	}

	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			api, store, _, _ := newPushTestAPI(t)
			recorder := pushTestDo(
				api, testCase.method, testCase.target, testCase.body,
				testCase.cookie, testCase.csrf, testCase.origin,
			)

			if recorder.Code != http.StatusUnauthorized {
				t.Fatalf("status = %d, quiero 401 (cuerpo %q)", recorder.Code, recorder.Body.String())
			}
			pushTestCheckHeaders(t, recorder)
			response := pushTestDecode[map[string]string](t, recorder)
			if response["error"] != "Autenticación requerida." {
				t.Fatalf("error = %q", response["error"])
			}
			if len(store.upserts) != 0 || len(store.deletes) != 0 {
				t.Fatalf("el store no debe mutar sin sesión")
			}
		})
	}
}

func TestPushSubscriptionsMutationsRequireCSRFAndOrigin(t *testing.T) {
	validBody := pushTestNestedBody(pushTestEndpoint, pushTestP256DH, pushTestAuth, "")
	deleteBody := fmt.Sprintf(`{"endpoint":%q}`, pushTestEndpoint)

	cases := []struct {
		name   string
		method string
		body   string
		csrf   string
		origin string
	}{
		{"POST sin origin ni csrf", http.MethodPost, validBody, "", ""},
		{"POST sin origin", http.MethodPost, validBody, "csrf", ""},
		{"POST origin no confiable", http.MethodPost, validBody, "csrf", "https://evil.example"},
		{"POST sin csrf", http.MethodPost, validBody, "", pushTestOrigin},
		{"POST csrf incorrecto", http.MethodPost, validBody, "otro", pushTestOrigin},
		{"DELETE sin origin ni csrf", http.MethodDelete, deleteBody, "", ""},
		{"DELETE origin no confiable", http.MethodDelete, deleteBody, "csrf", "https://evil.example"},
	}

	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			api, store, cookie, realCSRF := newPushTestAPI(t)
			csrf := testCase.csrf
			if csrf == "csrf" {
				csrf = realCSRF
			}
			recorder := pushTestDo(
				api, testCase.method, pushSubscriptionsPath, testCase.body,
				cookie, csrf, testCase.origin,
			)

			if recorder.Code != http.StatusForbidden {
				t.Fatalf("status = %d, quiero 403 (cuerpo %q)", recorder.Code, recorder.Body.String())
			}
			pushTestCheckHeaders(t, recorder)
			if len(store.upserts) != 0 || len(store.deletes) != 0 {
				t.Fatalf("el store no debe mutar sin CSRF/Origin")
			}
		})
	}
}

func TestPushSubscriptionsRouting(t *testing.T) {
	api, _, _, _ := newPushTestAPI(t)

	t.Run("ruta desconocida", func(t *testing.T) {
		recorder := pushTestDo(api, http.MethodGet, "/api/push/subscriptions/extra", "", nil, "", "")
		if recorder.Code != http.StatusNotFound {
			t.Fatalf("status = %d, quiero 404", recorder.Code)
		}
		pushTestCheckHeaders(t, recorder)
		response := pushTestDecode[map[string]string](t, recorder)
		if response["status"] != "not_found" {
			t.Fatalf("body = %v", response)
		}
	})

	t.Run("método no permitido en suscripciones", func(t *testing.T) {
		recorder := pushTestDo(api, http.MethodPut, pushSubscriptionsPath, "", nil, "", "")
		if recorder.Code != http.StatusMethodNotAllowed {
			t.Fatalf("status = %d, quiero 405", recorder.Code)
		}
		pushTestCheckHeaders(t, recorder)
		if got := recorder.Header().Get("Allow"); got != "GET, POST, DELETE" {
			t.Fatalf("Allow = %q", got)
		}
	})

	t.Run("método no permitido en public-key", func(t *testing.T) {
		recorder := pushTestDo(api, http.MethodPost, pushPublicKeyPath, "", nil, "", "")
		if recorder.Code != http.StatusMethodNotAllowed {
			t.Fatalf("status = %d, quiero 405", recorder.Code)
		}
		pushTestCheckHeaders(t, recorder)
		if got := recorder.Header().Get("Allow"); got != http.MethodGet {
			t.Fatalf("Allow = %q", got)
		}
	})
}
