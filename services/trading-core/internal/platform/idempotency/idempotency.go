// Package idempotency define el estado puro de una clave de idempotencia
// durable. La frontera Postgres se implementa fuera de este paquete.
package idempotency

import (
	"errors"
	"fmt"
)

// State es el estado de una operación idempotente.
type State string

const (
	Reserved  State = "reserved"
	Completed State = "completed"
	Failed    State = "failed"
)

// ClaimStatus es el resultado de reclamar una clave.
type ClaimStatus string

const (
	Claimed    ClaimStatus = "claimed"
	Replay     ClaimStatus = "replay"
	InProgress ClaimStatus = "in_progress"
	Conflict   ClaimStatus = "conflict"
)

// Record es una clave de idempotencia.
type Record struct {
	Scope        string
	Key          string
	RequestHash  string
	State        State
	ResponseJSON string
	CreatedAt    int64
	UpdatedAt    int64
	ExpiresAt    int64
}

// Claim reclama la clave o explica por qué no se puede.
func Claim(existing *Record, scope, key, requestHash string, now, ttlMs int64) (Record, ClaimStatus, error) {
	if scope == "" || key == "" || requestHash == "" {
		return Record{}, "", errors.New("scope, key y requestHash son obligatorios")
	}
	if existing != nil && (existing.ExpiresAt == 0 || existing.ExpiresAt > now) {
		if existing.RequestHash != requestHash {
			return *existing, Conflict, nil
		}
		switch existing.State {
		case Completed:
			return *existing, Replay, nil
		case Reserved:
			return *existing, InProgress, nil
		case Failed:
			// Permitir un nuevo intento tras un fallo definitivo.
		default:
			return *existing, Conflict, nil
		}
	}
	record := Record{
		Scope:       scope,
		Key:         key,
		RequestHash: requestHash,
		State:       Reserved,
		CreatedAt:   now,
		UpdatedAt:   now,
	}
	if ttlMs > 0 {
		record.ExpiresAt = now + ttlMs
	}
	return record, Claimed, nil
}

// Complete guarda la respuesta y marca la clave como completada.
func Complete(record Record, responseJSON string, now int64) (Record, error) {
	if record.State != Reserved {
		return Record{}, fmt.Errorf("la clave %s no está reservada", record.Key)
	}
	record.State = Completed
	record.ResponseJSON = responseJSON
	record.UpdatedAt = now
	return record, nil
}

// Fail marca la clave como fallida para permitir un reintento explícito.
func Fail(record Record, now int64) (Record, error) {
	if record.State != Reserved {
		return Record{}, fmt.Errorf("la clave %s no está reservada", record.Key)
	}
	record.State = Failed
	record.UpdatedAt = now
	return record, nil
}
