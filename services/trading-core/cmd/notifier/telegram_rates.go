package main

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/AGR55/QvaApp/services/shared/decimal"
	"github.com/AGR55/QvaApp/services/trading-core/internal/domain/telegrammenu"
	"github.com/AGR55/QvaApp/services/trading-core/internal/notifier"
)

func newRateToken() string {
	buffer := make([]byte, 9)
	if _, err := rand.Read(buffer); err != nil {
		return strconv.FormatInt(time.Now().UnixNano(), 36)
	}
	return base64.RawURLEncoding.EncodeToString(buffer)
}

func (runtime *telegramRuntime) ensureRatesLocked() *telegrammenu.Sessions {
	if runtime.rates == nil {
		runtime.rates = telegrammenu.NewSessions(newRateToken)
	}
	if runtime.rateMessageIDs == nil {
		runtime.rateMessageIDs = map[string]int64{}
	}
	return runtime.rates
}

func (runtime *telegramRuntime) storeRateMessageLocked(chat string, messageID int64) {
	if runtime.rateMessageIDs == nil {
		runtime.rateMessageIDs = map[string]int64{}
	}
	if messageID > 0 {
		runtime.rateMessageIDs[chat] = messageID
	} else {
		delete(runtime.rateMessageIDs, chat)
	}
}

func (runtime *telegramRuntime) takeRateMessageLocked(chat string) int64 {
	messageID := runtime.rateMessageIDs[chat]
	delete(runtime.rateMessageIDs, chat)
	return messageID
}

func (runtime *telegramRuntime) beginRateEdit(
	ctx context.Context,
	chat string,
	messageID int64,
	coin, side string,
) (string, notifier.InlineKeyboard) {
	config, err := runtime.edge.config(ctx)
	if err != nil {
		return "❌ " + err.Error(), nil
	}
	market := findMarket(config, strings.ToUpper(strings.TrimSpace(coin)))
	if market == nil {
		return "❌ Mercado no configurado: " + coin, nil
	}
	field := "buyMaxRate"
	if side == "sell" {
		field = "sellMinRate"
	}
	previous := asFloat(market[field])
	runtime.rateMu.Lock()
	sessions := runtime.ensureRatesLocked()
	session, err := sessions.Begin(chat, asString(market["code"]), side, decimalFromFloat(previous))
	if err == nil {
		runtime.storeRateMessageLocked(chat, messageID)
	}
	runtime.rateMu.Unlock()
	if err != nil {
		return "❌ " + err.Error(), nil
	}
	return fmt.Sprintf(
		"✏️ %s · %s\n\nValor actual: %s %s/QUSD\n\nEscribe la nueva tasa exacta o usa /cancel.",
		sideRateLabel(session.Side), asString(market["label"]),
		rateText(previous), asString(market["currency"]),
	), nil
}

// handleRateText consume el mensaje que responde a la edición de tasa.
func (runtime *telegramRuntime) handleRateText(ctx context.Context, chat, text string) (bool, string) {
	trimmed := strings.TrimSpace(text)
	runtime.rateMu.Lock()
	if runtime.rates == nil {
		runtime.rateMu.Unlock()
		return false, ""
	}
	sessions := runtime.ensureRatesLocked()
	session, ok := sessions.Current(chat)
	if !ok {
		runtime.rateMu.Unlock()
		return false, ""
	}
	if strings.HasPrefix(trimmed, "/") {
		sessions.Cancel(chat, nil)
		messageID := runtime.takeRateMessageLocked(chat)
		runtime.rateMu.Unlock()
		if strings.EqualFold(trimmed, "/cancel") {
			reply, keyboard := runtime.marketPanelWith(ctx, session.Coin, "Edición de tasa cancelada.")
			_ = runtime.deliverMenu(ctx, chat, messageID, reply, keyboard)
			return true, reply
		}
		return false, ""
	}
	if session.Stage == "confirm" {
		messageID := runtime.rateMessageIDs[chat]
		runtime.rateMu.Unlock()
		reply, keyboard := runtime.rateConfirmation(ctx, session)
		_ = runtime.deliverMenu(ctx, chat, messageID, reply, keyboard)
		return true, reply
	}
	next, err := sessions.Propose(chat, trimmed)
	messageID := runtime.rateMessageIDs[chat]
	runtime.rateMu.Unlock()
	if err != nil {
		reply := fmt.Sprintf("❌ %s\n\nEscribe una tasa positiva o usa /cancel.", err)
		_ = runtime.deliverMenu(ctx, chat, messageID, reply, nil)
		return true, reply
	}
	reply, keyboard := runtime.rateConfirmation(ctx, next)
	_ = runtime.deliverMenu(ctx, chat, messageID, reply, keyboard)
	return true, reply
}

func (runtime *telegramRuntime) rateConfirmation(
	ctx context.Context,
	session telegrammenu.Session,
) (string, notifier.InlineKeyboard) {
	config, _ := runtime.edge.config(ctx)
	label, currency := session.Coin, ""
	if market := findMarket(config, session.Coin); market != nil {
		label, currency = asString(market["label"]), asString(market["currency"])
	}
	proposed := decimalText(session.ProposedRate)
	previous := session.PreviousRate.Compact()
	confirm, _ := telegrammenu.Encode(telegrammenu.Action{Type: "rate-confirm", Token: session.Token})
	cancel, _ := telegrammenu.Encode(telegrammenu.Action{Type: "rate-cancel", Token: session.Token})
	text := fmt.Sprintf(
		"✏️ Confirmar tasa de cacería\n\n🪙 %s\n🎯 %s\n\nActual: %s %s/QUSD\nNueva: %s %s/QUSD\n\nLa nueva tasa se aplicará al confirmar.",
		label, sideRateLabel(session.Side), previous, currency, proposed, currency,
	)
	keyboard := notifier.InlineKeyboard{
		{
			{Text: "✅ Guardar tasa", CallbackData: confirm},
			{Text: "✖ Cancelar", CallbackData: cancel},
		},
	}
	return text, keyboard
}

func (runtime *telegramRuntime) confirmRate(ctx context.Context, chat, token string) (string, notifier.InlineKeyboard) {
	runtime.rateMu.Lock()
	sessions := runtime.ensureRatesLocked()
	session, err := sessions.Confirm(chat, token)
	runtime.takeRateMessageLocked(chat)
	runtime.rateMu.Unlock()
	if err != nil {
		return "❌ " + err.Error(), nil
	}
	field := "buyMaxRate"
	if session.Side == "sell" {
		field = "sellMinRate"
	}
	if session.ProposedRate == nil {
		return "❌ La nueva tasa no está disponible; vuelve a editarla.", nil
	}
	value := decimalFloat(*session.ProposedRate)
	if err := runtime.edge.send(ctx, http.MethodPut, "/api/hunting", map[string]any{
		"market": map[string]any{"code": session.Coin, field: value},
	}); err != nil {
		return "❌ " + err.Error(), nil
	}
	return runtime.marketPanelWith(ctx, session.Coin,
		fmt.Sprintf("✅ %s actualizada a %s.", sideRateLabel(session.Side), rateText(value)))
}

func (runtime *telegramRuntime) cancelRate(ctx context.Context, chat, token string) (string, notifier.InlineKeyboard) {
	runtime.rateMu.Lock()
	sessions := runtime.ensureRatesLocked()
	session, found, err := sessions.Cancel(chat, &token)
	runtime.takeRateMessageLocked(chat)
	runtime.rateMu.Unlock()
	if err != nil {
		return "❌ " + err.Error(), nil
	}
	if !found {
		return "No había una edición de tasa pendiente.", nil
	}
	return runtime.marketPanelWith(ctx, session.Coin, "Edición de tasa cancelada.")
}

func (runtime *telegramRuntime) cancelRateSession(chat string) {
	runtime.rateMu.Lock()
	if runtime.rates != nil {
		runtime.rates.Cancel(chat, nil)
	}
	if runtime.rateMessageIDs != nil {
		delete(runtime.rateMessageIDs, chat)
	}
	runtime.rateMu.Unlock()
}

func (runtime *telegramRuntime) ratePending(chat string) bool {
	runtime.rateMu.Lock()
	defer runtime.rateMu.Unlock()
	if runtime.rates == nil {
		return false
	}
	_, ok := runtime.rates.Current(chat)
	return ok
}

func (runtime *telegramRuntime) deliverMenu(
	ctx context.Context,
	chat string,
	messageID int64,
	reply string,
	keyboard notifier.InlineKeyboard,
) error {
	reply = truncate(reply, 3900)
	if messageID > 0 {
		if err := runtime.client.EditMenu(ctx, chat, messageID, reply, keyboard); err == nil ||
			notifier.IsMessageNotModified(err) {
			return nil
		} else {
			runtime.logger.Warn("no se pudo editar el panel; se envía uno nuevo", "error", err)
		}
	}
	return runtime.client.SendMenu(ctx, chat, reply, keyboard)
}

func sideRateLabel(side string) string {
	if side == "sell" {
		return "Mínimo de venta"
	}
	return "Máximo de compra"
}

func decimalFromFloat(value float64) decimal.Value {
	parsed, err := decimal.Parse(strconv.FormatFloat(value, 'f', -1, 64))
	if err != nil {
		return decimal.Zero()
	}
	return parsed
}

func decimalFloat(value decimal.Value) float64 {
	parsed, err := strconv.ParseFloat(value.Format(8), 64)
	if err != nil {
		return 0
	}
	return parsed
}

func decimalText(value *decimal.Value) string {
	if value == nil {
		return "—"
	}
	return value.Compact()
}
