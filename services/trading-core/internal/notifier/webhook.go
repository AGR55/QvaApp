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
	"unicode/utf8"
)

const (
	// maxWebhookSecret es el máximo de caracteres del secret_token de Telegram.
	maxWebhookSecret = 256
	// maxWebhookAllowedUpdates limita las actualizaciones suscritas.
	maxWebhookAllowedUpdates = 5
	// maxWebhookResponse limita el cuerpo leído de la API de Telegram.
	maxWebhookResponse = 64 * 1024
)

// WebhookInfo es el estado del webhook registrado en Telegram.
type WebhookInfo struct {
	URL            string
	PendingUpdates int64
	LastError      string
}

// setWebhookPayload es el cuerpo exacto de setWebhook. Los campos opcionales
// se omiten cuando están vacíos.
type setWebhookPayload struct {
	URL            string   `json:"url"`
	SecretToken    string   `json:"secret_token,omitempty"`
	AllowedUpdates []string `json:"allowed_updates,omitempty"`
}

// webhookInfoResult es el result de getWebhookInfo que interesa al bot.
type webhookInfoResult struct {
	URL                string `json:"url"`
	PendingUpdateCount int64  `json:"pending_update_count"`
	LastErrorMessage   string `json:"last_error_message"`
}

// telegramEnvelope es la envoltura común de las respuestas de Telegram.
type telegramEnvelope struct {
	OK          *bool           `json:"ok"`
	Description string          `json:"description"`
	Result      json.RawMessage `json:"result"`
}

// SetWebhook registra la URL que recibirá los updates de Telegram. Sólo
// acepta HTTPS, o HTTP en localhost/127.0.0.1 para pruebas. La URL no puede
// llevar credenciales ni query, el secret debe tener entre 1 y 256 caracteres
// y las actualizaciones permitidas se limitan a message y callback_query.
// No usa getUpdates ni long-polling. Los errores nunca incluyen el token del
// bot ni el secret.
func (client *Client) SetWebhook(ctx context.Context, url, secretToken string, allowedUpdates []string) error {
	if client.Token == "" {
		return fmt.Errorf("token de Telegram no configurado")
	}
	if err := validateWebhookURL(url); err != nil {
		return err
	}
	if err := validateWebhookSecret(secretToken); err != nil {
		return err
	}
	if err := validateWebhookAllowedUpdates(allowedUpdates); err != nil {
		return err
	}

	payload := setWebhookPayload{
		URL:         url,
		SecretToken: secretToken,
	}
	if len(allowedUpdates) > 0 {
		payload.AllowedUpdates = append([]string(nil), allowedUpdates...)
	}
	return client.doWebhookRequest(ctx, http.MethodPost, "setWebhook", payload, nil, secretToken)
}

// DeleteWebhook elimina el webhook registrado para que Telegram deje de
// enviar updates a la URL configurada.
func (client *Client) DeleteWebhook(ctx context.Context) error {
	if client.Token == "" {
		return fmt.Errorf("token de Telegram no configurado")
	}
	return client.doWebhookRequest(ctx, http.MethodPost, "deleteWebhook", nil, nil)
}

// WebhookInfo consulta la URL registrada, los updates pendientes y el último
// error del webhook. El valor URL queda vacío cuando no hay webhook.
func (client *Client) WebhookInfo(ctx context.Context) (WebhookInfo, error) {
	if client.Token == "" {
		return WebhookInfo{}, fmt.Errorf("token de Telegram no configurado")
	}

	var result webhookInfoResult
	if err := client.doWebhookRequest(ctx, http.MethodGet, "getWebhookInfo", nil, &result); err != nil {
		return WebhookInfo{}, err
	}
	return WebhookInfo{
		URL:            result.URL,
		PendingUpdates: result.PendingUpdateCount,
		LastError:      result.LastErrorMessage,
	}, nil
}

// validateWebhookURL exige una URL absoluta con host. HTTPS siempre es válido;
// HTTP sólo se acepta en localhost o 127.0.0.1 para poder usar httptest. Se
// rechazan credenciales y query para no filtrar secretos en la URL.
func validateWebhookURL(rawURL string) error {
	if strings.TrimSpace(rawURL) == "" {
		return fmt.Errorf("URL del webhook no configurada")
	}

	parsed, err := url.Parse(rawURL)
	if err != nil || !parsed.IsAbs() || parsed.Host == "" {
		return fmt.Errorf("URL del webhook inválida")
	}
	if parsed.User != nil {
		return fmt.Errorf("URL del webhook no puede incluir credenciales")
	}
	if parsed.RawQuery != "" || parsed.ForceQuery {
		return fmt.Errorf("URL del webhook no puede incluir query")
	}

	switch strings.ToLower(parsed.Scheme) {
	case "https":
		return nil
	case "http":
		host := strings.ToLower(parsed.Hostname())
		if host == "localhost" || host == "127.0.0.1" {
			return nil
		}
		return fmt.Errorf("URL del webhook con http sólo se permite en localhost o 127.0.0.1")
	default:
		return fmt.Errorf("URL del webhook debe usar https")
	}
}

// validateWebhookSecret exige entre 1 y 256 caracteres sin repetir el valor en
// el error.
func validateWebhookSecret(secret string) error {
	if secret == "" {
		return fmt.Errorf("secret del webhook no configurado")
	}
	if utf8.RuneCountInString(secret) > maxWebhookSecret {
		return fmt.Errorf("secret del webhook demasiado largo: máximo %d caracteres",
			maxWebhookSecret)
	}
	return nil
}

// validateWebhookAllowedUpdates sólo admite los tipos que procesa el bot y
// limita la lista a cinco entradas.
func validateWebhookAllowedUpdates(allowedUpdates []string) error {
	if len(allowedUpdates) > maxWebhookAllowedUpdates {
		return fmt.Errorf("demasiadas actualizaciones permitidas: %d, máximo %d",
			len(allowedUpdates), maxWebhookAllowedUpdates)
	}
	for index, update := range allowedUpdates {
		switch update {
		case "message", "callback_query":
		default:
			return fmt.Errorf("actualización no permitida en la posición %d: sólo message y callback_query",
				index)
		}
	}
	return nil
}

// doWebhookRequest ejecuta una llamada a la API de Telegram y descodifica el
// result cuando se solicita. Todos los errores se redactan para no exponer el
// token del bot ni los secretos recibidos.
func (client *Client) doWebhookRequest(ctx context.Context, method, endpoint string, payload, result any, secrets ...string) error {
	var body io.Reader
	if payload != nil {
		encoded, err := json.Marshal(payload)
		if err != nil {
			return fmt.Errorf("codificar la petición del webhook: %s",
				client.redactErrorText(err.Error(), secrets...))
		}
		body = bytes.NewReader(encoded)
	}

	request, err := http.NewRequestWithContext(ctx, method,
		client.BaseURL+"/bot"+client.Token+"/"+endpoint, body)
	if err != nil {
		return fmt.Errorf("crear la petición del webhook: %s",
			client.redactErrorText(err.Error(), secrets...))
	}
	if payload != nil {
		request.Header.Set("Content-Type", "application/json")
	}

	httpClient := client.HTTP
	if httpClient == nil {
		httpClient = &http.Client{Timeout: 10 * time.Second}
	}
	response, err := httpClient.Do(request)
	if err != nil {
		return fmt.Errorf("conectar Telegram: %s",
			client.redactErrorText(err.Error(), secrets...))
	}
	defer response.Body.Close()

	responseBody, err := io.ReadAll(io.LimitReader(response.Body, maxWebhookResponse))
	if err != nil {
		return fmt.Errorf("leer la respuesta de Telegram: %s",
			client.redactErrorText(err.Error(), secrets...))
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return &APIError{
			Status:      response.StatusCode,
			Description: client.redactErrorText(strings.TrimSpace(string(responseBody)), secrets...),
		}
	}

	if len(responseBody) == 0 {
		if result != nil {
			return fmt.Errorf("respuesta de Telegram sin contenido")
		}
		return nil
	}

	var envelope telegramEnvelope
	if err := json.Unmarshal(responseBody, &envelope); err != nil {
		if result != nil {
			return fmt.Errorf("respuesta inválida de Telegram")
		}
		return nil
	}
	if envelope.OK != nil && !*envelope.OK {
		description := strings.TrimSpace(envelope.Description)
		if description == "" {
			description = "operación rechazada"
		}
		return &APIError{
			Status:      response.StatusCode,
			Description: client.redactErrorText(description, secrets...),
		}
	}
	if result == nil {
		return nil
	}
	if len(envelope.Result) == 0 || string(envelope.Result) == "null" {
		return fmt.Errorf("respuesta de Telegram sin resultado")
	}
	if err := json.Unmarshal(envelope.Result, result); err != nil {
		return fmt.Errorf("respuesta inválida de Telegram")
	}
	return nil
}

// redactErrorText sustituye el token del bot y los secretos indicados para que
// nunca aparezcan en un error.
func (client *Client) redactErrorText(text string, secrets ...string) string {
	for _, secret := range append([]string{client.Token}, secrets...) {
		if secret == "" {
			continue
		}
		text = strings.ReplaceAll(text, secret, "[redactado]")
	}
	return text
}
