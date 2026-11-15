package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/AGR55/QvaApp/services/trading-core/internal/notifier"
)

// telegramRuntime atiende el bot por long polling y ejecuta comandos contra el
// edge. Solo el chat administrador puede mutar configuración u operaciones.
type telegramRuntime struct {
	client      *notifier.Client
	edge        *edgeClient
	adminChatID int64
	logger      *slog.Logger
}

func (runtime *telegramRuntime) Run(ctx context.Context) {
	if err := runtime.client.DeleteWebhook(ctx); err != nil {
		runtime.logger.Warn("telegram deleteWebhook falló", "error", err)
	}
	offset := int64(0)
	for {
		updates, err := runtime.client.GetUpdates(ctx, offset, 30*time.Second)
		if err != nil {
			if ctx.Err() != nil {
				return
			}
			runtime.logger.Warn("telegram getUpdates falló", "error", err)
			select {
			case <-ctx.Done():
				return
			case <-time.After(3 * time.Second):
			}
			continue
		}
		for _, raw := range updates {
			update, ok := notifier.ParseUpdate(raw)
			if !ok {
				continue
			}
			if update.UpdateID >= offset {
				offset = update.UpdateID + 1
			}
			runtime.handle(ctx, update)
		}
	}
}

func (runtime *telegramRuntime) handle(ctx context.Context, update notifier.Update) {
	chat := strconv.FormatInt(update.ChatID, 10)
	if update.ChatID != runtime.adminChatID {
		_ = runtime.client.SendMessage(ctx, chat, "⛔ Chat no autorizado.")
		return
	}
	text := update.Text
	if data := update.CallbackData; data != "" {
		text = data
		if strings.HasPrefix(data, "cmd:") {
			text = "/" + strings.TrimPrefix(data, "cmd:")
		}
	}
	command, ok := notifier.ParseCommand(text)
	if !ok {
		return
	}
	reply, keyboard := runtime.dispatch(ctx, command)
	if strings.TrimSpace(reply) == "" {
		return
	}
	if err := runtime.client.SendMenu(ctx, chat, truncate(reply, 3900), keyboard); err != nil {
		runtime.logger.Warn("telegram respuesta falló", "error", err)
	}
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
	case "hunting", "caceria":
		return runtime.huntingText(ctx)
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
	case "network", "coop":
		return runtime.networkText(ctx)
	case "historial":
		return runtime.historyText(ctx)
	default:
		return "❓ Comando no reconocido.\n\n" + helpText(), mainMenu()
	}
}

func mainMenu() notifier.InlineKeyboard {
	return notifier.InlineKeyboard{
		{{Text: "📊 Estado", CallbackData: "cmd:status"}, {Text: "💰 Balance", CallbackData: "cmd:balance"}},
		{{Text: "🔎 Mercados", CallbackData: "cmd:markets"}, {Text: "💼 Ofertas", CallbackData: "cmd:offers"}},
		{{Text: "📦 Operaciones", CallbackData: "cmd:operations"}, {Text: "⚙️ Estrategia", CallbackData: "cmd:strategy"}},
		{{Text: "🤖 Automatización", CallbackData: "cmd:automation"}, {Text: "❓ Ayuda", CallbackData: "cmd:help"}},
	}
}

func helpText() string {
	return `🤖 Bot QvaApply (Go)

Panel y lectura:
/status · /balance · /markets · /offers
/operations · /strategy · /automation · /hunting
/salud · /logs · /revisions · /network · /historial

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
	text := fmt.Sprintf(`📊 Panel QvaApply

💰 QUSD disponible: %s
💼 Ofertas propias: %d
📦 Operaciones: %d
🔄 Transacciones: %d
🟢 Cacería compra: %v
🧾 Cacería venta: %v`,
		money(asFloat(dashboard["balance"])),
		len(asList(dashboard["ownOffers"])),
		len(asList(dashboard["operations"])),
		len(asList(dashboard["transactions"])),
		boolValue(config, "buyRunning"),
		boolValue(config, "sellRunning"),
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
			money(asFloat(market["buyMaxRate"])), money(asFloat(market["sellMinRate"])),
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
			asString(market["label"]), money(asFloat(market["buyMaxRate"])),
			money(asFloat(market["sellMinRate"])), money(asFloat(market["fiatBalance"])),
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

func (runtime *telegramRuntime) huntingText(ctx context.Context) (string, notifier.InlineKeyboard) {
	config, err := runtime.edge.config(ctx)
	if err != nil {
		return "❌ " + err.Error(), mainMenu()
	}
	hunting := asMap(config["hunting"])
	text := fmt.Sprintf("🛒 Cacería\n\nCompra: %v\nVenta: %v\n\nUsa /pause o /resume para pausar toda la automatización.",
		asBool(hunting["buyRunning"]), asBool(hunting["sellRunning"]))
	return text, mainMenu()
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
		return "Uso: /setrate MERCADO buy|sell TASA", mainMenu()
	}
	code := strings.ToUpper(strings.TrimSpace(args[0]))
	side := strings.ToLower(strings.TrimSpace(args[1]))
	rate, err := strconv.ParseFloat(strings.ReplaceAll(args[2], ",", "."), 64)
	if err != nil || rate <= 0 {
		return "❌ Tasa inválida.", mainMenu()
	}
	market := map[string]any{"code": code}
	switch side {
	case "buy", "compra":
		market["buyMaxRate"] = rate
	case "sell", "venta":
		market["sellMinRate"] = rate
	default:
		return "Uso: /setrate MERCADO buy|sell TASA", mainMenu()
	}
	if err := runtime.edge.send(ctx, http.MethodPut, "/api/hunting", map[string]any{"market": market}); err != nil {
		return "❌ " + err.Error(), mainMenu()
	}
	return fmt.Sprintf("✅ %s: %s actualizado a %s.", code, side, money(rate)), mainMenu()
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
	return fmt.Sprintf("✅ %s: %s = %s.", code, label, money(value)), mainMenu()
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
