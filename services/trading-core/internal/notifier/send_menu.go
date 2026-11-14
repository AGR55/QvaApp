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
	"unicode/utf8"
)

const (
	// maxMenuText es el máximo de caracteres aceptado por SendMenu.
	maxMenuText = 4096
	// maxInlineRows es el máximo de filas de botones inline por mensaje.
	maxInlineRows = 8
	// maxInlineRowButtons es el máximo de botones por fila.
	maxInlineRowButtons = 8
)

// InlineButton es un botón inline listo para Telegram.
type InlineButton struct {
	Text         string `json:"text"`
	CallbackData string `json:"callback_data"`
}

// InlineKeyboard agrupa los botones inline por filas.
type InlineKeyboard [][]InlineButton

// sendMenuPayload es el cuerpo exacto de sendMessage con teclado inline.
type sendMenuPayload struct {
	ChatID      string       `json:"chat_id"`
	Text        string       `json:"text"`
	ReplyMarkup inlineMarkup `json:"reply_markup"`
}

type inlineMarkup struct {
	InlineKeyboard InlineKeyboard `json:"inline_keyboard"`
}

// SendMenu envía texto a un chat con un teclado inline. Valida el texto y el
// teclado antes de hacer red y usa las mismas reglas de token, chat y errores
// que SendMessage. Los errores nunca incluyen el token ni repiten el contenido
// del mensaje o de los callbacks.
func (client *Client) SendMenu(ctx context.Context, chatID, text string, keyboard InlineKeyboard) error {
	if client.Token == "" {
		return fmt.Errorf("token de Telegram no configurado")
	}
	if strings.TrimSpace(chatID) == "" {
		return fmt.Errorf("chat de Telegram no configurado")
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

	payload, err := json.Marshal(sendMenuPayload{
		ChatID:      chatID,
		Text:        text,
		ReplyMarkup: inlineMarkup{InlineKeyboard: keyboard},
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

// KeyboardFromMenu convierte los botones de un menú en un teclado inline,
// preservando textos, callbacks y filas.
func KeyboardFromMenu(menu Menu) InlineKeyboard {
	keyboard := make(InlineKeyboard, 0, len(menu.Buttons))
	for _, row := range menu.Buttons {
		inlineRow := make([]InlineButton, 0, len(row))
		for _, button := range row {
			inlineRow = append(inlineRow, InlineButton{
				Text:         button.Text,
				CallbackData: button.CallbackData,
			})
		}
		keyboard = append(keyboard, inlineRow)
	}
	return keyboard
}

// validateMenuText exige contenido no vacío y limita bytes y runas al mismo
// máximo que Telegram acepta.
func validateMenuText(text string) error {
	if strings.TrimSpace(text) == "" {
		return fmt.Errorf("mensaje vacío")
	}
	if len(text) > maxMenuText || utf8.RuneCountInString(text) > maxMenuText {
		return fmt.Errorf("mensaje demasiado largo: máximo %d caracteres", maxMenuText)
	}
	return nil
}

// validateInlineKeyboard comprueba la forma del teclado y el tamaño de cada
// callback sin exponer su contenido en los errores.
func validateInlineKeyboard(keyboard InlineKeyboard) error {
	if len(keyboard) > maxInlineRows {
		return fmt.Errorf("teclado con demasiadas filas: %d, máximo %d", len(keyboard), maxInlineRows)
	}
	for rowIndex, row := range keyboard {
		if len(row) > maxInlineRowButtons {
			return fmt.Errorf("fila %d con demasiados botones: %d, máximo %d",
				rowIndex, len(row), maxInlineRowButtons)
		}
		for buttonIndex, button := range row {
			callback := button.CallbackData
			if strings.TrimSpace(callback) == "" {
				return fmt.Errorf("callback vacío en la fila %d, botón %d", rowIndex, buttonIndex)
			}
			if len(callback) > maxCallbackData {
				return fmt.Errorf("callback demasiado largo en la fila %d, botón %d: %d bytes, máximo %d",
					rowIndex, buttonIndex, len(callback), maxCallbackData)
			}
		}
	}
	return nil
}
