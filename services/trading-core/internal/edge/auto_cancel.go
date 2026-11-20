package edge

import (
	"strings"
	"time"
)

// PendingOperation es una operación local que puede vencer.
type PendingOperation struct {
	UUID      string
	OrderUUID string
	Coin      string
	State     string
	CreatedAt int64
}

// DueForCancel devuelve las operaciones aplicadas que superaron la ventana de
// pago. No decide si QvaPay permite cancelarlas; eso lo hace la preflight.
func DueForCancel(operations []PendingOperation, now time.Time, window time.Duration) []PendingOperation {
	if window <= 0 {
		return nil
	}
	cutoff := now.Add(-window).UnixMilli()
	due := make([]PendingOperation, 0, len(operations))
	for _, operation := range operations {
		switch strings.ToLower(operation.State) {
		case "applied", "acknowledged":
		default:
			continue
		}
		if operation.CreatedAt <= 0 || operation.CreatedAt > cutoff {
			continue
		}
		due = append(due, operation)
	}
	return due
}

// ShouldAutoCancel exige que la operación siga en processing. Si ya está
// pagada o completada, la cancelación automática no debe tocarla.
func ShouldAutoCancel(parentStatus, orderStatus string) bool {
	status := strings.ToLower(strings.TrimSpace(orderStatus))
	if status == "" {
		status = strings.ToLower(strings.TrimSpace(parentStatus))
	}
	return status == "processing"
}
