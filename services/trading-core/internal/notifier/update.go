package notifier

import (
	"encoding/json"
	"strings"
	"unicode/utf8"
)

const (
	// maxUpdatePayload limita el tamaño del JSON recibido de Telegram.
	maxUpdatePayload = 64 * 1024
	// maxUpdateText limita el texto o el callback data procesado.
	maxUpdateText = 4096
)

// Update es un update mínimo de Telegram ya validado. No conserva campos
// desconocidos ni datos que el bot no necesite.
type Update struct {
	UpdateID     int64
	ChatID       int64
	Text         string
	CallbackData string
	CallbackID   string
	FromID       int64
	IsBot        bool
}

// Estructuras auxiliares de Telegram. Los punteros distinguen un campo
// ausente de un valor cero.
type updateUser struct {
	ID    *int64 `json:"id"`
	IsBot bool   `json:"is_bot"`
}

type updateChat struct {
	ID *int64 `json:"id"`
}

type updateMessage struct {
	Chat *updateChat `json:"chat"`
	Text *string     `json:"text"`
	From *updateUser `json:"from"`
}

type updateCallbackQuery struct {
	ID      *string        `json:"id"`
	Message *updateMessage `json:"message"`
	Data    *string        `json:"data"`
	From    *updateUser    `json:"from"`
}

type updateEnvelope struct {
	UpdateID      *int64               `json:"update_id"`
	Message       *updateMessage       `json:"message"`
	CallbackQuery *updateCallbackQuery `json:"callback_query"`
}

// ParseUpdate valida y normaliza un update de Telegram sin hacer red.
// Acepta mensajes con chat y texto, y callback queries con chat y data.
// Rechaza payloads mayores de 64 KiB, JSON inválido, bots, updates vacíos,
// chats ausentes o cero y texto/data vacío o mayor de 4096 bytes o runas.
// Si un payload trae message y callback_query a la vez, prevalece message.
func ParseUpdate(payload []byte) (Update, bool) {
	if len(payload) == 0 || len(payload) > maxUpdatePayload {
		return Update{}, false
	}

	var envelope updateEnvelope
	if err := json.Unmarshal(payload, &envelope); err != nil {
		return Update{}, false
	}

	update := Update{}
	if envelope.UpdateID != nil {
		update.UpdateID = *envelope.UpdateID
	}

	var (
		chat       *updateChat
		text       *string
		data       *string
		from       *updateUser
		callbackID *string
	)

	switch {
	case envelope.Message != nil:
		chat = envelope.Message.Chat
		text = envelope.Message.Text
		from = envelope.Message.From
	case envelope.CallbackQuery != nil:
		if envelope.CallbackQuery.Message == nil {
			return Update{}, false
		}
		chat = envelope.CallbackQuery.Message.Chat
		data = envelope.CallbackQuery.Data
		from = envelope.CallbackQuery.From
		callbackID = envelope.CallbackQuery.ID
	default:
		return Update{}, false
	}

	if chat == nil || chat.ID == nil || *chat.ID == 0 {
		return Update{}, false
	}
	update.ChatID = *chat.ID

	if from != nil {
		if from.IsBot {
			return Update{}, false
		}
		if from.ID != nil {
			update.FromID = *from.ID
		}
	}

	if text != nil {
		if !validUpdateText(*text) {
			return Update{}, false
		}
		update.Text = *text
	}
	if data != nil {
		if !validUpdateText(*data) {
			return Update{}, false
		}
		update.CallbackData = *data
	}
	if callbackID != nil {
		update.CallbackID = *callbackID
	}

	if update.Text == "" && update.CallbackData == "" {
		return Update{}, false
	}
	return update, true
}

// validUpdateText exige contenido no vacío y limita tanto bytes como runas.
func validUpdateText(value string) bool {
	if strings.TrimSpace(value) == "" {
		return false
	}
	return len(value) <= maxUpdateText && utf8.RuneCountInString(value) <= maxUpdateText
}

// UpdateResult es la respuesta determinista para un update. Reply siempre es
// exactamente Decision.Response.
type UpdateResult struct {
	UpdateID int64
	ChatID   int64
	Decision Decision
	Reply    string
}

// HandleUpdate resuelve un update ya validado sin red ni efectos secundarios.
// La autorización se decide por chat con Authorized. El texto se interpreta con
// ParseCommand y Dispatch. Los callbacks sólo aceptan status, pause y resume,
// con la misma autorización que los comandos. Cualquier otro contenido recibe
// una respuesta estable de ayuda o desconocido que nunca repite los datos de
// entrada.
func HandleUpdate(update Update, auth Authorization) UpdateResult {
	result := UpdateResult{
		UpdateID: update.UpdateID,
		ChatID:   update.ChatID,
	}
	authorized := Authorized(update.ChatID, auth)

	switch {
	case strings.TrimSpace(update.Text) != "":
		if command, ok := ParseCommand(update.Text); ok {
			result.Decision = Dispatch(command, authorized)
		} else {
			result.Decision = Decision{Action: ActionHelp, Response: HelpText(), Mutation: false}
		}
	case strings.TrimSpace(update.CallbackData) != "":
		result.Decision = dispatchCallbackData(update.CallbackData, authorized)
	default:
		result.Decision = Decision{Action: ActionUnknown, Response: unknownText, Mutation: false}
	}

	result.Reply = result.Decision.Response
	return result
}

// dispatchCallbackData sólo reconoce los callbacks definidos por el bot.
// Delega en Dispatch para compartir exactamente la misma autorización.
func dispatchCallbackData(data string, authorized bool) Decision {
	switch strings.ToLower(strings.TrimSpace(data)) {
	case "status":
		return Dispatch(Command{Name: "status"}, authorized)
	case "pause":
		return Dispatch(Command{Name: "pause"}, authorized)
	case "resume":
		return Dispatch(Command{Name: "resume"}, authorized)
	default:
		return Decision{Action: ActionUnknown, Response: unknownText, Mutation: false}
	}
}
