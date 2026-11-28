package main

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"
)

type fakeNotificationSender struct {
	mu        sync.Mutex
	calls     int
	failUntil int
	entered   chan struct{}
	release   chan struct{}
	delivered chan struct{}
}

func (sender *fakeNotificationSender) Send(ctx context.Context, _ string, _ string) error {
	sender.mu.Lock()
	sender.calls++
	call := sender.calls
	sender.mu.Unlock()
	if sender.entered != nil {
		select {
		case sender.entered <- struct{}{}:
		default:
		}
	}
	if sender.release != nil {
		select {
		case <-sender.release:
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	if call <= sender.failUntil {
		return errors.New("fallo simulado")
	}
	if sender.delivered != nil {
		select {
		case sender.delivered <- struct{}{}:
		default:
		}
	}
	return nil
}

func (sender *fakeNotificationSender) callCount() int {
	sender.mu.Lock()
	defer sender.mu.Unlock()
	return sender.calls
}

func TestNotificationDispatcherNoBloqueaAlProductor(t *testing.T) {
	sender := &fakeNotificationSender{entered: make(chan struct{}, 1), release: make(chan struct{})}
	dispatcher := newNotificationDispatcher(sender, nil)
	dispatcher.retryDelay = time.Millisecond
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go dispatcher.Run(ctx)

	started := time.Now()
	dispatcher.Enqueue(ctx, "hola", "apply:1")
	if elapsed := time.Since(started); elapsed > 100*time.Millisecond {
		t.Fatalf("Enqueue bloqueó %s", elapsed)
	}
	select {
	case <-sender.entered:
	case <-time.After(time.Second):
		t.Fatal("el trabajador no comenzó el envío")
	}
	close(sender.release)
	deadline := time.Now().Add(time.Second)
	for dispatcher.sent.Load() != 1 && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	if dispatcher.sent.Load() != 1 || dispatcher.enqueued.Load() != 1 {
		t.Fatalf("sent=%d enqueued=%d", dispatcher.sent.Load(), dispatcher.enqueued.Load())
	}
}

func TestNotificationDispatcherReintentaHastaEntregar(t *testing.T) {
	sender := &fakeNotificationSender{failUntil: 1, delivered: make(chan struct{}, 1)}
	dispatcher := newNotificationDispatcher(sender, nil)
	dispatcher.retryDelay = time.Millisecond
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go dispatcher.Run(ctx)

	dispatcher.Enqueue(ctx, "hola", "apply:2")
	select {
	case <-sender.delivered:
	case <-time.After(time.Second):
		t.Fatal("no se entregó tras reintentar")
	}
	if calls := sender.callCount(); calls != 2 {
		t.Fatalf("intentos = %d, quiero 2", calls)
	}
	if dispatcher.failed.Load() != 0 {
		t.Fatalf("failed = %d", dispatcher.failed.Load())
	}
}

func TestNotificationDispatcherRindeAnteContextoCancelado(t *testing.T) {
	sender := &fakeNotificationSender{failUntil: 3}
	dispatcher := newNotificationDispatcher(sender, nil)
	dispatcher.retryDelay = time.Hour
	ctx, cancel := context.WithCancel(context.Background())
	go dispatcher.Run(ctx)

	dispatcher.Enqueue(ctx, "hola", "apply:3")
	deadline := time.Now().Add(time.Second)
	for sender.callCount() == 0 && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	cancel()
	deadline = time.Now().Add(time.Second)
	for dispatcher.failed.Load() == 0 && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	if dispatcher.failed.Load() != 1 {
		t.Fatalf("failed = %d, quiero 1", dispatcher.failed.Load())
	}
}
