// Package reconciliation implementa el backoff persistido por intención de
// `src/reconciliation-scheduler.ts`. Programa reintentos; nunca resuelve una
// intención por sí mismo.
package reconciliation

import (
	"encoding/json"
	"fmt"
	"strings"
)

const (
	initialDelayMs int64 = 60_000
	maxDelayMs     int64 = 15 * 60_000
	keyPrefix            = "reconciliation_retry:"
)

// State es el almacén clave-valor inyectado.
type State interface {
	Get(key string) (string, bool)
	Set(key, value string)
}

// Record es el backoff persistido.
type Record struct {
	Attempts      int64
	NextAttemptAt int64
}

// Scheduler programa reintentos por intención.
type Scheduler struct {
	state State
}

// New crea un planificador sobre el almacén.
func New(state State) *Scheduler {
	return &Scheduler{state: state}
}

// CanAttempt indica si la intención puede reintentarse.
func (scheduler *Scheduler) CanAttempt(intentID string, now int64) (bool, error) {
	if err := validateIntentID(intentID); err != nil {
		return false, err
	}
	if err := validateTime(now); err != nil {
		return false, err
	}
	record := scheduler.read(intentID)
	return record == nil || record.NextAttemptAt <= now, nil
}

// RecordFailure incrementa el backoff y devuelve el registro persistido.
func (scheduler *Scheduler) RecordFailure(intentID string, now int64) (Record, error) {
	if err := validateIntentID(intentID); err != nil {
		return Record{}, err
	}
	if err := validateTime(now); err != nil {
		return Record{}, err
	}
	previous := scheduler.read(intentID)
	var attempts int64 = 1
	if previous != nil {
		attempts = previous.Attempts + 1
	}
	delay := initialDelayMs
	exponent := attempts - 1
	if exponent > 30 {
		exponent = 30
	}
	for step := int64(0); step < exponent; step++ {
		delay *= 2
		if delay >= maxDelayMs {
			delay = maxDelayMs
			break
		}
	}
	if delay > maxDelayMs {
		delay = maxDelayMs
	}
	record := Record{Attempts: attempts, NextAttemptAt: now + delay}
	encoded, err := json.Marshal(record)
	if err != nil {
		return Record{}, err
	}
	scheduler.state.Set(scheduler.key(intentID), string(encoded))
	return record, nil
}

// Clear marca la intención como limpia.
func (scheduler *Scheduler) Clear(intentID string) error {
	if err := validateIntentID(intentID); err != nil {
		return err
	}
	scheduler.state.Set(scheduler.key(intentID), "")
	return nil
}

// Status devuelve el backoff activo, si existe.
func (scheduler *Scheduler) Status(intentID string) (*Record, error) {
	if err := validateIntentID(intentID); err != nil {
		return nil, err
	}
	return scheduler.read(intentID), nil
}

func (scheduler *Scheduler) read(intentID string) *Record {
	raw, ok := scheduler.state.Get(scheduler.key(intentID))
	if !ok || raw == "" {
		return nil
	}
	var record Record
	if err := json.Unmarshal([]byte(raw), &record); err != nil {
		return nil
	}
	if record.Attempts <= 0 || record.NextAttemptAt < 0 {
		return nil
	}
	return &record
}

func (scheduler *Scheduler) key(intentID string) string {
	return keyPrefix + intentID
}

func validateIntentID(intentID string) error {
	if strings.TrimSpace(intentID) == "" || len(intentID) > 200 {
		return fmt.Errorf("el identificador de intención no es válido")
	}
	return nil
}

func validateTime(now int64) error {
	if now < 0 {
		return fmt.Errorf("la hora de conciliación no es válida")
	}
	return nil
}
