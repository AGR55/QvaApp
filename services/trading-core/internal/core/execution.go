package core

import (
	"encoding/json"
	"fmt"
	"strings"

	"github.com/AGR55/QvaApp/services/shared/decimal"
)

// Direcciones contables de un movimiento del ledger shadow.
const (
	DirectionDebit  = "debit"
	DirectionCredit = "credit"

	qusdLedgerCode = "qusd"
)

// LedgerEntry es un movimiento simulado del ledger shadow. Nunca representa
// una escritura real: solo describe el debe/haber que produciría la ejecución.
type LedgerEntry struct {
	Code      string
	Direction string
	Amount    decimal.Value
	Reason    string
}

// MarshalJSON expone el importe como texto decimal estable.
func (entry LedgerEntry) MarshalJSON() ([]byte, error) {
	return json.Marshal(struct {
		Code      string `json:"code"`
		Direction string `json:"direction"`
		Amount    string `json:"amount"`
		Reason    string `json:"reason"`
	}{
		Code: entry.Code, Direction: entry.Direction,
		Amount: entry.Amount.Format(8), Reason: entry.Reason,
	})
}

// ExecutionInput reúne la decisión ya evaluada y el estado con el que se quiere
// simular su ejecución. ReserveQusd es el saldo QUSD que debe permanecer
// reservado; AvailableQusd es el saldo total antes de la operación.
type ExecutionInput struct {
	Event         Event
	Result        Result
	AvailableQusd decimal.Value
	ReserveQusd   decimal.Value
	OperationID   string
}

// Execution es el resultado determinista de una simulación. No se persiste ni
// se muta ningún saldo: el llamador es responsable de guardar OperationID para
// evitar ejecutar dos veces la misma operación.
type Execution struct {
	Allowed       bool
	OperationID   string
	QusdAmount    decimal.Value
	ReserveQusd   decimal.Value
	RemainingQusd decimal.Value
	LedgerEntries []LedgerEntry
	Reason        string
}

// SimulateExecution calcula el efecto contable de una decisión allowed sin
// hacer I/O. Una compra debita fiat y acredita QUSD sin reservar QUSD; una
// venta consume QUSD del saldo libre (AvailableQusd - ReserveQusd) y acredita
// fiat. Las entradas no se ordenan por mapas, por lo que la misma entrada
// produce siempre la misma salida.
func SimulateExecution(input ExecutionInput) (Execution, error) {
	if !input.Result.Allowed {
		return Execution{
			Allowed:     false,
			OperationID: input.OperationID,
			Reason:      rejectionReason(input.Result),
		}, nil
	}
	if strings.TrimSpace(input.OperationID) == "" {
		return Execution{}, fmt.Errorf("ejecución sin OperationID: se requiere un identificador idempotente")
	}

	side := input.Event.Side
	if side != "buy" && side != "sell" {
		return Execution{}, fmt.Errorf("lado desconocido para ejecución: %q", side)
	}
	amount := input.Event.Amount
	if amount.Sign() <= 0 {
		return Execution{}, fmt.Errorf("importe QUSD inválido: %s", amount.Format(8))
	}
	receive := input.Event.Receive
	if receive.Sign() <= 0 {
		return Execution{}, fmt.Errorf("importe fiat inválido: %s", receive.Format(8))
	}
	available := input.AvailableQusd
	if available.Sign() < 0 {
		return Execution{}, fmt.Errorf("saldo QUSD disponible negativo: %s", available.Format(8))
	}
	reserve := input.ReserveQusd
	if reserve.Sign() < 0 {
		return Execution{}, fmt.Errorf("reserva QUSD negativa: %s", reserve.Format(8))
	}

	if side == "buy" {
		return simulateBuy(input, amount, receive, available), nil
	}
	return simulateSell(input, amount, receive, available, reserve)
}

// simulateBuy simula una compra de QUSD. No reserva QUSD: el saldo QUSD crece
// con el importe recibido y el fiat sale por Event.Receive.
func simulateBuy(input ExecutionInput, amount, receive, available decimal.Value) Execution {
	return Execution{
		Allowed:       true,
		OperationID:   input.OperationID,
		QusdAmount:    amount,
		ReserveQusd:   decimal.Zero(),
		RemainingQusd: available.Add(amount),
		LedgerEntries: []LedgerEntry{
			{
				Code:      fiatLedgerCode(input.Event.Coin),
				Direction: DirectionDebit,
				Amount:    receive,
				Reason:    "Fiat enviado por la compra simulada de QUSD.",
			},
			{
				Code:      qusdLedgerCode,
				Direction: DirectionCredit,
				Amount:    amount,
				Reason:    "QUSD recibido por la compra simulada.",
			},
		},
		Reason: "Compra de QUSD simulada: fiat debitado y QUSD acreditado sin reserva QUSD.",
	}
}

// simulateSell simula una venta de QUSD. El importe se consume del saldo libre
// (disponible menos reserva) y el fiat recibido se acredita.
func simulateSell(input ExecutionInput, amount, receive, available, reserve decimal.Value) (Execution, error) {
	free := available.Sub(reserve)
	if free.Cmp(amount) < 0 {
		return Execution{}, fmt.Errorf(
			"saldo QUSD insuficiente: disponible %s, reserva %s, importe %s",
			available.Format(8), reserve.Format(8), amount.Format(8),
		)
	}
	return Execution{
		Allowed:       true,
		OperationID:   input.OperationID,
		QusdAmount:    amount,
		ReserveQusd:   reserve,
		RemainingQusd: free.Sub(amount),
		LedgerEntries: []LedgerEntry{
			{
				Code:      qusdLedgerCode,
				Direction: DirectionDebit,
				Amount:    amount,
				Reason:    "QUSD entregado por la venta simulada.",
			},
			{
				Code:      fiatLedgerCode(input.Event.Coin),
				Direction: DirectionCredit,
				Amount:    receive,
				Reason:    "Fiat recibido por la venta simulada.",
			},
		},
		Reason: "Venta de QUSD simulada: QUSD debitado del saldo libre y fiat acreditado.",
	}, nil
}

func fiatLedgerCode(coin string) string {
	coin = strings.TrimSpace(coin)
	if coin == "" {
		return "fiat"
	}
	return "fiat:" + coin
}

func rejectionReason(result Result) string {
	if len(result.Reasons) == 0 {
		return "La decisión no permite ejecutar la operación."
	}
	return "La decisión no permite ejecutar: " + strings.Join(result.Reasons, "; ")
}
