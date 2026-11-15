package core

import (
	"fmt"
	"strings"

	"github.com/AGR55/QvaApp/services/shared/decimal"
)

// OperationState es el estado de una operación shadow. La máquina de estados
// es pura: no hace I/O ni mueve dinero; solo describe en qué punto del ciclo
// de vida se encuentra una operación.
type OperationState string

const (
	// StateCreated indica que la operación existe pero aún no reservó capital.
	StateCreated OperationState = "created"
	// StateReserved indica que el capital de la operación está reservado.
	StateReserved OperationState = "reserved"
	// StateSubmitted indica que la operación fue enviada a QvaPay.
	StateSubmitted OperationState = "submitted"
	// StateConfirmed es el estado terminal de una operación aplicada.
	StateConfirmed OperationState = "confirmed"
	// StateRejected es el estado terminal de una operación que no se aplicó.
	StateRejected OperationState = "rejected"
	// StateUncertain indica un resultado remoto ambiguo que exige conciliación.
	StateUncertain OperationState = "uncertain"
	// StateReconciled es el estado terminal de una operación incierta resuelta.
	StateReconciled OperationState = "reconciled"
	// StateDryRun marca una simulación del motor autónomo. No es dinero real.
	StateDryRun OperationState = "dry_run"
)

// Operation es una operación shadow del core. Es un valor inmutable: cada
// transición devuelve una copia nueva. Los importes son exactos y siempre
// positivos; UpdatedAt es el instante lógico (epoch en milisegundos) del
// último cambio de estado.
type Operation struct {
	ID         string
	State      OperationState
	QusdAmount decimal.Value
	FiatAmount decimal.Value
	// OrderUUID identifica la orden flexible creada en QvaPay. Es opaco y se
	// conserva para poder cancelar o conciliar la operación real.
	OrderUUID string
	UpdatedAt int64
}

// NewOperation crea una operación en estado created. El ID es opaco y se
// conserva tal cual se recibe; solo se rechazan identificadores vacíos o
// compuestos únicamente por espacios. Ambos importes deben ser positivos.
func NewOperation(id string, qusd, fiat decimal.Value, now int64) (Operation, error) {
	if strings.TrimSpace(id) == "" {
		return Operation{}, fmt.Errorf("operación sin ID: se requiere un identificador")
	}
	if qusd.Sign() <= 0 {
		return Operation{}, fmt.Errorf("importe QUSD inválido: %s", qusd.Format(8))
	}
	if fiat.Sign() <= 0 {
		return Operation{}, fmt.Errorf("importe fiat inválido: %s", fiat.Format(8))
	}
	return Operation{
		ID:         id,
		State:      StateCreated,
		QusdAmount: qusd,
		FiatAmount: fiat,
		UpdatedAt:  now,
	}, nil
}

// Transition devuelve una copia de la operación en el estado next. No muta el
// receptor. Rechaza transiciones no-op, estados desconocidos, cualquier salida
// desde un estado terminal, transiciones fuera de la máquina y timestamps que
// retroceden. Un timestamp igual al actual sí se acepta (varias transiciones
// pueden ocurrir en el mismo instante lógico).
func (op Operation) Transition(next OperationState, now int64) (Operation, error) {
	if next == op.State {
		return Operation{}, fmt.Errorf("transición no-op: la operación %q ya está en estado %q", op.ID, op.State)
	}
	if !next.valid() {
		return Operation{}, fmt.Errorf("estado de operación desconocido: %q", next)
	}
	if op.Terminal() {
		return Operation{}, fmt.Errorf(
			"transición inválida: la operación %q está en estado terminal %q",
			op.ID, op.State,
		)
	}
	if now < op.UpdatedAt {
		return Operation{}, fmt.Errorf(
			"timestamp no puede retroceder para la operación %q: %d < %d",
			op.ID, now, op.UpdatedAt,
		)
	}
	if !canTransition(op.State, next) {
		return Operation{}, fmt.Errorf("transición inválida: %q -> %q", op.State, next)
	}
	transitioned := op
	transitioned.State = next
	transitioned.UpdatedAt = now
	return transitioned, nil
}

// Terminal indica si la operación alcanzó un estado sin salidas.
func (op Operation) Terminal() bool {
	switch op.State {
	case StateConfirmed, StateRejected, StateReconciled, StateDryRun:
		return true
	default:
		return false
	}
}

// RequiresReconciliation indica si el resultado remoto es ambiguo y debe
// compararse contra QvaPay antes de continuar.
func (op Operation) RequiresReconciliation() bool {
	return op.State == StateUncertain
}

func (state OperationState) valid() bool {
	switch state {
	case StateCreated, StateReserved, StateSubmitted, StateConfirmed,
		StateRejected, StateUncertain, StateReconciled, StateDryRun:
		return true
	default:
		return false
	}
}

func canTransition(from, to OperationState) bool {
	switch from {
	case StateCreated:
		return to == StateReserved
	case StateReserved:
		return to == StateSubmitted
	case StateSubmitted:
		return to == StateConfirmed || to == StateRejected || to == StateUncertain || to == StateDryRun
	case StateUncertain:
		return to == StateReconciled || to == StateRejected
	default:
		return false
	}
}
