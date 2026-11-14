package core

import (
	"strings"
	"testing"

	"github.com/AGR55/QvaApp/services/shared/decimal"
)

var allOperationStates = []OperationState{
	StateCreated,
	StateReserved,
	StateSubmitted,
	StateConfirmed,
	StateRejected,
	StateUncertain,
	StateReconciled,
}

func mustNewOperation(t *testing.T, now int64) Operation {
	t.Helper()
	op, err := NewOperation("op-1", decimal.MustParse("10.5"), decimal.MustParse("15000"), now)
	if err != nil {
		t.Fatalf("NewOperation válida devolvió error: %v", err)
	}
	return op
}

func mustTransition(t *testing.T, op Operation, next OperationState, now int64) Operation {
	t.Helper()
	transitioned, err := op.Transition(next, now)
	if err != nil {
		t.Fatalf("transición %q -> %q falló: %v", op.State, next, err)
	}
	return transitioned
}

// operationInState construye una operación por la ruta canónica hasta state.
func operationInState(t *testing.T, state OperationState, now int64) Operation {
	t.Helper()
	op := mustNewOperation(t, now)
	switch state {
	case StateCreated:
		return op
	case StateReserved:
		return mustTransition(t, op, StateReserved, now+1)
	case StateSubmitted:
		op = mustTransition(t, op, StateReserved, now+1)
		return mustTransition(t, op, StateSubmitted, now+2)
	case StateConfirmed:
		op = mustTransition(t, op, StateReserved, now+1)
		op = mustTransition(t, op, StateSubmitted, now+2)
		return mustTransition(t, op, StateConfirmed, now+3)
	case StateRejected:
		op = mustTransition(t, op, StateReserved, now+1)
		op = mustTransition(t, op, StateSubmitted, now+2)
		return mustTransition(t, op, StateRejected, now+3)
	case StateUncertain:
		op = mustTransition(t, op, StateReserved, now+1)
		op = mustTransition(t, op, StateSubmitted, now+2)
		return mustTransition(t, op, StateUncertain, now+3)
	case StateReconciled:
		op = mustTransition(t, op, StateReserved, now+1)
		op = mustTransition(t, op, StateSubmitted, now+2)
		op = mustTransition(t, op, StateUncertain, now+3)
		return mustTransition(t, op, StateReconciled, now+4)
	default:
		op.State = state
		return op
	}
}

func allowedTransition(from, to OperationState) bool {
	switch from {
	case StateCreated:
		return to == StateReserved
	case StateReserved:
		return to == StateSubmitted
	case StateSubmitted:
		return to == StateConfirmed || to == StateRejected || to == StateUncertain
	case StateUncertain:
		return to == StateReconciled || to == StateRejected
	default:
		return false
	}
}

func requireOperationAmounts(t *testing.T, op Operation) {
	t.Helper()
	if op.QusdAmount.Cmp(decimal.MustParse("10.5")) != 0 {
		t.Fatalf("QusdAmount = %s, se esperaba 10.5", op.QusdAmount.Format(8))
	}
	if op.FiatAmount.Cmp(decimal.MustParse("15000")) != 0 {
		t.Fatalf("FiatAmount = %s, se esperaba 15000", op.FiatAmount.Format(8))
	}
}

func TestNewOperation(t *testing.T) {
	op, err := NewOperation("op-123", decimal.MustParse("20"), decimal.MustParse("24000"), 1234)
	if err != nil {
		t.Fatal(err)
	}
	if op.ID != "op-123" {
		t.Fatalf("ID = %q, se esperaba %q", op.ID, "op-123")
	}
	if op.State != StateCreated {
		t.Fatalf("State = %q, se esperaba %q", op.State, StateCreated)
	}
	if op.QusdAmount.Cmp(decimal.MustParse("20")) != 0 {
		t.Fatalf("QusdAmount = %s, se esperaba 20", op.QusdAmount.Format(8))
	}
	if op.FiatAmount.Cmp(decimal.MustParse("24000")) != 0 {
		t.Fatalf("FiatAmount = %s, se esperaba 24000", op.FiatAmount.Format(8))
	}
	if op.UpdatedAt != 1234 {
		t.Fatalf("UpdatedAt = %d, se esperaba 1234", op.UpdatedAt)
	}
	if op.Terminal() || op.RequiresReconciliation() {
		t.Fatalf("una operación nueva no debe ser terminal ni exigir conciliación: %+v", op)
	}
}

func TestNewOperationPrecisionAndZeroTimestamp(t *testing.T) {
	op, err := NewOperation("op-precise", decimal.MustParse("0.00000001"), decimal.MustParse("0.00000002"), 0)
	if err != nil {
		t.Fatal(err)
	}
	if op.QusdAmount.Cmp(decimal.MustParse("0.00000001")) != 0 {
		t.Fatalf("QusdAmount perdió precisión: %s", op.QusdAmount.Format(8))
	}
	if op.FiatAmount.Cmp(decimal.MustParse("0.00000002")) != 0 {
		t.Fatalf("FiatAmount perdió precisión: %s", op.FiatAmount.Format(8))
	}
	if op.UpdatedAt != 0 {
		t.Fatalf("UpdatedAt = %d, se esperaba 0", op.UpdatedAt)
	}
}

func TestNewOperationInvalidID(t *testing.T) {
	for _, id := range []string{"", "   ", "\t\n", " \u00a0"} {
		t.Run("id="+strings.ReplaceAll(id, "\n", "\\n"), func(t *testing.T) {
			op, err := NewOperation(id, decimal.MustParse("1"),
				decimal.MustParse("1"), 1000)
			if err == nil {
				t.Fatalf("se esperaba error para ID %q, operación = %+v", id, op)
			}
			if op != (Operation{}) {
				t.Fatalf("una entrada inválida no debe producir operación: %+v", op)
			}
		})
	}
}

func TestNewOperationInvalidAmounts(t *testing.T) {
	cases := []struct {
		name string
		qusd string
		fiat string
	}{
		{"qusd cero", "0", "1"},
		{"qusd negativo", "-0.00000001", "1"},
		{"fiat cero", "1", "0"},
		{"fiat negativo", "1", "-1"},
		{"ambos cero", "0", "0"},
		{"ambos negativos", "-1", "-1"},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			op, err := NewOperation("op-1", decimal.MustParse(testCase.qusd),
				decimal.MustParse(testCase.fiat), 1000)
			if err == nil {
				t.Fatalf("se esperaba error con qusd=%s fiat=%s, operación = %+v",
					testCase.qusd, testCase.fiat, op)
			}
			if op != (Operation{}) {
				t.Fatalf("una entrada inválida no debe producir operación: %+v", op)
			}
		})
	}
}

func TestNewOperationErrorsIdentifyAmount(t *testing.T) {
	if _, err := NewOperation("op-1", decimal.Zero(), decimal.MustParse("1"), 1); err == nil ||
		!strings.Contains(err.Error(), "QUSD") {
		t.Fatalf("el error debe identificar el importe QUSD: %v", err)
	}
	if _, err := NewOperation("op-1", decimal.MustParse("1"), decimal.Zero(), 1); err == nil ||
		!strings.Contains(err.Error(), "fiat") {
		t.Fatalf("el error debe identificar el importe fiat: %v", err)
	}
}

func TestTransitionMatrix(t *testing.T) {
	for _, from := range allOperationStates {
		for _, to := range allOperationStates {
			t.Run(string(from)+"_to_"+string(to), func(t *testing.T) {
				source := operationInState(t, from, 1000)
				before := source
				next, err := source.Transition(to, 2000)
				if allowedTransition(from, to) {
					if err != nil {
						t.Fatalf("transición permitida %q -> %q falló: %v", from, to, err)
					}
					if next.State != to {
						t.Fatalf("State = %q, se esperaba %q", next.State, to)
					}
					if next.UpdatedAt != 2000 {
						t.Fatalf("UpdatedAt = %d, se esperaba 2000", next.UpdatedAt)
					}
					if next.ID != before.ID {
						t.Fatalf("ID cambió: %q != %q", next.ID, before.ID)
					}
					requireOperationAmounts(t, next)
					return
				}
				if err == nil {
					t.Fatalf("transición inválida %q -> %q no falló: %+v", from, to, next)
				}
				if next != (Operation{}) {
					t.Fatalf("una transición inválida no debe producir operación: %+v", next)
				}
				if source.State != before.State || source.UpdatedAt != before.UpdatedAt {
					t.Fatalf("la transición inválida mutó el receptor: %+v", source)
				}
			})
		}
	}
}

func TestTransitionValidLifecycles(t *testing.T) {
	paths := [][]OperationState{
		{StateReserved, StateSubmitted, StateConfirmed},
		{StateReserved, StateSubmitted, StateRejected},
		{StateReserved, StateSubmitted, StateUncertain, StateReconciled},
		{StateReserved, StateSubmitted, StateUncertain, StateRejected},
	}
	for _, path := range paths {
		op := mustNewOperation(t, 1000)
		for index, next := range path {
			now := int64(2000 + index)
			op = mustTransition(t, op, next, now)
			if op.State != next {
				t.Fatalf("paso %d: State = %q, se esperaba %q", index, op.State, next)
			}
			if op.UpdatedAt != now {
				t.Fatalf("paso %d: UpdatedAt = %d, se esperaba %d", index, op.UpdatedAt, now)
			}
			if op.ID != "op-1" {
				t.Fatalf("paso %d: ID cambió a %q", index, op.ID)
			}
			requireOperationAmounts(t, op)
		}
		if !op.State.valid() {
			t.Fatalf("la ruta terminó en un estado desconocido: %q", op.State)
		}
	}
}

func TestTransitionRejectsNoOp(t *testing.T) {
	for _, state := range allOperationStates {
		t.Run(string(state), func(t *testing.T) {
			source := operationInState(t, state, 1000)
			before := source
			next, err := source.Transition(state, 2000)
			if err == nil {
				t.Fatalf("transición no-op %q -> %q no falló: %+v", state, state, next)
			}
			if !strings.Contains(err.Error(), "no-op") {
				t.Fatalf("error inesperado: %v", err)
			}
			if source.State != before.State || source.UpdatedAt != before.UpdatedAt {
				t.Fatalf("la transición no-op mutó el receptor: %+v", source)
			}
		})
	}
}

func TestTransitionRejectsTerminalStates(t *testing.T) {
	terminals := []OperationState{StateConfirmed, StateRejected, StateReconciled}
	for _, terminal := range terminals {
		t.Run(string(terminal), func(t *testing.T) {
			source := operationInState(t, terminal, 1000)
			before := source
			for _, destination := range allOperationStates {
				next, err := source.Transition(destination, 2000)
				if err == nil {
					t.Fatalf("estado terminal %q permitió transición a %q: %+v", terminal, destination, next)
				}
				if destination != terminal && !strings.Contains(err.Error(), "terminal") {
					t.Fatalf("error inesperado para %q -> %q: %v", terminal, destination, err)
				}
			}
			if source.State != before.State || source.UpdatedAt != before.UpdatedAt {
				t.Fatalf("un estado terminal fue mutado: %+v", source)
			}
		})
	}
}

func TestTransitionRejectsUnknownStates(t *testing.T) {
	source := mustNewOperation(t, 1000)
	for _, destination := range []OperationState{"", "pending", "Confirmed", "unknown"} {
		next, err := source.Transition(destination, 2000)
		if err == nil {
			t.Fatalf("estado destino %q no fue rechazado: %+v", destination, next)
		}
		if !strings.Contains(err.Error(), "desconocido") {
			t.Fatalf("error inesperado para %q: %v", destination, err)
		}
	}

	broken := mustNewOperation(t, 1000)
	broken.State = "corrupt"
	if _, err := broken.Transition(StateReserved, 2000); err == nil {
		t.Fatal("un estado actual desconocido debe rechazar la transición")
	}
}

func TestTransitionRejectsBackwardsTimestamp(t *testing.T) {
	for _, from := range allOperationStates {
		for _, to := range allOperationStates {
			if !allowedTransition(from, to) {
				continue
			}
			t.Run(string(from)+"_to_"+string(to), func(t *testing.T) {
				source := operationInState(t, from, 1000)
				before := source
				next, err := source.Transition(to, source.UpdatedAt-1)
				if err == nil {
					t.Fatalf("timestamp retrocedido %q -> %q no falló: %+v", from, to, next)
				}
				if !strings.Contains(err.Error(), "retroceder") {
					t.Fatalf("error inesperado: %v", err)
				}
				if source.State != before.State || source.UpdatedAt != before.UpdatedAt {
					t.Fatalf("la transición rechazada mutó el receptor: %+v", source)
				}
			})
		}
	}
}

func TestTransitionAllowsEqualTimestamp(t *testing.T) {
	for _, from := range allOperationStates {
		for _, to := range allOperationStates {
			if !allowedTransition(from, to) {
				continue
			}
			t.Run(string(from)+"_to_"+string(to), func(t *testing.T) {
				source := operationInState(t, from, 1000)
				next, err := source.Transition(to, source.UpdatedAt)
				if err != nil {
					t.Fatalf("el mismo instante debe permitirse: %v", err)
				}
				if next.UpdatedAt != source.UpdatedAt {
					t.Fatalf("UpdatedAt = %d, se esperaba %d", next.UpdatedAt, source.UpdatedAt)
				}
			})
		}
	}
}

func TestTransitionDoesNotMutateReceiver(t *testing.T) {
	source := mustNewOperation(t, 1000)
	beforeState := source.State
	beforeTimestamp := source.UpdatedAt

	next := mustTransition(t, source, StateReserved, 2000)
	if next.State != StateReserved {
		t.Fatalf("State de la copia = %q, se esperaba %q", next.State, StateReserved)
	}
	if source.State != beforeState || source.UpdatedAt != beforeTimestamp {
		t.Fatalf("el receptor cambió tras una transición válida: %+v", source)
	}

	if _, err := source.Transition(StateConfirmed, 3000); err == nil {
		t.Fatal("una transición inválida debía fallar")
	}
	if source.State != beforeState || source.UpdatedAt != beforeTimestamp {
		t.Fatalf("el receptor cambió tras una transición inválida: %+v", source)
	}
}

func TestTransitionDeterministic(t *testing.T) {
	source := operationInState(t, StateSubmitted, 1000)
	first, firstErr := source.Transition(StateConfirmed, 2000)
	second, secondErr := source.Transition(StateConfirmed, 2000)
	if firstErr != nil || secondErr != nil {
		t.Fatalf("transiciones deterministas fallaron: %v / %v", firstErr, secondErr)
	}
	if first.ID != second.ID || first.State != second.State || first.UpdatedAt != second.UpdatedAt {
		t.Fatalf("resultados no deterministas: %+v != %+v", first, second)
	}
	if first.QusdAmount.Cmp(second.QusdAmount) != 0 || first.FiatAmount.Cmp(second.FiatAmount) != 0 {
		t.Fatalf("importes no deterministas: %+v != %+v", first, second)
	}

	rebuilt := operationInState(t, StateSubmitted, 1000)
	third, err := rebuilt.Transition(StateConfirmed, 2000)
	if err != nil {
		t.Fatal(err)
	}
	if first.ID != third.ID || first.State != third.State || first.UpdatedAt != third.UpdatedAt {
		t.Fatalf("misma entrada produjo resultados distintos: %+v != %+v", first, third)
	}
	requireOperationAmounts(t, third)
}

func TestOperationTerminal(t *testing.T) {
	cases := []struct {
		state    OperationState
		terminal bool
	}{
		{StateCreated, false},
		{StateReserved, false},
		{StateSubmitted, false},
		{StateConfirmed, true},
		{StateRejected, true},
		{StateUncertain, false},
		{StateReconciled, true},
	}
	for _, testCase := range cases {
		t.Run(string(testCase.state), func(t *testing.T) {
			op := operationInState(t, testCase.state, 1000)
			if op.Terminal() != testCase.terminal {
				t.Fatalf("Terminal() de %q = %v, se esperaba %v",
					testCase.state, op.Terminal(), testCase.terminal)
			}
		})
	}

	unknown := mustNewOperation(t, 1000)
	unknown.State = "corrupt"
	if unknown.Terminal() {
		t.Fatal("un estado desconocido no debe considerarse terminal")
	}
}

func TestOperationRequiresReconciliation(t *testing.T) {
	for _, state := range allOperationStates {
		t.Run(string(state), func(t *testing.T) {
			op := operationInState(t, state, 1000)
			want := state == StateUncertain
			if op.RequiresReconciliation() != want {
				t.Fatalf("RequiresReconciliation() de %q = %v, se esperaba %v",
					state, op.RequiresReconciliation(), want)
			}
		})
	}

	unknown := mustNewOperation(t, 1000)
	unknown.State = "corrupt"
	if unknown.RequiresReconciliation() {
		t.Fatal("un estado desconocido no debe exigir conciliación")
	}
}

func TestUncertainCanReconcileOrReject(t *testing.T) {
	for _, destination := range []OperationState{StateReconciled, StateRejected} {
		t.Run(string(destination), func(t *testing.T) {
			uncertain := operationInState(t, StateUncertain, 1000)
			if !uncertain.RequiresReconciliation() {
				t.Fatal("el estado uncertain debe exigir conciliación")
			}
			resolved := mustTransition(t, uncertain, destination, 2000)
			if resolved.State != destination {
				t.Fatalf("State = %q, se esperaba %q", resolved.State, destination)
			}
			if resolved.RequiresReconciliation() {
				t.Fatalf("el estado resuelto %q no debe exigir conciliación", destination)
			}
			if !resolved.Terminal() {
				t.Fatalf("el estado resuelto %q debe ser terminal", destination)
			}
		})
	}
}

func TestUncertainCannotConfirmDirectly(t *testing.T) {
	uncertain := operationInState(t, StateUncertain, 1000)
	next, err := uncertain.Transition(StateConfirmed, 2000)
	if err == nil {
		t.Fatalf("uncertain -> confirmed debe rechazarse: %+v", next)
	}
	if !strings.Contains(err.Error(), "transición inválida") {
		t.Fatalf("error inesperado: %v", err)
	}
}
