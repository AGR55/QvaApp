package main

import "testing"

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
