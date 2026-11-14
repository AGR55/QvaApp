package main

import (
	"bytes"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/AGR55/QvaApp/services/trading-core/internal/notifier"
)

func testService() *service {
	return &service{
		cfg:    config{DryRun: true, ChatID: "123"},
		dedupe: notifier.NewDeduper(time.Minute),
	}
}

func TestNotifyDryRunAndDedupe(t *testing.T) {
	handler := testService()
	payload := []byte(`{"text":"hola","dedupeKey":"key-1"}`)
	for index, want := range []int{http.StatusAccepted, http.StatusOK} {
		recorder := httptest.NewRecorder()
		handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodPost, "/notify", bytes.NewReader(payload)))
		if recorder.Code != want {
			t.Fatalf("intento %d status = %d, quiero %d: %s", index, recorder.Code, want, recorder.Body.String())
		}
	}
	if handler.sent.Load() != 1 || handler.deduped.Load() != 1 {
		t.Fatalf("sent=%d deduped=%d", handler.sent.Load(), handler.deduped.Load())
	}
}

func TestNotifyRequiresInternalToken(t *testing.T) {
	service := testService()
	service.cfg.InternalKey = "secret"
	recorder := httptest.NewRecorder()
	service.ServeHTTP(recorder, httptest.NewRequest(http.MethodPost, "/notify", bytes.NewReader([]byte(`{"text":"hola"}`))))
	if recorder.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d", recorder.Code)
	}
}
