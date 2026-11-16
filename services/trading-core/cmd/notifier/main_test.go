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
		cfg:    config{DryRun: true, ChatID: "123", InternalKey: "secret"},
		dedupe: notifier.NewDeduper(time.Minute),
	}
}

func notifyHTTPRequest(payload []byte) *http.Request {
	request := httptest.NewRequest(http.MethodPost, "/notify", bytes.NewReader(payload))
	request.Header.Set("X-Notifier-Token", "secret")
	return request
}

func TestNotifyDryRunAndDedupe(t *testing.T) {
	handler := testService()
	payload := []byte(`{"text":"hola","dedupeKey":"key-1"}`)
	for index, want := range []int{http.StatusAccepted, http.StatusOK} {
		recorder := httptest.NewRecorder()
		handler.ServeHTTP(recorder, notifyHTTPRequest(payload))
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

func TestTelegramUpdateDisabled(t *testing.T) {
	service := testService()
	body := []byte(`{"update_id":1,"message":{"chat":{"id":123},"from":{"id":123,"is_bot":false},"text":"/status"}}`)
	recorder := httptest.NewRecorder()
	service.ServeHTTP(recorder, httptest.NewRequest(http.MethodPost, "/telegram/update", bytes.NewReader(body)))
	if recorder.Code != http.StatusNotFound {
		t.Fatalf("status = %d: %s", recorder.Code, recorder.Body.String())
	}
}

func TestTelegramUpdateRequiresSecret(t *testing.T) {
	service := testService()
	service.cfg.WebhookEnabled = true
	body := []byte(`{"update_id":1,"message":{"chat":{"id":123},"from":{"id":123,"is_bot":false},"text":"/status"}}`)
	recorder := httptest.NewRecorder()
	service.ServeHTTP(recorder, httptest.NewRequest(http.MethodPost, "/telegram/update", bytes.NewReader(body)))
	if recorder.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d: %s", recorder.Code, recorder.Body.String())
	}
}

func TestTelegramUpdateSecret(t *testing.T) {
	service := testService()
	service.cfg.WebhookEnabled = true
	service.cfg.TelegramSecret = "secreto"
	body := []byte(`{"update_id":1,"message":{"chat":{"id":123},"from":{"id":123,"is_bot":false},"text":"/status"}}`)
	recorder := httptest.NewRecorder()
	service.ServeHTTP(recorder, httptest.NewRequest(http.MethodPost, "/telegram/update", bytes.NewReader(body)))
	if recorder.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d", recorder.Code)
	}
}

func TestTelegramUpdateRequiresProcessor(t *testing.T) {
	service := testService()
	service.cfg.WebhookEnabled = true
	service.cfg.TelegramSecret = "secreto"
	body := []byte(`{"update_id":1,"message":{"chat":{"id":123},"from":{"id":123,"is_bot":false},"text":"/status"}}`)
	request := httptest.NewRequest(http.MethodPost, "/telegram/update", bytes.NewReader(body))
	request.Header.Set("X-Telegram-Bot-Api-Secret-Token", "secreto")
	recorder := httptest.NewRecorder()
	service.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d: %s", recorder.Code, recorder.Body.String())
	}
}
