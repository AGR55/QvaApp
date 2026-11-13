package applybudget

import (
	"reflect"
	"testing"
)

func pointer(value int64) *int64 { return &value }

func TestAttemptsAndReadyAt(t *testing.T) {
	cases := []struct {
		name     string
		attempts []int64
		legacy   *int64
		retryAt  *int64
		now      int64
		want     []int64
		ready    int64
	}{
		{"vacío", nil, nil, nil, 1000, []int64{}, 1000},
		{"un intento", []int64{1000}, nil, nil, 1000, []int64{1000}, 1000},
		{"dos intentos", []int64{1000, 1000}, nil, nil, 1000, []int64{1000, 1000}, 61001},
		{"ventana abierta", []int64{1000, 1000}, nil, nil, 60000, []int64{1000, 1000}, 61001},
		{"último ms", []int64{1000, 1000}, nil, nil, 61000, []int64{1000, 1000}, 61001},
		{"expirada", []int64{1000, 1000}, nil, nil, 61001, []int64{1000, 1000}, 61001},
		{"retry", nil, nil, pointer(91000), 1000, []int64{}, 91000},
		{"retry domina", []int64{1000, 1000}, nil, pointer(91000), 61000, []int64{1000, 1000}, 91000},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			attempts := Attempts(test.attempts, test.legacy)
			if !reflect.DeepEqual(attempts, test.want) {
				t.Fatalf("attempts = %v, quiero %v", attempts, test.want)
			}
			if ready := ReadyAt(attempts, test.retryAt, test.now); ready != test.ready {
				t.Fatalf("readyAt = %d, quiero %d", ready, test.ready)
			}
		})
	}
}

func TestLegacyWindowRetainsBothAttempts(t *testing.T) {
	legacy := int64(1000)
	attempts := Attempts(nil, &legacy)
	want := []int64{1, 1000}
	if !reflect.DeepEqual(attempts, want) {
		t.Fatalf("attempts = %v, quiero %v", attempts, want)
	}
}
