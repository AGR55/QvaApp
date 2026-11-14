package main

import (
	"encoding/json"
	"fmt"
	"strings"

	"github.com/AGR55/QvaApp/services/trading-core/internal/domain/coop"
)

func coopAction(fields map[string]any) (coop.Action, *opError) {
	actionType, failure := stringField(fields, "type")
	if failure != nil {
		return coop.Action{}, failure
	}
	action := coop.Action{Type: actionType}
	if fields["coin"] != nil {
		coin, failure := stringField(fields, "coin")
		if failure != nil {
			return coop.Action{}, failure
		}
		action.Coin = coin
	}
	if fields["token"] != nil {
		token, failure := stringField(fields, "token")
		if failure != nil {
			return coop.Action{}, failure
		}
		action.Token = token
	}
	return action, nil
}

func coopActionView(action coop.Action) map[string]any {
	result := map[string]any{"type": action.Type}
	if action.Coin != "" {
		result["coin"] = action.Coin
	}
	if action.Token != "" {
		result["token"] = action.Token
	}
	return result
}

func coopSessionView(session coop.Session) map[string]any {
	result := map[string]any{
		"stage": session.Stage,
		"token": session.Token,
		"coin":  session.Coin,
	}
	if session.Price != nil {
		result["price"] = json.Number(session.Price.Compact())
	}
	if session.Minimal != nil {
		result["minimal"] = json.Number(session.Minimal.Compact())
	}
	return result
}

func coopDraftView(draft coop.Draft) map[string]any {
	return map[string]any{
		"coin":    draft.Coin,
		"price":   json.Number(draft.Price.Compact()),
		"minimal": json.Number(draft.Minimal.Compact()),
	}
}

func coopFailure(err error) *opError {
	message := err.Error()
	class := "error"
	if strings.Contains(message, "inválid") {
		class = "validation"
	}
	return &opError{Class: class, Message: message}
}

func coopSessions(fields map[string]any) (any, *opError) {
	steps, ok := fields["steps"].([]any)
	if !ok {
		return nil, validation("El campo steps debe ser un array.")
	}
	serial := 0
	sessions := coop.NewSessions(func() string {
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
			session, err := sessions.Begin(chatID, coin)
			if err != nil {
				results = append(results, map[string]any{"error": err.Error()})
			} else {
				results = append(results, coopSessionView(session))
			}
		case "accept":
			chatID, failure := stringField(step, "chatId")
			if failure != nil {
				return nil, failure
			}
			text, failure := stringField(step, "text")
			if failure != nil {
				return nil, failure
			}
			session, err := sessions.Accept(chatID, text)
			if err != nil {
				results = append(results, map[string]any{"error": err.Error()})
			} else {
				results = append(results, coopSessionView(session))
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
			draft, err := sessions.Confirm(chatID, token)
			if err != nil {
				results = append(results, map[string]any{"error": err.Error()})
			} else {
				results = append(results, coopDraftView(draft))
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
				results = append(results, coopSessionView(session))
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
				results = append(results, coopSessionView(session))
			}
		default:
			return nil, validation(fmt.Sprintf("Operación cooperativa desconocida: %s.", operation))
		}
	}
	return map[string]any{"results": results}, nil
}
