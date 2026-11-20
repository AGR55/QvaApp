// Package ledger implementa el libro de reservas puro del núcleo. Garantiza
// que una operación no reserva dos veces y que la suma reservada nunca supera
// el saldo. No hace I/O ni gestión de concurrencia: el llamador serializa.
package ledger

import (
	"fmt"

	"github.com/AGR55/QvaApp/services/shared/decimal"
)

// Book es un saldo con reservas identificadas por operación.
type Book struct {
	balance  decimal.Value
	reserved map[string]decimal.Value
}

// New crea un libro con saldo no negativo.
func New(balance decimal.Value) (*Book, error) {
	if balance.Sign() < 0 {
		return nil, fmt.Errorf("el saldo no puede ser negativo")
	}
	return &Book{balance: balance, reserved: map[string]decimal.Value{}}, nil
}

// Balance devuelve el saldo total.
func (book *Book) Balance() decimal.Value {
	return book.balance
}

// Reserved devuelve la suma de reservas activas.
func (book *Book) Reserved() decimal.Value {
	total := decimal.Zero()
	for _, amount := range book.reserved {
		total = total.Add(amount)
	}
	return total
}

// Available devuelve el saldo libre.
func (book *Book) Available() decimal.Value {
	return book.balance.Sub(book.Reserved())
}

// Has indica si la operación ya tiene una reserva.
func (book *Book) Has(operationID string) bool {
	_, ok := book.reserved[operationID]
	return ok
}

// TryReserve reserva un importe positivo una sola vez por operación.
func (book *Book) TryReserve(operationID string, amount decimal.Value) bool {
	if operationID == "" || amount.Sign() <= 0 || book.Has(operationID) {
		return false
	}
	if book.Reserved().Add(amount).Cmp(book.balance) > 0 {
		return false
	}
	book.reserved[operationID] = amount
	return true
}

// Release libera la reserva de una operación. Devuelve si existía.
func (book *Book) Release(operationID string) bool {
	if !book.Has(operationID) {
		return false
	}
	delete(book.reserved, operationID)
	return true
}

// Reservations devuelve una copia de las reservas activas.
func (book *Book) Reservations() map[string]decimal.Value {
	result := make(map[string]decimal.Value, len(book.reserved))
	for operationID, amount := range book.reserved {
		result[operationID] = amount
	}
	return result
}
