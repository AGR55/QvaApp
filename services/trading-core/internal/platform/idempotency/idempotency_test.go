package idempotency

import "testing"

func TestIdempotencyClaimReplayConflict(t *testing.T) {
	record, status, err := Claim(nil, "apply", "key-1", "hash-a", 100, 1_000)
	if err != nil || status != Claimed || record.State != Reserved {
		t.Fatalf("claim inesperado: %+v %v %v", record, status, err)
	}
	if _, status, _ := Claim(&record, "apply", "key-1", "hash-a", 200, 1_000); status != InProgress {
		t.Fatalf("estado = %s", status)
	}
	if _, status, _ := Claim(&record, "apply", "key-1", "hash-b", 200, 1_000); status != Conflict {
		t.Fatalf("estado = %s", status)
	}
	completed, err := Complete(record, `{"ok":true}`, 300)
	if err != nil {
		t.Fatal(err)
	}
	replayed, status, _ := Claim(&completed, "apply", "key-1", "hash-a", 400, 1_000)
	if status != Replay || replayed.ResponseJSON != `{"ok":true}` {
		t.Fatalf("replay inesperado: %+v %v", replayed, status)
	}
	expired := completed
	expired.ExpiresAt = 500
	if _, status, _ := Claim(&expired, "apply", "key-1", "hash-a", 600, 1_000); status != Claimed {
		t.Fatalf("estado tras expirar = %s", status)
	}
}

func TestIdempotencyFailAllowsRetry(t *testing.T) {
	record, _, _ := Claim(nil, "apply", "key-1", "hash-a", 100, 1_000)
	failed, err := Fail(record, 200)
	if err != nil {
		t.Fatal(err)
	}
	retry, status, err := Claim(&failed, "apply", "key-1", "hash-a", 300, 1_000)
	if err != nil || status != Claimed || retry.State != Reserved {
		t.Fatalf("retry inesperado: %+v %v %v", retry, status, err)
	}
}
