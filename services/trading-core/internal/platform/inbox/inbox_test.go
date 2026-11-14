package inbox

import "testing"

func TestInboxDeduplicatesAndCompletes(t *testing.T) {
	record, accepted, err := Accept(nil, "consumer", "message-1", 100)
	if err != nil || !accepted {
		t.Fatalf("accept = %v, %v", accepted, err)
	}
	duplicate, accepted, err := Accept(&record, "consumer", "message-1", 200)
	if err != nil || accepted || duplicate.ReceivedAt != 100 {
		t.Fatalf("duplicado inesperado: %+v %v %v", duplicate, accepted, err)
	}
	completed, err := Complete(record, 300)
	if err != nil {
		t.Fatal(err)
	}
	if completed.State != Processed || completed.ProcessedAt == nil || *completed.ProcessedAt != 300 {
		t.Fatalf("complete inesperado: %+v", completed)
	}
	if _, err := Fail(completed, "late", 400); err == nil {
		t.Fatal("un mensaje procesado no debe fallar")
	}
}
