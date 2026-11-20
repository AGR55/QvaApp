// Package inbox define el estado puro de un inbox idempotente por consumidor.
package inbox

import "fmt"

// State es el estado de un mensaje recibido.
type State string

const (
	Received  State = "received"
	Processed State = "processed"
	Failed    State = "failed"
)

// Record es la recepción de un mensaje por un consumidor.
type Record struct {
	Consumer    string
	MessageID   string
	State       State
	ReceivedAt  int64
	ProcessedAt *int64
	Error       string
}

// Accept devuelve un registro nuevo o indica duplicado.
func Accept(existing *Record, consumer, messageID string, now int64) (Record, bool, error) {
	if consumer == "" || messageID == "" {
		return Record{}, false, fmt.Errorf("consumer y messageID son obligatorios")
	}
	if existing != nil {
		return *existing, false, nil
	}
	return Record{
		Consumer:   consumer,
		MessageID:  messageID,
		State:      Received,
		ReceivedAt: now,
	}, true, nil
}

// Complete marca el mensaje como procesado.
func Complete(record Record, now int64) (Record, error) {
	if record.State != Received {
		return Record{}, fmt.Errorf("el mensaje %s no está pendiente", record.MessageID)
	}
	record.State = Processed
	record.ProcessedAt = &now
	record.Error = ""
	return record, nil
}

// Fail marca el mensaje como fallido.
func Fail(record Record, reason string, now int64) (Record, error) {
	if record.State == Processed {
		return Record{}, fmt.Errorf("el mensaje %s ya está procesado", record.MessageID)
	}
	record.State = Failed
	record.ProcessedAt = &now
	record.Error = reason
	return record, nil
}
