package notifier

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

type editMenuPayload struct {
	ChatID      string       `json:"chat_id"`
	MessageID   int64        `json:"message_id"`
	Text        string       `json:"text"`
	ReplyMarkup inlineMarkup `json:"reply_markup"`
}

// EditMenu reemplaza el texto y el teclado inline del mensaje indicado. Es la
// vía preferida para las navegaciones del bot: evita acumular paneles nuevos.
func (client *Client) EditMenu(
	ctx context.Context,
	chatID string,
	messageID int64,
	text string,
	keyboard InlineKeyboard,
) error {
	if client.Token == "" {
		return fmt.Errorf("token de Telegram no configurado")
	}
	if strings.TrimSpace(chatID) == "" {
		return fmt.Errorf("chat de Telegram no configurado")
	}
	if messageID <= 0 {
		return fmt.Errorf("mensaje de Telegram inválido")
	}
	if err := validateMenuText(text); err != nil {
		return err
	}
	if err := validateInlineKeyboard(keyboard); err != nil {
		return err
	}
	if keyboard == nil {
		keyboard = InlineKeyboard{}
	}

	payload, err := json.Marshal(editMenuPayload{
		ChatID: chatID, MessageID: messageID, Text: text,
		ReplyMarkup: inlineMarkup{InlineKeyboard: keyboard},
	})
	if err != nil {
		return err
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost,
		client.BaseURL+"/bot"+client.Token+"/editMessageText", bytes.NewReader(payload))
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
		apiErr := &APIError{Status: response.StatusCode, Description: strings.TrimSpace(string(body))}
		if IsMessageNotModified(apiErr) {
			return nil
		}
		return apiErr
	}
	return nil
}

// IsMessageNotModified reconoce el 400 que Telegram devuelve cuando se edita
// un mensaje con exactamente el mismo contenido.
func IsMessageNotModified(err error) bool {
	if err == nil {
		return false
	}
	apiErr, ok := err.(*APIError)
	if !ok {
		return false
	}
	return strings.Contains(strings.ToLower(apiErr.Description), "message is not modified")
}
