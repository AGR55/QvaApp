package main

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/AGR55/QvaApp/services/shared/decimal"
	"github.com/AGR55/QvaApp/services/trading-core/internal/platform/qvapay"
)

type fakeLiveBalanceReader struct {
	balance decimal.Value
	err     error
	calls   int
}

func (reader *fakeLiveBalanceReader) Offer(context.Context, string) (qvapay.Offer, error) {
	return qvapay.Offer{}, nil
}

func (reader *fakeLiveBalanceReader) User(context.Context) (qvapay.User, error) {
	reader.calls++
	return qvapay.User{Balance: reader.balance}, reader.err
}

func TestCurrentBalanceUsaSaldoEnVivoYCachea(t *testing.T) {
	reader := &fakeLiveBalanceReader{balance: decimal.MustParse("83.32")}
	consumer := &hunterConsumer{reconciler: &operationReconciler{reader: reader}}

	if got := consumer.currentBalance(context.Background()); got.Cmp(decimal.MustParse("83.32")) != 0 {
		t.Fatalf("saldo = %s", got.Compact())
	}
	if got := consumer.currentBalance(context.Background()); got.Cmp(decimal.MustParse("83.32")) != 0 {
		t.Fatalf("saldo cacheado = %s", got.Compact())
	}
	if reader.calls != 1 {
		t.Fatalf("llamadas a /user = %d, quiero 1", reader.calls)
	}

	consumer.balanceAt = time.Now().Add(-2 * time.Second)
	reader.balance = decimal.MustParse("90")
	if got := consumer.currentBalance(context.Background()); got.Cmp(decimal.MustParse("90")) != 0 {
		t.Fatalf("saldo refrescado = %s", got.Compact())
	}
	if reader.calls != 2 {
		t.Fatalf("llamadas a /user = %d, quiero 2", reader.calls)
	}
}

func TestCurrentBalanceSinLecturaEnVivoQuedaEnCero(t *testing.T) {
	reader := &fakeLiveBalanceReader{err: errors.New("sin red")}
	consumer := &hunterConsumer{reconciler: &operationReconciler{reader: reader}}
	if got := consumer.currentBalance(context.Background()); got.Sign() != 0 {
		t.Fatalf("saldo = %s, quiero 0 sin snapshot disponible", got.Compact())
	}
}
