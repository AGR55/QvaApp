package notifier

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
)

func TestSetWebhook(t *testing.T) {
	var calls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		if r.Method != http.MethodPost {
			t.Errorf("método = %q, se esperaba POST", r.Method)
		}
		if r.URL.Path != "/bottoken-secreto/setWebhook" {
			t.Errorf("path = %q, se esperaba el de setWebhook con token", r.URL.Path)
		}
		if r.URL.RawQuery != "" {
			t.Errorf("query inesperada = %q", r.URL.RawQuery)
		}
		if r.Header.Get("Content-Type") != "application/json" {
			t.Errorf("Content-Type = %q, se esperaba application/json",
				r.Header.Get("Content-Type"))
		}

		body, err := io.ReadAll(r.Body)
		if err != nil {
			t.Fatal(err)
		}
		var raw map[string]json.RawMessage
		if err := json.Unmarshal(body, &raw); err != nil {
			t.Fatalf("payload inválido: %v: %s", err, body)
		}
		if len(raw) != 3 {
			t.Fatalf("el payload tiene %d campos, se esperaban 3: %s", len(raw), body)
		}
		for _, key := range []string{"url", "secret_token", "allowed_updates"} {
			if _, ok := raw[key]; !ok {
				t.Fatalf("falta el campo %q en el payload: %s", key, body)
			}
		}

		var payload struct {
			URL            string   `json:"url"`
			SecretToken    string   `json:"secret_token"`
			AllowedUpdates []string `json:"allowed_updates"`
		}
		if err := json.Unmarshal(body, &payload); err != nil {
			t.Fatal(err)
		}
		if payload.URL != "https://bot.example/telegram" {
			t.Errorf("url = %q, se esperaba https://bot.example/telegram", payload.URL)
		}
		if payload.SecretToken != "secreto-123" {
			t.Errorf("secret_token = %q, se esperaba secreto-123", payload.SecretToken)
		}
		wantAllowed := []string{"message", "callback_query"}
		if len(payload.AllowedUpdates) != len(wantAllowed) {
			t.Fatalf("allowed_updates = %v, se esperaba %v", payload.AllowedUpdates, wantAllowed)
		}
		for index, update := range wantAllowed {
			if payload.AllowedUpdates[index] != update {
				t.Fatalf("allowed_updates = %v, se esperaba %v", payload.AllowedUpdates, wantAllowed)
			}
		}

		fmt.Fprint(w, `{"ok":true,"result":true}`)
	}))
	t.Cleanup(server.Close)

	client := NewClient("token-secreto", server.URL)
	err := client.SetWebhook(context.Background(), "https://bot.example/telegram",
		"secreto-123", []string{"message", "callback_query"})
	if err != nil {
		t.Fatal(err)
	}
	if calls.Load() != 1 {
		t.Fatalf("se hicieron %d peticiones, se esperaba 1", calls.Load())
	}
}

func TestSetWebhookOmitsAllowedUpdates(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, err := io.ReadAll(r.Body)
		if err != nil {
			t.Fatal(err)
		}
		var raw map[string]json.RawMessage
		if err := json.Unmarshal(body, &raw); err != nil {
			t.Fatalf("payload inválido: %v: %s", err, body)
		}
		if len(raw) != 2 {
			t.Fatalf("el payload tiene %d campos, se esperaban 2: %s", len(raw), body)
		}
		if _, ok := raw["allowed_updates"]; ok {
			t.Fatalf("allowed_updates debería omitirse: %s", body)
		}
		fmt.Fprint(w, `{"ok":true,"result":true}`)
	}))
	t.Cleanup(server.Close)

	client := NewClient("token-secreto", server.URL)
	if err := client.SetWebhook(context.Background(), "https://bot.example/telegram",
		"secreto-123", nil); err != nil {
		t.Fatal(err)
	}
}

func TestSetWebhookAcceptsLocalhostHTTP(t *testing.T) {
	var calls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		if r.Method != http.MethodPost || r.URL.Path != "/bottoken-secreto/setWebhook" {
			t.Errorf("petición inesperada: %s %s", r.Method, r.URL.Path)
		}
		fmt.Fprint(w, `{"ok":true,"result":true}`)
	}))
	t.Cleanup(server.Close)

	localhostURL := strings.Replace(server.URL, "127.0.0.1", "localhost", 1)
	webhooks := []string{
		localhostURL + "/telegram",
		server.URL + "/telegram",
	}
	client := NewClient("token-secreto", server.URL)
	for _, webhookURL := range webhooks {
		if err := client.SetWebhook(context.Background(), webhookURL, "secreto-123", nil); err != nil {
			t.Fatalf("webhook local rechazado (%s): %v", webhookURL, err)
		}
	}
	if calls.Load() != int32(len(webhooks)) {
		t.Fatalf("se hicieron %d peticiones, se esperaban %d", calls.Load(), len(webhooks))
	}
}

func TestSetWebhookValidation(t *testing.T) {
	tests := []struct {
		name           string
		url            string
		secret         string
		allowedUpdates []string
		want           string
	}{
		{
			name:   "url vacía",
			url:    "",
			secret: "secreto-123",
			want:   "URL del webhook no configurada",
		},
		{
			name:   "url relativa",
			url:    "bot.example/telegram",
			secret: "secreto-123",
			want:   "URL del webhook inválida",
		},
		{
			name:   "url sin host",
			url:    "https://",
			secret: "secreto-123",
			want:   "URL del webhook inválida",
		},
		{
			name:   "url mal formada",
			url:    "://bot.example/telegram",
			secret: "secreto-123",
			want:   "URL del webhook inválida",
		},
		{
			name:   "esquema no permitido",
			url:    "ftp://bot.example/telegram",
			secret: "secreto-123",
			want:   "debe usar https",
		},
		{
			name:   "http fuera de localhost",
			url:    "http://bot.example/telegram",
			secret: "secreto-123",
			want:   "localhost o 127.0.0.1",
		},
		{
			name:   "http con host parecido a localhost",
			url:    "http://localhost.evil.example/telegram",
			secret: "secreto-123",
			want:   "localhost o 127.0.0.1",
		},
		{
			name:   "http con host parecido a 127.0.0.1",
			url:    "http://127.0.0.1.evil.example/telegram",
			secret: "secreto-123",
			want:   "localhost o 127.0.0.1",
		},
		{
			name:   "credenciales en la url",
			url:    "https://usuario:clave@bot.example/telegram",
			secret: "secreto-123",
			want:   "no puede incluir credenciales",
		},
		{
			name:   "query en la url",
			url:    "https://bot.example/telegram?token=secreto",
			secret: "secreto-123",
			want:   "no puede incluir query",
		},
		{
			name:   "query vacía en la url",
			url:    "https://bot.example/telegram?",
			secret: "secreto-123",
			want:   "no puede incluir query",
		},
		{
			name:   "secret vacío",
			url:    "https://bot.example/telegram",
			secret: "",
			want:   "secret del webhook no configurado",
		},
		{
			name:   "secret demasiado largo",
			url:    "https://bot.example/telegram",
			secret: strings.Repeat("a", maxWebhookSecret+1),
			want:   "secret del webhook demasiado largo",
		},
		{
			name:           "actualización no permitida",
			url:            "https://bot.example/telegram",
			secret:         "secreto-123",
			allowedUpdates: []string{"getUpdates"},
			want:           "actualización no permitida",
		},
		{
			name:           "actualización con mayúsculas",
			url:            "https://bot.example/telegram",
			secret:         "secreto-123",
			allowedUpdates: []string{"MESSAGE"},
			want:           "actualización no permitida",
		},
		{
			name:           "demasiadas actualizaciones",
			url:            "https://bot.example/telegram",
			secret:         "secreto-123",
			allowedUpdates: []string{"message", "message", "message", "message", "message", "message"},
			want:           "demasiadas actualizaciones permitidas",
		},
	}

	var calls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		calls.Add(1)
		fmt.Fprint(w, `{"ok":true,"result":true}`)
	}))
	t.Cleanup(server.Close)

	client := NewClient("token-secreto", server.URL)
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			err := client.SetWebhook(context.Background(), test.url, test.secret, test.allowedUpdates)
			if err == nil {
				t.Fatal("se esperaba error de validación")
			}
			if !strings.Contains(err.Error(), test.want) {
				t.Fatalf("error = %q, se esperaba que contuviera %q", err, test.want)
			}
			if strings.Contains(err.Error(), "token-secreto") {
				t.Fatalf("el error filtra el token: %v", err)
			}
		})
	}
	if calls.Load() != 0 {
		t.Fatalf("se hizo red con datos inválidos: %d peticiones", calls.Load())
	}
}

func TestSetWebhookAcceptsLimits(t *testing.T) {
	var calls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		calls.Add(1)
		fmt.Fprint(w, `{"ok":true,"result":true}`)
	}))
	t.Cleanup(server.Close)

	allowedUpdates := make([]string, maxWebhookAllowedUpdates)
	for index := range allowedUpdates {
		allowedUpdates[index] = "message"
	}

	client := NewClient("token-secreto", server.URL)
	err := client.SetWebhook(context.Background(), "https://bot.example/telegram",
		strings.Repeat("a", maxWebhookSecret), allowedUpdates)
	if err != nil {
		t.Fatalf("los límites exactos fueron rechazados: %v", err)
	}
	if calls.Load() != 1 {
		t.Fatalf("se hicieron %d peticiones, se esperaba 1", calls.Load())
	}
}

func TestDeleteWebhook(t *testing.T) {
	var calls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		if r.Method != http.MethodPost {
			t.Errorf("método = %q, se esperaba POST", r.Method)
		}
		if r.URL.Path != "/bottoken-secreto/deleteWebhook" {
			t.Errorf("path = %q, se esperaba el de deleteWebhook con token", r.URL.Path)
		}
		fmt.Fprint(w, `{"ok":true,"result":true}`)
	}))
	t.Cleanup(server.Close)

	client := NewClient("token-secreto", server.URL)
	if err := client.DeleteWebhook(context.Background()); err != nil {
		t.Fatal(err)
	}
	if calls.Load() != 1 {
		t.Fatalf("se hicieron %d peticiones, se esperaba 1", calls.Load())
	}
}

func TestWebhookInfo(t *testing.T) {
	tests := []struct {
		name   string
		result string
		want   WebhookInfo
	}{
		{
			name:   "webhook configurado",
			result: `{"url":"https://bot.example/telegram","pending_update_count":7,"last_error_message":"timeout"}`,
			want: WebhookInfo{
				URL:            "https://bot.example/telegram",
				PendingUpdates: 7,
				LastError:      "timeout",
			},
		},
		{
			name:   "sin webhook",
			result: `{"url":"","pending_update_count":0}`,
			want:   WebhookInfo{},
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			var calls atomic.Int32
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls.Add(1)
				if r.Method != http.MethodGet {
					t.Errorf("método = %q, se esperaba GET", r.Method)
				}
				if r.URL.Path != "/bottoken-secreto/getWebhookInfo" {
					t.Errorf("path = %q, se esperaba el de getWebhookInfo con token", r.URL.Path)
				}
				fmt.Fprintf(w, `{"ok":true,"result":%s}`, test.result)
			}))
			t.Cleanup(server.Close)

			client := NewClient("token-secreto", server.URL)
			info, err := client.WebhookInfo(context.Background())
			if err != nil {
				t.Fatal(err)
			}
			if info != test.want {
				t.Fatalf("WebhookInfo = %+v, se esperaba %+v", info, test.want)
			}
			if calls.Load() != 1 {
				t.Fatalf("se hicieron %d peticiones, se esperaba 1", calls.Load())
			}
		})
	}
}

func TestWebhookInfoErrors(t *testing.T) {
	tests := []struct {
		name   string
		body   string
		status int
		want   string
	}{
		{
			name:   "sin resultado",
			body:   `{"ok":true}`,
			status: http.StatusOK,
			want:   "sin resultado",
		},
		{
			name:   "respuesta no json",
			body:   `no-json`,
			status: http.StatusOK,
			want:   "respuesta inválida",
		},
		{
			name:   "ok falso",
			body:   `{"ok":false,"description":"Unauthorized for token-secreto"}`,
			status: http.StatusOK,
			want:   "Unauthorized",
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				w.WriteHeader(test.status)
				fmt.Fprint(w, test.body)
			}))
			t.Cleanup(server.Close)

			client := NewClient("token-secreto", server.URL)
			info, err := client.WebhookInfo(context.Background())
			if err == nil {
				t.Fatal("se esperaba error")
			}
			if !strings.Contains(err.Error(), test.want) {
				t.Fatalf("error = %q, se esperaba que contuviera %q", err, test.want)
			}
			if strings.Contains(err.Error(), "token-secreto") {
				t.Fatalf("el error filtra el token: %v", err)
			}
			if info != (WebhookInfo{}) {
				t.Fatalf("WebhookInfo = %+v, se esperaba el valor cero", info)
			}
		})
	}
}

func TestWebhookAPIErrorDoesNotLeakToken(t *testing.T) {
	const secret = "secret-super-secreto"

	var calls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		calls.Add(1)
		w.WriteHeader(http.StatusUnauthorized)
		fmt.Fprintf(w, `{"ok":false,"description":"Unauthorized token-secreto %s"}`, secret)
	}))
	t.Cleanup(server.Close)

	client := NewClient("token-secreto", server.URL)
	err := client.SetWebhook(context.Background(), "https://bot.example/telegram",
		secret, []string{"message"})
	if err == nil {
		t.Fatal("se esperaba error")
	}
	if strings.Contains(err.Error(), "token-secreto") {
		t.Fatalf("el error filtra el token: %v", err)
	}
	if strings.Contains(err.Error(), secret) {
		t.Fatalf("el error filtra el secret: %v", err)
	}
	apiErr := &APIError{}
	if !errors.As(err, &apiErr) {
		t.Fatalf("error = %T, se esperaba *APIError", err)
	}
	if apiErr.Status != http.StatusUnauthorized {
		t.Fatalf("Status = %d, se esperaba %d", apiErr.Status, http.StatusUnauthorized)
	}

	for name, call := range map[string]func() error{
		"DeleteWebhook": func() error { return client.DeleteWebhook(context.Background()) },
		"WebhookInfo": func() error {
			_, callErr := client.WebhookInfo(context.Background())
			return callErr
		},
	} {
		err := call()
		if err == nil {
			t.Fatalf("%s: se esperaba error", name)
		}
		if strings.Contains(err.Error(), "token-secreto") {
			t.Fatalf("%s filtra el token: %v", name, err)
		}
		apiErr := &APIError{}
		if !errors.As(err, &apiErr) {
			t.Fatalf("%s: error = %T, se esperaba *APIError", name, err)
		}
	}
	if calls.Load() != 3 {
		t.Fatalf("se hicieron %d peticiones, se esperaban 3", calls.Load())
	}
}

func TestWebhookNetworkErrorDoesNotLeakToken(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		fmt.Fprint(w, `{"ok":true,"result":true}`)
	}))
	baseURL := server.URL
	server.Close()

	client := NewClient("token-secreto", baseURL)
	err := client.DeleteWebhook(context.Background())
	if err == nil {
		t.Fatal("se esperaba error de conexión")
	}
	if !strings.Contains(err.Error(), "conectar Telegram") {
		t.Fatalf("error = %q, se esperaba un error de conexión", err)
	}
	if strings.Contains(err.Error(), "token-secreto") {
		t.Fatalf("el error filtra el token: %v", err)
	}
}

func TestWebhookMissingToken(t *testing.T) {
	var calls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		calls.Add(1)
		fmt.Fprint(w, `{"ok":true,"result":true}`)
	}))
	t.Cleanup(server.Close)

	client := NewClient("", server.URL)
	operations := map[string]func() error{
		"SetWebhook": func() error {
			return client.SetWebhook(context.Background(), "https://bot.example/telegram",
				"secreto-123", []string{"message"})
		},
		"DeleteWebhook": func() error { return client.DeleteWebhook(context.Background()) },
		"WebhookInfo": func() error {
			_, err := client.WebhookInfo(context.Background())
			return err
		},
	}
	for name, call := range operations {
		err := call()
		if err == nil || !strings.Contains(err.Error(), "token de Telegram no configurado") {
			t.Fatalf("%s: error sin token = %v", name, err)
		}
	}
	if calls.Load() != 0 {
		t.Fatalf("se hizo red sin token: %d peticiones", calls.Load())
	}
}
