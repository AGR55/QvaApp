package outbox

import (
	"testing"
	"time"
)

func TestOutboxLifecycle(t *testing.T) {
	message, err := New("m1", "core.events", "{}", "key-1", 100)
	if err != nil {
		t.Fatal(err)
	}
	if !message.Due(100) {
		t.Fatal("el mensaje debe estar disponible")
	}
	claimed, err := Claim(message, "worker-1", 100, time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	if claimed.State != InFlight || claimed.Attempts != 1 || claimed.LockedBy != "worker-1" {
		t.Fatalf("claim inesperado: %+v", claimed)
	}
	if _, err := Claim(claimed, "worker-2", 101, time.Minute); err == nil {
		t.Fatal("un lease vigente no debe reclamarse")
	}
	if _, err := Claim(claimed, "worker-2", 60_101, time.Minute); err != nil {
		t.Fatalf("un lease vencido debe reclamarse: %v", err)
	}
	completed, err := Complete(claimed, 300)
	if err != nil {
		t.Fatal(err)
	}
	if completed.State != Published || completed.LockedAt != nil {
		t.Fatalf("complete inesperado: %+v", completed)
	}
	if _, err := Claim(completed, "worker", 400, time.Minute); err == nil {
		t.Fatal("un mensaje publicado no debe reclamarse")
	}
}

func TestOutboxRetryAndFailure(t *testing.T) {
	message, _ := New("m1", "core.events", "{}", "key-1", 100)
	first, _ := Claim(message, "worker", 100, time.Minute)
	retry, err := Fail(first, "network", 200, 500, 2)
	if err != nil {
		t.Fatal(err)
	}
	if retry.State != Pending || retry.AvailableAt != 500 || retry.LastError != "network" {
		t.Fatalf("retry inesperado: %+v", retry)
	}
	second, _ := Claim(retry, "worker", 500, time.Minute)
	failed, err := Fail(second, "network", 600, 900, 2)
	if err != nil {
		t.Fatal(err)
	}
	if failed.State != Failed || failed.AvailableAt != 0 {
		t.Fatalf("failed inesperado: %+v", failed)
	}
}
