package notifier

import (
	"strings"
	"testing"
)

func TestParseCommandValid(t *testing.T) {
	tests := []struct {
		text string
		name string
		args []string
	}{
		{text: "/start", name: "start"},
		{text: "  /status  ", name: "status"},
		{text: "/HeLp", name: "help"},
		{text: "/pause ahora mismo", name: "pause", args: []string{"ahora", "mismo"}},
		{text: "/resume  001   ABC", name: "resume", args: []string{"001", "ABC"}},
		{text: "/help\n/status", name: "help", args: []string{"/status"}},
	}
	for _, test := range tests {
		command, ok := ParseCommand(test.text)
		if !ok {
			t.Fatalf("ParseCommand(%q) rechazó un comando válido", test.text)
		}
		if command.Name != test.name {
			t.Fatalf("ParseCommand(%q).Name = %q, se esperaba %q", test.text, command.Name, test.name)
		}
		if len(command.Args) != len(test.args) {
			t.Fatalf("ParseCommand(%q).Args = %v, se esperaba %v", test.text, command.Args, test.args)
		}
		for index := range test.args {
			if command.Args[index] != test.args[index] {
				t.Fatalf("ParseCommand(%q).Args = %v, se esperaba %v", test.text, command.Args, test.args)
			}
		}
	}
}

func TestParseCommandInvalid(t *testing.T) {
	tests := []string{
		"",
		"   ",
		"/",
		"/   ",
		"texto normal",
		"texto /start",
		"start",
		"/" + strings.Repeat("a", maxCommandLength),
	}
	for _, text := range tests {
		if command, ok := ParseCommand(text); ok {
			t.Fatalf("ParseCommand(%q) aceptó un comando inválido: %+v", text, command)
		}
	}
}

func TestParseCommandLengthLimit(t *testing.T) {
	atLimit := "/" + strings.Repeat("a", maxCommandLength-1)
	if _, ok := ParseCommand(atLimit); !ok {
		t.Fatal("ParseCommand rechazó un comando de exactamente 512 caracteres")
	}

	unicodeAtLimit := "/" + strings.Repeat("á", maxCommandLength-1)
	if _, ok := ParseCommand(unicodeAtLimit); !ok {
		t.Fatal("ParseCommand contó bytes en lugar de caracteres")
	}
}

func TestAuthorized(t *testing.T) {
	tests := []struct {
		name    string
		chatID  int64
		auth    Authorization
		allowed bool
	}{
		{name: "chat cero", chatID: 0, auth: Authorization{AdminChatID: 42}, allowed: false},
		{name: "admin cero", chatID: 42, auth: Authorization{AdminChatID: 0}, allowed: false},
		{name: "chat distinto", chatID: 41, auth: Authorization{AdminChatID: 42}, allowed: false},
		{name: "chat autorizado", chatID: 42, auth: Authorization{AdminChatID: 42}, allowed: true},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := Authorized(test.chatID, test.auth); got != test.allowed {
				t.Fatalf("Authorized(%d, %+v) = %v, se esperaba %v", test.chatID, test.auth, got, test.allowed)
			}
		})
	}
}

func TestDispatch(t *testing.T) {
	tests := []struct {
		name       string
		text       string
		authorized bool
		action     Action
		response   string
		mutation   bool
	}{
		{name: "start", text: "/start", action: ActionHelp, response: HelpText()},
		{name: "help", text: "/help", action: ActionHelp, response: HelpText()},
		{name: "status", text: "/status", action: ActionStatus, response: StatusText()},
		{name: "pause autorizado", text: "/pause", authorized: true, action: ActionPause, response: pauseText, mutation: true},
		{name: "resume autorizado", text: "/resume", authorized: true, action: ActionResume, response: resumeText, mutation: true},
		{name: "pause denegado", text: "/pause", authorized: false, action: ActionPause, response: deniedText},
		{name: "resume denegado", text: "/resume", authorized: false, action: ActionResume, response: deniedText},
		{name: "desconocido", text: "/borrar", authorized: true, action: ActionUnknown, response: unknownText},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			command, ok := ParseCommand(test.text)
			if !ok {
				t.Fatalf("ParseCommand(%q) rechazó el comando de prueba", test.text)
			}
			decision := Dispatch(command, test.authorized)
			if decision.Action != test.action {
				t.Fatalf("Action = %q, se esperaba %q", decision.Action, test.action)
			}
			if decision.Response != test.response {
				t.Fatalf("Response = %q, se esperaba %q", decision.Response, test.response)
			}
			if decision.Mutation != test.mutation {
				t.Fatalf("Mutation = %v, se esperaba %v", decision.Mutation, test.mutation)
			}
		})
	}
}

func TestDispatchUnknownCommandWithoutSlash(t *testing.T) {
	decision := Dispatch(Command{Name: "noexiste"}, true)
	if decision.Action != ActionUnknown {
		t.Fatalf("Action = %q, se esperaba %q", decision.Action, ActionUnknown)
	}
	if decision.Mutation {
		t.Fatal("un comando desconocido no debe mutar")
	}
	if decision.Response == "" {
		t.Fatal("un comando desconocido debe tener respuesta")
	}
}

func TestTextsAreStableAndNonEmpty(t *testing.T) {
	if HelpText() == "" {
		t.Fatal("HelpText está vacío")
	}
	if StatusText() == "" {
		t.Fatal("StatusText está vacío")
	}
	if HelpText() != HelpText() {
		t.Fatal("HelpText no es determinista")
	}
	if StatusText() != StatusText() {
		t.Fatal("StatusText no es determinista")
	}
	if !strings.Contains(HelpText(), "/help") || !strings.Contains(HelpText(), "/status") {
		t.Fatalf("HelpText no menciona los comandos básicos: %q", HelpText())
	}
}
