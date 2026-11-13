package ledger

import (
	"fmt"
	"testing"
	"testing/quick"

	"github.com/AGR55/QvaApp/services/shared/decimal"
)

type operation struct {
	Kind   uint8
	ID     uint8
	Amount uint16
}

func TestReservationInvariants(t *testing.T) {
	property := func(operations []operation) bool {
		book, err := New(decimal.FromInt(1_000))
		if err != nil {
			return false
		}
		active := map[string]bool{}
		for _, op := range operations {
			id := fmt.Sprintf("operation-%d", op.ID%8)
			amount := decimal.FromInt(int64(op.Amount % 1_200))
			switch op.Kind % 3 {
			case 0, 1:
				expected := amount.Sign() > 0 && amount.Cmp(book.Available()) <= 0 && !active[id]
				if got := book.TryReserve(id, amount); got != expected {
					return false
				}
				if expected {
					active[id] = true
				}
			case 2:
				expected := active[id]
				if got := book.Release(id); got != expected {
					return false
				}
				delete(active, id)
			}
			if book.Available().Sign() < 0 || book.Reserved().Cmp(book.Balance()) > 0 {
				return false
			}
			reserved := decimal.Zero()
			for operationID, value := range book.Reservations() {
				if value.Sign() <= 0 || !active[operationID] {
					return false
				}
				reserved = reserved.Add(value)
			}
			if reserved.Cmp(book.Reserved()) != 0 || len(book.Reservations()) != len(active) {
				return false
			}
		}
		return true
	}
	if err := quick.Check(property, &quick.Config{MaxCount: 500}); err != nil {
		t.Fatal(err)
	}
}

func TestReservationRejectsDuplicateAndOverdraft(t *testing.T) {
	book, _ := New(decimal.FromInt(100))
	if !book.TryReserve("first", decimal.FromInt(60)) {
		t.Fatal("la primera reserva debe aceptarse")
	}
	if book.TryReserve("first", decimal.FromInt(10)) {
		t.Fatal("la misma operación no puede reservar dos veces")
	}
	if book.TryReserve("second", decimal.FromInt(50)) {
		t.Fatal("la segunda reserva supera el saldo libre")
	}
	if !book.Release("first") || book.Release("first") {
		t.Fatal("release debe ser idempotente en falso")
	}
	if !book.TryReserve("second", decimal.FromInt(100)) {
		t.Fatal("la reserva debe aceptarse tras liberar")
	}
	if book.Available().Sign() != 0 {
		t.Fatalf("disponible = %s", book.Available().Format(8))
	}
}
