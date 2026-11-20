package main

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/AGR55/QvaApp/services/trading-core/internal/platform/qvapay"
)

func TestLiveMutationsCreateOfferParsesUUID(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/p2p/create" {
			t.Errorf("ruta = %q", r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, `{"p2p":{"uuid":"7c9e6679-7425-40de-944b-e07fc1f90ae7"}}`)
	}))
	defer server.Close()

	client := qvapay.NewMutationClient(server.URL, "token")
	client.Enable()
	live := &liveMutations{client: client}

	result, err := live.CreateOffer(context.Background(), map[string]any{
		"coin": "CLASICA", "type": "sell", "amount": 1, "receive": 2,
	})
	if err != nil {
		t.Fatalf("CreateOffer: %v", err)
	}
	if result["uuid"] != "7c9e6679-7425-40de-944b-e07fc1f90ae7" {
		t.Fatalf("uuid = %v", result["uuid"])
	}
}
