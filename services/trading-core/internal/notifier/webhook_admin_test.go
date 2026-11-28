package notifier

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
)

const (
	webhookAdminTestBotToken = "token-bot-super-secreto"
	webhookAdminTestSecret   = "secret-webhook-super-secreto"
	webhookAdminTestInternal = "interno-super-secreto"
)

func TestWebhookRegistrationValidate(t *testing.T) {
	validUpdates := []string{"message", "callback_query"}

	tests := []struct {
		name         string
		registration WebhookRegistration
		want         string
	}{
		{
			name: "habilitado con https",
			registration: WebhookRegistration{
				PublicURL:      "https://bot.example/telegram",
				Secret:         "secreto-123",
				AllowedUpdates: validUpdates,
				Enabled:        true,
			},
		},
		{
			name: "habilitado con http en localhost",
			registration: WebhookRegistration{
				PublicURL: "http://localhost:8080/telegram",
				Secret:    "secreto-123",
				Enabled:   true,
			},
		},
		{
			name: "habilitado con http en 127.0.0.1",
			registration: WebhookRegistration{
				PublicURL: "http://127.0.0.1:8080/telegram",
				Secret:    "secreto-123",
				Enabled:   true,
			},
		},
		{
			name: "habilitado sin actualizaciones",
			registration: WebhookRegistration{
				PublicURL: "https://bot.example/telegram",
				Secret:    "secreto-123",
				Enabled:   true,
			},
		},
		{
			name: "secret en el límite",
			registration: WebhookRegistration{
				PublicURL: "https://bot.example/telegram",
				Secret:    strings.Repeat("a", maxWebhookSecret),
				Enabled:   true,
			},
		},
		{
			name: "deshabilitado sin configuración",
			registration: WebhookRegistration{
				Enabled: false,
			},
		},
		{
			name: "deshabilitado con url en blanco",
			registration: WebhookRegistration{
				PublicURL: "   ",
				Enabled:   false,
			},
		},
		{
			name: "deshabilitado con configuración válida",
			registration: WebhookRegistration{
				PublicURL:      "https://bot.example/telegram",
				Secret:         "secreto-123",
				AllowedUpdates: validUpdates,
				Enabled:        false,
			},
		},
		{
			name: "deshabilitado con secret pero sin url",
			registration: WebhookRegistration{
				Secret:  "secreto-123",
				Enabled: false,
			},
		},
		{
			name: "habilitado sin url",
			registration: WebhookRegistration{
				Secret:  "secreto-123",
				Enabled: true,
			},
			want: "URL del webhook no configurada",
		},
		{
			name: "habilitado con http externo",
			registration: WebhookRegistration{
				PublicURL: "http://bot.example/telegram",
				Secret:    "secreto-123",
				Enabled:   true,
			},
			want: "localhost o 127.0.0.1",
		},
		{
			name: "habilitado con esquema no permitido",
			registration: WebhookRegistration{
				PublicURL: "ftp://bot.example/telegram",
				Secret:    "secreto-123",
				Enabled:   true,
			},
			want: "debe usar https",
		},
		{
			name: "habilitado con credenciales",
			registration: WebhookRegistration{
				PublicURL: "https://usuario:clave@bot.example/telegram",
				Secret:    "secreto-123",
				Enabled:   true,
			},
			want: "no puede incluir credenciales",
		},
		{
			name: "habilitado con query",
			registration: WebhookRegistration{
				PublicURL: "https://bot.example/telegram?token=secreto",
				Secret:    "secreto-123",
				Enabled:   true,
			},
			want: "no puede incluir query",
		},
		{
			name: "habilitado sin secret",
			registration: WebhookRegistration{
				PublicURL: "https://bot.example/telegram",
				Enabled:   true,
			},
			want: "secret del webhook no configurado",
		},
		{
			name: "habilitado con secret demasiado largo",
			registration: WebhookRegistration{
				PublicURL: "https://bot.example/telegram",
				Secret:    strings.Repeat("a", maxWebhookSecret+1),
				Enabled:   true,
			},
			want: "secret del webhook demasiado largo",
		},
		{
			name: "habilitado con actualización no permitida",
			registration: WebhookRegistration{
				PublicURL:      "https://bot.example/telegram",
				Secret:         "secreto-123",
				AllowedUpdates: []string{"getUpdates"},
				Enabled:        true,
			},
			want: "actualización no permitida",
		},
		{
			name: "habilitado con demasiadas actualizaciones",
			registration: WebhookRegistration{
				PublicURL:      "https://bot.example/telegram",
				Secret:         "secreto-123",
				AllowedUpdates: []string{"message", "message", "message", "message", "message", "message"},
				Enabled:        true,
			},
			want: "demasiadas actualizaciones permitidas",
		},
		{
			name: "deshabilitado con url inválida presente",
			registration: WebhookRegistration{
				PublicURL: "http://bot.example/telegram",
				Enabled:   false,
			},
			want: "localhost o 127.0.0.1",
		},
		{
			name: "deshabilitado con secret demasiado largo presente",
			registration: WebhookRegistration{
				Secret:  strings.Repeat("a", maxWebhookSecret+1),
				Enabled: false,
			},
			want: "secret del webhook demasiado largo",
		},
		{
			name: "deshabilitado con actualización no permitida presente",
			registration: WebhookRegistration{
				AllowedUpdates: []string{"edited_message"},
				Enabled:        false,
			},
			want: "actualización no permitida",
		},
		{
			name: "deshabilitado con demasiadas actualizaciones presentes",
			registration: WebhookRegistration{
				AllowedUpdates: []string{"message", "message", "message", "message", "message", "message"},
				Enabled:        false,
			},
			want: "demasiadas actualizaciones permitidas",
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			err := test.registration.Validate()
			if test.want == "" {
				if err != nil {
					t.Fatalf("Validate() = %v, se esperaba nil", err)
				}
				return
			}
			if err == nil {
				t.Fatalf("Validate() = nil, se esperaba un error con %q", test.want)
			}
			if !strings.Contains(err.Error(), test.want) {
				t.Fatalf("Validate() = %q, se esperaba que contuviera %q", err, test.want)
			}
			if strings.Contains(err.Error(), test.registration.Secret) && test.registration.Secret != "" {
				t.Fatalf("el error filtra el secret: %v", err)
			}
		})
	}
}

func TestWebhookAdminAuth(t *testing.T) {
	tests := []struct {
		name       string
		method     string
		path       string
		token      string
		wantCode   int
		wantStatus string
		wantCalls  int32
	}{
		{
			name:       "register sin token",
			method:     http.MethodPost,
			path:       webhookAdminRegisterPath,
			wantCode:   http.StatusUnauthorized,
			wantStatus: "unauthorized",
		},
		{
			name:       "register con token incorrecto",
			method:     http.MethodPost,
			path:       webhookAdminRegisterPath,
			token:      "otro-token",
			wantCode:   http.StatusUnauthorized,
			wantStatus: "unauthorized",
		},
		{
			name:       "register con token correcto",
			method:     http.MethodPost,
			path:       webhookAdminRegisterPath,
			token:      webhookAdminTestInternal,
			wantCode:   http.StatusOK,
			wantStatus: "registered",
			wantCalls:  1,
		},
		{
			name:       "delete sin token",
			method:     http.MethodDelete,
			path:       webhookAdminDeletePath,
			wantCode:   http.StatusUnauthorized,
			wantStatus: "unauthorized",
		},
		{
			name:       "delete con token incorrecto",
			method:     http.MethodDelete,
			path:       webhookAdminDeletePath,
			token:      "otro-token",
			wantCode:   http.StatusUnauthorized,
			wantStatus: "unauthorized",
		},
		{
			name:       "delete con token correcto",
			method:     http.MethodDelete,
			path:       webhookAdminDeletePath,
			token:      webhookAdminTestInternal,
			wantCode:   http.StatusOK,
			wantStatus: "deleted",
			wantCalls:  1,
		},
		{
			name:       "status sin token",
			method:     http.MethodGet,
			path:       webhookAdminStatusPath,
			wantCode:   http.StatusOK,
			wantStatus: "ok",
			wantCalls:  1,
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			client, calls := newWebhookAdminFakeTelegram(t, webhookAdminTelegramOK)
			admin := enabledWebhookAdmin(client, webhookAdminTestInternal)

			response := serveWebhookAdmin(t, admin, test.method, test.path, test.token)
			assertWebhookAdminJSON(t, response, test.wantCode, test.wantStatus)
			if calls.Load() != test.wantCalls {
				t.Fatalf("se hicieron %d peticiones a Telegram, se esperaban %d",
					calls.Load(), test.wantCalls)
			}
			assertWebhookAdminNoSecrets(t, response,
				webhookAdminTestBotToken, webhookAdminTestSecret, webhookAdminTestInternal)
		})
	}
}

func TestWebhookAdminAuthDisabledWithoutInternalToken(t *testing.T) {
	client, calls := newWebhookAdminFakeTelegram(t, webhookAdminTelegramOK)
	admin := enabledWebhookAdmin(client, "")

	response := serveWebhookAdmin(t, admin, http.MethodPost, webhookAdminRegisterPath, "")
	assertWebhookAdminJSON(t, response, http.StatusOK, "registered")
	if calls.Load() != 1 {
		t.Fatalf("se hicieron %d peticiones a Telegram, se esperaba 1", calls.Load())
	}
}

func TestWebhookAdminDisabledDoesNotCallTelegram(t *testing.T) {
	client, calls := newWebhookAdminFakeTelegram(t, func(w http.ResponseWriter, r *http.Request) {
		t.Errorf("no se esperaba red con el webhook deshabilitado: %s %s", r.Method, r.URL.Path)
		http.Error(w, "no esperado", http.StatusInternalServerError)
	})
	admin := &WebhookAdmin{
		Client:        client,
		Registration:  WebhookRegistration{Enabled: false},
		InternalToken: webhookAdminTestInternal,
	}

	tests := []struct {
		name   string
		method string
		path   string
		token  string
	}{
		{name: "register", method: http.MethodPost, path: webhookAdminRegisterPath, token: webhookAdminTestInternal},
		{name: "status", method: http.MethodGet, path: webhookAdminStatusPath},
		{name: "delete", method: http.MethodDelete, path: webhookAdminDeletePath, token: webhookAdminTestInternal},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			response := serveWebhookAdmin(t, admin, test.method, test.path, test.token)
			assertWebhookAdminJSON(t, response, http.StatusOK, "disabled")
			assertWebhookAdminNoSecrets(t, response,
				webhookAdminTestBotToken, webhookAdminTestSecret, webhookAdminTestInternal)
		})
	}
	if calls.Load() != 0 {
		t.Fatalf("se hicieron %d peticiones a Telegram, se esperaban 0", calls.Load())
	}

	admin.Client = nil
	for _, test := range tests {
		response := serveWebhookAdmin(t, admin, test.method, test.path, test.token)
		assertWebhookAdminJSON(t, response, http.StatusOK, "disabled")
	}
}

func TestWebhookAdminRegister(t *testing.T) {
	client, calls := newWebhookAdminFakeTelegram(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			t.Errorf("método = %q, se esperaba POST", r.Method)
		}
		if r.URL.Path != "/bot"+webhookAdminTestBotToken+"/setWebhook" {
			t.Errorf("path = %q, se esperaba setWebhook con el token", r.URL.Path)
		}
		if r.Header.Get("Content-Type") != "application/json" {
			t.Errorf("Content-Type = %q, se esperaba application/json",
				r.Header.Get("Content-Type"))
		}

		body, err := io.ReadAll(r.Body)
		if err != nil {
			t.Fatal(err)
		}
		var payload struct {
			URL            string   `json:"url"`
			SecretToken    string   `json:"secret_token"`
			AllowedUpdates []string `json:"allowed_updates"`
		}
		if err := json.Unmarshal(body, &payload); err != nil {
			t.Fatalf("payload inválido: %v: %s", err, body)
		}
		if payload.URL != "https://bot.example/telegram" {
			t.Errorf("url = %q", payload.URL)
		}
		if payload.SecretToken != webhookAdminTestSecret {
			t.Errorf("secret_token = %q", payload.SecretToken)
		}
		wantUpdates := []string{"message", "callback_query"}
		if len(payload.AllowedUpdates) != len(wantUpdates) {
			t.Fatalf("allowed_updates = %v, se esperaba %v",
				payload.AllowedUpdates, wantUpdates)
		}
		for index, update := range wantUpdates {
			if payload.AllowedUpdates[index] != update {
				t.Fatalf("allowed_updates = %v, se esperaba %v",
					payload.AllowedUpdates, wantUpdates)
			}
		}
		fmt.Fprint(w, `{"ok":true,"result":true}`)
	})
	admin := enabledWebhookAdmin(client, webhookAdminTestInternal)

	response := serveWebhookAdmin(t, admin, http.MethodPost, webhookAdminRegisterPath,
		webhookAdminTestInternal)
	assertWebhookAdminJSON(t, response, http.StatusOK, "registered")
	if calls.Load() != 1 {
		t.Fatalf("se hicieron %d peticiones, se esperaba 1", calls.Load())
	}
	if response.Header().Get("Cache-Control") != "no-store" {
		t.Errorf("Cache-Control = %q, se esperaba no-store",
			response.Header().Get("Cache-Control"))
	}
	assertWebhookAdminNoSecrets(t, response,
		webhookAdminTestBotToken, webhookAdminTestSecret, webhookAdminTestInternal)
}

func TestWebhookAdminRegisterValidation(t *testing.T) {
	tests := []struct {
		name         string
		registration WebhookRegistration
		want         string
	}{
		{
			name: "habilitado sin url",
			registration: WebhookRegistration{
				Secret:  "secreto-123",
				Enabled: true,
			},
			want: "URL del webhook no configurada",
		},
		{
			name: "habilitado con http externo",
			registration: WebhookRegistration{
				PublicURL: "http://bot.example/telegram",
				Secret:    "secreto-123",
				Enabled:   true,
			},
			want: "localhost o 127.0.0.1",
		},
		{
			name: "habilitado sin secret",
			registration: WebhookRegistration{
				PublicURL: "https://bot.example/telegram",
				Enabled:   true,
			},
			want: "secret del webhook no configurado",
		},
		{
			name: "habilitado con actualización no permitida",
			registration: WebhookRegistration{
				PublicURL:      "https://bot.example/telegram",
				Secret:         "secreto-123",
				AllowedUpdates: []string{"edited_message"},
				Enabled:        true,
			},
			want: "actualización no permitida",
		},
		{
			name: "deshabilitado con url inválida",
			registration: WebhookRegistration{
				PublicURL: "ftp://bot.example/telegram",
				Enabled:   false,
			},
			want: "debe usar https",
		},
		{
			name: "deshabilitado con secret demasiado largo",
			registration: WebhookRegistration{
				Secret:  strings.Repeat("a", maxWebhookSecret+1),
				Enabled: false,
			},
			want: "secret del webhook demasiado largo",
		},
		{
			name: "deshabilitado con actualización no permitida",
			registration: WebhookRegistration{
				AllowedUpdates: []string{"getUpdates"},
				Enabled:        false,
			},
			want: "actualización no permitida",
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			client, calls := newWebhookAdminFakeTelegram(t, func(w http.ResponseWriter, r *http.Request) {
				t.Errorf("no se esperaba red con configuración inválida: %s %s",
					r.Method, r.URL.Path)
				http.Error(w, "no esperado", http.StatusInternalServerError)
			})
			admin := &WebhookAdmin{
				Client:        client,
				Registration:  test.registration,
				InternalToken: webhookAdminTestInternal,
			}

			response := serveWebhookAdmin(t, admin, http.MethodPost, webhookAdminRegisterPath,
				webhookAdminTestInternal)
			payload := assertWebhookAdminJSON(t, response, http.StatusBadRequest,
				"invalid_registration")
			message, _ := payload["error"].(string)
			if !strings.Contains(message, test.want) {
				t.Fatalf("error = %q, se esperaba que contuviera %q", message, test.want)
			}
			if calls.Load() != 0 {
				t.Fatalf("se hicieron %d peticiones, se esperaban 0", calls.Load())
			}
			if test.registration.Secret != "" && strings.Contains(message, test.registration.Secret) {
				t.Fatalf("el error de validación filtra el secret: %q", message)
			}
		})
	}
}

func TestWebhookAdminRegisterTelegramError(t *testing.T) {
	client, calls := newWebhookAdminFakeTelegram(t, func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
		fmt.Fprintf(w, `{"ok":false,"description":"fallo con %s y %s"}`,
			webhookAdminTestBotToken, webhookAdminTestSecret)
	})
	admin := enabledWebhookAdmin(client, webhookAdminTestInternal)

	response := serveWebhookAdmin(t, admin, http.MethodPost, webhookAdminRegisterPath,
		webhookAdminTestInternal)
	assertWebhookAdminJSON(t, response, http.StatusBadGateway, "telegram_error")
	if calls.Load() != 1 {
		t.Fatalf("se hicieron %d peticiones, se esperaba 1", calls.Load())
	}
	assertWebhookAdminNoSecrets(t, response,
		webhookAdminTestBotToken, webhookAdminTestSecret, webhookAdminTestInternal)
}

func TestWebhookAdminRegisterWithoutClient(t *testing.T) {
	admin := enabledWebhookAdmin(nil, "")

	response := serveWebhookAdmin(t, admin, http.MethodPost, webhookAdminRegisterPath, "")
	assertWebhookAdminJSON(t, response, http.StatusServiceUnavailable, "not_configured")
}

func TestWebhookAdminStatus(t *testing.T) {
	tests := []struct {
		name           string
		result         string
		wantRegistered bool
		wantURL        string
		wantPending    float64
		wantLastError  string
	}{
		{
			name:           "webhook registrado",
			result:         `{"url":"https://bot.example/telegram","pending_update_count":7,"last_error_message":"timeout"}`,
			wantRegistered: true,
			wantURL:        "https://bot.example/telegram",
			wantPending:    7,
			wantLastError:  "timeout",
		},
		{
			name:           "sin webhook",
			result:         `{"url":"","pending_update_count":0}`,
			wantRegistered: false,
			wantPending:    0,
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			client, calls := newWebhookAdminFakeTelegram(t, func(w http.ResponseWriter, r *http.Request) {
				if r.Method != http.MethodGet {
					t.Errorf("método = %q, se esperaba GET", r.Method)
				}
				if r.URL.Path != "/bot"+webhookAdminTestBotToken+"/getWebhookInfo" {
					t.Errorf("path = %q, se esperaba getWebhookInfo con el token", r.URL.Path)
				}
				fmt.Fprintf(w, `{"ok":true,"result":%s}`, test.result)
			})
			admin := enabledWebhookAdmin(client, webhookAdminTestInternal)

			response := serveWebhookAdmin(t, admin, http.MethodGet, webhookAdminStatusPath, "")
			payload := assertWebhookAdminJSON(t, response, http.StatusOK, "ok")

			if payload["enabled"] != true {
				t.Errorf("enabled = %v, se esperaba true", payload["enabled"])
			}
			if payload["registered"] != test.wantRegistered {
				t.Errorf("registered = %v, se esperaba %v",
					payload["registered"], test.wantRegistered)
			}
			if test.wantURL == "" {
				if _, exists := payload["url"]; exists {
					t.Errorf("url no debería aparecer sin webhook: %v", payload["url"])
				}
			} else if payload["url"] != test.wantURL {
				t.Errorf("url = %v, se esperaba %q", payload["url"], test.wantURL)
			}
			if payload["pendingUpdates"] != test.wantPending {
				t.Errorf("pendingUpdates = %v, se esperaba %v",
					payload["pendingUpdates"], test.wantPending)
			}
			if test.wantLastError == "" {
				if _, exists := payload["lastError"]; exists {
					t.Errorf("lastError no debería aparecer: %v", payload["lastError"])
				}
			} else if payload["lastError"] != test.wantLastError {
				t.Errorf("lastError = %v, se esperaba %q",
					payload["lastError"], test.wantLastError)
			}

			if calls.Load() != 1 {
				t.Fatalf("se hicieron %d peticiones, se esperaba 1", calls.Load())
			}
			assertWebhookAdminNoSecrets(t, response,
				webhookAdminTestBotToken, webhookAdminTestSecret, webhookAdminTestInternal)
		})
	}
}

func TestWebhookAdminStatusRedactsUnexpectedSecrets(t *testing.T) {
	client, calls := newWebhookAdminFakeTelegram(t, func(w http.ResponseWriter, _ *http.Request) {
		fmt.Fprintf(w, `{"ok":true,"result":{"url":"https://bot.example/telegram?token=%s","pending_update_count":1,"last_error_message":"fallo %s %s %s"}}`,
			webhookAdminTestSecret, webhookAdminTestBotToken, webhookAdminTestSecret,
			webhookAdminTestInternal)
	})
	admin := enabledWebhookAdmin(client, webhookAdminTestInternal)

	response := serveWebhookAdmin(t, admin, http.MethodGet, webhookAdminStatusPath, "")
	payload := assertWebhookAdminJSON(t, response, http.StatusOK, "ok")
	assertWebhookAdminNoSecrets(t, response,
		webhookAdminTestBotToken, webhookAdminTestSecret, webhookAdminTestInternal)
	if payload["lastError"] != "fallo [redactado] [redactado] [redactado]" {
		t.Errorf("lastError = %v, se esperaba el texto redactado", payload["lastError"])
	}
	if calls.Load() != 1 {
		t.Fatalf("se hicieron %d peticiones, se esperaba 1", calls.Load())
	}
}

func TestWebhookAdminStatusErrors(t *testing.T) {
	tests := []struct {
		name   string
		status int
		body   string
	}{
		{
			name:   "api error",
			status: http.StatusInternalServerError,
			body: fmt.Sprintf(`{"ok":false,"description":"fallo con %s y %s"}`,
				webhookAdminTestBotToken, webhookAdminTestSecret),
		},
		{
			name:   "sin resultado",
			status: http.StatusOK,
			body:   `{"ok":true}`,
		},
		{
			name:   "respuesta inválida",
			status: http.StatusOK,
			body:   `no-json`,
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			client, calls := newWebhookAdminFakeTelegram(t, func(w http.ResponseWriter, _ *http.Request) {
				w.WriteHeader(test.status)
				fmt.Fprint(w, test.body)
			})
			admin := enabledWebhookAdmin(client, webhookAdminTestInternal)

			response := serveWebhookAdmin(t, admin, http.MethodGet, webhookAdminStatusPath, "")
			assertWebhookAdminJSON(t, response, http.StatusBadGateway, "telegram_error")
			if calls.Load() != 1 {
				t.Fatalf("se hicieron %d peticiones, se esperaba 1", calls.Load())
			}
			assertWebhookAdminNoSecrets(t, response,
				webhookAdminTestBotToken, webhookAdminTestSecret, webhookAdminTestInternal)
		})
	}
}

func TestWebhookAdminStatusWithoutClient(t *testing.T) {
	admin := enabledWebhookAdmin(nil, "")

	response := serveWebhookAdmin(t, admin, http.MethodGet, webhookAdminStatusPath, "")
	assertWebhookAdminJSON(t, response, http.StatusServiceUnavailable, "not_configured")
}

func TestWebhookAdminDelete(t *testing.T) {
	client, calls := newWebhookAdminFakeTelegram(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			t.Errorf("método = %q, se esperaba POST", r.Method)
		}
		if r.URL.Path != "/bot"+webhookAdminTestBotToken+"/deleteWebhook" {
			t.Errorf("path = %q, se esperaba deleteWebhook con el token", r.URL.Path)
		}
		fmt.Fprint(w, `{"ok":true,"result":true}`)
	})
	admin := enabledWebhookAdmin(client, webhookAdminTestInternal)

	response := serveWebhookAdmin(t, admin, http.MethodDelete, webhookAdminDeletePath,
		webhookAdminTestInternal)
	assertWebhookAdminJSON(t, response, http.StatusOK, "deleted")
	if calls.Load() != 1 {
		t.Fatalf("se hicieron %d peticiones, se esperaba 1", calls.Load())
	}
	assertWebhookAdminNoSecrets(t, response,
		webhookAdminTestBotToken, webhookAdminTestSecret, webhookAdminTestInternal)
}

func TestWebhookAdminDeleteTelegramError(t *testing.T) {
	client, calls := newWebhookAdminFakeTelegram(t, func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
		fmt.Fprintf(w, `{"ok":false,"description":"fallo con %s y %s"}`,
			webhookAdminTestBotToken, webhookAdminTestSecret)
	})
	admin := enabledWebhookAdmin(client, webhookAdminTestInternal)

	response := serveWebhookAdmin(t, admin, http.MethodDelete, webhookAdminDeletePath,
		webhookAdminTestInternal)
	assertWebhookAdminJSON(t, response, http.StatusBadGateway, "telegram_error")
	if calls.Load() != 1 {
		t.Fatalf("se hicieron %d peticiones, se esperaba 1", calls.Load())
	}
	assertWebhookAdminNoSecrets(t, response,
		webhookAdminTestBotToken, webhookAdminTestSecret, webhookAdminTestInternal)
}

func TestWebhookAdminDeleteWithoutClient(t *testing.T) {
	admin := enabledWebhookAdmin(nil, "")

	response := serveWebhookAdmin(t, admin, http.MethodDelete, webhookAdminDeletePath, "")
	assertWebhookAdminJSON(t, response, http.StatusServiceUnavailable, "not_configured")
}

func TestWebhookAdminRouting(t *testing.T) {
	tests := []struct {
		name       string
		method     string
		path       string
		wantCode   int
		wantStatus string
		wantAllow  string
	}{
		{
			name:       "register con GET",
			method:     http.MethodGet,
			path:       webhookAdminRegisterPath,
			wantCode:   http.StatusMethodNotAllowed,
			wantStatus: "method_not_allowed",
			wantAllow:  http.MethodPost,
		},
		{
			name:       "status con POST",
			method:     http.MethodPost,
			path:       webhookAdminStatusPath,
			wantCode:   http.StatusMethodNotAllowed,
			wantStatus: "method_not_allowed",
			wantAllow:  http.MethodGet,
		},
		{
			name:       "delete con GET",
			method:     http.MethodGet,
			path:       webhookAdminDeletePath,
			wantCode:   http.StatusMethodNotAllowed,
			wantStatus: "method_not_allowed",
			wantAllow:  http.MethodDelete,
		},
		{
			name:       "ruta desconocida",
			method:     http.MethodGet,
			path:       "/admin/telegram/otra",
			wantCode:   http.StatusNotFound,
			wantStatus: "not_found",
		},
		{
			name:       "ruta con barra final",
			method:     http.MethodPost,
			path:       webhookAdminRegisterPath + "/",
			wantCode:   http.StatusNotFound,
			wantStatus: "not_found",
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			client, calls := newWebhookAdminFakeTelegram(t, func(w http.ResponseWriter, r *http.Request) {
				t.Errorf("no se esperaba red: %s %s", r.Method, r.URL.Path)
				http.Error(w, "no esperado", http.StatusInternalServerError)
			})
			admin := enabledWebhookAdmin(client, webhookAdminTestInternal)

			response := serveWebhookAdmin(t, admin, test.method, test.path, "")
			assertWebhookAdminJSON(t, response, test.wantCode, test.wantStatus)
			if got := response.Header().Get("Allow"); got != test.wantAllow {
				t.Errorf("Allow = %q, se esperaba %q", got, test.wantAllow)
			}
			if calls.Load() != 0 {
				t.Fatalf("se hicieron %d peticiones, se esperaban 0", calls.Load())
			}
			assertWebhookAdminNoSecrets(t, response,
				webhookAdminTestBotToken, webhookAdminTestSecret, webhookAdminTestInternal)
		})
	}
}

func TestWebhookAdminDoesNotRegisterAutomatically(t *testing.T) {
	client, calls := newWebhookAdminFakeTelegram(t, webhookAdminTelegramOK)
	admin := enabledWebhookAdmin(client, webhookAdminTestInternal)
	if admin.Registration.Enabled != true {
		t.Fatal("la configuración de prueba debería estar habilitada")
	}
	if calls.Load() != 0 {
		t.Fatalf("construir el router hizo %d peticiones, se esperaban 0", calls.Load())
	}
}

func enabledWebhookAdmin(client *Client, internalToken string) *WebhookAdmin {
	return &WebhookAdmin{
		Client: client,
		Registration: WebhookRegistration{
			PublicURL:      "https://bot.example/telegram",
			Secret:         webhookAdminTestSecret,
			AllowedUpdates: []string{"message", "callback_query"},
			Enabled:        true,
		},
		InternalToken: internalToken,
	}
}

func newWebhookAdminFakeTelegram(t *testing.T, handler http.HandlerFunc) (*Client, *atomic.Int32) {
	t.Helper()
	var calls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		handler(w, r)
	}))
	t.Cleanup(server.Close)
	return NewClient(webhookAdminTestBotToken, server.URL), &calls
}

func webhookAdminTelegramOK(w http.ResponseWriter, r *http.Request) {
	switch {
	case strings.HasSuffix(r.URL.Path, "/setWebhook"),
		strings.HasSuffix(r.URL.Path, "/deleteWebhook"):
		fmt.Fprint(w, `{"ok":true,"result":true}`)
	case strings.HasSuffix(r.URL.Path, "/getWebhookInfo"):
		fmt.Fprint(w, `{"ok":true,"result":{"url":"https://bot.example/telegram","pending_update_count":0}}`)
	default:
		http.NotFound(w, r)
	}
}

func serveWebhookAdmin(t *testing.T, admin *WebhookAdmin, method, path, token string) *httptest.ResponseRecorder {
	t.Helper()
	request := httptest.NewRequest(method, path, nil)
	if token != "" {
		request.Header.Set("X-Notifier-Token", token)
	}
	recorder := httptest.NewRecorder()
	admin.ServeHTTP(recorder, request)
	return recorder
}

func assertWebhookAdminJSON(t *testing.T, response *httptest.ResponseRecorder, code int, status string) map[string]any {
	t.Helper()
	if response.Code != code {
		t.Fatalf("código = %d, se esperaba %d: %s", response.Code, code, response.Body)
	}
	if contentType := response.Header().Get("Content-Type"); contentType != "application/json; charset=utf-8" {
		t.Fatalf("Content-Type = %q, se esperaba application/json; charset=utf-8", contentType)
	}
	var payload map[string]any
	if err := json.Unmarshal(response.Body.Bytes(), &payload); err != nil {
		t.Fatalf("respuesta no JSON: %v: %s", err, response.Body)
	}
	if payload["status"] != status {
		t.Fatalf("status = %v, se esperaba %q: %s", payload["status"], status, response.Body)
	}
	return payload
}

func assertWebhookAdminNoSecrets(t *testing.T, response *httptest.ResponseRecorder, secrets ...string) {
	t.Helper()
	body := response.Body.String()
	for _, secret := range secrets {
		if secret == "" {
			continue
		}
		if strings.Contains(body, secret) {
			t.Fatalf("la respuesta filtra %q: %s", secret, body)
		}
	}
}
