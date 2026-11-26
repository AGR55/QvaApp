package main

import (
	"errors"
	"fmt"
	"testing"

	"github.com/AGR55/QvaApp/services/trading-core/internal/platform/qvapay"
)

func TestDefinitiveApplyRejection(t *testing.T) {
	cases := []struct {
		status int
		want   bool
	}{
		{400, true},
		{403, true},
		{409, true},
		{422, true},
		{401, false},
		{429, false},
		{500, false},
		{502, false},
	}
	for _, tc := range cases {
		t.Run(fmt.Sprintf("status_%d", tc.status), func(t *testing.T) {
			err := fmt.Errorf("envoltorio: %w", &qvapay.MutationError{Status: tc.status})
			if got := definitiveApplyRejection(err); got != tc.want {
				t.Fatalf("definitiveApplyRejection = %v, quiero %v", got, tc.want)
			}
		})
	}
	if definitiveApplyRejection(errors.New("red")) {
		t.Fatal("un error de red no es un rechazo definitivo")
	}
	if definitiveApplyRejection(nil) {
		t.Fatal("nil no es un rechazo")
	}
}
