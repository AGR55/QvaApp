package main

//lint:file-ignore ST1005 los mensajes simulan errores de Telegram

import (
	"errors"
	"fmt"

	"github.com/AGR55/QvaApp/services/trading-core/internal/domain/telegramruntime"
)

func telegramRuntimeAnswer(fields map[string]any) (any, *opError) {
	scenario, failure := stringField(fields, "scenario")
	if failure != nil {
		return nil, failure
	}
	calls := 0
	answered := telegramruntime.AnswerCallbackSafely(func() error {
		calls++
		switch scenario {
		case "expired":
			return errors.New("Call to 'answerCallbackQuery' failed! (400: Bad Request: query is too old and response timeout expired)")
		case "invalid":
			return errors.New("Bad Request: query ID is invalid")
		case "other":
			return errors.New("network error")
		default:
			return nil
		}
	})
	return map[string]any{"answered": answered, "calls": calls}, nil
}

func telegramRuntimeRenderGuard(fields map[string]any) (any, *opError) {
	steps, ok := fields["steps"].([]any)
	if !ok {
		return nil, validation("El campo steps debe ser un array.")
	}
	guard := telegramruntime.NewRenderGuard()
	revisions := map[string]int64{}
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
		key, failure := stringField(step, "key")
		if failure != nil {
			return nil, failure
		}
		switch operation {
		case "begin":
			label, failure := stringField(step, "label")
			if failure != nil {
				return nil, failure
			}
			revision := guard.Begin(key)
			revisions[label] = revision
			results = append(results, map[string]any{"revision": revision})
		case "isCurrent":
			label, failure := stringField(step, "label")
			if failure != nil {
				return nil, failure
			}
			revision, ok := revisions[label]
			results = append(results, map[string]any{"current": ok && guard.IsCurrent(key, revision)})
		default:
			return nil, validation(fmt.Sprintf("Operación de render desconocida: %s.", operation))
		}
	}
	return map[string]any{"results": results}, nil
}

func telegramRuntimeSplit(data string) map[string]any {
	action, value := telegramruntime.SplitCallbackData(data)
	return map[string]any{"parts": []any{action, value}}
}

func telegramRuntimeNotModified(message string) map[string]any {
	return map[string]any{"notModified": telegramruntime.IsMessageNotModified(errors.New(message))}
}
