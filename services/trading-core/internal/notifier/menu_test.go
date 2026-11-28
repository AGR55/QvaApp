package notifier

import (
	"reflect"
	"strings"
	"testing"
)

// menuButtons aplana los botones de un menú en orden de filas.
func menuButtons(menu Menu) []Button {
	buttons := make([]Button, 0)
	for _, row := range menu.Buttons {
		buttons = append(buttons, row...)
	}
	return buttons
}

// callbackSet devuelve los callbacks presentes en un menú.
func callbackSet(menu Menu) map[string]bool {
	set := make(map[string]bool)
	for _, button := range menuButtons(menu) {
		set[button.CallbackData] = true
	}
	return set
}

func assertMenuShape(t *testing.T, name string, menu Menu) {
	t.Helper()

	if strings.TrimSpace(menu.Text) == "" {
		t.Fatalf("%s tiene texto vacío", name)
	}
	if len(menu.Buttons) == 0 {
		t.Fatalf("%s no tiene botones", name)
	}

	seen := make(map[string]bool)
	for rowIndex, row := range menu.Buttons {
		if len(row) == 0 {
			t.Fatalf("%s tiene una fila vacía en el índice %d", name, rowIndex)
		}
		for buttonIndex, button := range row {
			if strings.TrimSpace(button.Text) == "" {
				t.Fatalf("%s tiene un botón sin texto en [%d][%d]", name, rowIndex, buttonIndex)
			}
			if len(button.CallbackData) > maxCallbackData {
				t.Fatalf("%s.%q usa %d bytes de callback, el máximo es %d",
					name, button.Text, len(button.CallbackData), maxCallbackData)
			}
			if seen[button.CallbackData] {
				t.Fatalf("%s repite el callback %q", name, button.CallbackData)
			}
			seen[button.CallbackData] = true

			if _, ok := ValidateCallback(button.CallbackData); !ok {
				t.Fatalf("%s.%q usa un callback no válido: %q", name, button.Text, button.CallbackData)
			}
		}
	}
}

func TestStatusMenu(t *testing.T) {
	menu := StatusMenu()

	if menu.Text != statusText {
		t.Fatalf("StatusMenu.Text = %q, se esperaba el texto de estado", menu.Text)
	}

	buttons := menuButtons(menu)
	expected := []struct {
		text     string
		callback Action
	}{
		{text: "Estado", callback: ActionStatus},
		{text: "Pausar", callback: ActionPause},
		{text: "Reanudar", callback: ActionResume},
		{text: "Ayuda", callback: ActionHelp},
	}
	if len(buttons) != len(expected) {
		t.Fatalf("StatusMenu tiene %d botones, se esperaban %d", len(buttons), len(expected))
	}
	for index, want := range expected {
		if buttons[index].Text != want.text {
			t.Fatalf("botón %d = %q, se esperaba %q", index, buttons[index].Text, want.text)
		}
		if buttons[index].CallbackData != string(want.callback) {
			t.Fatalf("callback %d = %q, se esperaba %q",
				index, buttons[index].CallbackData, want.callback)
		}
	}

	assertMenuShape(t, "StatusMenu", menu)
}

func TestHelpMenu(t *testing.T) {
	menu := HelpMenu()

	if menu.Text != helpText {
		t.Fatalf("HelpMenu.Text = %q, se esperaba el texto de ayuda", menu.Text)
	}
	if !strings.Contains(menu.Text, "Comandos disponibles") {
		t.Fatalf("HelpMenu no explica los comandos: %q", menu.Text)
	}

	callbacks := callbackSet(menu)
	if !callbacks[string(ActionStatus)] || !callbacks[string(ActionHelp)] {
		t.Fatalf("HelpMenu no ofrece botones seguros: %+v", callbacks)
	}
	if callbacks[string(ActionPause)] || callbacks[string(ActionResume)] {
		t.Fatalf("HelpMenu no debe ofrecer mutaciones: %+v", callbacks)
	}

	assertMenuShape(t, "HelpMenu", menu)
}

func TestMenuForActionReadOnly(t *testing.T) {
	tests := []struct {
		name       string
		action     Action
		authorized bool
		want       Menu
	}{
		{name: "help autorizado", action: ActionHelp, authorized: true, want: HelpMenu()},
		{name: "help sin autorización", action: ActionHelp, authorized: false, want: HelpMenu()},
		{name: "status autorizado", action: ActionStatus, authorized: true, want: StatusMenu()},
		{name: "status sin autorización", action: ActionStatus, authorized: false, want: StatusMenu()},
		{name: "desconocido autorizado", action: ActionUnknown, authorized: true, want: HelpMenu()},
		{name: "desconocido sin autorización", action: ActionUnknown, authorized: false, want: HelpMenu()},
		{name: "acción vacía", action: "", authorized: true, want: HelpMenu()},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			got := MenuForAction(test.action, test.authorized)
			if !reflect.DeepEqual(got, test.want) {
				t.Fatalf("MenuForAction(%q, %v) = %+v, se esperaba %+v",
					test.action, test.authorized, got, test.want)
			}
			assertMenuShape(t, "MenuForAction", got)
		})
	}
}

func TestMenuForActionMutationAuthorized(t *testing.T) {
	tests := []struct {
		action       Action
		wantText     string
		wantCallback Action
	}{
		{action: ActionPause, wantText: pauseText, wantCallback: ActionResume},
		{action: ActionResume, wantText: resumeText, wantCallback: ActionPause},
	}
	for _, test := range tests {
		t.Run(string(test.action), func(t *testing.T) {
			menu := MenuForAction(test.action, true)
			if menu.Text != test.wantText {
				t.Fatalf("Text = %q, se esperaba %q", menu.Text, test.wantText)
			}

			callbacks := callbackSet(menu)
			if !callbacks[string(ActionStatus)] || !callbacks[string(ActionHelp)] {
				t.Fatalf("el menú autorizado no incluye acciones seguras: %+v", callbacks)
			}
			if !callbacks[string(test.wantCallback)] {
				t.Fatalf("el menú autorizado no incluye %q: %+v", test.wantCallback, callbacks)
			}

			assertMenuShape(t, "menú autorizado", menu)
		})
	}
}

func TestMenuForActionMutationDenied(t *testing.T) {
	for _, action := range []Action{ActionPause, ActionResume} {
		t.Run(string(action), func(t *testing.T) {
			menu := MenuForAction(action, false)

			if menu.Text != deniedText {
				t.Fatalf("Text = %q, se esperaba %q", menu.Text, deniedText)
			}

			callbacks := callbackSet(menu)
			if callbacks[string(ActionPause)] || callbacks[string(ActionResume)] {
				t.Fatalf("el menú denegado no debe tener mutaciones: %+v", callbacks)
			}
			if !callbacks[string(ActionStatus)] || !callbacks[string(ActionHelp)] {
				t.Fatalf("el menú denegado debe tener sólo acciones seguras: %+v", callbacks)
			}

			assertMenuShape(t, "menú denegado", menu)
		})
	}
}

func TestMenusDoNotExposeUnsafeActions(t *testing.T) {
	forbidden := []string{
		"apply", "cancel", "pay", "payment", "pago", "pagos",
		"money", "dinero", "saldo", "transfer", "withdraw",
	}
	menus := map[string]Menu{
		"status": StatusMenu(),
		"help":   HelpMenu(),
	}
	for _, action := range []Action{ActionHelp, ActionStatus, ActionPause, ActionResume, ActionUnknown} {
		for _, authorized := range []bool{true, false} {
			menus[string(action)+"/"+boolName(authorized)] = MenuForAction(action, authorized)
		}
	}

	for name, menu := range menus {
		for _, button := range menuButtons(menu) {
			callback := strings.ToLower(button.CallbackData)
			for _, unsafe := range forbidden {
				if strings.Contains(callback, unsafe) {
					t.Fatalf("%s expone una acción no permitida: %q", name, button.CallbackData)
				}
			}
		}
	}
}

func boolName(value bool) string {
	if value {
		return "autorizado"
	}
	return "denegado"
}

func TestValidateCallback(t *testing.T) {
	valid := []struct {
		data string
		want Action
	}{
		{data: "status", want: ActionStatus},
		{data: "pause", want: ActionPause},
		{data: "resume", want: ActionResume},
		{data: "help", want: ActionHelp},
		{data: "  status  ", want: ActionStatus},
		{data: "PAUSE", want: ActionPause},
		{data: "\tReSuMe\n", want: ActionResume},
		{data: " Help ", want: ActionHelp},
	}
	for _, test := range valid {
		action, ok := ValidateCallback(test.data)
		if !ok {
			t.Fatalf("ValidateCallback(%q) rechazó un callback válido", test.data)
		}
		if action != test.want {
			t.Fatalf("ValidateCallback(%q) = %q, se esperaba %q", test.data, action, test.want)
		}
	}

	invalid := []string{
		"",
		"   ",
		"\n\t",
		"start",
		"unknown",
		"apply",
		"cancel",
		"pago",
		"/status",
		"status pause",
		"status;pause",
		"pause\x00",
		strings.Repeat("a", maxCallbackData+1),
	}
	for _, data := range invalid {
		action, ok := ValidateCallback(data)
		if ok {
			t.Fatalf("ValidateCallback(%q) aceptó un callback inválido: %q", data, action)
		}
		if action != "" {
			t.Fatalf("ValidateCallback(%q) devolvió acción %q con ok=false", data, action)
		}
	}
}

func TestMenusAreDeterministic(t *testing.T) {
	for _, action := range []Action{ActionHelp, ActionStatus, ActionPause, ActionResume, ActionUnknown} {
		for _, authorized := range []bool{true, false} {
			first := MenuForAction(action, authorized)
			for iteration := 0; iteration < 10; iteration++ {
				next := MenuForAction(action, authorized)
				if !reflect.DeepEqual(first, next) {
					t.Fatalf("MenuForAction(%q, %v) no es determinista:\n%+v\n%+v",
						action, authorized, first, next)
				}
			}
		}
	}

	if !reflect.DeepEqual(StatusMenu(), StatusMenu()) {
		t.Fatal("StatusMenu no es determinista")
	}
	if !reflect.DeepEqual(HelpMenu(), HelpMenu()) {
		t.Fatal("HelpMenu no es determinista")
	}
}
