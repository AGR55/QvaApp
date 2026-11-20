package edge

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

const qvapayWebhookTestSecret = "secreto-de-prueba-qvapay"

var qvapayWebhookTestNow = time.UnixMilli(1_700_000_000_000)

type qvapayWebhookCall struct {
	eventKey   string
	event      string
	payload    []byte
	receivedAt int64
}

type qvapayFakeFeedStore struct {
	calls []qvapayWebhookCall
	err   error
}

func (store *qvapayFakeFeedStore) Upsert(
	_ context.Context,
	eventKey, event string,
	payload []byte,
	receivedAt int64,
) error {
	if store.err != nil {
		return store.err
	}
	store.calls = append(store.calls, qvapayWebhookCall{
		eventKey:   eventKey,
		event:      event,
		payload:    append([]byte(nil), payload...),
		receivedAt: receivedAt,
	})
	return nil
}

func newQvapayWebhookTestAPI(enabled bool, secret string) (*QvapayWebhookAPI, *qvapayFakeFeedStore) {
	store := &qvapayFakeFeedStore{}
	return &QvapayWebhookAPI{
		Enabled: enabled,
		Secret:  secret,
		Store:   store,
		Now:     func() time.Time { return qvapayWebhookTestNow },
	}, store
}

func qvapayWebhookSign(secret string, body []byte) string {
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write(body)
	return hex.EncodeToString(mac.Sum(nil))
}

func qvapayWebhookDo(
	api *QvapayWebhookAPI,
	method, target string,
	body []byte,
	signature string,
) *httptest.ResponseRecorder {
	request := httptest.NewRequest(method, target, bytes.NewReader(body))
	if signature != "" {
		request.Header.Set(qvapayWebhookSignatureHeader, signature)
	}
	recorder := httptest.NewRecorder()
	api.ServeHTTP(recorder, request)
	return recorder
}

func qvapayWebhookDecode(t *testing.T, recorder *httptest.ResponseRecorder) map[string]any {
	t.Helper()
	var payload map[string]any
	if err := json.Unmarshal(recorder.Body.Bytes(), &payload); err != nil {
		t.Fatalf("respuesta no es JSON: %v (%q)", err, recorder.Body.String())
	}
	return payload
}

func TestQvapayWebhookAcceptsValidEvent(t *testing.T) {
	api, store := newQvapayWebhookTestAPI(true, qvapayWebhookTestSecret)
	body := []byte(`{"event":"p2p.offer.created","data":{"id":"offer-1","amount":12.5,"coin":"QUSD"}}`)

	recorder := qvapayWebhookDo(
		api, http.MethodPost, qvapayWebhookPath, body,
		qvapayWebhookSign(qvapayWebhookTestSecret, body),
	)

	if recorder.Code != http.StatusAccepted {
		t.Fatalf("status = %d, quiero %d (%s)", recorder.Code, http.StatusAccepted, recorder.Body.String())
	}
	if len(store.calls) != 1 {
		t.Fatalf("llamadas al store = %d, quiero 1", len(store.calls))
	}
	call := store.calls[0]
	if call.eventKey != "p2p.offer.created:offer-1" {
		t.Errorf("eventKey = %q", call.eventKey)
	}
	if call.event != "p2p.offer.created" {
		t.Errorf("event = %q", call.event)
	}
	if !bytes.Equal(call.payload, body) {
		t.Errorf("payload guardado = %q, quiero %q", call.payload, body)
	}
	if call.receivedAt != qvapayWebhookTestNow.UnixMilli() {
		t.Errorf("receivedAt = %d, quiero %d", call.receivedAt, qvapayWebhookTestNow.UnixMilli())
	}

	response := qvapayWebhookDecode(t, recorder)
	if response["ok"] != true {
		t.Errorf("ok = %v", response["ok"])
	}
	if response["event"] != "p2p.offer.created" {
		t.Errorf("event = %v", response["event"])
	}
	if response["eventKey"] != "p2p.offer.created:offer-1" {
		t.Errorf("eventKey = %v", response["eventKey"])
	}
}

func TestQvapayWebhookSignaturePrefixedIsAccepted(t *testing.T) {
	api, store := newQvapayWebhookTestAPI(true, qvapayWebhookTestSecret)
	body := []byte(`{"event":"p2p.offer.updated","data":{"id":"offer-2"}}`)
	signature := "sha256=" + qvapayWebhookSign(qvapayWebhookTestSecret, body)

	recorder := qvapayWebhookDo(api, http.MethodPost, qvapayWebhookPath, body, signature)

	if recorder.Code != http.StatusAccepted {
		t.Fatalf("status = %d, quiero %d (%s)", recorder.Code, http.StatusAccepted, recorder.Body.String())
	}
	if len(store.calls) != 1 {
		t.Fatalf("llamadas al store = %d, quiero 1", len(store.calls))
	}
}

func TestQvapayWebhookRejectsBadSignatures(t *testing.T) {
	body := []byte(`{"event":"p2p.offer.created","data":{"id":"offer-3"}}`)
	valid := qvapayWebhookSign(qvapayWebhookTestSecret, body)

	cases := []struct {
		name      string
		signature string
	}{
		{name: "sin firma", signature: ""},
		{name: "firma incorrecta", signature: strings.Repeat("0", len(valid))},
		{name: "hex inválido", signature: strings.Repeat("z", len(valid))},
		{name: "longitud incorrecta", signature: valid[:len(valid)-2]},
		{name: "secreto distinto", signature: qvapayWebhookSign("otro-secreto", body)},
		{name: "prefijo sin valor", signature: "sha256="},
	}

	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			api, store := newQvapayWebhookTestAPI(true, qvapayWebhookTestSecret)
			recorder := qvapayWebhookDo(api, http.MethodPost, qvapayWebhookPath, body, testCase.signature)

			if recorder.Code != http.StatusUnauthorized {
				t.Fatalf("status = %d, quiero %d", recorder.Code, http.StatusUnauthorized)
			}
			if len(store.calls) != 0 {
				t.Errorf("el store se llamó con firma inválida")
			}
			response := qvapayWebhookDecode(t, recorder)
			if response["error"] != "Firma inválida." {
				t.Errorf("error = %v", response["error"])
			}
			if strings.Contains(recorder.Body.String(), qvapayWebhookTestSecret) {
				t.Errorf("la respuesta expone el secreto")
			}
		})
	}
}

func TestQvapayWebhookSecurityFlag(t *testing.T) {
	body := []byte(`{"event":"p2p.offer.created","data":{"id":"offer-4"}}`)

	t.Run("deshabilitado", func(t *testing.T) {
		api, store := newQvapayWebhookTestAPI(false, qvapayWebhookTestSecret)
		recorder := qvapayWebhookDo(
			api, http.MethodPost, qvapayWebhookPath, body,
			qvapayWebhookSign(qvapayWebhookTestSecret, body),
		)

		if recorder.Code != http.StatusServiceUnavailable {
			t.Fatalf("status = %d, quiero %d", recorder.Code, http.StatusServiceUnavailable)
		}
		response := qvapayWebhookDecode(t, recorder)
		if response["error"] != "Webhook deshabilitado." {
			t.Errorf("error = %v", response["error"])
		}
		if len(store.calls) != 0 {
			t.Errorf("el store se llamó con el webhook deshabilitado")
		}
	})

	t.Run("sin secreto", func(t *testing.T) {
		api, store := newQvapayWebhookTestAPI(true, "")
		recorder := qvapayWebhookDo(api, http.MethodPost, qvapayWebhookPath, body, "")

		if recorder.Code != http.StatusServiceUnavailable {
			t.Fatalf("status = %d, quiero %d", recorder.Code, http.StatusServiceUnavailable)
		}
		response := qvapayWebhookDecode(t, recorder)
		if response["error"] != "Webhook sin secreto configurado." {
			t.Errorf("error = %v", response["error"])
		}
		if len(store.calls) != 0 {
			t.Errorf("el store se llamó sin secreto configurado")
		}
	})
}

func TestQvapayWebhookRejectsOversizedBody(t *testing.T) {
	api, store := newQvapayWebhookTestAPI(true, qvapayWebhookTestSecret)
	body := []byte(`{"event":"p2p.offer.created","data":{"id":"offer-5"},"pad":"` +
		strings.Repeat("a", qvapayWebhookMaxBodyBytes) + `"}`)

	recorder := qvapayWebhookDo(
		api, http.MethodPost, qvapayWebhookPath, body,
		qvapayWebhookSign(qvapayWebhookTestSecret, body),
	)

	if recorder.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("status = %d, quiero %d", recorder.Code, http.StatusRequestEntityTooLarge)
	}
	if len(store.calls) != 0 {
		t.Errorf("el store se llamó con cuerpo demasiado grande")
	}
}

func TestQvapayWebhookRejectsInvalidJSON(t *testing.T) {
	api, store := newQvapayWebhookTestAPI(true, qvapayWebhookTestSecret)
	body := []byte(`{"event":`)

	recorder := qvapayWebhookDo(
		api, http.MethodPost, qvapayWebhookPath, body,
		qvapayWebhookSign(qvapayWebhookTestSecret, body),
	)

	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, quiero %d", recorder.Code, http.StatusBadRequest)
	}
	if len(store.calls) != 0 {
		t.Errorf("el store se llamó con JSON inválido")
	}
}

func TestQvapayWebhookRejectsEmptyEvent(t *testing.T) {
	api, store := newQvapayWebhookTestAPI(true, qvapayWebhookTestSecret)
	body := []byte(`{"event":"   ","data":{"id":"offer-6"}}`)

	recorder := qvapayWebhookDo(
		api, http.MethodPost, qvapayWebhookPath, body,
		qvapayWebhookSign(qvapayWebhookTestSecret, body),
	)

	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, quiero %d", recorder.Code, http.StatusBadRequest)
	}
	if len(store.calls) != 0 {
		t.Errorf("el store se llamó con evento vacío")
	}
}

func TestQvapayWebhookEventKeyFallbacks(t *testing.T) {
	cases := []struct {
		name string
		body string
		key  string
	}{
		{
			name: "uuid cuando no hay id",
			body: `{"event":"p2p.offer.created","data":{"uuid":"uuid-1"}}`,
			key:  "p2p.offer.created:uuid-1",
		},
		{
			name: "id numérico",
			body: `{"event":"p2p.offer.created","data":{"id":12345}}`,
			key:  "p2p.offer.created:12345",
		},
		{
			name: "id nulo usa uuid",
			body: `{"event":"p2p.offer.created","data":{"id":null,"uuid":"uuid-2"}}`,
			key:  "p2p.offer.created:uuid-2",
		},
		{
			name: "hash del cuerpo sin identificadores",
			body: `{"event":"p2p.ping","data":{}}`,
			key:  "",
		},
	}

	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			api, store := newQvapayWebhookTestAPI(true, qvapayWebhookTestSecret)
			body := []byte(testCase.body)
			recorder := qvapayWebhookDo(
				api, http.MethodPost, qvapayWebhookPath, body,
				qvapayWebhookSign(qvapayWebhookTestSecret, body),
			)

			if recorder.Code != http.StatusAccepted {
				t.Fatalf("status = %d, quiero %d (%s)", recorder.Code, http.StatusAccepted, recorder.Body.String())
			}
			if len(store.calls) != 1 {
				t.Fatalf("llamadas al store = %d, quiero 1", len(store.calls))
			}
			want := testCase.key
			if want == "" {
				sum := sha256.Sum256(body)
				want = hex.EncodeToString(sum[:])
			}
			if store.calls[0].eventKey != want {
				t.Errorf("eventKey = %q, quiero %q", store.calls[0].eventKey, want)
			}
		})
	}
}

func TestQvapayWebhookStoreError(t *testing.T) {
	api, store := newQvapayWebhookTestAPI(true, qvapayWebhookTestSecret)
	store.err = errors.New("fallo simulado")
	body := []byte(`{"event":"p2p.offer.created","data":{"id":"offer-7"}}`)

	recorder := qvapayWebhookDo(
		api, http.MethodPost, qvapayWebhookPath, body,
		qvapayWebhookSign(qvapayWebhookTestSecret, body),
	)

	if recorder.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, quiero %d", recorder.Code, http.StatusInternalServerError)
	}
	if strings.Contains(recorder.Body.String(), "fallo simulado") {
		t.Errorf("la respuesta filtra el error interno: %s", recorder.Body.String())
	}
}

func TestQvapayWebhookMethodAndRoute(t *testing.T) {
	api, _ := newQvapayWebhookTestAPI(true, qvapayWebhookTestSecret)

	for _, method := range []string{http.MethodGet, http.MethodPut, http.MethodDelete} {
		recorder := qvapayWebhookDo(api, method, qvapayWebhookPath, nil, "")
		if recorder.Code != http.StatusMethodNotAllowed {
			t.Fatalf("%s status = %d, quiero %d", method, recorder.Code, http.StatusMethodNotAllowed)
		}
		if recorder.Header().Get("Allow") != http.MethodPost {
			t.Errorf("%s Allow = %q", method, recorder.Header().Get("Allow"))
		}
	}

	recorder := qvapayWebhookDo(api, http.MethodPost, "/webhooks/qvapay/otro", nil, "")
	if recorder.Code != http.StatusNotFound {
		t.Fatalf("ruta desconocida status = %d, quiero %d", recorder.Code, http.StatusNotFound)
	}
}

func TestQvapayWebhookHeaders(t *testing.T) {
	api, _ := newQvapayWebhookTestAPI(true, qvapayWebhookTestSecret)
	body := []byte(`{"event":"p2p.offer.created","data":{"id":"offer-8"}}`)

	recorder := qvapayWebhookDo(
		api, http.MethodPost, qvapayWebhookPath, body,
		qvapayWebhookSign(qvapayWebhookTestSecret, body),
	)

	if got := recorder.Header().Get("Cache-Control"); got != "no-store" {
		t.Errorf("Cache-Control = %q", got)
	}
	if got := recorder.Header().Get("Content-Type"); got != "application/json; charset=utf-8" {
		t.Errorf("Content-Type = %q", got)
	}
	if got := recorder.Header().Get("X-Content-Type-Options"); got != "nosniff" {
		t.Errorf("X-Content-Type-Options = %q", got)
	}
	for _, header := range []string{
		"Access-Control-Allow-Origin",
		"Access-Control-Allow-Credentials",
		"Access-Control-Allow-Methods",
	} {
		if got := recorder.Header().Get(header); got != "" {
			t.Errorf("%s = %q, quiero vacío", header, got)
		}
	}
}
