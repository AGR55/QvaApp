// Package outbox define el estado puro de un outbox transaccional. La
// persistencia concreta vive en Postgres; este paquete no hace I/O.
package outbox

import (
	"errors"
	"fmt"
	"time"
)

// State es el estado de un mensaje.
type State string

const (
	Pending   State = "pending"
	InFlight  State = "in_flight"
	Published State = "published"
	Failed    State = "failed"
)

// Message es un evento pendiente de publicar.
type Message struct {
	ID             string
	Topic          string
	PayloadJSON    string
	IdempotencyKey string
	State          State
	Attempts       int
	AvailableAt    int64
	LockedBy       string
	LockedAt       *int64
	LastError      string
	CreatedAt      int64
}

// New crea un mensaje pendiente.
func New(id, topic, payloadJSON, idempotencyKey string, now int64) (Message, error) {
	if id == "" || topic == "" || idempotencyKey == "" {
		return Message{}, errors.New("id, topic e idempotencyKey son obligatorios")
	}
	return Message{
		ID:             id,
		Topic:          topic,
		PayloadJSON:    payloadJSON,
		IdempotencyKey: idempotencyKey,
		State:          Pending,
		AvailableAt:    now,
		CreatedAt:      now,
	}, nil
}

// Due indica si el mensaje puede reclamarse.
func (message Message) Due(now int64) bool {
	return message.State == Pending && message.AvailableAt <= now
}

// Claim marca el mensaje en vuelo con un lease.
func Claim(message Message, worker string, now int64, lease time.Duration) (Message, error) {
	if worker == "" {
		return Message{}, errors.New("worker vacío")
	}
	if message.State == Published {
		return Message{}, fmt.Errorf("el mensaje %s ya está publicado", message.ID)
	}
	if message.State == InFlight && message.LockedAt != nil &&
		*message.LockedAt+lease.Milliseconds() > now {
		return Message{}, fmt.Errorf("el mensaje %s tiene un lease vigente", message.ID)
	}
	if message.State == Failed {
		return Message{}, fmt.Errorf("el mensaje %s está fallido", message.ID)
	}
	message.State = InFlight
	message.Attempts++
	message.LockedBy = worker
	message.LockedAt = &now
	return message, nil
}

// Complete publica el mensaje.
func Complete(message Message, now int64) (Message, error) {
	if message.State != InFlight {
		return Message{}, fmt.Errorf("el mensaje %s no está en vuelo", message.ID)
	}
	message.State = Published
	message.LockedBy = ""
	message.LockedAt = nil
	message.LastError = ""
	message.AvailableAt = now
	return message, nil
}

// Fail devuelve el mensaje a pendiente o lo marca fallido tras el máximo.
func Fail(message Message, reason string, now, retryAt int64, maxAttempts int) (Message, error) {
	if message.State != InFlight {
		return Message{}, fmt.Errorf("el mensaje %s no está en vuelo", message.ID)
	}
	message.LastError = reason
	message.LockedBy = ""
	message.LockedAt = nil
	if maxAttempts > 0 && message.Attempts >= maxAttempts {
		message.State = Failed
		message.AvailableAt = 0
	} else {
		message.State = Pending
		message.AvailableAt = retryAt
	}
	return message, nil
}
