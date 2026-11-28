// Package monetary implementa el protocolo durable de una mutación remota de
// `src/application/monetary-intents.ts`: persistir la intención antes de
// despachar y clasificar el fallo de forma conservadora.
package monetary

import (
	"errors"
	"fmt"
	"time"
)

// Intent es la intención persistida.
type Intent struct {
	ID            string
	Kind          string
	OperationUUID string
	WorkflowID    string
	Request       any
}

// Repository es el almacén durable inyectado.
type Repository interface {
	Create(Intent) error
	Update(intentID, state string, response any, failure string) error
	Audit(action, message, operationUUID string)
}

// Mutation describe la operación remota.
type Mutation struct {
	Kind          string
	OperationUUID string
	WorkflowID    string
	Request       any
	Action        func(intentID string) (any, error)
	OnTiming      func(phase string, milliseconds float64)
}

// APIError representa un rechazo HTTP de QvaPay.
type APIError struct {
	Status  int
	Message string
}

func (err *APIError) Error() string { return err.Message }

// UncertainError representa un resultado ambiguo tras despachar.
type UncertainError struct {
	Kind    string
	Message string
}

func (err *UncertainError) Error() string { return err.Message }

// Outcome clasifica un error de mutación.
func Outcome(err error) string {
	var api *APIError
	if errors.As(err, &api) {
		if api.Status < 500 {
			return "rejected"
		}
		return "uncertain"
	}
	var uncertain *UncertainError
	if errors.As(err, &uncertain) {
		return "uncertain"
	}
	return "uncertain"
}

// Execute persiste la intención, despacha y persiste el resultado.
func Execute(repository Repository, createID func() string, mutation Mutation) (any, error) {
	intentID := createID()
	persistStarted := time.Now()
	createErr := repository.Create(Intent{
		ID:            intentID,
		Kind:          mutation.Kind,
		OperationUUID: mutation.OperationUUID,
		WorkflowID:    mutation.WorkflowID,
		Request:       mutation.Request,
	})
	report(mutation.OnTiming, "intentPersistMs", persistStarted)
	if createErr != nil {
		return nil, createErr
	}

	mutationStarted := time.Now()
	response, actionErr := mutation.Action(intentID)
	report(mutation.OnTiming, "mutationMs", mutationStarted)
	if actionErr == nil {
		resultStarted := time.Now()
		updateErr := repository.Update(intentID, "confirmed", response, "")
		report(mutation.OnTiming, "resultPersistMs", resultStarted)
		if updateErr != nil {
			return nil, updateErr
		}
		return response, nil
	}

	outcome := Outcome(actionErr)
	detail := actionErr.Error()
	resultStarted := time.Now()
	_ = repository.Update(intentID, outcome, nil, detail)
	report(mutation.OnTiming, "resultPersistMs", resultStarted)
	action := "mutation_rejected"
	if outcome == "uncertain" {
		action = "mutation_uncertain"
	}
	repository.Audit(action, fmt.Sprintf("%s: %s", mutation.Kind, detail), mutation.OperationUUID)
	return nil, actionErr
}

func report(callback func(string, float64), phase string, started time.Time) {
	if callback == nil {
		return
	}
	defer func() {
		_ = recover()
	}()
	callback(phase, float64(time.Since(started).Microseconds())/1_000)
}
