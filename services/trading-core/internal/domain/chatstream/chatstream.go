// Package chatstream implementa el framing SSE acotado de
// `src/chat-stream.ts`. Los payloads solo invalidan la caché; el dominio
// financiero nunca los consume.
package chatstream

//lint:file-ignore ST1005 los mensajes son contractuales y deben coincidir con el oráculo

import (
	"encoding/json"
	"errors"
	"strings"
)

const maxBuffer = 65_536

var controlEvents = map[string]bool{
	"ping":      true,
	"heartbeat": true,
	"keepalive": true,
	"connected": true,
}

// Consume procesa los fragmentos y llama a `changed` por cada evento útil.
func Consume(chunks []string, changed func()) error {
	buffer := ""
	for _, chunk := range chunks {
		buffer += strings.ReplaceAll(chunk, "\r\n", "\n")
		if len(buffer) > maxBuffer {
			return errors.New("Evento de chat demasiado grande.")
		}
		parts := strings.Split(buffer, "\n\n")
		buffer = parts[len(parts)-1]
		for _, frame := range parts[:len(parts)-1] {
			if frameChanged(frame) && changed != nil {
				changed()
			}
		}
	}
	return nil
}

func frameChanged(frame string) bool {
	lines := strings.Split(frame, "\n")
	event := ""
	for _, line := range lines {
		if strings.HasPrefix(line, "event:") {
			event = strings.ToLower(strings.TrimSpace(line[6:]))
			break
		}
	}
	if controlEvents[event] {
		return false
	}
	dataLines := make([]string, 0)
	for _, line := range lines {
		if strings.HasPrefix(line, "data:") {
			dataLines = append(dataLines, strings.TrimLeft(line[5:], " \t"))
		}
	}
	data := strings.Join(dataLines, "\n")
	if data == "" {
		return false
	}
	trimmed := strings.TrimSpace(data)
	if controlEvents[strings.ToLower(trimmed)] {
		return false
	}
	var payload struct {
		Type  string `json:"type"`
		Event string `json:"event"`
	}
	if err := json.Unmarshal([]byte(data), &payload); err == nil {
		kind := payload.Type
		if kind == "" {
			kind = payload.Event
		}
		if controlEvents[strings.ToLower(kind)] {
			return false
		}
	}
	return true
}
