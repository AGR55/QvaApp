package hunter

import (
	"encoding/json"
	"testing"

	"github.com/AGR55/QvaApp/services/trading-core/internal/platform/qvapay"
)

func TestOfferCounterpartyUsesCreator(t *testing.T) {
	offer := qvapay.Offer{
		User: json.RawMessage(`{"uuid":"creator-1"}`),
		Peer: json.RawMessage(`{"uuid":"taker-1"}`),
	}
	if got := offerCounterparty(offer); got != "creator-1" {
		t.Fatalf("counterparty = %q", got)
	}
	offer.User = json.RawMessage(`{"uuid":"creator-1","username":"@cryptobro"}`)
	if got := offerCounterpartyName(offer); got != "cryptobro" {
		t.Fatalf("counterparty name = %q", got)
	}
	offer.User = nil
	if got := offerCounterparty(offer); got != "taker-1" {
		t.Fatalf("fallback = %q", got)
	}
}
