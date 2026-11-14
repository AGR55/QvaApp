package core

import (
	"context"
	"errors"
	"slices"
	"strings"
	"testing"
)

// fakeRemote registra las operaciones recibidas y permite elegir el resultado.
type fakeRemote struct {
	result   RemoteResult
	err      error
	events   *[]string
	calls    int
	received []Operation
	contexts []context.Context
}

func (fake *fakeRemote) Submit(ctx context.Context, operation Operation) (RemoteResult, error) {
	fake.calls++
	fake.received = append(fake.received, operation)
	fake.contexts = append(fake.contexts, ctx)
	if fake.events != nil {
		*fake.events = append(*fake.events, "submit")
	}
	return fake.result, fake.err
}

// fakeClock entrega una secuencia de instantes y repite el último al agotarse.
type fakeClock struct {
	values []int64
	index  int
	events *[]string
}

func newFakeClock(values ...int64) *fakeClock {
	if len(values) == 0 {
		values = []int64{1000}
	}
	return &fakeClock{values: values}
}

func (clock *fakeClock) Now() int64 {
	if clock.events != nil {
		*clock.events = append(*clock.events, "now")
	}
	if clock.index >= len(clock.values) {
		return clock.values[len(clock.values)-1]
	}
	value := clock.values[clock.index]
	clock.index++
	return value
}

func newReservedOperation(t *testing.T) Operation {
	t.Helper()
	return operationInState(t, StateReserved, 1000)
}

func requireSameOperation(t *testing.T, got, want Operation) {
	t.Helper()
	if got != want {
		t.Fatalf("operación = %+v, se esperaba %+v", got, want)
	}
}

func TestExecutorConfirmed(t *testing.T) {
	source := newReservedOperation(t)
	before := source
	remote := &fakeRemote{result: RemoteResult{Confirmed: true, Reference: "qva-123"}}
	clock := newFakeClock(2000, 3000)
	executor := NewExecutor(remote, clock.Now)

	result, err := executor.Execute(context.Background(), source)
	if err != nil {
		t.Fatal(err)
	}
	if result.State != StateConfirmed {
		t.Fatalf("State = %q, se esperaba %q", result.State, StateConfirmed)
	}
	if result.UpdatedAt != 3000 {
		t.Fatalf("UpdatedAt = %d, se esperaba 3000", result.UpdatedAt)
	}
	if result.ID != source.ID {
		t.Fatalf("ID = %q, se esperaba %q", result.ID, source.ID)
	}
	requireOperationAmounts(t, result)
	if remote.calls != 1 {
		t.Fatalf("llamadas al remoto = %d, se esperaba 1", remote.calls)
	}
	if len(remote.received) != 1 || remote.received[0].State != StateSubmitted {
		t.Fatalf("el remoto debía recibir una operación submitted: %+v", remote.received)
	}
	if remote.received[0].UpdatedAt != 2000 {
		t.Fatalf("UpdatedAt enviado = %d, se esperaba 2000", remote.received[0].UpdatedAt)
	}
	requireSameOperation(t, source, before)
}

func TestExecutorRejected(t *testing.T) {
	source := newReservedOperation(t)
	remote := &fakeRemote{result: RemoteResult{}}
	executor := NewExecutor(remote, newFakeClock(2000, 3000).Now)

	result, err := executor.Execute(context.Background(), source)
	if err != nil {
		t.Fatal(err)
	}
	if result.State != StateRejected {
		t.Fatalf("State = %q, se esperaba %q", result.State, StateRejected)
	}
	if !result.Terminal() {
		t.Fatalf("una operación rechazada debe ser terminal: %+v", result)
	}
	if remote.calls != 1 {
		t.Fatalf("llamadas al remoto = %d, se esperaba 1", remote.calls)
	}
}

func TestExecutorUncertain(t *testing.T) {
	source := newReservedOperation(t)
	remote := &fakeRemote{result: RemoteResult{Uncertain: true, Reference: "qva-pending"}}
	executor := NewExecutor(remote, newFakeClock(2000, 3000).Now)

	result, err := executor.Execute(context.Background(), source)
	if err != nil {
		t.Fatal(err)
	}
	if result.State != StateUncertain {
		t.Fatalf("State = %q, se esperaba %q", result.State, StateUncertain)
	}
	if !result.RequiresReconciliation() {
		t.Fatalf("un resultado incierto debe exigir conciliación: %+v", result)
	}
	if result.Terminal() {
		t.Fatalf("uncertain no es terminal: %+v", result)
	}
}

func TestExecutorUncertainWinsOverConfirmed(t *testing.T) {
	source := newReservedOperation(t)
	remote := &fakeRemote{result: RemoteResult{Confirmed: true, Uncertain: true}}
	executor := NewExecutor(remote, newFakeClock(2000, 3000).Now)

	result, err := executor.Execute(context.Background(), source)
	if err != nil {
		t.Fatal(err)
	}
	if result.State != StateUncertain {
		t.Fatalf("State = %q, un resultado ambiguo debe quedar uncertain", result.State)
	}
}

func TestExecutorRemoteError(t *testing.T) {
	sentinel := errors.New("timeout del remoto")
	source := newReservedOperation(t)
	before := source
	remote := &fakeRemote{err: sentinel}
	executor := NewExecutor(remote, newFakeClock(2000, 3000).Now)

	result, err := executor.Execute(context.Background(), source)
	if err == nil {
		t.Fatalf("se esperaba error remoto, operación = %+v", result)
	}
	if !errors.Is(err, sentinel) {
		t.Fatalf("el error debe envolver el remoto: %v", err)
	}
	if result.State != StateUncertain {
		t.Fatalf("State = %q, se esperaba %q", result.State, StateUncertain)
	}
	if result.UpdatedAt != 3000 {
		t.Fatalf("UpdatedAt = %d, se esperaba 3000", result.UpdatedAt)
	}
	if !result.RequiresReconciliation() {
		t.Fatalf("un error remoto debe exigir conciliación: %+v", result)
	}
	if remote.calls != 1 {
		t.Fatalf("llamadas al remoto = %d, se esperaba 1", remote.calls)
	}
	requireSameOperation(t, source, before)
}

func TestExecutorRejectsInvalidInitialState(t *testing.T) {
	cases := []struct {
		name  string
		state OperationState
	}{
		{"created", StateCreated},
		{"submitted", StateSubmitted},
		{"confirmed", StateConfirmed},
		{"rejected", StateRejected},
		{"uncertain", StateUncertain},
		{"reconciled", StateReconciled},
		{"desconocido", "corrupt"},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			source := operationInState(t, testCase.state, 1000)
			remote := &fakeRemote{result: RemoteResult{Confirmed: true}}
			clock := newFakeClock(2000, 3000)
			executor := NewExecutor(remote, clock.Now)

			result, err := executor.Execute(context.Background(), source)
			if err == nil {
				t.Fatalf("se esperaba error para estado inicial %q: %+v", testCase.state, result)
			}
			if !strings.Contains(err.Error(), "reserved") {
				t.Fatalf("el error debe indicar el estado exigido: %v", err)
			}
			requireSameOperation(t, result, source)
			if remote.calls != 0 {
				t.Fatalf("no se debe llamar al remoto con estado %q: %d llamadas", testCase.state, remote.calls)
			}
			if clock.index != 0 {
				t.Fatalf("no se debe consultar el reloj con estado inválido: %d lecturas", clock.index)
			}
		})
	}
}

func TestExecutorRejectsReplay(t *testing.T) {
	source := newReservedOperation(t)
	remote := &fakeRemote{result: RemoteResult{Confirmed: true}}
	executor := NewExecutor(remote, newFakeClock(2000, 3000).Now)

	confirmed, err := executor.Execute(context.Background(), source)
	if err != nil {
		t.Fatal(err)
	}
	replayed, err := executor.Execute(context.Background(), confirmed)
	if err == nil {
		t.Fatalf("reejecutar una operación terminal debe fallar: %+v", replayed)
	}
	if remote.calls != 1 {
		t.Fatalf("llamadas al remoto = %d, se esperaba 1", remote.calls)
	}
	requireSameOperation(t, replayed, confirmed)
}

func TestExecutorTimestampsMonotonic(t *testing.T) {
	source := newReservedOperation(t)
	if source.UpdatedAt != 1001 {
		t.Fatalf("UpdatedAt inicial = %d, se esperaba 1001", source.UpdatedAt)
	}
	remote := &fakeRemote{result: RemoteResult{Confirmed: true}}
	clock := newFakeClock(900, 800)
	executor := NewExecutor(remote, clock.Now)

	result, err := executor.Execute(context.Background(), source)
	if err != nil {
		t.Fatal(err)
	}
	if result.UpdatedAt < source.UpdatedAt {
		t.Fatalf("el timestamp retrocedió: %d < %d", result.UpdatedAt, source.UpdatedAt)
	}
	if remote.received[0].UpdatedAt < source.UpdatedAt {
		t.Fatalf("el timestamp enviado retrocedió: %d < %d",
			remote.received[0].UpdatedAt, source.UpdatedAt)
	}
	if result.UpdatedAt != 1001 {
		t.Fatalf("con reloj retrasado UpdatedAt = %d, se esperaba conservar 1001", result.UpdatedAt)
	}
}

func TestExecutorTimestampsAdvance(t *testing.T) {
	source := newReservedOperation(t)
	remote := &fakeRemote{result: RemoteResult{Confirmed: true}}
	clock := newFakeClock(2000, 3001)
	executor := NewExecutor(remote, clock.Now)

	result, err := executor.Execute(context.Background(), source)
	if err != nil {
		t.Fatal(err)
	}
	if remote.received[0].UpdatedAt != 2000 {
		t.Fatalf("UpdatedAt submitted = %d, se esperaba 2000", remote.received[0].UpdatedAt)
	}
	if result.UpdatedAt != 3001 {
		t.Fatalf("UpdatedAt final = %d, se esperaba 3001", result.UpdatedAt)
	}
	if remote.received[0].UpdatedAt <= source.UpdatedAt {
		t.Fatalf("submitted debe avanzar el timestamp: %d <= %d",
			remote.received[0].UpdatedAt, source.UpdatedAt)
	}
}

func TestExecutorCallOrder(t *testing.T) {
	events := []string{}
	source := newReservedOperation(t)
	remote := &fakeRemote{result: RemoteResult{Confirmed: true}, events: &events}
	clock := newFakeClock(2000, 3000)
	clock.events = &events
	executor := NewExecutor(remote, clock.Now)

	if _, err := executor.Execute(context.Background(), source); err != nil {
		t.Fatal(err)
	}
	want := []string{"now", "submit", "now"}
	if !slices.Equal(events, want) {
		t.Fatalf("orden de llamadas = %v, se esperaba %v", events, want)
	}
}

func TestExecutorPropagatesContext(t *testing.T) {
	type key struct{}
	ctx := context.WithValue(context.Background(), key{}, "correlation-1")
	source := newReservedOperation(t)
	remote := &fakeRemote{result: RemoteResult{Confirmed: true}}
	executor := NewExecutor(remote, newFakeClock(2000, 3000).Now)

	if _, err := executor.Execute(ctx, source); err != nil {
		t.Fatal(err)
	}
	if len(remote.contexts) != 1 {
		t.Fatalf("contextos recibidos = %d, se esperaba 1", len(remote.contexts))
	}
	if got := remote.contexts[0].Value(key{}); got != "correlation-1" {
		t.Fatalf("contexto no propagado: %v", got)
	}
}

func TestExecutorMissingDependencies(t *testing.T) {
	source := newReservedOperation(t)

	withoutRemote := NewExecutor(nil, newFakeClock(2000, 3000).Now)
	result, err := withoutRemote.Execute(context.Background(), source)
	if err == nil {
		t.Fatalf("un ejecutor sin remoto debe fallar: %+v", result)
	}
	requireSameOperation(t, result, source)

	withoutClock := NewExecutor(&fakeRemote{result: RemoteResult{Confirmed: true}}, nil)
	result, err = withoutClock.Execute(context.Background(), source)
	if err == nil {
		t.Fatalf("un ejecutor sin reloj debe fallar: %+v", result)
	}
	requireSameOperation(t, result, source)

	var nilExecutor *Executor
	result, err = nilExecutor.Execute(context.Background(), source)
	if err == nil {
		t.Fatalf("un ejecutor nil debe fallar: %+v", result)
	}
	requireSameOperation(t, result, source)
}
