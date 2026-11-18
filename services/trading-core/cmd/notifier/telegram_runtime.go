package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/AGR55/QvaApp/services/trading-core/internal/domain/telegrammenu"
	"github.com/AGR55/QvaApp/services/trading-core/internal/notifier"
)

// telegramRuntime atiende el bot por long polling y ejecuta comandos contra el
// edge. Solo el chat administrador puede mutar configuración u operaciones.
type telegramRuntime struct {
	client      *notifier.Client
	edge        *edgeClient
	inbox       *telegramInbox
	adminChatID int64
	logger      *slog.Logger

	// pendingMu protege el flujo de publicación cooperativa: tras pulsar
	// Publicar se guarda el mercado y el siguiente mensaje de texto se toma
	// como cantidad mínima. Caduca a los cinco minutos.
	pendingMu   sync.Mutex
	pendingCoin string
	pendingAt   time.Time

	// Las ediciones de tasa viven en memoria y se aplican sobre el mismo
	// mensaje que abrió el panel del mercado.
	rateMu         sync.Mutex
	rates          *telegrammenu.Sessions
	rateMessageIDs map[string]int64
}

func (runtime *telegramRuntime) Run(ctx context.Context) {
	if err := runtime.inbox.MarkInterruptedUncertain(ctx); err != nil {
		runtime.logger.Error("no se pudo recuperar el inbox de Telegram; polling detenido", "error", err)
		return
	}
	if err := runtime.client.DeleteWebhook(ctx); err != nil {
		runtime.logger.Warn("telegram deleteWebhook falló", "error", err)
	}
	offset := int64(0)
	for {
		if err := runtime.processPending(ctx); err != nil {
			if ctx.Err() != nil {
				return
			}
			runtime.logger.Warn("procesar inbox de Telegram falló", "error", err)
			if !runtime.waitRetry(ctx) {
				return
			}
			continue
		}
		updates, err := runtime.client.GetUpdates(ctx, offset, 30*time.Second)
		if err != nil {
			if ctx.Err() != nil {
				return
			}
			runtime.logger.Warn("telegram getUpdates falló", "error", err)
			if !runtime.waitRetry(ctx) {
				return
			}
			continue
		}
		maxID, stored, err := runtime.inbox.Store(ctx, updates)
		if err != nil {
			runtime.logger.Error("no se pudieron guardar updates de Telegram; se reintentará el mismo offset", "error", err)
			if !runtime.waitRetry(ctx) {
				return
			}
			continue
		}
		if stored && maxID >= offset {
			offset = maxID + 1
		}
	}
}

func (runtime *telegramRuntime) RunWebhookInbox(ctx context.Context) {
	if err := runtime.inbox.MarkInterruptedUncertain(ctx); err != nil {
		runtime.logger.Error("no se pudo recuperar el inbox de Telegram; worker detenido", "error", err)
		return
	}
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	for {
		if err := runtime.processPending(ctx); err != nil && ctx.Err() == nil {
			runtime.logger.Warn("procesar inbox de webhook Telegram falló", "error", err)
		}
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

func (runtime *telegramRuntime) processPending(ctx context.Context) error {
	for {
		id, raw, err := runtime.inbox.Claim(ctx)
		if err != nil {
			return err
		}
		if raw == nil {
			return nil
		}
		update, ok := notifier.ParseUpdate(raw)
		if !ok {
			if err := runtime.inbox.Finish(ctx, id, false); err != nil {
				return err
			}
			runtime.logger.Warn("update de Telegram inválido guardado como incierto", "update_id", id)
			continue
		}
		handled := false
		func() {
			defer func() {
				if recovered := recover(); recovered != nil {
					runtime.logger.Error("panic procesando update Telegram; no se repetirá automáticamente", "update_id", id, "panic", recovered)
				}
			}()
			_, handled = runtime.handle(ctx, update)
		}()
		if err := runtime.inbox.Finish(ctx, id, handled); err != nil {
			return err
		}
		if !handled {
			runtime.logger.Warn("update Telegram finalizado con resultado incierto para evitar repetir acciones", "update_id", id)
		}
	}
}

func (runtime *telegramRuntime) waitRetry(ctx context.Context) bool {
	timer := time.NewTimer(3 * time.Second)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-timer.C:
		return true
	}
}

// handle procesa un update y devuelve la respuesta enviada. El webhook interno
// reutiliza el mismo camino para diagnóstico.
func (runtime *telegramRuntime) handle(ctx context.Context, update notifier.Update) (string, bool) {
	chat := strconv.FormatInt(update.ChatID, 10)
	if update.ChatID != runtime.adminChatID {
		text := "⛔ Chat no autorizado."
		_ = runtime.client.SendMessage(ctx, chat, text)
		return text, true
	}
	if update.CallbackID != "" {
		_ = runtime.client.AnswerCallbackQuery(ctx, update.CallbackID)
	}
	text := update.Text
	viaCallback := false
	if data := update.CallbackData; data != "" {
		if strings.HasPrefix(data, "cmd:") {
			text = "/" + strings.TrimPrefix(data, "cmd:")
			viaCallback = true
		} else {
			reply, keyboard := runtime.handleCallback(ctx, chat, data, update.MessageID)
			if strings.TrimSpace(reply) == "" {
				return "", false
			}
			if err := runtime.deliverMenu(ctx, chat, update.MessageID, reply, keyboard); err != nil {
				runtime.logger.Warn("telegram callback falló", "error", err)
				return reply, false
			}
			return reply, true
		}
	}
	trimmed := strings.TrimSpace(text)
	if trimmed != "" {
		if handled, reply := runtime.handleRateText(ctx, chat, trimmed); handled {
			return reply, true
		}
	}
	if strings.HasPrefix(trimmed, "/") {
		runtime.clearPendingMinimal()
		runtime.cancelRateSession(chat)
	} else if text != "" {
		if reply, keyboard, handled := runtime.consumePendingMinimal(ctx, text); handled {
			if err := runtime.deliverMenu(ctx, chat, 0, reply, keyboard); err != nil {
				runtime.logger.Warn("telegram respuesta de cantidad falló", "error", err)
				return reply, false
			}
			return reply, true
		}
	}
	command, ok := notifier.ParseCommand(text)
	if !ok {
		return "", false
	}
	reply, keyboard := runtime.dispatch(ctx, command)
	if strings.TrimSpace(reply) == "" {
		return "", false
	}
	messageID := int64(0)
	if viaCallback {
		messageID = update.MessageID
	}
	if err := runtime.deliverMenu(ctx, chat, messageID, reply, keyboard); err != nil {
		runtime.logger.Warn("telegram respuesta falló", "error", err)
		return reply, false
	}
	return reply, true
}

func (runtime *telegramRuntime) dispatch(ctx context.Context, command notifier.Command) (string, notifier.InlineKeyboard) {
	name := strings.ToLower(strings.TrimPrefix(command.Name, "/"))
	args := command.Args
	switch name {
	case "start", "panel", "status":
		return runtime.dashboardText(ctx)
	case "help", "ayuda":
		return helpText(), mainMenu()
	case "balance":
		return runtime.balanceText(ctx)
	case "markets", "mercados":
		return runtime.marketsText(ctx)
	case "offers", "ofertas":
		return runtime.offersText(ctx)
	case "operations", "operaciones":
		return runtime.operationsText(ctx)
	case "strategy", "estrategia":
		return runtime.strategyText(ctx)
	case "automation", "automatizacion":
		return runtime.automationText(ctx)
	case "hunting", "caceria", "cacerias", "cacerías":
		return runtime.huntingCommand(ctx, args)
	case "huntbuy":
		if len(args) != 1 {
			return "Uso: /huntbuy on|off", mainMenu()
		}
		enabled, ok := parseOnOff(args[0])
		if !ok {
			return "Uso: /huntbuy on|off", mainMenu()
		}
		return runtime.setGlobalHuntingValue(ctx, "buy", enabled)
	case "huntsell":
		if len(args) != 1 {
			return "Uso: /huntsell on|off", mainMenu()
		}
		enabled, ok := parseOnOff(args[0])
		if !ok {
			return "Uso: /huntsell on|off", mainMenu()
		}
		return runtime.setGlobalHuntingValue(ctx, "sell", enabled)
	case "market", "mercado":
		if len(args) == 0 {
			return runtime.huntingPanel(ctx)
		}
		return runtime.marketPanel(ctx, args[0])
	case "salud":
		return runtime.healthText(ctx)
	case "logs":
		return runtime.logsText(ctx)
	case "pause", "pausar":
		return runtime.control(ctx, true)
	case "resume", "reanudar":
		return runtime.control(ctx, false)
	case "refresh", "refresco":
		return runtime.refresh(ctx, args)
	case "setrate":
		return runtime.setRate(ctx, args)
	case "setlimit":
		return runtime.setMarketNumber(ctx, args, "purchaseMaxQusd", "límite QUSD")
	case "setfee":
		return runtime.setMarketNumber(ctx, args, "sellFeePercent", "comisión %")
	case "fiat":
		return runtime.setMarketNumber(ctx, args, "fiatBalance", "saldo fiat")
	case "paid":
		return runtime.operationAction(ctx, "paid", args)
	case "received":
		return runtime.operationAction(ctx, "received", args)
	case "cancel":
		return runtime.operationAction(ctx, "cancel", args)
	case "editoffer":
		return runtime.editOffer(ctx, args)
	case "canceloffer":
		return runtime.cancelOffer(ctx, args)
	case "createbuy":
		return runtime.createOffer(ctx, "buy", args)
	case "createsell":
		return runtime.createOffer(ctx, "sell", args)
	case "revisions":
		return runtime.revisionsText(ctx)
	case "network":
		return runtime.networkText(ctx)
	case "coop", "conjuntas", "cacerias-conjuntas":
		if len(args) >= 2 {
			return runtime.publishCooperative(ctx, strings.ToUpper(args[0]), args[1])
		}
		if len(args) == 1 {
			return runtime.cooperativePanelWith(ctx, "")
		}
		return runtime.cooperativePanel(ctx)
	case "historial":
		return runtime.historyText(ctx)
	default:
		return "❓ Comando no reconocido.\n\n" + helpText(), mainMenu()
	}
}

func mainMenu() notifier.InlineKeyboard {
	return notifier.InlineKeyboard{
		{{Text: "🎯 Cacerías", CallbackData: "nav:hunting"}},
		{{Text: "📦 Operaciones", CallbackData: "nav:operations"}, {Text: "💼 Ofertas", CallbackData: "nav:offers"}},
		{{Text: "💰 Balance", CallbackData: "cmd:balance"}, {Text: "📊 Estado", CallbackData: "cmd:status"}},
		{{Text: "🔎 Mercados", CallbackData: "nav:markets"}, {Text: "🤝 Conjuntas", CallbackData: "nav:coop"}},
		{{Text: "⚙️ Estrategia", CallbackData: "cmd:strategy"}, {Text: "🤖 Automatización", CallbackData: "cmd:automation"}},
		{{Text: "❓ Ayuda", CallbackData: "cmd:help"}},
	}
}

func helpText() string {
	return `🤖 Bot QvaApply (Go)

Panel y lectura:
/status · /balance · /markets · /offers
/operations · /strategy · /automation · /hunting
/coop · /coop MERCADO MÍNIMO
/salud · /logs · /revisions · /network · /historial

Cacerías:
/hunting · /market MERCADO
🎯 Cacerías → mercado → ✏️ precio (compra/venta)
/huntbuy on|off · /huntsell on|off

Control:
/pause · /resume
/refresh on|off

Configuración:
/setrate MERCADO buy|sell TASA
/setlimit MERCADO QUSD
/setfee MERCADO PORCENTAJE
/fiat MERCADO IMPORTE

Operaciones:
/paid UUID REFERENCIA
/received UUID
/cancel UUID
/editoffer UUID IMPORTE RECIBE
/canceloffer UUID
/createbuy MONEDA IMPORTE TASA
/createsell MONEDA IMPORTE TASA

Solo el chat administrador puede ejecutar comandos.`
}

func (runtime *telegramRuntime) dashboardText(ctx context.Context) (string, notifier.InlineKeyboard) {
	dashboard, err := runtime.edge.dashboard(ctx)
	if err != nil {
		return "❌ No se pudo leer el panel: " + err.Error(), mainMenu()
	}
	config, _ := runtime.edge.config(ctx)
	text := fmt.Sprintf(`📊 QvaApply

💰 QUSD disponible: %s
💼 Ofertas propias: %d
📦 Operaciones: %d
🔄 Transacciones: %d

🎯 Cacería compra: %s
🎯 Cacería venta: %s`,
		money(asFloat(dashboard["balance"])),
		len(asList(dashboard["ownOffers"])),
		len(asList(dashboard["operations"])),
		len(asList(dashboard["transactions"])),
		statusWord(boolValue(config, "buyRunning")),
		statusWord(boolValue(config, "sellRunning")),
	)
	return text, mainMenu()
}

func (runtime *telegramRuntime) balanceText(ctx context.Context) (string, notifier.InlineKeyboard) {
	dashboard, err := runtime.edge.dashboard(ctx)
	if err != nil {
		return "❌ " + err.Error(), mainMenu()
	}
	config, err := runtime.edge.config(ctx)
	if err != nil {
		return "❌ " + err.Error(), mainMenu()
	}
	var builder strings.Builder
	fmt.Fprintf(&builder, "💰 QUSD: %s\n\n", money(asFloat(dashboard["balance"])))
	for _, item := range asList(config["markets"]) {
		market := asMap(item)
		fmt.Fprintf(&builder, "• %s (%s): %s %s\n",
			asString(market["label"]), asString(market["code"]),
			money(asFloat(market["fiatBalance"])), asString(market["currency"]))
	}
	return builder.String(), mainMenu()
}

func (runtime *telegramRuntime) marketsText(ctx context.Context) (string, notifier.InlineKeyboard) {
	config, err := runtime.edge.config(ctx)
	if err != nil {
		return "❌ " + err.Error(), mainMenu()
	}
	var builder strings.Builder
	builder.WriteString("🔎 Mercados\n\n")
	for index, item := range asList(config["markets"]) {
		if index >= 10 {
			break
		}
		market := asMap(item)
		icon := "⚪"
		if asBool(market["active"]) {
			icon = "🟢"
		}
		fmt.Fprintf(&builder, "%s %s (%s)\n  compra ≤ %s · venta ≥ %s\n  máx %s QUSD · fee %s%% · fiat %s %s\n\n",
			icon, asString(market["label"]), asString(market["code"]),
			rateText(asFloat(market["buyMaxRate"])), rateText(asFloat(market["sellMinRate"])),
			money(asFloat(market["purchaseMaxQusd"])), money(asFloat(market["sellFeePercent"])),
			money(asFloat(market["fiatBalance"])), asString(market["currency"]))
	}
	return builder.String(), mainMenu()
}

func (runtime *telegramRuntime) offersText(ctx context.Context) (string, notifier.InlineKeyboard) {
	dashboard, err := runtime.edge.dashboard(ctx)
	if err != nil {
		return "❌ " + err.Error(), mainMenu()
	}
	offers := asList(dashboard["ownOffers"])
	if len(offers) == 0 {
		return "💼 No hay ofertas propias abiertas.", mainMenu()
	}
	var builder strings.Builder
	builder.WriteString("💼 Ofertas propias\n\n")
	for index, item := range offers {
		if index >= 8 {
			break
		}
		offer := asMap(item)
		fmt.Fprintf(&builder, "%d. %s · %s\n   %s %s QUSD · tasa %s\n   %s\n",
			index+1, asString(offer["uuid"]), asString(offer["coin"]),
			asString(offer["type"]), money(asFloat(offer["amount"])), money(asFloat(offer["rate"])),
			asString(offer["status"]))
	}
	builder.WriteString("\nUsa /editoffer UUID IMPORTE RECIBE o /canceloffer UUID.")
	return builder.String(), mainMenu()
}

func (runtime *telegramRuntime) operationsText(ctx context.Context) (string, notifier.InlineKeyboard) {
	dashboard, err := runtime.edge.dashboard(ctx)
	if err != nil {
		return "❌ " + err.Error(), mainMenu()
	}
	operations := asList(dashboard["operations"])
	if len(operations) == 0 {
		return "📦 No hay operaciones.", mainMenu()
	}
	var builder strings.Builder
	builder.WriteString("📦 Operaciones recientes\n\n")
	for index, item := range operations {
		if index >= 8 {
			break
		}
		operation := asMap(item)
		fmt.Fprintf(&builder, "%d. %s · %s\n   %s QUSD · %s\n   estado: %s\n",
			index+1, asString(operation["uuid"]), asString(operation["coin"]),
			money(asFloat(operation["amount"])), money(asFloat(operation["receive"])),
			asString(operation["state"]))
	}
	builder.WriteString("\n/paid UUID REF · /received UUID · /cancel UUID")
	return builder.String(), mainMenu()
}

func (runtime *telegramRuntime) strategyText(ctx context.Context) (string, notifier.InlineKeyboard) {
	config, err := runtime.edge.config(ctx)
	if err != nil {
		return "❌ " + err.Error(), mainMenu()
	}
	var builder strings.Builder
	builder.WriteString("⚙️ Estrategia\n\n")
	for index, item := range asList(config["markets"]) {
		if index >= 10 {
			break
		}
		market := asMap(item)
		fmt.Fprintf(&builder, "• %s: compra ≤ %s · venta ≥ %s · fiat %s %s\n",
			asString(market["label"]), rateText(asFloat(market["buyMaxRate"])),
			rateText(asFloat(market["sellMinRate"])), money(asFloat(market["fiatBalance"])),
			asString(market["currency"]))
	}
	risk := asMap(config["risk"])
	fmt.Fprintf(&builder, "\n🛡 Reserva: %s QUSD\n📈 Máx por operación: %s QUSD\n📅 Máx diario: %s QUSD",
		money(asFloat(config["qusdReserve"])), money(asFloat(risk["maxQusdPerOperation"])),
		money(asFloat(risk["maxDailyAppliedQusd"])))
	return builder.String(), mainMenu()
}

func (runtime *telegramRuntime) automationText(ctx context.Context) (string, notifier.InlineKeyboard) {
	config, err := runtime.edge.config(ctx)
	if err != nil {
		return "❌ " + err.Error(), mainMenu()
	}
	automation := asMap(config["automation"])
	risk := asMap(config["risk"])
	text := fmt.Sprintf(`🤖 Automatización

Escaneo: %s s
Auto-cancelación: %s min
Refresco de ofertas: %s min
Espaciado: %s s
Guardián de precio: %s %%
Operaciones simultáneas: %s
Errores consecutivos: %s`,
		money(asFloat(automation["scanIntervalSeconds"])),
		money(asFloat(automation["autoCancelMinutes"])),
		money(asFloat(automation["offerRefreshIntervalMinutes"])),
		money(asFloat(automation["offerRefreshSpacingSeconds"])),
		money(asFloat(automation["priceGuardPercent"])),
		money(asFloat(risk["maxConcurrentOperations"])),
		money(asFloat(risk["maxConsecutiveErrors"])))
	return text, mainMenu()
}

func (runtime *telegramRuntime) huntingCommand(ctx context.Context, args []string) (string, notifier.InlineKeyboard) {
	if len(args) >= 2 {
		if side, ok := normalizeSide(args[0]); ok {
			if enabled, ok := parseOnOff(args[1]); ok {
				return runtime.setGlobalHuntingValue(ctx, side, enabled)
			}
		}
	}
	if len(args) >= 3 {
		if side, ok := normalizeSide(args[1]); ok {
			if enabled, ok := parseOnOff(args[2]); ok {
				return runtime.setMarketHuntingValue(ctx, strings.ToUpper(args[0]), side, enabled)
			}
		}
	}
	if len(args) > 0 {
		return "Uso: /hunting [buy|sell on|off | MERCADO buy|sell on|off]", mainMenu()
	}
	return runtime.huntingPanel(ctx)
}

func (runtime *telegramRuntime) huntingPanel(ctx context.Context) (string, notifier.InlineKeyboard) {
	return runtime.huntingPanelWith(ctx, "")
}

func (runtime *telegramRuntime) huntingPanelWith(ctx context.Context, notice string) (string, notifier.InlineKeyboard) {
	config, err := runtime.edge.config(ctx)
	if err != nil {
		return "❌ " + err.Error(), mainMenu()
	}
	dashboard, _ := runtime.edge.dashboard(ctx)
	averages := asMap(dashboard["averages"])
	hunting := asMap(config["hunting"])
	buyRunning := asBool(hunting["buyRunning"])
	sellRunning := asBool(hunting["sellRunning"])
	var builder strings.Builder
	builder.WriteString("🎯 Cacerías automáticas\n\n")
	fmt.Fprintf(&builder, "🌐 Compra global: %s\n🌐 Venta global: %s\n\n",
		statusWord(buyRunning), statusWord(sellRunning))
	markets := asList(config["markets"])
	for index, item := range markets {
		if index >= 5 {
			break
		}
		market := asMap(item)
		code := asString(market["code"])
		average := asMap(averages[code])
		icon := "⚪"
		if asBool(market["active"]) {
			icon = "🟢"
		}
		fmt.Fprintf(&builder, "%s %s\n", icon, asString(market["label"]))
		fmt.Fprintf(&builder, "   🔵 %s · ≤ %s · media %s\n",
			effectiveStatus(market, "huntBuyEnabled", buyRunning),
			rateText(asFloat(market["buyMaxRate"])), averageText(average["averageBuy"]))
		fmt.Fprintf(&builder, "   🟢 %s · ≥ %s · media %s\n\n",
			effectiveStatus(market, "huntSellEnabled", sellRunning),
			rateText(asFloat(market["sellMinRate"])), averageText(average["averageSell"]))
	}
	builder.WriteString("Toca un mercado para ajustar precios o pausar sus cacerías.")
	if notice != "" {
		builder.WriteString("\n\n")
		builder.WriteString(notice)
	}
	keyboard := notifier.InlineKeyboard{
		{
			{Text: toggleLabel("compra", buyRunning), CallbackData: "hunt:global:buy:" + toggleValue(buyRunning)},
			{Text: toggleLabel("venta", sellRunning), CallbackData: "hunt:global:sell:" + toggleValue(sellRunning)},
		},
	}
	for index, item := range markets {
		if index >= 5 {
			break
		}
		market := asMap(item)
		icon := "⚪"
		if asBool(market["active"]) {
			icon = "🟢"
		}
		keyboard = append(keyboard, []notifier.InlineButton{{
			Text: icon + " " + asString(market["label"]), CallbackData: "hunt:" + asString(market["code"]),
		}})
	}
	keyboard = append(keyboard, []notifier.InlineButton{{Text: "‹ Volver al panel", CallbackData: "nav:main"}})
	return builder.String(), keyboard
}

func (runtime *telegramRuntime) marketPanel(ctx context.Context, code string) (string, notifier.InlineKeyboard) {
	return runtime.marketPanelWith(ctx, code, "")
}

func (runtime *telegramRuntime) marketPanelWith(ctx context.Context, code, notice string) (string, notifier.InlineKeyboard) {
	config, err := runtime.edge.config(ctx)
	if err != nil {
		return "❌ " + err.Error(), mainMenu()
	}
	market := findMarket(config, strings.ToUpper(strings.TrimSpace(code)))
	if market == nil {
		return "❌ Mercado no configurado: " + code, mainMenu()
	}
	dashboard, _ := runtime.edge.dashboard(ctx)
	averages := asMap(dashboard["averages"])
	average := asMap(averages[asString(market["code"])])
	hunting := asMap(config["hunting"])
	buyRunning := asBool(hunting["buyRunning"])
	sellRunning := asBool(hunting["sellRunning"])
	buyEnabled := asBool(market["huntBuyEnabled"])
	sellEnabled := asBool(market["huntSellEnabled"])
	currency := asString(market["currency"])
	marketCode := asString(market["code"])
	var builder strings.Builder
	marketState := "inactivo"
	if asBool(market["active"]) {
		marketState = "activo"
	}
	fmt.Fprintf(&builder, "🎯 Cacería · %s\n", asString(market["label"]))
	fmt.Fprintf(&builder, "Mercado: %s · %s\n\n", marketState, currency)
	fmt.Fprintf(&builder, "🔵 Compra: %s\n   Máximo %s %s/QUSD · media %s\n",
		effectiveStatus(market, "huntBuyEnabled", buyRunning),
		rateText(asFloat(market["buyMaxRate"])), currency, averageText(average["averageBuy"]))
	fmt.Fprintf(&builder, "🟢 Venta: %s\n   Mínimo %s %s/QUSD · media %s\n\n",
		effectiveStatus(market, "huntSellEnabled", sellRunning),
		rateText(asFloat(market["sellMinRate"])), currency, averageText(average["averageSell"]))
	fmt.Fprintf(&builder, "Fiat: %s %s · Máx %s QUSD · Fee %s%%\n",
		money(asFloat(market["fiatBalance"])), currency,
		money(asFloat(market["purchaseMaxQusd"])), money(asFloat(market["sellFeePercent"])))
	builder.WriteString("Global: compra ")
	builder.WriteString(statusWord(buyRunning))
	builder.WriteString(" · venta ")
	builder.WriteString(statusWord(sellRunning))
	if notice != "" {
		builder.WriteString("\n\n")
		builder.WriteString(notice)
	}
	keyboard := notifier.InlineKeyboard{
		{
			{Text: toggleLabel("compra", buyEnabled), CallbackData: "hunt:" + marketCode + ":buy:" + toggleValue(buyEnabled)},
			{Text: toggleLabel("venta", sellEnabled), CallbackData: "hunt:" + marketCode + ":sell:" + toggleValue(sellEnabled)},
		},
		{{Text: "✏️ Máximo de compra", CallbackData: "hunt:e:buy:" + marketCode}},
		{{Text: "✏️ Mínimo de venta", CallbackData: "hunt:e:sell:" + marketCode}},
		{
			{Text: "‹ Volver a cacerías", CallbackData: "nav:hunting"},
			{Text: "‹ Volver al panel", CallbackData: "nav:main"},
		},
	}
	return builder.String(), keyboard
}

func (runtime *telegramRuntime) handleCallback(
	ctx context.Context,
	chat, data string,
	messageID int64,
) (string, notifier.InlineKeyboard) {
	if !strings.HasPrefix(data, "hunt:y:") &&
		!strings.HasPrefix(data, "hunt:n:") &&
		!strings.HasPrefix(data, "hunt:e:") {
		runtime.cancelRateSession(chat)
	}
	switch data {
	case "nav:main":
		return runtime.dashboardText(ctx)
	case "nav:hunting":
		return runtime.huntingPanel(ctx)
	case "nav:markets":
		return runtime.marketsText(ctx)
	case "nav:offers":
		return runtime.offersText(ctx)
	case "nav:operations":
		return runtime.operationsText(ctx)
	case "nav:coop":
		return runtime.cooperativePanel(ctx)
	}
	if strings.HasPrefix(data, "coop:") {
		parts := strings.Split(data, ":")
		if len(parts) == 2 && parts[1] == "refresh" {
			return runtime.cooperativePanelWith(ctx, "Red actualizada.")
		}
		if len(parts) == 3 {
			coin := strings.ToUpper(strings.TrimSpace(parts[2]))
			switch parts[1] {
			case "publish":
				return runtime.requestMinimal(ctx, coin)
			case "withdraw":
				return runtime.withdrawCooperative(ctx, coin)
			}
		}
		return "❌ Acción cooperativa inválida.", mainMenu()
	}
	if strings.HasPrefix(data, "hunt:") {
		parts := strings.Split(data, ":")
		if len(parts) == 2 {
			return runtime.marketPanel(ctx, parts[1])
		}
		if len(parts) == 3 && parts[1] == "y" {
			return runtime.confirmRate(ctx, chat, parts[2])
		}
		if len(parts) == 3 && parts[1] == "n" {
			return runtime.cancelRate(ctx, chat, parts[2])
		}
		if len(parts) == 4 && parts[1] == "e" {
			return runtime.beginRateEdit(ctx, chat, messageID, parts[3], parts[2])
		}
		if len(parts) == 4 {
			enabled, ok := parseOnOff(parts[3])
			if !ok {
				return "❌ Acción inválida.", mainMenu()
			}
			if parts[1] == "global" {
				return runtime.setGlobalHuntingValue(ctx, parts[2], enabled)
			}
			return runtime.setMarketHuntingValue(ctx, strings.ToUpper(parts[1]), parts[2], enabled)
		}
	}
	return "", nil
}

func (runtime *telegramRuntime) setGlobalHuntingValue(ctx context.Context, side string, enabled bool) (string, notifier.InlineKeyboard) {
	body := map[string]any{}
	switch side {
	case "buy":
		body["buyRunning"] = enabled
	case "sell":
		body["sellRunning"] = enabled
	default:
		return "❌ Lado inválido.", mainMenu()
	}
	if err := runtime.edge.send(ctx, http.MethodPut, "/api/hunting", body); err != nil {
		return "❌ " + err.Error(), mainMenu()
	}
	label := "Compra"
	if side == "sell" {
		label = "Venta"
	}
	return runtime.huntingPanelWith(ctx, fmt.Sprintf("✅ %s global %s.", label, statusWord(enabled)))
}

func (runtime *telegramRuntime) setMarketHuntingValue(ctx context.Context, code, side string, enabled bool) (string, notifier.InlineKeyboard) {
	market := map[string]any{"code": code}
	switch side {
	case "buy":
		market["huntBuyEnabled"] = enabled
	case "sell":
		market["huntSellEnabled"] = enabled
	default:
		return "❌ Lado inválido.", mainMenu()
	}
	if err := runtime.edge.send(ctx, http.MethodPut, "/api/hunting", map[string]any{"market": market}); err != nil {
		return "❌ " + err.Error(), mainMenu()
	}
	label := "Compra"
	if side == "sell" {
		label = "Venta"
	}
	return runtime.marketPanelWith(ctx, code, fmt.Sprintf("✅ %s %s.", label, statusWord(enabled)))
}

// cooperativePanel muestra el estado del sincronizador y los mercados con su
// precio de compra y fiat disponible. Publicar solo pedirá la cantidad mínima.
func (runtime *telegramRuntime) cooperativePanel(ctx context.Context) (string, notifier.InlineKeyboard) {
	return runtime.cooperativePanelWith(ctx, "")
}

func (runtime *telegramRuntime) cooperativePanelWith(ctx context.Context, notice string) (string, notifier.InlineKeyboard) {
	dashboard, err := runtime.edge.dashboard(ctx)
	if err != nil {
		return "❌ " + err.Error(), mainMenu()
	}
	config, err := runtime.edge.config(ctx)
	if err != nil {
		return "❌ " + err.Error(), mainMenu()
	}
	network := asMap(dashboard["cooperativeNetwork"])
	enabled := asBool(network["enabled"])
	connected := asBool(network["httpConnected"])
	contributions := asMap(network["contributions"])
	lastError := asString(network["lastError"])

	var builder strings.Builder
	builder.WriteString("🤝 Cacerías conjuntas\n\n")
	switch {
	case !enabled:
		builder.WriteString("⚠️ Sincronizador sin configurar (SYNC_*).\n")
	case connected:
		builder.WriteString("🟢 Conectado al sincronizador.\n")
	default:
		builder.WriteString("🟠 Sin conexión con el sincronizador.\n")
		if lastError != "" {
			fmt.Fprintf(&builder, "%s\n", truncate(lastError, 180))
		}
	}
	if connected {
		builder.WriteString("El precio es tu compra configurada; el fiat es el saldo del mercado.\n")
	}
	builder.WriteString("\n")

	markets := asList(config["markets"])
	keyboard := notifier.InlineKeyboard{}
	for index, item := range markets {
		if index >= 5 {
			break
		}
		market := asMap(item)
		code := asString(market["code"])
		if code == "" || !asBool(market["active"]) {
			continue
		}
		current := asMap(contributions[code])
		published := asString(current["coin"]) != ""
		price := asFloat(market["buyMaxRate"])
		fiat := asFloat(market["fiatBalance"])
		currency := asString(market["currency"])
		icon := "⚪"
		if published {
			icon = "🟢"
		}
		fmt.Fprintf(&builder, "%s %s (%s)\n", icon, asString(market["label"]), code)
		fmt.Fprintf(&builder, "• Precio de compra: %s %s/QUSD\n", rateText(price), currency)
		fmt.Fprintf(&builder, "• Fiat disponible: %s %s\n", money(fiat), currency)
		if published {
			fmt.Fprintf(&builder, "• Publicado desde %s QUSD · precio %s\n",
				money(asFloat(current["minimal"])), rateText(asFloat(current["price"])))
		} else {
			builder.WriteString("• Sin publicar\n")
		}
		builder.WriteString("\n")
		label := asString(market["label"])
		if published {
			keyboard = append(keyboard, []notifier.InlineButton{{
				Text: "🔴 Retirar " + label, CallbackData: "coop:withdraw:" + code,
			}})
		} else {
			keyboard = append(keyboard, []notifier.InlineButton{{
				Text: "🟢 Publicar " + label, CallbackData: "coop:publish:" + code,
			}})
		}
	}
	if len(keyboard) == 0 {
		builder.WriteString("No hay mercados activos configurados.\n")
	}
	if notice != "" {
		builder.WriteString(notice)
		builder.WriteString("\n")
	}
	keyboard = append(keyboard, []notifier.InlineButton{
		{Text: "🔄 Actualizar red", CallbackData: "coop:refresh"},
		{Text: "‹ Volver al panel", CallbackData: "nav:main"},
	})
	return builder.String(), keyboard
}

// requestMinimal pide solo la cantidad mínima y guarda el mercado pendiente.
func (runtime *telegramRuntime) requestMinimal(ctx context.Context, coin string) (string, notifier.InlineKeyboard) {
	config, err := runtime.edge.config(ctx)
	if err != nil {
		return "❌ " + err.Error(), mainMenu()
	}
	market := findMarket(config, coin)
	if market == nil {
		return "❌ Mercado no configurado: " + coin, mainMenu()
	}
	price := asFloat(market["buyMaxRate"])
	fiat := asFloat(market["fiatBalance"])
	if price <= 0 || fiat < 5*price {
		return runtime.cooperativePanelWith(ctx, fmt.Sprintf(
			"❌ %s necesita más de %s %s para aportar 5 QUSD al precio de compra.",
			coin, money(5*price), asString(market["currency"])))
	}
	runtime.pendingMu.Lock()
	runtime.pendingCoin = coin
	runtime.pendingAt = time.Now()
	runtime.pendingMu.Unlock()
	text := fmt.Sprintf("🤝 Publicar en %s\n\nPrecio de compra: %s %s/QUSD\nFiat disponible: %s %s\n\nEscribe solo la cantidad mínima en QUSD que aceptas. Ejemplo: 5",
		asString(market["label"]), rateText(price), asString(market["currency"]),
		money(fiat), asString(market["currency"]))
	return text, notifier.InlineKeyboard{
		{{Text: "‹ Cancelar", CallbackData: "nav:coop"}},
	}
}

// consumePendingMinimal interpreta el siguiente mensaje de texto como la
// cantidad mínima de la publicación pendiente.
func (runtime *telegramRuntime) consumePendingMinimal(ctx context.Context, text string) (string, notifier.InlineKeyboard, bool) {
	runtime.pendingMu.Lock()
	coin := runtime.pendingCoin
	at := runtime.pendingAt
	runtime.pendingMu.Unlock()
	if coin == "" {
		return "", nil, false
	}
	if time.Since(at) > 5*time.Minute {
		runtime.clearPendingMinimal()
		return "⌛ La publicación caducó. Pulsa Publicar de nuevo.", mainMenu(), true
	}
	value := strings.TrimSpace(strings.ReplaceAll(text, ",", "."))
	minimal, err := strconv.ParseFloat(value, 64)
	if err != nil || minimal <= 0 || mathIsNotFinite(minimal) {
		return "❌ Cantidad mínima inválida. Escribe un número mayor que 0 o pulsa Cancelar.", notifier.InlineKeyboard{
			{{Text: "‹ Cancelar", CallbackData: "nav:coop"}},
		}, true
	}
	runtime.clearPendingMinimal()
	reply, keyboard := runtime.publishCooperative(ctx, coin, value)
	return reply, keyboard, true
}

func (runtime *telegramRuntime) publishCooperative(ctx context.Context, coin, rawMinimal string) (string, notifier.InlineKeyboard) {
	value := strings.TrimSpace(strings.ReplaceAll(rawMinimal, ",", "."))
	minimal, err := strconv.ParseFloat(value, 64)
	if err != nil || minimal <= 0 || mathIsNotFinite(minimal) {
		return "❌ Cantidad mínima inválida.", mainMenu()
	}
	market := map[string]any{}
	if config, configErr := runtime.edge.config(ctx); configErr == nil {
		if found := findMarket(config, strings.ToUpper(coin)); found != nil {
			market = found
		}
	}
	if err := runtime.edge.send(ctx, http.MethodPut,
		"/api/cooperative-network/contributions",
		map[string]any{"coin": strings.ToUpper(coin), "minimal": minimal},
	); err != nil {
		return runtime.cooperativePanelWith(ctx, "❌ "+err.Error())
	}
	return runtime.cooperativePanelWith(ctx, fmt.Sprintf(
		"✅ Publicado en %s · mínimo %s QUSD · precio %s %s · fiat %s %s",
		strings.ToUpper(coin), money(minimal),
		rateText(asFloat(market["buyMaxRate"])), asString(market["currency"]),
		money(asFloat(market["fiatBalance"])), asString(market["currency"])))
}

func (runtime *telegramRuntime) withdrawCooperative(ctx context.Context, coin string) (string, notifier.InlineKeyboard) {
	if err := runtime.edge.send(ctx, http.MethodDelete,
		"/api/cooperative-network/contributions/"+strings.ToUpper(coin), nil,
	); err != nil {
		return runtime.cooperativePanelWith(ctx, "❌ "+err.Error())
	}
	return runtime.cooperativePanelWith(ctx, "✅ Retirado de "+strings.ToUpper(coin)+".")
}

func (runtime *telegramRuntime) clearPendingMinimal() {
	runtime.pendingMu.Lock()
	runtime.pendingCoin = ""
	runtime.pendingAt = time.Time{}
	runtime.pendingMu.Unlock()
}

func mathIsNotFinite(value float64) bool {
	return value != value || value > 1e12 || value < -1e12
}

func normalizeSide(value string) (string, bool) {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "buy", "compra":
		return "buy", true
	case "sell", "venta":
		return "sell", true
	default:
		return "", false
	}
}

func parseOnOff(value string) (bool, bool) {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "on", "si", "sí", "true", "1", "activar", "activa":
		return true, true
	case "off", "no", "false", "0", "detener", "detenida":
		return false, true
	default:
		return false, false
	}
}

func statusWord(enabled bool) string {
	if enabled {
		return "activa"
	}
	return "detenida"
}

func effectiveStatus(market map[string]any, key string, global bool) string {
	if !asBool(market[key]) {
		return "detenida"
	}
	if !global {
		return "detenida (global)"
	}
	return "activa"
}

func toggleLabel(label string, enabled bool) string {
	if enabled {
		return "⏸ Detener " + label
	}
	return "▶️ Activar " + label
}

func toggleValue(enabled bool) string {
	if enabled {
		return "off"
	}
	return "on"
}

func averageText(value any) string {
	number := asFloat(value)
	if number <= 0 {
		return "sin observación"
	}
	return rateText(number)
}

func countText(value any) string {
	number := asFloat(value)
	if number <= 0 {
		return "sin"
	}
	return strconv.FormatFloat(number, 'f', 0, 64)
}

func (runtime *telegramRuntime) healthText(ctx context.Context) (string, notifier.InlineKeyboard) {
	dashboard, err := runtime.edge.dashboard(ctx)
	if err != nil {
		return "❌ " + err.Error(), mainMenu()
	}
	freshness := asMap(dashboard["freshness"])
	alerts := asList(dashboard["alerts"])
	text := fmt.Sprintf("🩺 Salud\n\nAlertas: %d\nFrescura de balance: %s\nFrescura de ofertas: %s\nFrescura de mercado: %s",
		len(alerts), timestamp(asFloat(freshness["balance"])),
		timestamp(asFloat(freshness["ownOffers"])), timestamp(asFloat(freshness["market"])))
	return text, mainMenu()
}

func (runtime *telegramRuntime) logsText(ctx context.Context) (string, notifier.InlineKeyboard) {
	logs, err := runtime.edge.logs(ctx)
	if err != nil {
		return "❌ " + err.Error(), mainMenu()
	}
	if len(logs) == 0 {
		return "📝 Sin logs recientes.", mainMenu()
	}
	var builder strings.Builder
	builder.WriteString("📝 Últimos logs\n\n")
	for index, item := range logs {
		if index >= 5 {
			break
		}
		encoded, _ := json.Marshal(item)
		fmt.Fprintf(&builder, "%d. %s\n", index+1, truncate(string(encoded), 280))
	}
	return builder.String(), mainMenu()
}

func (runtime *telegramRuntime) revisionsText(ctx context.Context) (string, notifier.InlineKeyboard) {
	var envelope struct {
		Data []any `json:"data"`
	}
	if err := runtime.edge.do(ctx, http.MethodGet, "/api/config-revisions?limit=5", nil, &envelope); err != nil {
		return "❌ " + err.Error(), mainMenu()
	}
	var builder strings.Builder
	builder.WriteString("🧾 Revisiones de configuración\n\n")
	for index, item := range envelope.Data {
		if index >= 5 {
			break
		}
		revision := asMap(item)
		fmt.Fprintf(&builder, "v%s · %s · %s\n", asString(revision["version"]),
			asString(revision["source"]), asString(revision["reason"]))
	}
	return builder.String(), mainMenu()
}

func (runtime *telegramRuntime) networkText(ctx context.Context) (string, notifier.InlineKeyboard) {
	dashboard, err := runtime.edge.dashboard(ctx)
	if err != nil {
		return "❌ " + err.Error(), mainMenu()
	}
	network := asMap(dashboard["cooperativeNetwork"])
	encoded, _ := json.Marshal(network)
	return "🌐 Red cooperativa\n\n" + truncate(string(encoded), 3500), mainMenu()
}

func (runtime *telegramRuntime) historyText(ctx context.Context) (string, notifier.InlineKeyboard) {
	dashboard, err := runtime.edge.dashboard(ctx)
	if err != nil {
		return "❌ " + err.Error(), mainMenu()
	}
	history := asList(dashboard["history"])
	if len(history) == 0 {
		return "📈 Sin historial.", mainMenu()
	}
	var builder strings.Builder
	builder.WriteString("📈 Historial\n\n")
	for index, item := range history {
		if index >= 6 {
			break
		}
		entry := asMap(item)
		fmt.Fprintf(&builder, "• %s · balance %s · ofertas %s\n",
			timestamp(asFloat(entry["createdAt"])), money(asFloat(entry["qusdBalance"])),
			money(asFloat(entry["openOffers"])))
	}
	return builder.String(), mainMenu()
}

func (runtime *telegramRuntime) control(ctx context.Context, paused bool) (string, notifier.InlineKeyboard) {
	if err := runtime.edge.send(ctx, http.MethodPut, "/api/control", map[string]any{"paused": paused}); err != nil {
		return "❌ " + err.Error(), mainMenu()
	}
	if paused {
		return "⏸ Automatización pausada.", mainMenu()
	}
	return "▶️ Automatización reanudada.", mainMenu()
}

func (runtime *telegramRuntime) refresh(ctx context.Context, args []string) (string, notifier.InlineKeyboard) {
	if len(args) == 0 {
		return "🔄 Refresco automático activo (4 min por oferta, 10 s de espaciado).\nUsa /refresh on u /refresh off para cambiarlo.", mainMenu()
	}
	switch strings.ToLower(args[0]) {
	case "on", "si", "sí", "true":
		if err := runtime.edge.send(ctx, http.MethodPut, "/api/control", map[string]any{"refresh": true}); err != nil {
			return "❌ " + err.Error(), mainMenu()
		}
		return "🔄 Refresco de ofertas activado.", mainMenu()
	case "off", "no", "false":
		if err := runtime.edge.send(ctx, http.MethodPut, "/api/control", map[string]any{"refresh": false}); err != nil {
			return "❌ " + err.Error(), mainMenu()
		}
		return "⏹ Refresco de ofertas desactivado.", mainMenu()
	default:
		return "Uso: /refresh on|off", mainMenu()
	}
}

func (runtime *telegramRuntime) setRate(ctx context.Context, args []string) (string, notifier.InlineKeyboard) {
	if len(args) != 3 {
		return "Uso: /setrate MERCADO buy|sell TASA", nil
	}
	code := strings.ToUpper(strings.TrimSpace(args[0]))
	side := strings.ToLower(strings.TrimSpace(args[1]))
	rate, err := strconv.ParseFloat(strings.ReplaceAll(args[2], ",", "."), 64)
	if err != nil || rate <= 0 {
		return "❌ Tasa inválida.", nil
	}
	market := map[string]any{"code": code}
	switch side {
	case "buy", "compra":
		market["buyMaxRate"] = rate
	case "sell", "venta":
		market["sellMinRate"] = rate
	default:
		return "Uso: /setrate MERCADO buy|sell TASA", nil
	}
	if err := runtime.edge.send(ctx, http.MethodPut, "/api/hunting", map[string]any{"market": market}); err != nil {
		return "❌ " + err.Error(), nil
	}
	return fmt.Sprintf("✅ %s: %s actualizado a %s.", code, side, rateText(rate)), nil
}

func (runtime *telegramRuntime) setMarketNumber(ctx context.Context, args []string, field, label string) (string, notifier.InlineKeyboard) {
	if len(args) != 2 {
		return fmt.Sprintf("Uso: /%s MERCADO IMPORTE", strings.ToLower(label)), mainMenu()
	}
	code := strings.ToUpper(strings.TrimSpace(args[0]))
	value, err := strconv.ParseFloat(strings.ReplaceAll(args[1], ",", "."), 64)
	if err != nil || value < 0 {
		return "❌ Importe inválido.", mainMenu()
	}
	config, err := runtime.edge.config(ctx)
	if err != nil {
		return "❌ " + err.Error(), mainMenu()
	}
	market := findMarket(config, code)
	if market == nil {
		return "❌ Mercado no configurado: " + code, mainMenu()
	}
	market[field] = value
	if err := runtime.edge.send(ctx, http.MethodPut, "/api/config", map[string]any{
		"config": config, "reason": "Telegram " + label,
	}); err != nil {
		return "❌ " + err.Error(), mainMenu()
	}
	return fmt.Sprintf("✅ %s: %s = %s.", code, label, money(value)), nil
}

func (runtime *telegramRuntime) operationAction(ctx context.Context, action string, args []string) (string, notifier.InlineKeyboard) {
	if len(args) == 0 {
		return "Uso: /" + action + " UUID [REFERENCIA]", mainMenu()
	}
	uuid := strings.TrimSpace(args[0])
	path := "/api/operations/" + uuid + "/" + action
	body := map[string]any{}
	switch action {
	case "paid":
		if len(args) < 2 {
			return "Uso: /paid UUID REFERENCIA", mainMenu()
		}
		body["reference"] = strings.TrimSpace(args[1])
	case "cancel":
		if len(args) >= 2 {
			path += "?order=" + strings.TrimSpace(args[1])
		}
	}
	if err := runtime.edge.send(ctx, http.MethodPost, path, body); err != nil {
		return "❌ " + err.Error(), mainMenu()
	}
	return "✅ Acción " + action + " aplicada.", mainMenu()
}

func (runtime *telegramRuntime) editOffer(ctx context.Context, args []string) (string, notifier.InlineKeyboard) {
	if len(args) != 3 {
		return "Uso: /editoffer UUID IMPORTE RECIBE", mainMenu()
	}
	amount, err1 := strconv.ParseFloat(strings.ReplaceAll(args[1], ",", "."), 64)
	receive, err2 := strconv.ParseFloat(strings.ReplaceAll(args[2], ",", "."), 64)
	if err1 != nil || err2 != nil || amount <= 0 || receive <= 0 {
		return "❌ Importes inválidos.", mainMenu()
	}
	if err := runtime.edge.send(ctx, http.MethodPut, "/api/offers/"+strings.TrimSpace(args[0]),
		map[string]any{"amount": amount, "receive": receive, "rate": receive / amount}); err != nil {
		return "❌ " + err.Error(), mainMenu()
	}
	return "✅ Oferta actualizada.", mainMenu()
}

func (runtime *telegramRuntime) cancelOffer(ctx context.Context, args []string) (string, notifier.InlineKeyboard) {
	if len(args) != 1 {
		return "Uso: /canceloffer UUID", mainMenu()
	}
	if err := runtime.edge.send(ctx, http.MethodDelete, "/api/offers/"+strings.TrimSpace(args[0]), map[string]any{}); err != nil {
		return "❌ " + err.Error(), mainMenu()
	}
	return "✅ Oferta cancelada.", mainMenu()
}

func (runtime *telegramRuntime) createOffer(ctx context.Context, kind string, args []string) (string, notifier.InlineKeyboard) {
	if len(args) != 3 {
		return "Uso: /create" + kind + " MONEDA IMPORTE TASA", mainMenu()
	}
	amount, err1 := strconv.ParseFloat(strings.ReplaceAll(args[1], ",", "."), 64)
	rate, err2 := strconv.ParseFloat(strings.ReplaceAll(args[2], ",", "."), 64)
	if err1 != nil || err2 != nil || amount <= 0 || rate <= 0 {
		return "❌ Importes inválidos.", mainMenu()
	}
	body := map[string]any{
		"coin": strings.ToUpper(strings.TrimSpace(args[0])), "type": kind,
		"amount": amount, "rate": rate,
	}
	if err := runtime.edge.send(ctx, http.MethodPost, "/api/offers", body); err != nil {
		return "❌ " + err.Error(), mainMenu()
	}
	return "✅ Oferta creada.", mainMenu()
}

func findMarket(config map[string]any, code string) map[string]any {
	for _, item := range asList(config["markets"]) {
		market := asMap(item)
		if strings.EqualFold(asString(market["code"]), code) {
			return market
		}
	}
	return nil
}

func asMap(value any) map[string]any {
	if mapped, ok := value.(map[string]any); ok {
		return mapped
	}
	return map[string]any{}
}

func asList(value any) []any {
	if list, ok := value.([]any); ok {
		return list
	}
	return nil
}

func asString(value any) string {
	switch typed := value.(type) {
	case string:
		return typed
	case json.Number:
		return typed.String()
	case float64:
		return strconv.FormatFloat(typed, 'f', -1, 64)
	case bool:
		return strconv.FormatBool(typed)
	case nil:
		return ""
	default:
		return fmt.Sprintf("%v", typed)
	}
}

func asFloat(value any) float64 {
	switch typed := value.(type) {
	case float64:
		return typed
	case json.Number:
		parsed, _ := typed.Float64()
		return parsed
	case string:
		parsed, _ := strconv.ParseFloat(typed, 64)
		return parsed
	case bool:
		if typed {
			return 1
		}
	}
	return 0
}

func asBool(value any) bool {
	switch typed := value.(type) {
	case bool:
		return typed
	case string:
		return typed == "true" || typed == "1"
	case float64:
		return typed != 0
	}
	return false
}

func boolValue(config map[string]any, key string) bool {
	hunting := asMap(config["hunting"])
	return asBool(hunting[key])
}

func money(value float64) string {
	return strconv.FormatFloat(value, 'f', 2, 64)
}

// rateText conserva la precisión de tasas y precios sin ceros innecesarios.
func rateText(value float64) string {
	return strconv.FormatFloat(value, 'f', -1, 64)
}

func timestamp(milliseconds float64) string {
	if milliseconds <= 0 {
		return "sin datos"
	}
	return time.UnixMilli(int64(milliseconds)).UTC().Format("15:04:05")
}

func truncate(text string, limit int) string {
	runes := []rune(text)
	if len(runes) <= limit {
		return text
	}
	return string(runes[:limit]) + "…"
}
