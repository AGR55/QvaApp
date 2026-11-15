package edge

import (
	"context"
	"encoding/json"
	"net/url"
	"testing"
	"time"

	"github.com/AGR55/QvaApp/services/shared/decimal"
	"github.com/AGR55/QvaApp/services/trading-core/internal/platform/qvapay"
)

type fakeLiveReader struct {
	userCalls int
	offers    []qvapay.Offer
	txs       []qvapay.Transaction
}

func (fake *fakeLiveReader) User(context.Context) (qvapay.User, error) {
	fake.userCalls++
	return qvapay.User{UUID: "user-1", Balance: decimal.MustParse("123.45000000")}, nil
}

func (fake *fakeLiveReader) Offers(_ context.Context, params url.Values) ([]qvapay.Offer, error) {
	if params.Get("my") == "true" {
		return fake.offers[:1], nil
	}
	return fake.offers, nil
}

func (fake *fakeLiveReader) Offer(_ context.Context, uuid string) (qvapay.Offer, error) {
	for _, offer := range fake.offers {
		if offer.UUID == uuid {
			return offer, nil
		}
	}
	return qvapay.Offer{}, nil
}

func (fake *fakeLiveReader) Averages(context.Context) (map[string]qvapay.Average, error) {
	return map[string]qvapay.Average{
		"CLASICA": {MedianBuy: decimal.MustParse("1.07"), MedianSell: decimal.MustParse("1.10"), Count: 10},
	}, nil
}

func (fake *fakeLiveReader) Transactions(context.Context, int, int) (qvapay.TransactionPage, error) {
	return qvapay.TransactionPage{Transactions: fake.txs}, nil
}

func TestLiveDashboardSnapshotAndCache(t *testing.T) {
	reader := &fakeLiveReader{
		offers: []qvapay.Offer{
			{UUID: "offer-1", Type: "sell", Coin: "CLASICA", Amount: decimal.MustParse("10"), Receive: decimal.MustParse("11"), Status: "open"},
			{UUID: "offer-2", Type: "buy", Coin: "BANK_CUP", Amount: decimal.MustParse("5"), Receive: decimal.MustParse("5500"), Rate: decimal.MustParse("1100"), Status: "open"},
		},
		txs: []qvapay.Transaction{{
			UUID: "tx-1", Amount: decimal.MustParse("2"), Description: "Pago", Status: "paid",
			CreatedAt: "2026-11-15T10:00:00Z",
			P2P:       json.RawMessage(`{"uuid":"p2p-1","coin":"CLASICA","type":"sell","status":"completed","amount":"2","receive":"2.2"}`),
		}},
	}
	now := time.Unix(1_700_000_000, 0)
	live := &LiveDashboard{Reader: reader, TTL: time.Minute, Now: func() time.Time { return now }}

	snapshot := live.Snapshot(context.Background())
	if !snapshot.Live || snapshot.Balance != 123.45 {
		t.Fatalf("snapshot = %+v", snapshot)
	}
	if snapshot.OwnOffers[0]["rate"].(float64) != 1.1 {
		t.Fatalf("rate derivada = %v", snapshot.OwnOffers[0]["rate"])
	}
	if len(snapshot.OwnOffers) != 1 || len(snapshot.Transactions) != 1 {
		t.Fatalf("own=%d tx=%d", len(snapshot.OwnOffers), len(snapshot.Transactions))
	}
	if len(snapshot.Market["CLASICA"]["offers"].([]any)) != 1 || len(snapshot.Market["BANK_CUP"]["offers"].([]any)) != 1 {
		t.Fatalf("market = %+v", snapshot.Market)
	}
	if snapshot.Averages["CLASICA"].(map[string]any)["medianSell"].(float64) != 1.10 {
		t.Fatalf("market = %+v", snapshot.Market)
	}
	if snapshot.Transactions[0]["createdAt"].(int64) == 0 {
		t.Fatal("createdAt no se parseó")
	}
	if len(snapshot.Operations) != 1 || snapshot.Operations[0]["uuid"] != "p2p-1" {
		t.Fatalf("operations = %+v", snapshot.Operations)
	}

	live.Snapshot(context.Background())
	if reader.userCalls != 1 {
		t.Fatalf("cache no aplicada: userCalls=%d", reader.userCalls)
	}
}
