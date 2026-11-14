package core

import (
	"context"
	"fmt"
)

// RemoteResult describe la respuesta de un remoto (QvaPay) para una operación
// shadow. Reference es opaca: el ejecutor no la interpreta ni la persiste.
type RemoteResult struct {
	Confirmed bool
	Uncertain bool
	Reference string
}

// Remote es el envío remoto inyectable del ejecutor. La implementación real
// puede hablar con QvaPay; las pruebas usan un fake. Submit debe ser
// idempotente respecto a Operation.ID.
type Remote interface {
	Submit(ctx context.Context, operation Operation) (RemoteResult, error)
}

// Executor lleva una operación reserved por el ciclo remoto sin mutar el
// receptor: cada paso devuelve una copia nueva. Now es el reloj lógico
// inyectable en milisegundos.
type Executor struct {
	Remote Remote
	Now    func() int64
}

// NewExecutor construye un ejecutor con el remoto y el reloj dados.
func NewExecutor(remote Remote, now func() int64) *Executor {
	return &Executor{Remote: remote, Now: now}
}

// Execute envía una operación reserved al remoto y aplica su resultado. La
// operación pasa a submitted antes de invocar al remoto. Un error remoto no se
// descarta: se marca la operación como uncertain y se devuelve junto al error,
// porque el envío pudo haberse aplicado. El receptor nunca se muta y el remoto
// solo se llama si el estado inicial es reserved.
func (e *Executor) Execute(ctx context.Context, operation Operation) (Operation, error) {
	if operation.State != StateReserved {
		return operation, fmt.Errorf(
			"ejecución inválida: la operación %q está en estado %q, se esperaba %q",
			operation.ID, operation.State, StateReserved,
		)
	}
	if e == nil || e.Remote == nil {
		return operation, fmt.Errorf("ejecutor sin remoto configurado para la operación %q", operation.ID)
	}
	if e.Now == nil {
		return operation, fmt.Errorf("ejecutor sin reloj configurado para la operación %q", operation.ID)
	}

	submitted, err := operation.Transition(StateSubmitted, e.nextTimestamp(operation.UpdatedAt))
	if err != nil {
		return operation, fmt.Errorf("no se pudo marcar la operación %q como submitted: %w", operation.ID, err)
	}

	result, remoteErr := e.Remote.Submit(ctx, submitted)
	if remoteErr != nil {
		uncertain, transitionErr := submitted.Transition(StateUncertain, e.nextTimestamp(submitted.UpdatedAt))
		if transitionErr != nil {
			return submitted, fmt.Errorf(
				"la operación %q se envió con resultado remoto incierto y no pudo marcarse como uncertain: %w (error remoto: %v)",
				operation.ID, transitionErr, remoteErr,
			)
		}
		return uncertain, fmt.Errorf("resultado remoto incierto para la operación %q: %w", operation.ID, remoteErr)
	}

	next := StateRejected
	switch {
	case result.Uncertain:
		next = StateUncertain
	case result.Confirmed:
		next = StateConfirmed
	}

	final, err := submitted.Transition(next, e.nextTimestamp(submitted.UpdatedAt))
	if err != nil {
		return submitted, fmt.Errorf("no se pudo aplicar el resultado remoto a la operación %q: %w", operation.ID, err)
	}
	return final, nil
}

// nextTimestamp nunca retrocede: si el reloj devuelve un instante anterior al
// último conocido, conserva el último. Transition acepta timestamps iguales.
func (e *Executor) nextTimestamp(previous int64) int64 {
	now := e.Now()
	if now < previous {
		return previous
	}
	return now
}
