package main

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/AGR55/QvaApp/services/shared/decimal"
	"github.com/AGR55/QvaApp/services/trading-core/internal/platform/qvapay"
)

func TestValidateHunterPayload(t *testing.T) {
	valid := `{"offerUuid":"offer-1","coin":"BANK_CUP","side":"buy","decision":"auto_buy","amount":"10.00000000","receive":"18000.00000000","rate":"1800.00000000"}`
	if err := validateHunterPayload(valid); err != nil {
		t.Fatalf("payload válido rechazado: %v", err)
	}
	for _, payload := range []string{
		`{}`,
		`{"offerUuid":"offer-1","coin":"BANK_CUP","side":"x","decision":"auto_buy","amount":"1","receive":"1","rate":"1"}`,
		`{"offerUuid":"offer-1","coin":"BANK_CUP","side":"buy","decision":"blocked","amount":"1","receive":"1","rate":"1"}`,
		`{"offerUuid":"offer-1","coin":"BANK_CUP","side":"buy","decision":"auto_buy","amount":"1","receive":"1","rate":"0"}`,
		`no-json`,
	} {
		if err := validateHunterPayload(payload); err == nil {
			t.Fatalf("payload inválido aceptado: %s", payload)
		}
	}
}

func TestOfferStillEligibleToleraRedondeoDeTasa(t *testing.T) {
	onlyVIP := false
	other, _ := json.Marshal(map[string]string{"uuid": "otro"})
	reader := &fakeOfferReader{
		offer: qvapay.Offer{
			UUID: "offer-1", Status: "open", Type: "sell", OfferKind: "fixed",
			OnlyVIP: &onlyVIP, Rate: decimal.MustParse("1.017964071234"),
			Amount: decimal.MustParse("10"), Receive: decimal.MustParse("10.17964071234"),
			AvailableAmount: decimal.MustParse("10"), OwnerUUID: "otro", User: other,
		},
		user: qvapay.User{UUID: "yo"},
	}
	consumer := &hunterConsumer{reconciler: &operationReconciler{reader: reader}}
	task := executionTask{
		payload: hunterPayload{OfferUUID: "offer-1", Side: "buy", Rate: "1.01796407"},
		amount:  decimal.MustParse("10"),
	}
	ok, reason := consumer.offerStillEligible(context.Background(), task)
	if !ok {
		t.Fatalf("la diferencia de redondeo no debe bloquear: %s", reason)
	}
}
