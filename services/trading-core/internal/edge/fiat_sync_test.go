package edge

import (
	"context"
	"encoding/json"
	"net/url"
	"testing"

	"github.com/AGR55/QvaApp/services/shared/decimal"
	"github.com/AGR55/QvaApp/services/trading-core/internal/platform/qvapay"
)

type fakeFiatReader struct {
	profile qvapay.User
	created []qvapay.Offer
	peer    []qvapay.Offer
	detail  map[string]qvapay.Offer
}

func (reader *fakeFiatReader) User(context.Context) (qvapay.User, error) {
	return reader.profile, nil
}

func (reader *fakeFiatReader) Offers(_ context.Context, params url.Values) ([]qvapay.Offer, error) {
	if params.Get("my") == "true" {
		return reader.created, nil
	}
	if params.Get("peer") == reader.profile.UUID {
		return reader.peer, nil
	}
	return nil, nil
}

func (reader *fakeFiatReader) Offer(_ context.Context, uuid string) (qvapay.Offer, error) {
	return reader.detail[uuid], nil
}

type fiatCall struct {
	coin, key, offerType string
	receive              float64
	status               string
}

type fakeFiatRecorder struct {
	calls   []fiatCall
	changed bool
}

func (recorder *fakeFiatRecorder) RecordOperationFiat(
	_ context.Context,
	coin, key, offerType string,
	receive float64,
	status, _ string,
	_ int64,
) (bool, error) {
	recorder.calls = append(recorder.calls, fiatCall{
		coin: coin, key: key, offerType: offerType, receive: receive, status: status,
	})
	return recorder.changed, nil
}

func flexibleOffer(
	uuid, offerType, owner, taker string,
	orderUUID, orderStatus string,
	receive string,
	releasedAt int64,
) qvapay.Offer {
	takerRaw, _ := json.Marshal(map[string]string{"uuid": taker})
	ownerRaw, _ := json.Marshal(map[string]string{"uuid": owner})
	return qvapay.Offer{
		UUID: uuid, Type: offerType, Coin: "BANK_CUP", OfferKind: "flexible",
		User: ownerRaw, OwnerUUID: owner,
		Orders: []qvapay.OfferOrder{{
			UUID: orderUUID, Status: orderStatus,
			Receive: decimal.MustParse(receive), ReleasedAt: releasedAt,
			UpdatedAt: releasedAt, CreatedAt: releasedAt, Taker: takerRaw,
		}},
	}
}

func TestFiatSyncRegistraOrdenesFlexiblesSegunRol(t *testing.T) {
	cases := []struct {
		name      string
		offerType string
		creator   bool
		wantType  string
	}{
		{"propia de venta acredita", "sell", true, "buy"},
		{"propia de compra debita", "buy", true, "sell"},
		{"tomada de venta debita", "sell", false, "sell"},
		{"tomada de compra acredita", "buy", false, "buy"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			offer := flexibleOffer("offer-1", tc.offerType, "otro", "me",
				"order-1", "completed", "123.45", 2000)
			reader := &fakeFiatReader{profile: qvapay.User{UUID: "me"}}
			if tc.creator {
				offer = flexibleOffer("offer-1", tc.offerType, "me", "otro",
					"order-1", "completed", "123.45", 2000)
				reader.created = []qvapay.Offer{offer}
			} else {
				reader.peer = []qvapay.Offer{offer}
			}
			recorder := &fakeFiatRecorder{changed: true}
			syncer := &FiatSyncer{
				Reader: reader, Recorder: recorder,
				StartedAt: func(context.Context) int64 { return 1000 },
			}
			movements, err := syncer.Sync(context.Background())
			if err != nil {
				t.Fatalf("Sync: %v", err)
			}
			if movements != 1 || len(recorder.calls) != 1 {
				t.Fatalf("movements=%d calls=%+v", movements, recorder.calls)
			}
			call := recorder.calls[0]
			if call.key != "order-1" || call.coin != "BANK_CUP" ||
				call.offerType != tc.wantType || call.status != "completed" {
				t.Fatalf("llamada inesperada: %+v", call)
			}
			if call.receive != 123.45 {
				t.Fatalf("importe = %v", call.receive)
			}
		})
	}
}

func TestFiatSyncIgnoraOrdenesPreviasOIncompletas(t *testing.T) {
	reader := &fakeFiatReader{
		profile: qvapay.User{UUID: "me"},
		created: []qvapay.Offer{
			flexibleOffer("vieja", "buy", "me", "otro", "order-vieja", "completed", "10", 500),
			flexibleOffer("abierta", "buy", "me", "otro", "order-abierta", "processing", "10", 2000),
		},
	}
	recorder := &fakeFiatRecorder{changed: true}
	syncer := &FiatSyncer{
		Reader: reader, Recorder: recorder,
		StartedAt: func(context.Context) int64 { return 1000 },
	}
	movements, err := syncer.Sync(context.Background())
	if err != nil {
		t.Fatalf("Sync: %v", err)
	}
	if movements != 0 || len(recorder.calls) != 0 {
		t.Fatalf("movements=%d calls=%+v", movements, recorder.calls)
	}
}

func TestFiatSyncHidrataDetalleDeOfertaFlexible(t *testing.T) {
	listed := flexibleOffer("offer-1", "sell", "me", "otro", "", "", "0", 0)
	listed.Orders = nil
	detail := flexibleOffer("offer-1", "sell", "me", "otro", "order-1", "completed", "77", 2000)
	reader := &fakeFiatReader{
		profile: qvapay.User{UUID: "me"},
		created: []qvapay.Offer{listed},
		detail:  map[string]qvapay.Offer{"offer-1": detail},
	}
	recorder := &fakeFiatRecorder{changed: true}
	syncer := &FiatSyncer{
		Reader: reader, Recorder: recorder,
		StartedAt: func(context.Context) int64 { return 1000 },
	}
	movements, err := syncer.Sync(context.Background())
	if err != nil {
		t.Fatalf("Sync: %v", err)
	}
	if movements != 1 || len(recorder.calls) != 1 || recorder.calls[0].key != "order-1" {
		t.Fatalf("movements=%d calls=%+v", movements, recorder.calls)
	}
}
