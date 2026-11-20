package main

import (
	"encoding/json"
	"fmt"
	"strings"

	"github.com/AGR55/QvaApp/services/trading-core/internal/domain/telegrammenu"
)

func telegramAction(fields map[string]any) (telegrammenu.Action, *opError) {
	actionType, failure := stringField(fields, "type")
	if failure != nil {
		return telegrammenu.Action{}, failure
	}
	action := telegrammenu.Action{Type: actionType}
	for _, key := range []string{"side", "coin", "token"} {
		if fields[key] != nil {
			value, failure := stringField(fields, key)
			if failure != nil {
				return telegrammenu.Action{}, failure
			}
			switch key {
			case "side":
				action.Side = value
			case "coin":
				action.Coin = value
			case "token":
				action.Token = value
			}
		}
	}
	return action, nil
}

func telegramActionView(action telegrammenu.Action) map[string]any {
	result := map[string]any{"type": action.Type}
	if action.Side != "" {
		result["side"] = action.Side
	}
	if action.Coin != "" {
		result["coin"] = action.Coin
	}
	if action.Token != "" {
		result["token"] = action.Token
	}
	return result
}

func telegramSessionView(session telegrammenu.Session) map[string]any {
	result := map[string]any{
		"stage":        session.Stage,
		"token":        session.Token,
		"coin":         session.Coin,
		"side":         session.Side,
		"previousRate": json.Number(session.PreviousRate.Compact()),
	}
	if session.ProposedRate != nil {
		result["proposedRate"] = json.Number(session.ProposedRate.Compact())
	}
	return result
}

func telegramFailure(err error) *opError {
	message := err.Error()
	class := "error"
	if strings.Contains(message, "inválid") {
		class = "validation"
	}
	return &opError{Class: class, Message: message}
}

func telegramRateSessions(fields map[string]any) (any, *opError) {
	steps, ok := fields["steps"].([]any)
	if !ok {
		return nil, validation("El campo steps debe ser un array.")
	}
	serial := 0
	sessions := telegrammenu.NewSessions(func() string {
		serial++
		return fmt.Sprintf("token%d", serial)
	})
	results := make([]any, 0, len(steps))
	for _, item := range steps {
		step, ok := item.(map[string]any)
		if !ok {
			return nil, validation("Cada paso debe ser un objeto.")
		}
		operation, failure := stringField(step, "op")
		if failure != nil {
			return nil, failure
		}
		switch operation {
		case "begin":
			chatID, failure := stringField(step, "chatId")
			if failure != nil {
				return nil, failure
			}
			coin, failure := stringField(step, "coin")
			if failure != nil {
				return nil, failure
			}
			side, failure := stringField(step, "side")
			if failure != nil {
				return nil, failure
			}
			previousRate, _, failure := numberField(step, "previousRate")
			if failure != nil {
				return nil, failure
			}
			session, err := sessions.Begin(chatID, coin, side, previousRate)
			if err != nil {
				results = append(results, map[string]any{"error": err.Error()})
			} else {
				results = append(results, telegramSessionView(session))
			}
		case "propose":
			chatID, failure := stringField(step, "chatId")
			if failure != nil {
				return nil, failure
			}
			text, failure := stringField(step, "text")
			if failure != nil {
				return nil, failure
			}
			session, err := sessions.Propose(chatID, text)
			if err != nil {
				results = append(results, map[string]any{"error": err.Error()})
			} else {
				results = append(results, telegramSessionView(session))
			}
		case "confirm":
			chatID, failure := stringField(step, "chatId")
			if failure != nil {
				return nil, failure
			}
			token, failure := stringField(step, "token")
			if failure != nil {
				return nil, failure
			}
			session, err := sessions.Confirm(chatID, token)
			if err != nil {
				results = append(results, map[string]any{"error": err.Error()})
			} else {
				results = append(results, telegramSessionView(session))
			}
		case "cancel":
			chatID, failure := stringField(step, "chatId")
			if failure != nil {
				return nil, failure
			}
			var token *string
			if step["token"] != nil {
				value, failure := stringField(step, "token")
				if failure != nil {
					return nil, failure
				}
				token = &value
			}
			session, found, err := sessions.Cancel(chatID, token)
			if err != nil {
				results = append(results, map[string]any{"error": err.Error()})
			} else if !found {
				results = append(results, nil)
			} else {
				results = append(results, telegramSessionView(session))
			}
		case "current":
			chatID, failure := stringField(step, "chatId")
			if failure != nil {
				return nil, failure
			}
			session, found := sessions.Current(chatID)
			if !found {
				results = append(results, nil)
			} else {
				results = append(results, telegramSessionView(session))
			}
		default:
			return nil, validation(fmt.Sprintf("Operación de tasa desconocida: %s.", operation))
		}
	}
	return map[string]any{"results": results}, nil
}
