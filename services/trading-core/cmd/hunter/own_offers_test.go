package main

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/AGR55/QvaApp/services/trading-core/internal/platform/qvapay"
)

func TestWithoutOwnOffers(t *testing.T) {
	source := &qvapaySource{ownUUID: "me"}
	offers := []qvapay.Offer{
		{UUID: "own", User: json.RawMessage(`{"uuid":"me"}`)},
		{UUID: "other", User: json.RawMessage(`{"uuid":"other"}`)},
		{UUID: "owner-field", OwnerUUID: "me"},
		{UUID: "empty"},
	}
	filtered := source.withoutOwnOffers(context.Background(), offers)
	if len(filtered) != 2 || filtered[0].UUID != "other" || filtered[1].UUID != "empty" {
		t.Fatalf("filtered = %+v", filtered)
	}
}
