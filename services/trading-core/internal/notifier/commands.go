package notifier

import (
	"strings"
	"unicode/utf8"
)

// maxCommandLength es el máximo de caracteres aceptado por ParseCommand.
const maxCommandLength = 512

// Command es un comando ya parseado, sin el prefijo "/".
type Command struct {
	Name string
	Args []string
}

// ParseCommand interpreta un texto de Telegram como comando.
// Devuelve false si el texto está vacío, supera 512 caracteres, no empieza
// por "/" o no contiene un nombre de comando.
func ParseCommand(text string) (Command, bool) {
	text = strings.TrimSpace(text)
	if text == "" || utf8.RuneCountInString(text) > maxCommandLength {
		return Command{}, false
	}
	if !strings.HasPrefix(text, "/") {
		return Command{}, false
	}

	fields := strings.Fields(text)
	if len(fields) == 0 {
		return Command{}, false
	}

	name := strings.ToLower(strings.TrimPrefix(fields[0], "/"))
	if name == "" {
		return Command{}, false
	}

	args := make([]string, 0, len(fields)-1)
	args = append(args, fields[1:]...)
	return Command{Name: name, Args: args}, true
}

// Authorization contiene las credenciales mínimas para mutar el bot.
type Authorization struct {
	AdminChatID int64
}

// Authorized indica si el chat puede ejecutar comandos con mutación.
// El chat 0 y un administrador sin configurar siempre se deniegan.
func Authorized(chatID int64, auth Authorization) bool {
	if chatID == 0 || auth.AdminChatID == 0 {
		return false
	}
	return chatID == auth.AdminChatID
}

// Action identifica la acción solicitada por un comando.
type Action string

const (
	ActionHelp    Action = "help"
	ActionStatus  Action = "status"
	ActionPause   Action = "pause"
	ActionResume  Action = "resume"
	ActionUnknown Action = "unknown"
)

// Decision es el resultado puro de despachar un comando.
type Decision struct {
	Action   Action
	Response string
	Mutation bool
}

// Textos estables del bot. No contienen datos sensibles.
const (
	helpText = "Comandos disponibles:\n" +
		"/start - inicia el bot\n" +
		"/help - muestra esta ayuda\n" +
		"/status - muestra el estado del bot\n" +
		"/pause - pausa las operaciones\n" +
		"/resume - reanuda las operaciones"

	statusText = "Estado del bot: operativo.\n" +
		"Modo: control manual.\n" +
		"Sin datos sensibles."

	pauseText  = "Bot pausado."
	resumeText = "Bot reanudado."

	deniedText  = "Comando no autorizado."
	unknownText = "Comando desconocido. Usa /help para ver los comandos disponibles."
)

// HelpText devuelve la ayuda estable del bot.
func HelpText() string {
	return helpText
}

// StatusText devuelve el estado estable del bot.
func StatusText() string {
	return statusText
}

// Dispatch resuelve un comando sin efectos secundarios. Sólo los comandos
// /pause y /resume producen mutación, y únicamente si authorized es true.
func Dispatch(command Command, authorized bool) Decision {
	switch normalizeName(command.Name) {
	case "start", "help":
		return Decision{Action: ActionHelp, Response: HelpText(), Mutation: false}
	case "status":
		return Decision{Action: ActionStatus, Response: StatusText(), Mutation: false}
	case "pause":
		if !authorized {
			return Decision{Action: ActionPause, Response: deniedText, Mutation: false}
		}
		return Decision{Action: ActionPause, Response: pauseText, Mutation: true}
	case "resume":
		if !authorized {
			return Decision{Action: ActionResume, Response: deniedText, Mutation: false}
		}
		return Decision{Action: ActionResume, Response: resumeText, Mutation: true}
	default:
		return Decision{Action: ActionUnknown, Response: unknownText, Mutation: false}
	}
}

func normalizeName(name string) string {
	return strings.ToLower(strings.TrimPrefix(strings.TrimSpace(name), "/"))
}
