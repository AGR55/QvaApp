package main

import (
	"context"
	"log/slog"
	"strings"
	"sync/atomic"
	"time"
)

const (
	notificationQueueSize = 1024
	notificationAttempts  = 3
	notificationSendTTL   = 5 * time.Second
)

type notificationSender interface {
	Send(ctx context.Context, text, key string) error
}

type notificationJob struct {
	text     string
	key      string
	queuedAt time.Time
}

// notificationDispatcher entrega los avisos de operación en una cola propia.
// El worker de apply no espera a Telegram: publica en la cola y sigue con la
// siguiente operación. Un único trabajador evita ráfagas que Telegram limite.
type notificationDispatcher struct {
	sender notificationSender
	logger *slog.Logger
	queue  chan notificationJob

	retryDelay time.Duration

	enqueued    atomic.Uint64
	sent        atomic.Uint64
	failed      atomic.Uint64
	queueWaitMS atomic.Uint64
	sendMS      atomic.Uint64
}

func newNotificationDispatcher(sender notificationSender, logger *slog.Logger) *notificationDispatcher {
	if sender == nil {
		return nil
	}
	return &notificationDispatcher{
		sender: sender, logger: logger,
		queue:      make(chan notificationJob, notificationQueueSize),
		retryDelay: time.Second,
	}
}

func (dispatcher *notificationDispatcher) Run(ctx context.Context) {
	if dispatcher == nil {
		return
	}
	for {
		select {
		case <-ctx.Done():
			return
		case job := <-dispatcher.queue:
			dispatcher.deliver(ctx, job)
		}
	}
}

// Enqueue acepta un aviso sin esperar al envío. Si la cola está llena aplica
// contrapresión hasta que haya hueco o termine el contexto del servicio.
func (dispatcher *notificationDispatcher) Enqueue(ctx context.Context, text, key string) {
	if dispatcher == nil || strings.TrimSpace(text) == "" {
		return
	}
	dispatcher.enqueued.Add(1)
	job := notificationJob{text: text, key: key, queuedAt: time.Now()}
	select {
	case dispatcher.queue <- job:
	case <-ctx.Done():
		dispatcher.failed.Add(1)
	}
}

func (dispatcher *notificationDispatcher) deliver(ctx context.Context, job notificationJob) {
	queueWaitMS := time.Since(job.queuedAt).Milliseconds()
	if queueWaitMS < 0 {
		queueWaitMS = 0
	}
	dispatcher.queueWaitMS.Add(uint64(queueWaitMS))
	started := time.Now()
	var lastErr error

deliveries:
	for attempt := 1; attempt <= notificationAttempts; attempt++ {
		sendCtx, cancel := context.WithTimeout(ctx, notificationSendTTL)
		lastErr = dispatcher.sender.Send(sendCtx, job.text, job.key)
		cancel()
		if lastErr == nil {
			elapsed := time.Since(started)
			dispatcher.sent.Add(1)
			dispatcher.sendMS.Add(uint64(elapsed.Milliseconds()))
			if dispatcher.logger != nil {
				dispatcher.logger.Info("notificación de aplicación enviada",
					"key", job.key,
					"queue_ms", queueWaitMS,
					"send_ms", elapsed.Milliseconds(),
					"attempts", attempt,
				)
			}
			return
		}
		if attempt == notificationAttempts {
			break
		}
		timer := time.NewTimer(dispatcher.retryDelay * time.Duration(attempt))
		select {
		case <-ctx.Done():
			timer.Stop()
			break deliveries
		case <-timer.C:
		}
		if ctx.Err() != nil {
			break
		}
	}
	dispatcher.failed.Add(1)
	if dispatcher.logger != nil {
		dispatcher.logger.Warn("no se pudo enviar la notificación",
			"key", job.key, "error", lastErr)
	}
}

func (dispatcher *notificationDispatcher) queueDepth() int {
	if dispatcher == nil {
		return 0
	}
	return len(dispatcher.queue)
}
