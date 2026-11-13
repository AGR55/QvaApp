package outbox

import (
	"context"
	"fmt"
	"time"
)

// Repository es la persistencia que consume el worker.
type Repository interface {
	ClaimDue(ctx context.Context, worker string, now, leaseMs int64, limit int) ([]Message, error)
	Complete(ctx context.Context, id, worker string, now int64) (bool, error)
	Fail(ctx context.Context, id, worker, reason string, now, retryAt int64, maxAttempts int) (State, error)
}

// Publisher entrega un mensaje al bus.
type Publisher interface {
	Publish(ctx context.Context, message Message) error
}

// WorkerConfig limita el lote y los reintentos.
type WorkerConfig struct {
	WorkerID    string
	Batch       int
	Lease       time.Duration
	MaxAttempts int
	RetryDelay  time.Duration
}

// Result resume una pasada del worker.
type Result struct {
	Claimed   int
	Published int
	Failed    int
	Errors    []error
}

// Worker publica el outbox pendiente.
type Worker struct {
	repository Repository
	publisher  Publisher
	config     WorkerConfig
}

// NewWorker crea el worker.
func NewWorker(repository Repository, publisher Publisher, config WorkerConfig) (*Worker, error) {
	if repository == nil || publisher == nil {
		return nil, fmt.Errorf("repository y publisher son obligatorios")
	}
	if config.WorkerID == "" {
		config.WorkerID = "outbox-worker"
	}
	if config.Batch <= 0 {
		config.Batch = 50
	}
	if config.Lease <= 0 {
		config.Lease = time.Minute
	}
	if config.RetryDelay <= 0 {
		config.RetryDelay = time.Second
	}
	return &Worker{repository: repository, publisher: publisher, config: config}, nil
}

// RunOnce reclama y publica un lote. Los fallos de publicación se reintentan
// según la política; los fallos del repositorio se devuelven.
func (worker *Worker) RunOnce(ctx context.Context, now int64) (Result, error) {
	messages, err := worker.repository.ClaimDue(
		ctx,
		worker.config.WorkerID,
		now,
		worker.config.Lease.Milliseconds(),
		worker.config.Batch,
	)
	if err != nil {
		return Result{}, err
	}
	result := Result{Claimed: len(messages)}
	for _, message := range messages {
		if err := worker.publisher.Publish(ctx, message); err != nil {
			result.Failed++
			result.Errors = append(result.Errors, fmt.Errorf("%s: %w", message.ID, err))
			retryAt := now + worker.config.RetryDelay.Milliseconds()
			if _, failErr := worker.repository.Fail(
				ctx, message.ID, worker.config.WorkerID, err.Error(), now, retryAt, worker.config.MaxAttempts,
			); failErr != nil {
				return result, failErr
			}
			continue
		}
		completed, err := worker.repository.Complete(ctx, message.ID, worker.config.WorkerID, now)
		if err != nil {
			return result, err
		}
		if !completed {
			result.Errors = append(result.Errors, fmt.Errorf("%s: lease perdido antes de completar", message.ID))
			continue
		}
		result.Published++
	}
	return result, nil
}
