// Package telegramruntime contiene utilidades puras de `src/telegram-runtime.ts`.
package telegramruntime

import (
	"regexp"
	"strings"
)

var notModified = regexp.MustCompile(`(?i)message is not modified`)

// AnswerCallbackSafely responde sin propagar errores de callback expirado.
func AnswerCallbackSafely(answer func() error) bool {
	if answer == nil {
		return true
	}
	if err := answer(); err != nil {
		return false
	}
	return true
}

// SplitCallbackData separa acción y valor por el primer `:`.
func SplitCallbackData(data string) (string, string) {
	index := strings.IndexByte(data, ':')
	if index < 0 {
		return data, ""
	}
	return data[:index], data[index+1:]
}

// RenderGuard invalida renders anteriores por clave.
type RenderGuard struct {
	revisions map[string]int64
}

// NewRenderGuard crea el guard.
func NewRenderGuard() *RenderGuard {
	return &RenderGuard{revisions: map[string]int64{}}
}

// Begin incrementa la revisión y la devuelve.
func (guard *RenderGuard) Begin(key string) int64 {
	guard.revisions[key]++
	return guard.revisions[key]
}

// IsCurrent indica si la revisión sigue vigente.
func (guard *RenderGuard) IsCurrent(key string, revision int64) bool {
	return guard.revisions[key] == revision
}

// IsMessageNotModified reconoce el error benigno de Telegram.
func IsMessageNotModified(err error) bool {
	if err == nil {
		return false
	}
	return notModified.MatchString(err.Error())
}
