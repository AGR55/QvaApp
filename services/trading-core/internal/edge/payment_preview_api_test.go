package edge

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/AGR55/QvaApp/services/shared/decimal"
	"github.com/AGR55/QvaApp/services/trading-core/internal/platform/qvapay"
)

type fakePaymentStore struct {
	operation paymentPreviewOperation
	found     bool
}

func (store *fakePaymentStore) Lookup(context.Context, string) (paymentPreviewOperation, bool, error) {
	return store.operation, store.found, nil
}

type fakePaymentReader struct {
	user  qvapay.User
	offer qvapay.Offer
}

func (reader *fakePaymentReader) User(context.Context) (qvapay.User, error) {
	return reader.user, nil
}
func (reader *fakePaymentReader) Offer(context.Context, string) (qvapay.Offer, error) {
	return reader.offer, nil
}

func newPaymentPreviewTestAPI(t *testing.T, operation paymentPreviewOperation, reader *fakePaymentReader) (*PaymentPreviewAPI, string) {
	t.Helper()
	token := "payment-operator-token-1234567890-abcdefghijklmnop"
	snapshot, _ := json.Marshal(map[string]any{
		"devices": []any{},
		"operators": []any{map[string]any{
			"id": "op-1", "tokenHash": mobileAuthTestHash(token),
			"scopes": []string{"read", "actions"}, "revokedAt": nil,
		}},
	})
	file := filepath.Join(t.TempDir(), "mobile-auth.json")
	if err := os.WriteFile(file, snapshot, 0o600); err != nil {
		t.Fatal(err)
	}
	now := time.Unix(1_700_000_000, 0)
	return &PaymentPreviewAPI{
		MobileAuth: &MobileAuthAPI{File: file, Now: func() time.Time { return now }},
		Reader:     reader, Store: &fakePaymentStore{operation: operation, found: true},
		Now: func() time.Time { return now },
	}, token
}

func paymentPreviewOffer(peer string) qvapay.Offer {
	return qvapay.Offer{
		UUID: "op-1", Type: "sell", Coin: "CLASICA", Status: "processing",
		Amount: decimal.MustParse("10"), Receive: decimal.MustParse("11"),
		OwnerUUID: "creator-1",
		Peer:      json.RawMessage(`{"uuid":"` + peer + `"}`),
		Details:   map[string]any{"card": "1234 5678 9012 3456", "phone": "+53 5555 1234"},
	}
}

func TestPaymentPreviewSuccess(t *testing.T) {
	operation := paymentPreviewOperation{
		UUID: "op-1", Coin: "CLASICA", Amount: 10, Receive: 11,
		State: "processing", CounterpartyID: "creator-1",
	}
	reader := &fakePaymentReader{
		user:  qvapay.User{UUID: "taker-1"},
		offer: paymentPreviewOffer("taker-1"),
	}
	api, token := newPaymentPreviewTestAPI(t, operation, reader)

	request := httptest.NewRequest(http.MethodGet, "/api/mobile/operations/op-1/payment-preview", nil)
	request.Header.Set("Authorization", "Bearer "+token)
	recorder := httptest.NewRecorder()
	api.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d (cuerpo %q)", recorder.Code, recorder.Body.String())
	}
	var payload struct {
		Data map[string]any `json:"data"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &payload); err != nil {
		t.Fatal(err)
	}
	if payload.Data["destination"] != "1234567890123456" || payload.Data["amount"] != "11.00" {
		t.Fatalf("data = %+v", payload.Data)
	}
	if payload.Data["confirmationPhone"] != "55551234" || payload.Data["fingerprint"] == "" {
		t.Fatalf("data = %+v", payload.Data)
	}
}

func TestPaymentPreviewRejectsCreatorAndMismatch(t *testing.T) {
	operation := paymentPreviewOperation{
		UUID: "op-1", Coin: "CLASICA", Amount: 10, Receive: 11,
		State: "processing", CounterpartyID: "creator-1",
	}
	reader := &fakePaymentReader{
		user:  qvapay.User{UUID: "creator-1"},
		offer: paymentPreviewOffer("taker-1"),
	}
	api, token := newPaymentPreviewTestAPI(t, operation, reader)
	request := httptest.NewRequest(http.MethodGet, "/api/mobile/operations/op-1/payment-preview", nil)
	request.Header.Set("Authorization", "Bearer "+token)
	recorder := httptest.NewRecorder()
	api.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusConflict {
		t.Fatalf("creador: status = %d", recorder.Code)
	}

	anonymous := httptest.NewRequest(http.MethodGet, "/api/mobile/operations/op-1/payment-preview", nil)
	anonymousRecorder := httptest.NewRecorder()
	api.ServeHTTP(anonymousRecorder, anonymous)
	if anonymousRecorder.Code != http.StatusUnauthorized {
		t.Fatalf("sin token: %d", anonymousRecorder.Code)
	}
}
