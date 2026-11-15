// Package notifier envía mensajes a Telegram sin long-polling ni menús.
package notifier

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// Client es un cliente mínimo de Telegram sendMessage.
type Client struct {
	BaseURL string
	Token   string
	HTTP    *http.Client
}

// APIError es un error de Telegram sin incluir el token.
type APIError struct {
	Status      int
	Description string
}

func (err *APIError) Error() string {
	return fmt.Sprintf("Telegram respondió %d: %s", err.Status, err.Description)
}

// NewClient crea el cliente. BaseURL por defecto es la API oficial.
func NewClient(token, baseURL string) *Client {
	if strings.TrimSpace(baseURL) == "" {
		baseURL = "https://api.telegram.org"
	}
	return &Client{
		BaseURL: strings.TrimRight(baseURL, "/"),
		Token:   strings.TrimSpace(token),
		HTTP:    &http.Client{Timeout: 10 * time.Second},
	}
}

// SendMessage envía texto a un chat.
func (client *Client) SendMessage(ctx context.Context, chatID, text string) error {
	if client.Token == "" {
		return fmt.Errorf("token de Telegram no configurado")
	}
	if strings.TrimSpace(chatID) == "" {
		return fmt.Errorf("chat de Telegram no configurado")
	}
	if strings.TrimSpace(text) == "" {
		return fmt.Errorf("mensaje vacío")
	}
	payload, err := json.Marshal(map[string]any{
		"chat_id": chatID, "text": text, "disable_web_page_preview": true,
	})
	if err != nil {
		return err
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost,
		client.BaseURL+"/bot"+client.Token+"/sendMessage", bytes.NewReader(payload))
	if err != nil {
		return err
	}
	request.Header.Set("Content-Type", "application/json")
	httpClient := client.HTTP
	if httpClient == nil {
		httpClient = &http.Client{Timeout: 10 * time.Second}
	}
	response, err := httpClient.Do(request)
	if err != nil {
		return fmt.Errorf("conectar Telegram: %w", err)
	}
	defer response.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(response.Body, 2048))
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return &APIError{Status: response.StatusCode, Description: strings.TrimSpace(string(body))}
	}
	return nil
}

// Deduper evita repetir notificaciones durante un TTL.
type Deduper struct {
	seen map[string]time.Time
	ttl  time.Duration
	now  func() time.Time
}

// NewDeduper crea el deduplicador.
func NewDeduper(ttl time.Duration) *Deduper {
	if ttl <= 0 {
		ttl = 10 * time.Minute
	}
	return &Deduper{seen: map[string]time.Time{}, ttl: ttl, now: time.Now}
}

// Seen registra la clave y devuelve true si ya estaba vigente.
func (deduper *Deduper) Seen(key string) bool {
	if key == "" {
		return false
	}
	now := deduper.now()
	for existing, at := range deduper.seen {
		if now.Sub(at) > deduper.ttl {
			delete(deduper.seen, existing)
		}
	}
	if _, exists := deduper.seen[key]; exists {
		return true
	}
	deduper.seen[key] = now
	return false
}

// GetUpdates hace long polling de Telegram. Devuelve los updates crudos para
// que el llamador los valide con ParseUpdate.
func (client *Client) GetUpdates(
	ctx context.Context,
	offset int64,
	timeout time.Duration,
) ([]json.RawMessage, error) {
	if client.Token == "" {
		return nil, fmt.Errorf("token de Telegram no configurado")
	}
	if timeout <= 0 {
		timeout = 30 * time.Second
	}
	query := url.Values{}
	query.Set("offset", fmt.Sprintf("%d", offset))
	query.Set("timeout", fmt.Sprintf("%d", int(timeout.Seconds())))
	query.Set("allowed_updates", `["message","callback_query"]`)
	endpoint := client.BaseURL + "/bot" + client.Token + "/getUpdates?" + query.Encode()
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return nil, err
	}
	httpClient := &http.Client{Timeout: timeout + 10*time.Second}
	response, err := httpClient.Do(request)
	if err != nil {
		return nil, fmt.Errorf("conectar Telegram: %w", err)
	}
	defer response.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(response.Body, 4<<20))
	if err != nil {
		return nil, fmt.Errorf("leer updates: %w", err)
	}
	var envelope struct {
		OK          bool              `json:"ok"`
		Result      []json.RawMessage `json:"result"`
		Description string            `json:"description"`
	}
	if err := json.Unmarshal(raw, &envelope); err != nil {
		return nil, fmt.Errorf("respuesta de updates inválida")
	}
	if !envelope.OK {
		return nil, &APIError{Status: response.StatusCode, Description: envelope.Description}
	}
	return envelope.Result, nil
}

// AnswerCallbackQuery detiene el indicador de carga del botón inline.
func (client *Client) AnswerCallbackQuery(ctx context.Context, callbackID string) error {
	if client.Token == "" || strings.TrimSpace(callbackID) == "" {
		return nil
	}
	payload, _ := json.Marshal(map[string]any{"callback_query_id": callbackID})
	request, err := http.NewRequestWithContext(ctx, http.MethodPost,
		client.BaseURL+"/bot"+client.Token+"/answerCallbackQuery", bytes.NewReader(payload))
	if err != nil {
		return err
	}
	request.Header.Set("Content-Type", "application/json")
	httpClient := client.HTTP
	if httpClient == nil {
		httpClient = &http.Client{Timeout: 10 * time.Second}
	}
	response, err := httpClient.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		body, _ := io.ReadAll(io.LimitReader(response.Body, 1024))
		return &APIError{Status: response.StatusCode, Description: strings.TrimSpace(string(body))}
	}
	return nil
}
