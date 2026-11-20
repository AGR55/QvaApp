package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"
)

// operationNotifier envía avisos de operaciones al notifier, que a su vez los
// publica en el chat administrador de Telegram.
type operationNotifier struct {
	url   string
	token string
	http  *http.Client
}

func newOperationNotifier() *operationNotifier {
	url := strings.TrimSpace(os.Getenv("NOTIFIER_URL"))
	if url == "" {
		return nil
	}
	return &operationNotifier{
		url: strings.TrimRight(url, "/"), token: strings.TrimSpace(os.Getenv("NOTIFIER_INTERNAL_TOKEN")),
		http: &http.Client{Timeout: 5 * time.Second},
	}
}

func (notifier *operationNotifier) Send(ctx context.Context, text, key string) error {
	if notifier == nil || strings.TrimSpace(text) == "" {
		return nil
	}
	payload, err := json.Marshal(map[string]string{"text": text, "dedupeKey": key})
	if err != nil {
		return err
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost,
		notifier.url+"/notify", bytes.NewReader(payload))
	if err != nil {
		return err
	}
	request.Header.Set("Content-Type", "application/json")
	if notifier.token != "" {
		request.Header.Set("X-Notifier-Token", notifier.token)
	}
	response, err := notifier.http.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		raw, _ := io.ReadAll(io.LimitReader(response.Body, 512))
		return fmt.Errorf("notifier respondió %d: %s", response.StatusCode, strings.TrimSpace(string(raw)))
	}
	return nil
}
