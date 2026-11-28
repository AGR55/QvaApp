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

func TestCurrentBalanceNoBloqueaYUsaElRefresco(t *testing.T) {
	reader := &fakeLiveBalanceReader{balance: decimal.MustParse("83.32")}
	consumer := &hunterConsumer{reconciler: &operationReconciler{reader: reader}}

	if got := consumer.currentBalance(context.Background()); got.Sign() != 0 {
		t.Fatalf("antes del refresco el saldo debe ser cero, es %s", got.Compact())
	}
	if reader.calls != 0 {
		t.Fatalf("currentBalance no debe llamar a QvaPay, llamadas = %d", reader.calls)
	}
	consumer.refreshBalance(context.Background())
	if got := consumer.currentBalance(context.Background()); got.Cmp(decimal.MustParse("83.32")) != 0 {
		t.Fatalf("saldo tras refresco = %s", got.Compact())
	}
	if reader.calls != 1 {
		t.Fatalf("llamadas a /user = %d, quiero 1", reader.calls)
	}
}

func TestRefreshBalanceConservaElUltimoValorSiFallaLaLectura(t *testing.T) {
	reader := &fakeLiveBalanceReader{balance: decimal.MustParse("50")}
	consumer := &hunterConsumer{reconciler: &operationReconciler{reader: reader}}
	consumer.refreshBalance(context.Background())

	reader.err = errors.New("sin red")
	consumer.refreshBalance(context.Background())
	if got := consumer.currentBalance(context.Background()); got.Cmp(decimal.MustParse("50")) != 0 {
		t.Fatalf("un fallo no debe borrar el último saldo válido: %s", got.Compact())
	}
}

func TestDebitBalanceDescuentaLaVentaConfirmada(t *testing.T) {
	consumer := &hunterConsumer{balanceValue: decimal.MustParse("83.32"), balanceAt: time.Now()}
	consumer.debitBalance(decimal.MustParse("20"))
	if got := consumer.currentBalance(context.Background()); got.Cmp(decimal.MustParse("63.32")) != 0 {
		t.Fatalf("saldo tras venta = %s", got.Compact())
	}
	consumer.debitBalance(decimal.MustParse("100"))
	if got := consumer.currentBalance(context.Background()); got.Sign() != 0 {
		t.Fatalf("el saldo no puede ser negativo: %s", got.Compact())
	}
}

func TestApplyTraceRegistraTramos(t *testing.T) {
	trace := &applyTrace{}
	client := trace.clientTrace()
	client.GetConn("api.qvapay.com:443")
	time.Sleep(2 * time.Millisecond)
	client.GotConn(gotConnInfo(true))
	trace.markDispatch()
	time.Sleep(2 * time.Millisecond)
	client.GotFirstResponseByte()

	timing := trace.snapshot(time.Now().Add(-50 * time.Millisecond).UnixMilli())
	if !timing.connReused {
		t.Fatal("la conexión reutilizada no se registró")
	}
	if timing.receiveToDispatchMS < 40 {
		t.Fatalf("receive_to_dispatch_ms = %d", timing.receiveToDispatchMS)
	}
	if timing.firstByteMS < 1 {
		t.Fatalf("first_byte_ms = %d", timing.firstByteMS)
	}
}

func TestApplyTraceSinContextoNoFalla(t *testing.T) {
	if applyTraceFrom(context.Background()) != nil {
		t.Fatal("no debe haber traza sin contexto")
	}
	if got := withApplyTrace(context.Background(), nil); applyTraceFrom(got) != nil {
		t.Fatal("una traza nula no debe guardarse")
	}
}
