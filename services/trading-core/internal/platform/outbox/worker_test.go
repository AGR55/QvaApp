package outbox

import (
	"context"
	"errors"
	"testing"
	"time"
)

type fakeRepository struct {
	claimed  []Message
	failed   []string
	complete map[string]bool
}

func (repository *fakeRepository) ClaimDue(context.Context, string, int64, int64, int) ([]Message, error) {
	return repository.claimed, nil
}

func (repository *fakeRepository) Complete(_ context.Context, id, _ string, _ int64) (bool, error) {
	return repository.complete[id], nil
}

func (repository *fakeRepository) Fail(_ context.Context, id, _, _ string, _, _ int64, _ int) (State, error) {
	repository.failed = append(repository.failed, id)
	return Pending, nil
}

type fakePublisher struct {
	fail map[string]bool
	sent []string
}

func (publisher *fakePublisher) Publish(_ context.Context, message Message) error {
	if publisher.fail[message.ID] {
		return errors.New("bus caído")
	}
	publisher.sent = append(publisher.sent, message.ID)
	return nil
}

func TestWorkerPublishesAndRetries(t *testing.T) {
	repository := &fakeRepository{
		claimed:  []Message{{ID: "m1"}, {ID: "m2"}},
		complete: map[string]bool{"m1": true, "m2": true},
	}
	publisher := &fakePublisher{fail: map[string]bool{"m2": true}}
	worker, err := NewWorker(repository, publisher, WorkerConfig{
		WorkerID: "w1", Batch: 10, Lease: time.Minute, RetryDelay: time.Second,
	})
	if err != nil {
		t.Fatal(err)
	}
	result, err := worker.RunOnce(context.Background(), 1000)
	if err != nil {
		t.Fatal(err)
	}
	if result.Claimed != 2 || result.Published != 1 || result.Failed != 1 {
		t.Fatalf("resultado inesperado: %+v", result)
	}
	if len(publisher.sent) != 1 || publisher.sent[0] != "m1" {
		t.Fatalf("publicados = %v", publisher.sent)
	}
	if len(repository.failed) != 1 || repository.failed[0] != "m2" {
		t.Fatalf("fallidos = %v", repository.failed)
	}
}

func TestWorkerReportsLostLease(t *testing.T) {
	repository := &fakeRepository{
		claimed:  []Message{{ID: "m1"}},
		complete: map[string]bool{"m1": false},
	}
	worker, _ := NewWorker(repository, &fakePublisher{}, WorkerConfig{})
	result, err := worker.RunOnce(context.Background(), 1000)
	if err != nil {
		t.Fatal(err)
	}
	if result.Published != 0 || len(result.Errors) != 1 {
		t.Fatalf("resultado inesperado: %+v", result)
	}
}
