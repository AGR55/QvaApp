package notifier

import (
	"encoding/json"
	"strings"
	"testing"
)

func encodeUpdateTestPayload(t *testing.T, value any) []byte {
	t.Helper()
	payload, err := json.Marshal(value)
	if err != nil {
		t.Fatalf("json.Marshal: %v", err)
	}
	return payload
}

func messageUpdateTestPayload(updateID, chatID, fromID int64, text string) map[string]any {
	return map[string]any{
		"update_id": updateID,
		"message": map[string]any{
			"chat": map[string]any{"id": chatID},
			"from": map[string]any{"id": fromID, "is_bot": false},
			"text": text,
		},
	}
}

func callbackUpdateTestPayload(updateID, chatID, fromID int64, data string) map[string]any {
	return map[string]any{
		"update_id": updateID,
		"callback_query": map[string]any{
			"from":    map[string]any{"id": fromID, "is_bot": false},
			"message": map[string]any{"chat": map[string]any{"id": chatID}},
			"data":    data,
		},
	}
}

func updatePayloadWithSize(t *testing.T, size int) []byte {
	t.Helper()
	const prefix = `{"update_id":1,"message":{"chat":{"id":42},"from":{"id":7},"text":"/status"},"padding":"`
	const suffix = `"}`
	padding := size - len(prefix) - len(suffix)
	if padding < 0 {
		t.Fatalf("tamaño de payload %d demasiado pequeño para el prefijo", size)
	}
	payload := []byte(prefix + strings.Repeat("a", padding) + suffix)
	if len(payload) != size {
		t.Fatalf("payload de %d bytes, se esperaban %d", len(payload), size)
	}
	return payload
}

func assertUpdateResult(t *testing.T, result UpdateResult, updateID, chatID int64, action Action, response string, mutation bool) {
	t.Helper()
	if result.UpdateID != updateID {
		t.Fatalf("UpdateID = %d, se esperaba %d", result.UpdateID, updateID)
	}
	if result.ChatID != chatID {
		t.Fatalf("ChatID = %d, se esperaba %d", result.ChatID, chatID)
	}
	if result.Decision.Action != action {
		t.Fatalf("Action = %q, se esperaba %q", result.Decision.Action, action)
	}
	if result.Decision.Response != response {
		t.Fatalf("Response = %q, se esperaba %q", result.Decision.Response, response)
	}
	if result.Decision.Mutation != mutation {
		t.Fatalf("Mutation = %v, se esperaba %v", result.Decision.Mutation, mutation)
	}
	if result.Reply != result.Decision.Response {
		t.Fatalf("Reply = %q, se esperaba exactamente Decision.Response = %q", result.Reply, result.Decision.Response)
	}
	if result.Reply != response {
		t.Fatalf("Reply = %q, se esperaba %q", result.Reply, response)
	}
}

func TestParseUpdateMessage(t *testing.T) {
	payload := encodeUpdateTestPayload(t, map[string]any{
		"update_id": int64(100),
		"message": map[string]any{
			"message_id": int64(7),
			"date":       int64(1700000000),
			"from": map[string]any{
				"id":         int64(-42),
				"is_bot":     false,
				"first_name": "Ana",
			},
			"chat": map[string]any{"id": int64(-100123), "type": "group"},
			"text": "/status ahora",
		},
	})

	update, ok := ParseUpdate(payload)
	if !ok {
		t.Fatal("ParseUpdate rechazó un mensaje válido")
	}
	if update.UpdateID != 100 {
		t.Fatalf("UpdateID = %d, se esperaba 100", update.UpdateID)
	}
	if update.ChatID != -100123 {
		t.Fatalf("ChatID = %d, se esperaba -100123", update.ChatID)
	}
	if update.Text != "/status ahora" {
		t.Fatalf("Text = %q, se esperaba %q", update.Text, "/status ahora")
	}
	if update.CallbackData != "" {
		t.Fatalf("CallbackData = %q, se esperaba vacío", update.CallbackData)
	}
	if update.FromID != -42 {
		t.Fatalf("FromID = %d, se esperaba -42", update.FromID)
	}
	if update.IsBot {
		t.Fatal("IsBot = true en un mensaje de usuario")
	}
}

func TestParseUpdateCallbackQuery(t *testing.T) {
	payload := encodeUpdateTestPayload(t, map[string]any{
		"update_id": int64(200),
		"callback_query": map[string]any{
			"id":            "cb-1",
			"chat_instance": "instancia",
			"from":          map[string]any{"id": int64(43), "is_bot": false},
			"message": map[string]any{
				"message_id": int64(8),
				"chat":       map[string]any{"id": int64(42)},
			},
			"data": "pause",
		},
	})

	update, ok := ParseUpdate(payload)
	if !ok {
		t.Fatal("ParseUpdate rechazó un callback válido")
	}
	if update.UpdateID != 200 {
		t.Fatalf("UpdateID = %d, se esperaba 200", update.UpdateID)
	}
	if update.ChatID != 42 {
		t.Fatalf("ChatID = %d, se esperaba 42", update.ChatID)
	}
	if update.Text != "" {
		t.Fatalf("Text = %q, se esperaba vacío", update.Text)
	}
	if update.CallbackData != "pause" {
		t.Fatalf("CallbackData = %q, se esperaba %q", update.CallbackData, "pause")
	}
	if update.FromID != 43 {
		t.Fatalf("FromID = %d, se esperaba 43", update.FromID)
	}
	if update.IsBot {
		t.Fatal("IsBot = true en un callback de usuario")
	}
}

func TestParseUpdateRejectsBots(t *testing.T) {
	tests := []struct {
		name    string
		payload string
	}{
		{
			name:    "mensaje de bot",
			payload: `{"update_id":1,"message":{"chat":{"id":42},"from":{"id":7,"is_bot":true},"text":"/pause"}}`,
		},
		{
			name:    "callback de bot",
			payload: `{"update_id":2,"callback_query":{"from":{"id":7,"is_bot":true},"message":{"chat":{"id":42}},"data":"pause"}}`,
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if update, ok := ParseUpdate([]byte(test.payload)); ok {
				t.Fatalf("ParseUpdate aceptó un update de bot: %+v", update)
			}
		})
	}
}

func TestParseUpdateRejectsMissingChat(t *testing.T) {
	tests := []struct {
		name    string
		payload string
	}{
		{
			name:    "mensaje sin chat",
			payload: `{"update_id":1,"message":{"text":"/status","from":{"id":7}}}`,
		},
		{
			name:    "mensaje con chat sin id",
			payload: `{"update_id":2,"message":{"chat":{},"text":"/status","from":{"id":7}}}`,
		},
		{
			name:    "mensaje con chat cero",
			payload: `{"update_id":3,"message":{"chat":{"id":0},"text":"/status","from":{"id":7}}}`,
		},
		{
			name:    "callback sin mensaje",
			payload: `{"update_id":4,"callback_query":{"data":"status","from":{"id":7}}}`,
		},
		{
			name:    "callback con mensaje sin chat",
			payload: `{"update_id":5,"callback_query":{"message":{},"data":"status","from":{"id":7}}}`,
		},
		{
			name:    "callback con chat sin id",
			payload: `{"update_id":6,"callback_query":{"message":{"chat":{}},"data":"status","from":{"id":7}}}`,
		},
		{
			name:    "callback con chat cero",
			payload: `{"update_id":7,"callback_query":{"message":{"chat":{"id":0}},"data":"status","from":{"id":7}}}`,
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if update, ok := ParseUpdate([]byte(test.payload)); ok {
				t.Fatalf("ParseUpdate aceptó un update sin chat: %+v", update)
			}
		})
	}
}

func TestParseUpdateRejectsEmptyContent(t *testing.T) {
	tests := []struct {
		name    string
		payload string
	}{
		{
			name:    "texto vacío",
			payload: `{"update_id":1,"message":{"chat":{"id":42},"from":{"id":7},"text":""}}`,
		},
		{
			name:    "texto sólo espacios",
			payload: `{"update_id":2,"message":{"chat":{"id":42},"from":{"id":7},"text":"   "}}`,
		},
		{
			name:    "texto nulo",
			payload: `{"update_id":3,"message":{"chat":{"id":42},"from":{"id":7},"text":null}}`,
		},
		{
			name:    "mensaje sin texto",
			payload: `{"update_id":4,"message":{"chat":{"id":42},"from":{"id":7}}}`,
		},
		{
			name:    "data vacía",
			payload: `{"update_id":5,"callback_query":{"from":{"id":7},"message":{"chat":{"id":42}},"data":""}}`,
		},
		{
			name:    "data sólo espacios",
			payload: `{"update_id":6,"callback_query":{"from":{"id":7},"message":{"chat":{"id":42}},"data":"   "}}`,
		},
		{
			name:    "data nula",
			payload: `{"update_id":7,"callback_query":{"from":{"id":7},"message":{"chat":{"id":42}},"data":null}}`,
		},
		{
			name:    "callback sin data",
			payload: `{"update_id":8,"callback_query":{"from":{"id":7},"message":{"chat":{"id":42}}}}`,
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if update, ok := ParseUpdate([]byte(test.payload)); ok {
				t.Fatalf("ParseUpdate aceptó un update sin contenido útil: %+v", update)
			}
		})
	}
}

func TestParseUpdateRejectsInvalidPayload(t *testing.T) {
	tests := []struct {
		name    string
		payload []byte
	}{
		{name: "nil", payload: nil},
		{name: "vacío", payload: []byte{}},
		{name: "no json", payload: []byte("esto no es json")},
		{name: "json truncado", payload: []byte(`{"update_id":1`)},
		{name: "arreglo", payload: []byte(`[]`)},
		{name: "nulo", payload: []byte(`null`)},
		{name: "número", payload: []byte(`42`)},
		{name: "objeto vacío", payload: []byte(`{}`)},
		{name: "sólo update id", payload: []byte(`{"update_id":1}`)},
		{name: "mensaje nulo", payload: []byte(`{"message":null}`)},
		{name: "callback vacío", payload: []byte(`{"callback_query":{}}`)},
		{name: "update id de tipo incorrecto", payload: []byte(`{"update_id":"uno","message":{"chat":{"id":42},"text":"hola"}}`)},
		{name: "mensaje de tipo incorrecto", payload: []byte(`{"message":"hola"}`)},
		{name: "basura al final", payload: []byte(`{"update_id":1,"message":{"chat":{"id":42},"text":"hola"}}x`)},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if update, ok := ParseUpdate(test.payload); ok {
				t.Fatalf("ParseUpdate aceptó un payload inválido: %+v", update)
			}
		})
	}
}

func TestParseUpdatePayloadLimit(t *testing.T) {
	atLimit := updatePayloadWithSize(t, maxUpdatePayload)
	if _, ok := ParseUpdate(atLimit); !ok {
		t.Fatalf("ParseUpdate rechazó un payload de exactamente %d bytes", maxUpdatePayload)
	}

	overLimit := updatePayloadWithSize(t, maxUpdatePayload+1)
	if _, ok := ParseUpdate(overLimit); ok {
		t.Fatalf("ParseUpdate aceptó un payload de %d bytes", len(overLimit))
	}
}

func TestParseUpdateTextLimit(t *testing.T) {
	atLimit := encodeUpdateTestPayload(t, messageUpdateTestPayload(1, 42, 7, strings.Repeat("a", maxUpdateText)))
	if _, ok := ParseUpdate(atLimit); !ok {
		t.Fatalf("ParseUpdate rechazó un texto de exactamente %d bytes", maxUpdateText)
	}

	overLimit := encodeUpdateTestPayload(t, messageUpdateTestPayload(2, 42, 7, strings.Repeat("a", maxUpdateText+1)))
	if _, ok := ParseUpdate(overLimit); ok {
		t.Fatalf("ParseUpdate aceptó un texto de %d bytes", maxUpdateText+1)
	}

	multibyteAtLimit := encodeUpdateTestPayload(t, messageUpdateTestPayload(3, 42, 7, strings.Repeat("á", maxUpdateText/2)))
	if _, ok := ParseUpdate(multibyteAtLimit); !ok {
		t.Fatalf("ParseUpdate rechazó un texto multibyte de exactamente %d bytes", maxUpdateText)
	}

	multibyteOverLimit := encodeUpdateTestPayload(t, messageUpdateTestPayload(4, 42, 7, strings.Repeat("á", maxUpdateText/2+1)))
	if _, ok := ParseUpdate(multibyteOverLimit); ok {
		t.Fatalf("ParseUpdate aceptó un texto multibyte de %d bytes", maxUpdateText+2)
	}

	manyRunes := encodeUpdateTestPayload(t, messageUpdateTestPayload(5, 42, 7, strings.Repeat("á", maxUpdateText)))
	if _, ok := ParseUpdate(manyRunes); ok {
		t.Fatalf("ParseUpdate aceptó un texto de %d runas multibyte", maxUpdateText)
	}

	callbackAtLimit := encodeUpdateTestPayload(t, callbackUpdateTestPayload(6, 42, 7, strings.Repeat("a", maxUpdateText)))
	if _, ok := ParseUpdate(callbackAtLimit); !ok {
		t.Fatalf("ParseUpdate rechazó un callback data de exactamente %d bytes", maxUpdateText)
	}

	callbackOverLimit := encodeUpdateTestPayload(t, callbackUpdateTestPayload(7, 42, 7, strings.Repeat("a", maxUpdateText+1)))
	if _, ok := ParseUpdate(callbackOverLimit); ok {
		t.Fatalf("ParseUpdate aceptó un callback data de %d bytes", maxUpdateText+1)
	}
}

func TestParseUpdateAcceptsMissingFrom(t *testing.T) {
	update, ok := ParseUpdate([]byte(`{"update_id":9,"message":{"chat":{"id":42},"text":"/status"}}`))
	if !ok {
		t.Fatal("ParseUpdate rechazó un mensaje sin from")
	}
	if update.ChatID != 42 {
		t.Fatalf("ChatID = %d, se esperaba 42", update.ChatID)
	}
	if update.FromID != 0 {
		t.Fatalf("FromID = %d, se esperaba 0", update.FromID)
	}
	if update.IsBot {
		t.Fatal("IsBot = true sin campo from")
	}
}

func TestHandleUpdateAuthorizedCommands(t *testing.T) {
	auth := Authorization{AdminChatID: 42}
	tests := []struct {
		name     string
		text     string
		action   Action
		response string
		mutation bool
	}{
		{name: "status", text: "/status", action: ActionStatus, response: StatusText()},
		{name: "help", text: "/help", action: ActionHelp, response: HelpText()},
		{name: "start", text: "/start", action: ActionHelp, response: HelpText()},
		{name: "pause", text: "/pause", action: ActionPause, response: pauseText, mutation: true},
		{name: "resume", text: "/resume", action: ActionResume, response: resumeText, mutation: true},
		{name: "pause con mayúsculas", text: "/PaUsE", action: ActionPause, response: pauseText, mutation: true},
		{name: "pause con argumentos", text: "/pause ahora", action: ActionPause, response: pauseText, mutation: true},
		{name: "comando desconocido", text: "/dinero", action: ActionUnknown, response: unknownText},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			update := Update{UpdateID: 100, ChatID: 42, Text: test.text, FromID: 7}
			result := HandleUpdate(update, auth)
			assertUpdateResult(t, result, 100, 42, test.action, test.response, test.mutation)
		})
	}
}

func TestHandleUpdateDeniedCommands(t *testing.T) {
	tests := []struct {
		name     string
		chatID   int64
		auth     Authorization
		text     string
		action   Action
		response string
	}{
		{name: "pause con otro chat", chatID: 41, auth: Authorization{AdminChatID: 42}, text: "/pause", action: ActionPause, response: deniedText},
		{name: "resume con otro chat", chatID: 41, auth: Authorization{AdminChatID: 42}, text: "/resume", action: ActionResume, response: deniedText},
		{name: "pause con chat cero", chatID: 0, auth: Authorization{AdminChatID: 42}, text: "/pause", action: ActionPause, response: deniedText},
		{name: "pause sin admin configurado", chatID: 42, auth: Authorization{}, text: "/pause", action: ActionPause, response: deniedText},
		{name: "resume sin admin configurado", chatID: 42, auth: Authorization{}, text: "/resume", action: ActionResume, response: deniedText},
		{name: "status sigue disponible", chatID: 41, auth: Authorization{AdminChatID: 42}, text: "/status", action: ActionStatus, response: StatusText()},
		{name: "help sigue disponible", chatID: 41, auth: Authorization{AdminChatID: 42}, text: "/help", action: ActionHelp, response: HelpText()},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			update := Update{UpdateID: 101, ChatID: test.chatID, Text: test.text, FromID: 7}
			result := HandleUpdate(update, test.auth)
			assertUpdateResult(t, result, 101, test.chatID, test.action, test.response, false)
		})
	}
}

func TestHandleUpdateCallbacks(t *testing.T) {
	auth := Authorization{AdminChatID: 42}
	tests := []struct {
		name     string
		chatID   int64
		data     string
		action   Action
		response string
		mutation bool
	}{
		{name: "status autorizado", chatID: 42, data: "status", action: ActionStatus, response: StatusText()},
		{name: "status denegado", chatID: 41, data: "status", action: ActionStatus, response: StatusText()},
		{name: "pause autorizado", chatID: 42, data: "pause", action: ActionPause, response: pauseText, mutation: true},
		{name: "pause denegado", chatID: 41, data: "pause", action: ActionPause, response: deniedText},
		{name: "resume autorizado", chatID: 42, data: "resume", action: ActionResume, response: resumeText, mutation: true},
		{name: "resume denegado", chatID: 41, data: "resume", action: ActionResume, response: deniedText},
		{name: "data normalizada", chatID: 42, data: " Pause ", action: ActionPause, response: pauseText, mutation: true},
		{name: "status en mayúsculas", chatID: 42, data: "STATUS", action: ActionStatus, response: StatusText()},
		{name: "callback desconocido", chatID: 42, data: "pay", action: ActionUnknown, response: unknownText},
		{name: "callback de dinero", chatID: 42, data: "transfer", action: ActionUnknown, response: unknownText},
		{name: "callback vacío construido", chatID: 42, data: "", action: ActionUnknown, response: unknownText},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			update := Update{UpdateID: 200, ChatID: test.chatID, CallbackData: test.data, FromID: 7}
			result := HandleUpdate(update, auth)
			assertUpdateResult(t, result, 200, test.chatID, test.action, test.response, test.mutation)
		})
	}
}

func TestHandleUpdateNonCommandText(t *testing.T) {
	auth := Authorization{AdminChatID: 42}
	texts := []string{
		"hola",
		"start",
		"/",
		"   texto con espacios   ",
		strings.Repeat("a", maxCommandLength+50),
	}
	for _, text := range texts {
		update := Update{UpdateID: 300, ChatID: 42, Text: text, FromID: 7}
		result := HandleUpdate(update, auth)
		assertUpdateResult(t, result, 300, 42, ActionHelp, HelpText(), false)
	}
}

func TestHandleUpdateEmptyUpdate(t *testing.T) {
	auth := Authorization{AdminChatID: 42}
	tests := []Update{
		{},
		{UpdateID: 9, ChatID: 42},
		{UpdateID: 10, ChatID: 42, Text: "   "},
	}
	for _, update := range tests {
		result := HandleUpdate(update, auth)
		assertUpdateResult(t, result, update.UpdateID, update.ChatID, ActionUnknown, unknownText, false)
	}
}

func TestHandleUpdateIsDeterministicAndReplyMatchesDecision(t *testing.T) {
	auth := Authorization{AdminChatID: 42}
	updates := []Update{
		{UpdateID: 1, ChatID: 42, Text: "/status", FromID: 7},
		{UpdateID: 2, ChatID: 41, Text: "/pause", FromID: 7},
		{UpdateID: 3, ChatID: 42, CallbackData: "resume", FromID: 7},
		{UpdateID: 4, ChatID: 42, CallbackData: "pay", FromID: 7},
		{UpdateID: 5, ChatID: 42, Text: "hola", FromID: 7},
		{UpdateID: 6, ChatID: 42},
	}
	for _, update := range updates {
		first := HandleUpdate(update, auth)
		second := HandleUpdate(update, auth)
		if first != second {
			t.Fatalf("HandleUpdate no es determinista para %+v: %+v != %+v", update, first, second)
		}
		if first.Reply != first.Decision.Response {
			t.Fatalf("Reply = %q, se esperaba Decision.Response = %q", first.Reply, first.Decision.Response)
		}
	}
}

func TestHandleUpdateDoesNotLeakData(t *testing.T) {
	const secret = "SECRETO_12345"
	auth := Authorization{AdminChatID: 42}
	updates := []Update{
		{UpdateID: 1, ChatID: 999999, FromID: 777777, Text: secret},
		{UpdateID: 2, ChatID: 999999, FromID: 777777, CallbackData: secret},
		{UpdateID: 3, ChatID: 42, FromID: 777777, Text: "/pause " + secret},
	}
	forbidden := []string{secret, "999999", "777777"}
	for _, update := range updates {
		result := HandleUpdate(update, auth)
		for _, value := range forbidden {
			if strings.Contains(result.Reply, value) {
				t.Fatalf("Reply filtró %q: %q", value, result.Reply)
			}
			if strings.Contains(result.Decision.Response, value) {
				t.Fatalf("Decision.Response filtró %q: %q", value, result.Decision.Response)
			}
		}
		if result.Reply != result.Decision.Response {
			t.Fatalf("Reply = %q, se esperaba Decision.Response = %q", result.Reply, result.Decision.Response)
		}
	}
}
