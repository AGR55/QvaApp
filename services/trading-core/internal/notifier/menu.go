package notifier

import "strings"

// maxCallbackData es el límite de bytes que Telegram acepta para el
// callback_data de un botón inline.
const maxCallbackData = 64

// Button es un botón inline puro, sin depender de los tipos de Telegram.
type Button struct {
	Text         string
	CallbackData string
}

// Menu es una vista determinista del bot: un texto y sus botones.
// No contiene datos sensibles ni efectos secundarios.
type Menu struct {
	Text    string
	Buttons [][]Button
}

// StatusMenu devuelve el menú operativo con las acciones básicas del bot.
func StatusMenu() Menu {
	return Menu{
		Text: statusText,
		Buttons: [][]Button{
			{
				{Text: "Estado", CallbackData: string(ActionStatus)},
				{Text: "Pausar", CallbackData: string(ActionPause)},
			},
			{
				{Text: "Reanudar", CallbackData: string(ActionResume)},
				{Text: "Ayuda", CallbackData: string(ActionHelp)},
			},
		},
	}
}

// HelpMenu devuelve la ayuda del bot con botones seguros y sin mutaciones.
func HelpMenu() Menu {
	return Menu{
		Text: helpText,
		Buttons: [][]Button{
			{
				{Text: "Estado", CallbackData: string(ActionStatus)},
				{Text: "Ayuda", CallbackData: string(ActionHelp)},
			},
		},
	}
}

// MenuForAction devuelve el menú correspondiente a una acción. Las acciones de
// mutación no autorizadas reciben un menú de denegación sin botones de
// mutación. Las acciones de sólo lectura nunca exponen datos sensibles.
func MenuForAction(action Action, authorized bool) Menu {
	switch action {
	case ActionHelp, ActionUnknown:
		return HelpMenu()
	case ActionStatus:
		return StatusMenu()
	case ActionPause:
		if !authorized {
			return deniedMenu()
		}
		return pauseMenu()
	case ActionResume:
		if !authorized {
			return deniedMenu()
		}
		return resumeMenu()
	default:
		return HelpMenu()
	}
}

// ValidateCallback valida y normaliza el callback_data de un botón inline.
// Sólo acepta status, pause, resume y help, ignorando espacios y mayúsculas.
func ValidateCallback(data string) (Action, bool) {
	switch strings.ToLower(strings.TrimSpace(data)) {
	case string(ActionStatus):
		return ActionStatus, true
	case string(ActionPause):
		return ActionPause, true
	case string(ActionResume):
		return ActionResume, true
	case string(ActionHelp):
		return ActionHelp, true
	default:
		return "", false
	}
}

// pauseMenu confirma la pausa y ofrece sólo acciones seguras o autorizadas.
func pauseMenu() Menu {
	return Menu{
		Text: pauseText,
		Buttons: [][]Button{
			{
				{Text: "Estado", CallbackData: string(ActionStatus)},
				{Text: "Reanudar", CallbackData: string(ActionResume)},
			},
			{
				{Text: "Ayuda", CallbackData: string(ActionHelp)},
			},
		},
	}
}

// resumeMenu confirma la reanudación y ofrece sólo acciones seguras o autorizadas.
func resumeMenu() Menu {
	return Menu{
		Text: resumeText,
		Buttons: [][]Button{
			{
				{Text: "Estado", CallbackData: string(ActionStatus)},
				{Text: "Pausar", CallbackData: string(ActionPause)},
			},
			{
				{Text: "Ayuda", CallbackData: string(ActionHelp)},
			},
		},
	}
}

// deniedMenu informa la denegación sin ofrecer botones de mutación.
func deniedMenu() Menu {
	return Menu{
		Text: deniedText,
		Buttons: [][]Button{
			{
				{Text: "Estado", CallbackData: string(ActionStatus)},
				{Text: "Ayuda", CallbackData: string(ActionHelp)},
			},
		},
	}
}
