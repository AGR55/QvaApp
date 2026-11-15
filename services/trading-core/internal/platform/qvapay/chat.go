package qvapay

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

// ChatClient habla con el chat P2P de QvaPay. Se separa del Client de lectura
// para que la superficie read-only no gane métodos de escritura.
type ChatClient struct {
	BaseURL string
	Token   string
	HTTP    *http.Client
}

// NewChatClient valida la URL y exige token.
func NewChatClient(baseURL, token string) (*ChatClient, error) {
	if strings.TrimSpace(token) == "" {
		return nil, ErrMissingToken
	}
	parsed, err := mutationBaseURL(baseURL)
	if err != nil {
		return nil, err
	}
	return &ChatClient{BaseURL: parsed.String(), Token: strings.TrimSpace(token)}, nil
}

// ChatMessage es un mensaje del chat P2P de QvaPay.
type ChatMessage struct {
	ID          string
	PeerID      string
	Message     string
	Image       string
	CreatedAt   int64
	IsModerator bool
}

// Chat lista los mensajes de una oferta/orden.
func (c *ChatClient) Chat(ctx context.Context, offerUUID, order string) ([]ChatMessage, error) {
	endpoint, err := c.chatEndpoint(offerUUID, order)
	if err != nil {
		return nil, err
	}
	requestCtx, cancel := context.WithTimeout(ctx, DefaultTimeout)
	defer cancel()
	request, err := http.NewRequestWithContext(requestCtx, http.MethodGet, endpoint, nil)
	if err != nil {
		return nil, fmt.Errorf("no se pudo construir la lectura de chat: %w", err)
	}
	request.Header.Set("Authorization", "Bearer "+c.Token)
	request.Header.Set("Accept", "application/json")
	response, err := c.chatHTTPClient().Do(request)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(response.Body, 2<<20))
	if err != nil {
		return nil, err
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return nil, fmt.Errorf("QvaPay rechazó la lectura de chat con %d", response.StatusCode)
	}
	var payload any
	if err := json.Unmarshal(raw, &payload); err != nil {
		return nil, fmt.Errorf("respuesta de chat inválida: %w", err)
	}
	entries := chatEntries(payload)
	messages := make([]ChatMessage, 0, len(entries))
	for _, entry := range entries {
		object, ok := entry.(map[string]any)
		if !ok {
			continue
		}
		peer := stringField(object, "peer_id", "peerId")
		if peer == "" {
			if nested, ok := object["Peer"].(map[string]any); ok {
				peer = stringField(nested, "uuid")
			}
		}
		message := stringField(object, "message")
		image := stringField(object, "image")
		if message == "" && image != "" {
			message = "📎 Imagen adjunta"
		}
		if message == "" {
			continue
		}
		messages = append(messages, ChatMessage{
			ID: stringField(object, "id", "uuid"), PeerID: peer,
			Message: message, Image: image,
			CreatedAt:   chatTimestamp(object["created_at"]),
			IsModerator: object["is_moderator"] == true,
		})
	}
	return messages, nil
}

// SendChat envía un mensaje de texto a una oferta/orden.
func (c *ChatClient) SendChat(ctx context.Context, offerUUID, order, message string) (ChatMessage, error) {
	message = strings.TrimSpace(message)
	if message == "" || len(message) > 599 {
		return ChatMessage{}, fmt.Errorf("mensaje de chat inválido")
	}
	endpoint, err := c.chatEndpoint(offerUUID, order)
	if err != nil {
		return ChatMessage{}, err
	}
	body, _ := json.Marshal(map[string]string{"message": message})
	requestCtx, cancel := context.WithTimeout(ctx, DefaultTimeout)
	defer cancel()
	request, err := http.NewRequestWithContext(requestCtx, http.MethodPost, endpoint, bytes.NewReader(body))
	if err != nil {
		return ChatMessage{}, fmt.Errorf("no se pudo construir el envío de chat: %w", err)
	}
	request.Header.Set("Authorization", "Bearer "+c.Token)
	request.Header.Set("Accept", "application/json")
	request.Header.Set("Content-Type", "application/json")
	response, err := c.chatHTTPClient().Do(request)
	if err != nil {
		return ChatMessage{}, err
	}
	defer response.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(response.Body, 1<<20))
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return ChatMessage{}, fmt.Errorf("QvaPay rechazó el mensaje con %d", response.StatusCode)
	}
	var payload map[string]any
	_ = json.Unmarshal(raw, &payload)
	candidate := payload
	if nested, ok := payload["message"].(map[string]any); ok {
		candidate = nested
	} else if nested, ok := payload["data"].(map[string]any); ok {
		candidate = nested
	}
	id := stringField(candidate, "id", "uuid")
	if id == "" {
		return ChatMessage{}, fmt.Errorf("QvaPay no devolvió el identificador del mensaje")
	}
	return ChatMessage{
		ID: id, PeerID: stringField(candidate, "peer_id", "peerId"),
		Message: message, CreatedAt: chatTimestamp(candidate["created_at"]),
	}, nil
}

func (c *ChatClient) chatEndpoint(offerUUID, order string) (string, error) {
	if !isMutationUUID(offerUUID) {
		return "", fmt.Errorf("UUID de oferta inválido: %w", ErrInvalidUUID)
	}
	base, err := mutationBaseURL(c.BaseURL)
	if err != nil {
		return "", err
	}
	base.Path = strings.TrimRight(base.Path, "/") + "/p2p/" + offerUUID + "/chat"
	base.RawPath = ""
	if order != "" {
		if !isMutationUUID(order) {
			return "", fmt.Errorf("UUID de orden inválido: %w", ErrInvalidUUID)
		}
		base.RawQuery = url.Values{"order": []string{order}}.Encode()
	}
	return base.String(), nil
}

func (c *ChatClient) chatHTTPClient() *http.Client {
	if c.HTTP == nil {
		return &http.Client{Timeout: DefaultTimeout, CheckRedirect: checkNoMutationRedirect}
	}
	clone := *c.HTTP
	clone.CheckRedirect = checkNoMutationRedirect
	if clone.Timeout <= 0 {
		clone.Timeout = DefaultTimeout
	}
	return &clone
}

func chatEntries(payload any) []any {
	switch value := payload.(type) {
	case []any:
		return value
	case map[string]any:
		for _, key := range []string{"chat", "messages"} {
			if items, ok := value[key].([]any); ok {
				return items
			}
		}
		if data, ok := value["data"].(map[string]any); ok {
			if items, ok := data["messages"].([]any); ok {
				return items
			}
		}
	}
	return nil
}

func stringField(value map[string]any, keys ...string) string {
	for _, key := range keys {
		if item, ok := value[key]; ok {
			if text, ok := item.(string); ok {
				return text
			}
		}
	}
	return ""
}

func chatTimestamp(value any) int64 {
	switch item := value.(type) {
	case float64:
		if item > 0 {
			if item < 1_000_000_000_000 {
				item *= 1000
			}
			return int64(item)
		}
	case string:
		if item == "" {
			return 0
		}
		if parsed, err := time.Parse(time.RFC3339, item); err == nil {
			return parsed.UnixMilli()
		}
	}
	return 0
}
