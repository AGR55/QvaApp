package notifier

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"
)

func TestSendMenu(t *testing.T) {
	var calls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		if r.Method != http.MethodPost {
			t.Errorf("método = %q, se esperaba POST", r.Method)
		}
		if r.URL.Path != "/bottoken-secreto/sendMessage" {
			t.Errorf("path = %q, se esperaba el de sendMessage con token", r.URL.Path)
		}
		if r.Header.Get("Content-Type") != "application/json" {
			t.Errorf("Content-Type = %q, se esperaba application/json",
				r.Header.Get("Content-Type"))
		}

		body, err := io.ReadAll(r.Body)
		if err != nil {
			t.Fatal(err)
		}
		var raw map[string]json.RawMessage
		if err := json.Unmarshal(body, &raw); err != nil {
			t.Fatal(err)
		}
		if len(raw) != 3 {
			t.Fatalf("el payload tiene %d campos, se esperaban 3: %s", len(raw), body)
		}
		for _, key := range []string{"chat_id", "text", "reply_markup"} {
			if _, ok := raw[key]; !ok {
				t.Fatalf("falta el campo %q en el payload: %s", key, body)
			}
		}
		var markup map[string]json.RawMessage
		if err := json.Unmarshal(raw["reply_markup"], &markup); err != nil {
			t.Fatal(err)
		}
		if len(markup) != 1 {
			t.Fatalf("reply_markup tiene %d campos, se esperaba sólo inline_keyboard: %s",
				len(markup), raw["reply_markup"])
		}
		inline, ok := markup["inline_keyboard"]
		if !ok {
			t.Fatalf("falta inline_keyboard en reply_markup: %s", raw["reply_markup"])
		}

		var payload struct {
			ChatID string `json:"chat_id"`
			Text   string `json:"text"`
		}
		if err := json.Unmarshal(body, &payload); err != nil {
			t.Fatal(err)
		}
		if payload.ChatID != "123" {
			t.Errorf("chat_id = %q, se esperaba 123", payload.ChatID)
		}
		if payload.Text != "hola" {
			t.Errorf("text = %q, se esperaba hola", payload.Text)
		}

		var got InlineKeyboard
		if err := json.Unmarshal(inline, &got); err != nil {
			t.Fatal(err)
		}
		want := InlineKeyboard{
			{
				{Text: "Estado", CallbackData: "status"},
				{Text: "Ayuda", CallbackData: "help"},
			},
			{
				{Text: "Pausar", CallbackData: "pause"},
			},
		}
		if !reflect.DeepEqual(got, want) {
			t.Errorf("inline_keyboard = %+v, se esperaba %+v", got, want)
		}

		fmt.Fprint(w, `{"ok":true}`)
	}))
	t.Cleanup(server.Close)

	client := NewClient("token-secreto", server.URL)
	keyboard := InlineKeyboard{
		{
			{Text: "Estado", CallbackData: "status"},
			{Text: "Ayuda", CallbackData: "help"},
		},
		{
			{Text: "Pausar", CallbackData: "pause"},
		},
	}
	if err := client.SendMenu(context.Background(), "123", "hola", keyboard); err != nil {
		t.Fatal(err)
	}
	if calls.Load() != 1 {
		t.Fatalf("se hicieron %d peticiones, se esperaba 1", calls.Load())
	}
}

func TestSendMenuAPIErrorDoesNotLeakToken(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
		fmt.Fprint(w, `{"ok":false,"description":"Unauthorized"}`)
	}))
	t.Cleanup(server.Close)

	client := NewClient("token-secreto", server.URL)
	err := client.SendMenu(context.Background(), "123", "hola", InlineKeyboard{
		{{Text: "Estado", CallbackData: "status"}},
	})
	if err == nil {
		t.Fatal("se esperaba error")
	}
	if strings.Contains(err.Error(), "token-secreto") {
		t.Fatalf("el error filtra el token: %v", err)
	}
	apiErr := &APIError{}
	if !errors.As(err, &apiErr) {
		t.Fatalf("error = %T, se esperaba *APIError", err)
	}
	if apiErr.Status != http.StatusUnauthorized {
		t.Fatalf("Status = %d, se esperaba %d", apiErr.Status, http.StatusUnauthorized)
	}
}

func TestSendMenuValidation(t *testing.T) {
	validKeyboard := InlineKeyboard{
		{{Text: "Estado", CallbackData: "status"}},
	}
	longCallback := "callback-secreto-" + strings.Repeat("a", maxCallbackData)
	tooManyRows := make(InlineKeyboard, 0, maxInlineRows+1)
	for index := 0; index <= maxInlineRows; index++ {
		tooManyRows = append(tooManyRows, []InlineButton{
			{Text: "Botón", CallbackData: fmt.Sprintf("cb-%d", index)},
		})
	}
	tooManyButtons := make([]InlineButton, 0, maxInlineRowButtons+1)
	for index := 0; index <= maxInlineRowButtons; index++ {
		tooManyButtons = append(tooManyButtons, InlineButton{
			Text:         "Botón",
			CallbackData: fmt.Sprintf("cb-%d", index),
		})
	}

	tests := []struct {
		name     string
		text     string
		keyboard InlineKeyboard
		want     string
		secret   string
	}{
		{
			name:     "texto vacío",
			text:     "   ",
			keyboard: validKeyboard,
			want:     "mensaje vacío",
		},
		{
			name:     "texto demasiado largo",
			text:     strings.Repeat("a", maxMenuText+1),
			keyboard: validKeyboard,
			want:     "demasiado largo",
		},
		{
			name:     "callback vacío",
			text:     "hola",
			keyboard: InlineKeyboard{{{Text: "Estado"}}},
			want:     "callback vacío",
		},
		{
			name:     "callback demasiado largo",
			text:     "hola",
			keyboard: InlineKeyboard{{{Text: "Estado", CallbackData: longCallback}}},
			want:     "callback demasiado largo",
			secret:   longCallback,
		},
		{
			name:     "demasiadas filas",
			text:     "hola",
			keyboard: tooManyRows,
			want:     "demasiadas filas",
		},
		{
			name:     "demasiados botones por fila",
			text:     "hola",
			keyboard: InlineKeyboard{tooManyButtons},
			want:     "demasiados botones",
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			var calls atomic.Int32
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				calls.Add(1)
				fmt.Fprint(w, `{"ok":true}`)
			}))
			t.Cleanup(server.Close)

			client := NewClient("token-secreto", server.URL)
			err := client.SendMenu(context.Background(), "123", test.text, test.keyboard)
			if err == nil {
				t.Fatal("se esperaba error de validación")
			}
			if !strings.Contains(err.Error(), test.want) {
				t.Fatalf("error = %q, se esperaba que contuviera %q", err, test.want)
			}
			if strings.Contains(err.Error(), "token-secreto") {
				t.Fatalf("el error filtra el token: %v", err)
			}
			if test.secret != "" && strings.Contains(err.Error(), test.secret) {
				t.Fatalf("el error repite el callback: %v", err)
			}
			if calls.Load() != 0 {
				t.Fatalf("se hizo red con datos inválidos: %d peticiones", calls.Load())
			}
		})
	}
}

func TestSendMenuMissingTokenOrChat(t *testing.T) {
	var calls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		calls.Add(1)
		fmt.Fprint(w, `{"ok":true}`)
	}))
	t.Cleanup(server.Close)

	keyboard := InlineKeyboard{{{Text: "Estado", CallbackData: "status"}}}

	err := NewClient("", server.URL).SendMenu(context.Background(), "123", "hola", keyboard)
	if err == nil || !strings.Contains(err.Error(), "token de Telegram no configurado") {
		t.Fatalf("error sin token = %v", err)
	}

	err = NewClient("token-secreto", server.URL).SendMenu(context.Background(), "  ", "hola", keyboard)
	if err == nil || !strings.Contains(err.Error(), "chat de Telegram no configurado") {
		t.Fatalf("error sin chat = %v", err)
	}

	if calls.Load() != 0 {
		t.Fatalf("se hizo red sin token o chat: %d peticiones", calls.Load())
	}
}

func TestSendMenuAcceptsLimits(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		fmt.Fprint(w, `{"ok":true}`)
	}))
	t.Cleanup(server.Close)

	fullCallback := strings.Repeat("a", maxCallbackData)
	keyboard := make(InlineKeyboard, 0, maxInlineRows)
	for rowIndex := 0; rowIndex < maxInlineRows; rowIndex++ {
		row := make([]InlineButton, 0, maxInlineRowButtons)
		for buttonIndex := 0; buttonIndex < maxInlineRowButtons; buttonIndex++ {
			row = append(row, InlineButton{
				Text:         "Botón",
				CallbackData: fullCallback,
			})
		}
		keyboard = append(keyboard, row)
	}

	client := NewClient("token-secreto", server.URL)
	err := client.SendMenu(context.Background(), "123", strings.Repeat("a", maxMenuText), keyboard)
	if err != nil {
		t.Fatalf("los límites exactos fueron rechazados: %v", err)
	}
}

func TestKeyboardFromMenu(t *testing.T) {
	menu := Menu{
		Text: "hola",
		Buttons: [][]Button{
			{
				{Text: "Estado", CallbackData: "status"},
				{Text: "Ayuda", CallbackData: "help"},
			},
			{
				{Text: "Pausar", CallbackData: "pause"},
			},
		},
	}

	keyboard := KeyboardFromMenu(menu)
	want := InlineKeyboard{
		{
			{Text: "Estado", CallbackData: "status"},
			{Text: "Ayuda", CallbackData: "help"},
		},
		{
			{Text: "Pausar", CallbackData: "pause"},
		},
	}
	if !reflect.DeepEqual(keyboard, want) {
		t.Fatalf("KeyboardFromMenu = %+v, se esperaba %+v", keyboard, want)
	}

	statusMenu := StatusMenu()
	status := KeyboardFromMenu(statusMenu)
	if len(status) != len(statusMenu.Buttons) {
		t.Fatalf("StatusMenu produjo %d filas, se esperaban %d",
			len(status), len(statusMenu.Buttons))
	}
	flat := make([]InlineButton, 0)
	for _, row := range status {
		flat = append(flat, row...)
	}
	wantButtons := menuButtons(statusMenu)
	for index, button := range flat {
		wantButton := wantButtons[index]
		if button.Text != wantButton.Text || button.CallbackData != wantButton.CallbackData {
			t.Fatalf("botón %d = %+v, se esperaba %+v", index, button, wantButton)
		}
	}
}
