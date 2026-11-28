package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/cookiejar"
	"strings"
	"sync"
	"time"
)

// edgeClient habla con la API interna del edge usando la sesión de panel.
// Reutiliza cookie y CSRF y renueva la sesión si expira.
type edgeClient struct {
	baseURL  string
	origin   string
	password string
	http     *http.Client

	mu     sync.Mutex
	logged bool
	csrf   string
}

func newEdgeClient(baseURL, origin, password string) *edgeClient {
	jar, _ := cookiejar.New(nil)
	return &edgeClient{
		baseURL: strings.TrimRight(baseURL, "/"), origin: origin, password: password,
		http: &http.Client{Jar: jar, Timeout: 25 * time.Second},
	}
}

func (client *edgeClient) login(ctx context.Context) error {
	payload, _ := json.Marshal(map[string]string{"password": client.password})
	request, err := http.NewRequestWithContext(ctx, http.MethodPost,
		client.baseURL+"/api/session", bytes.NewReader(payload))
	if err != nil {
		return err
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Origin", client.origin)
	response, err := client.http.Do(request)
	if err != nil {
		return fmt.Errorf("edge login: %w", err)
	}
	defer response.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(response.Body, 1<<20))
	if response.StatusCode != http.StatusOK {
		return fmt.Errorf("edge login: %d", response.StatusCode)
	}
	var envelope struct {
		Data struct {
			CSRF string `json:"csrfToken"`
		} `json:"data"`
	}
	if err := json.Unmarshal(raw, &envelope); err != nil {
		return fmt.Errorf("edge login: respuesta inválida")
	}
	if strings.TrimSpace(envelope.Data.CSRF) == "" {
		return fmt.Errorf("edge login: sin CSRF")
	}
	client.csrf = envelope.Data.CSRF
	client.logged = true
	return nil
}

func (client *edgeClient) do(
	ctx context.Context,
	method, path string,
	body any,
	out any,
) error {
	for attempt := 0; attempt < 2; attempt++ {
		client.mu.Lock()
		if !client.logged {
			if err := client.login(ctx); err != nil {
				client.mu.Unlock()
				return err
			}
		}
		csrf := client.csrf
		client.mu.Unlock()

		var reader io.Reader
		if body != nil {
			encoded, err := json.Marshal(body)
			if err != nil {
				return err
			}
			reader = bytes.NewReader(encoded)
		}
		request, err := http.NewRequestWithContext(ctx, method, client.baseURL+path, reader)
		if err != nil {
			return err
		}
		request.Header.Set("Origin", client.origin)
		if body != nil {
			request.Header.Set("Content-Type", "application/json")
		}
		if method != http.MethodGet {
			request.Header.Set("X-CSRF-Token", csrf)
		}
		response, err := client.http.Do(request)
		if err != nil {
			return fmt.Errorf("edge %s %s: %w", method, path, err)
		}
		raw, _ := io.ReadAll(io.LimitReader(response.Body, 2<<20))
		response.Body.Close()
		if response.StatusCode == http.StatusUnauthorized && attempt == 0 {
			client.mu.Lock()
			client.logged = false
			client.csrf = ""
			client.mu.Unlock()
			continue
		}
		if response.StatusCode < 200 || response.StatusCode >= 300 {
			message := strings.TrimSpace(string(raw))
			if len(message) > 300 {
				message = message[:300]
			}
			return fmt.Errorf("edge %s %s: %d %s", method, path, response.StatusCode, message)
		}
		if out != nil && len(raw) > 0 {
			if err := json.Unmarshal(raw, out); err != nil {
				return fmt.Errorf("edge %s %s: respuesta inválida", method, path)
			}
		}
		return nil
	}
	return fmt.Errorf("edge: sesión no autorizada")
}

func (client *edgeClient) data(ctx context.Context, path string) (map[string]any, error) {
	var envelope struct {
		Data map[string]any `json:"data"`
	}
	if err := client.do(ctx, http.MethodGet, path, nil, &envelope); err != nil {
		return nil, err
	}
	return envelope.Data, nil
}

func (client *edgeClient) dashboard(ctx context.Context) (map[string]any, error) {
	return client.data(ctx, "/api/dashboard")
}

func (client *edgeClient) config(ctx context.Context) (map[string]any, error) {
	return client.data(ctx, "/api/config")
}

func (client *edgeClient) logs(ctx context.Context) ([]any, error) {
	var envelope struct {
		Data []any `json:"data"`
	}
	if err := client.do(ctx, http.MethodGet, "/api/logs?limit=5", nil, &envelope); err != nil {
		return nil, err
	}
	return envelope.Data, nil
}

func (client *edgeClient) send(ctx context.Context, method, path string, body any) error {
	return client.do(ctx, method, path, body, nil)
}
