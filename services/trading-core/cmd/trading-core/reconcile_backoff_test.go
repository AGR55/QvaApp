package main

import (
	"testing"
	"time"
)

func TestStaleBackoffDuplicaHastaElMaximo(t *testing.T) {
	reconciler := &operationReconciler{}
	now := time.Unix(1_700_000_000, 0)
	if !reconciler.staleDue("op-1", now) {
		t.Fatal("una operación nueva debe releerse de inmediato")
	}
	expected := []time.Duration{30 * time.Second, 60 * time.Second, 2 * time.Minute, 4 * time.Minute, 8 * time.Minute, 15 * time.Minute, 15 * time.Minute}
	for _, delay := range expected {
		reconciler.noteStale("op-1", now)
		if reconciler.staleDue("op-1", now.Add(delay-time.Second)) {
			t.Fatalf("no debe releerse antes de %s", delay)
		}
		if !reconciler.staleDue("op-1", now.Add(delay)) {
			t.Fatalf("debe releerse tras %s", delay)
		}
		now = now.Add(delay)
	}
}

func TestStaleBackoffSeLimpiaCuandoLaOperacionCierra(t *testing.T) {
	reconciler := &operationReconciler{}
	now := time.Unix(1_700_000_000, 0)
	reconciler.noteStale("op-1", now)
	reconciler.noteStale("op-2", now)
	reconciler.pruneStale(map[string]struct{}{"op-2": {}})
	if !reconciler.staleDue("op-1", now.Add(time.Second)) {
		t.Fatal("una operación cerrada debe quitarse del backoff")
	}
	if reconciler.staleDue("op-2", now.Add(time.Second)) {
		t.Fatal("una operación aún estancada debe conservar el backoff")
	}
}
