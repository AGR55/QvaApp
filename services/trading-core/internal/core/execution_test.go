package core

import (
	"strings"
	"testing"

	"github.com/AGR55/QvaApp/services/shared/decimal"
)

func parseDecimal(t *testing.T, text string) decimal.Value {
	t.Helper()
	value, err := decimal.Parse(text)
	if err != nil {
		t.Fatalf("decimal inválido %q: %v", text, err)
	}
	return value
}

func assertDecimal(t *testing.T, label string, got, want decimal.Value) {
	t.Helper()
	if got.Cmp(want) != 0 {
		t.Fatalf("%s = %s, se esperaba %s", label, got.Format(8), want.Format(8))
	}
}

func assertEntry(t *testing.T, entries []LedgerEntry, index int, code, direction, amount string) {
	t.Helper()
	if len(entries) <= index {
		t.Fatalf("faltan movimientos: se esperaba uno en el índice %d y hay %d", index, len(entries))
	}
	entry := entries[index]
	if entry.Code != code {
		t.Fatalf("movimiento %d: código = %q, se esperaba %q", index, entry.Code, code)
	}
	if entry.Direction != direction {
		t.Fatalf("movimiento %d: dirección = %q, se esperaba %q", index, entry.Direction, direction)
	}
	assertDecimal(t, "movimiento "+code, entry.Amount, parseDecimal(t, amount))
	if strings.TrimSpace(entry.Reason) == "" {
		t.Fatalf("movimiento %d sin motivo", index)
	}
}

func buyInput(t *testing.T) ExecutionInput {
	t.Helper()
	return ExecutionInput{
		Event: Event{
			OfferUUID: "offer-buy", Coin: "BANK_CUP", Side: "buy", Decision: "auto_buy",
			Amount: parseDecimal(t, "20"), Receive: parseDecimal(t, "24000"), Rate: parseDecimal(t, "1200"),
		},
		Result:        Result{Kind: "apply", Allowed: true},
		AvailableQusd: parseDecimal(t, "100"),
		ReserveQusd:   decimal.Zero(),
		OperationID:   "op-buy-1",
	}
}

func sellInput(t *testing.T) ExecutionInput {
	t.Helper()
	return ExecutionInput{
		Event: Event{
			OfferUUID: "offer-sell", Coin: "BANK_CUP", Side: "sell", Decision: "manual_sell",
			Amount: parseDecimal(t, "20"), Receive: parseDecimal(t, "30000"), Rate: parseDecimal(t, "1500"),
		},
		Result:        Result{Kind: "apply", Allowed: true},
		AvailableQusd: parseDecimal(t, "100"),
		ReserveQusd:   parseDecimal(t, "30"),
		OperationID:   "op-sell-1",
	}
}

func TestSimulateExecutionBuyAllowed(t *testing.T) {
	input := buyInput(t)
	execution, err := SimulateExecution(input)
	if err != nil {
		t.Fatal(err)
	}
	if !execution.Allowed {
		t.Fatalf("la compra permitida debe simularse: %+v", execution)
	}
	if execution.OperationID != input.OperationID {
		t.Fatalf("OperationID = %q, se esperaba %q", execution.OperationID, input.OperationID)
	}
	assertDecimal(t, "QusdAmount", execution.QusdAmount, parseDecimal(t, "20"))
	assertDecimal(t, "ReserveQusd", execution.ReserveQusd, decimal.Zero())
	assertDecimal(t, "RemainingQusd", execution.RemainingQusd, parseDecimal(t, "120"))
	if len(execution.LedgerEntries) != 2 {
		t.Fatalf("movimientos = %d, se esperaban 2", len(execution.LedgerEntries))
	}
	assertEntry(t, execution.LedgerEntries, 0, "fiat:BANK_CUP", DirectionDebit, "24000")
	assertEntry(t, execution.LedgerEntries, 1, "qusd", DirectionCredit, "20")
	if strings.TrimSpace(execution.Reason) == "" {
		t.Fatal("la ejecución permitida debe explicar el resultado")
	}
}

func TestSimulateExecutionBuyDoesNotReserveQusd(t *testing.T) {
	input := buyInput(t)
	input.AvailableQusd = decimal.Zero()
	input.ReserveQusd = parseDecimal(t, "50")

	execution, err := SimulateExecution(input)
	if err != nil {
		t.Fatal(err)
	}
	if !execution.Allowed {
		t.Fatalf("una compra no requiere saldo QUSD: %+v", execution)
	}
	assertDecimal(t, "ReserveQusd", execution.ReserveQusd, decimal.Zero())
	assertDecimal(t, "RemainingQusd", execution.RemainingQusd, parseDecimal(t, "20"))
}

func TestSimulateExecutionSellAllowedWithReserve(t *testing.T) {
	input := sellInput(t)
	execution, err := SimulateExecution(input)
	if err != nil {
		t.Fatal(err)
	}
	if !execution.Allowed {
		t.Fatalf("la venta permitida debe simularse: %+v", execution)
	}
	if execution.OperationID != input.OperationID {
		t.Fatalf("OperationID = %q, se esperaba %q", execution.OperationID, input.OperationID)
	}
	assertDecimal(t, "QusdAmount", execution.QusdAmount, parseDecimal(t, "20"))
	assertDecimal(t, "ReserveQusd", execution.ReserveQusd, parseDecimal(t, "30"))
	assertDecimal(t, "RemainingQusd", execution.RemainingQusd, parseDecimal(t, "50"))
	if len(execution.LedgerEntries) != 2 {
		t.Fatalf("movimientos = %d, se esperaban 2", len(execution.LedgerEntries))
	}
	assertEntry(t, execution.LedgerEntries, 0, "qusd", DirectionDebit, "20")
	assertEntry(t, execution.LedgerEntries, 1, "fiat:BANK_CUP", DirectionCredit, "30000")
}

func TestSimulateExecutionSellExactFreeBalance(t *testing.T) {
	input := sellInput(t)
	input.AvailableQusd = parseDecimal(t, "50")
	input.ReserveQusd = parseDecimal(t, "30")
	input.Event.Amount = parseDecimal(t, "20")

	execution, err := SimulateExecution(input)
	if err != nil {
		t.Fatal(err)
	}
	assertDecimal(t, "RemainingQusd", execution.RemainingQusd, decimal.Zero())
}

func TestSimulateExecutionSellInsufficientBalance(t *testing.T) {
	input := sellInput(t)
	input.AvailableQusd = parseDecimal(t, "100")
	input.ReserveQusd = parseDecimal(t, "81")
	input.Event.Amount = parseDecimal(t, "20")

	execution, err := SimulateExecution(input)
	if err == nil {
		t.Fatalf("se esperaba saldo insuficiente, ejecución = %+v", execution)
	}
	if !strings.Contains(err.Error(), "insuficiente") {
		t.Fatalf("error inesperado: %v", err)
	}
	if execution.Allowed || len(execution.LedgerEntries) != 0 {
		t.Fatalf("una ejecución rechazada no debe producir movimientos: %+v", execution)
	}
}

func TestSimulateExecutionNotAllowed(t *testing.T) {
	input := sellInput(t)
	input.Result = Result{Kind: "blocked", Allowed: false, Reasons: []string{"Riesgo excedido", "Precio no elegible"}}

	execution, err := SimulateExecution(input)
	if err != nil {
		t.Fatal(err)
	}
	if execution.Allowed {
		t.Fatalf("una decisión no allowed no debe simularse: %+v", execution)
	}
	if execution.OperationID != input.OperationID {
		t.Fatalf("OperationID = %q, se esperaba %q", execution.OperationID, input.OperationID)
	}
	if len(execution.LedgerEntries) != 0 {
		t.Fatalf("una decisión no allowed no debe producir movimientos: %+v", execution)
	}
	if !strings.Contains(execution.Reason, "Riesgo excedido") || !strings.Contains(execution.Reason, "Precio no elegible") {
		t.Fatalf("motivo incompleto: %q", execution.Reason)
	}
}

func TestSimulateExecutionInvalidInput(t *testing.T) {
	cases := []struct {
		name   string
		mutate func(*ExecutionInput)
	}{
		{"importe cero", func(input *ExecutionInput) { input.Event.Amount = decimal.Zero() }},
		{"importe negativo", func(input *ExecutionInput) { input.Event.Amount = parseDecimal(t, "-1") }},
		{"fiat cero", func(input *ExecutionInput) { input.Event.Receive = decimal.Zero() }},
		{"fiat negativo", func(input *ExecutionInput) { input.Event.Receive = parseDecimal(t, "-1") }},
		{"disponible negativo", func(input *ExecutionInput) { input.AvailableQusd = parseDecimal(t, "-1") }},
		{"reserva negativa", func(input *ExecutionInput) { input.ReserveQusd = parseDecimal(t, "-1") }},
		{"lado desconocido", func(input *ExecutionInput) { input.Event.Side = "hold" }},
		{"operación vacía", func(input *ExecutionInput) { input.OperationID = "" }},
		{"operación solo espacios", func(input *ExecutionInput) { input.OperationID = "   " }},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			input := buyInput(t)
			testCase.mutate(&input)
			execution, err := SimulateExecution(input)
			if err == nil {
				t.Fatalf("se esperaba error, ejecución = %+v", execution)
			}
			if execution.Allowed || len(execution.LedgerEntries) != 0 {
				t.Fatalf("una entrada inválida no debe simular movimientos: %+v", execution)
			}
		})
	}
}

func TestSimulateExecutionDeterministic(t *testing.T) {
	for _, input := range []ExecutionInput{buyInput(t), sellInput(t)} {
		first, err := SimulateExecution(input)
		if err != nil {
			t.Fatal(err)
		}
		second, err := SimulateExecution(input)
		if err != nil {
			t.Fatal(err)
		}
		requireSameExecution(t, first, second)
	}
}

func requireSameExecution(t *testing.T, left, right Execution) {
	t.Helper()
	if left.Allowed != right.Allowed {
		t.Fatalf("Allowed difiere: %v != %v", left.Allowed, right.Allowed)
	}
	if left.OperationID != right.OperationID {
		t.Fatalf("OperationID difiere: %q != %q", left.OperationID, right.OperationID)
	}
	assertDecimal(t, "QusdAmount determinista", left.QusdAmount, right.QusdAmount)
	assertDecimal(t, "ReserveQusd determinista", left.ReserveQusd, right.ReserveQusd)
	assertDecimal(t, "RemainingQusd determinista", left.RemainingQusd, right.RemainingQusd)
	if left.Reason != right.Reason {
		t.Fatalf("Reason difiere: %q != %q", left.Reason, right.Reason)
	}
	if len(left.LedgerEntries) != len(right.LedgerEntries) {
		t.Fatalf("número de movimientos difiere: %d != %d", len(left.LedgerEntries), len(right.LedgerEntries))
	}
	for index := range left.LedgerEntries {
		leftEntry := left.LedgerEntries[index]
		rightEntry := right.LedgerEntries[index]
		if leftEntry.Code != rightEntry.Code || leftEntry.Direction != rightEntry.Direction || leftEntry.Reason != rightEntry.Reason {
			t.Fatalf("movimiento %d difiere: %+v != %+v", index, leftEntry, rightEntry)
		}
		assertDecimal(t, "importe determinista", leftEntry.Amount, rightEntry.Amount)
	}
}
