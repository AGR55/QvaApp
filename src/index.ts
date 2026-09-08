import { Bot, Context, InlineKeyboard } from "grammy";
import { config } from "./config.js";
import { QvaPayClient } from "./qvapay.js";
import { Session } from "./session.js";
import { Store } from "./store.js";
import { TradingEngine, type MarketItem } from "./trading.js";
import { MarketConfigService } from "./market-config.js";
import type { FiatMarket } from "./types.js";
import { answerCallbackSafely, splitCallbackData } from "./telegram-runtime.js";
import { Vault } from "./vault.js";
import { DashboardReadModel } from "./dashboard.js";
import { startDashboard } from "./http-dashboard.js";
import { Scheduler } from "./scheduler.js";

const store = new Store(config.dataDir);
const marketConfig = new MarketConfigService(config.dataDir, config, store);
const session = new Session(store, new Vault(config.encryptionKey));
const qva = new QvaPayClient(() => session.token());
const bot = new Bot(config.telegramToken);
const trading = new TradingEngine(
  store,
  qva,
  config,
  marketConfig,
  async (message, uuid) => {
    const keyboard = uuid
      ? new InlineKeyboard()
          .text("✅ Voy a pagar", `ack:${uuid}`)
          .text("✖ Cancelar", `cancel:${uuid}`)
      : undefined;
    await bot.api.sendMessage(String(config.adminChatId), message, {
      ...(keyboard ? { reply_markup: keyboard } : {}),
    });
  },
);
const dashboardServer = await startDashboard(
  new DashboardReadModel(trading, qva, config, store, marketConfig),
  config.dashboardPort,
  {
    password: config.dashboardAdminPassword,
    trustedOrigin: config.dashboardTrustedOrigin,
    secureCookies: config.dashboardSecureCookies,
  },
);

bot.use(async (ctx, next) => {
  if (!ctx.chat || BigInt(ctx.chat.id) !== config.adminChatId) {
    if (ctx.callbackQuery)
      await answerCallbackSafely(() =>
        ctx.answerCallbackQuery({ text: "No autorizado" }),
      );
    return;
  }
  await next();
});

bot.command(["start", "panel", "status"], (ctx) => void showDashboard(ctx));
bot.command("help", (ctx) => ctx.reply(helpText(), { parse_mode: "HTML" }));
bot.command("balance", (ctx) =>
  execute(
    ctx,
    async () =>
      `💰 <b>Saldo QUSD</b>\n${money(await trading.qusdBalance())} QUSD`,
  ),
);
bot.command("activate", (ctx) =>
  execute(ctx, async () => {
    await trading.activate();
    return `▶️ <b>Automatización activada</b>\nModo: ${trading.mode().toUpperCase()}.`;
  }),
);
bot.command("pause", (ctx) => {
  trading.setPaused(true);
  return ctx.reply(
    "⏸ <b>Automatización pausada</b>\nNo se iniciarán nuevas acciones.",
    { parse_mode: "HTML" },
  );
});
bot.command("resume", (ctx) =>
  execute(ctx, async () => {
    await trading.activate();
    return "▶️ <b>Automatización activada</b>";
  }),
);
bot.command("scan", (ctx) =>
  execute(ctx, async () => scanSummary(await trading.scan())),
);
bot.command("logs", (ctx) => ctx.reply(logsText(), { parse_mode: "HTML" }));
bot.command("fiat", (ctx) =>
  execute(ctx, async () => {
    const [marketText, amountText] = argumentsOf(ctx.msg?.text);
    const coin = parseMarket(marketText);
    const amount = Number(amountText);
    if (!coin || !Number.isFinite(amount) || amount < 0)
      throw new Error("Uso: /fiat cup|prepago|clasica IMPORTE");
    trading.setFiatBalance(coin, amount);
    return `💳 <b>Saldo ${trading.marketLabel(coin)} actualizado</b>\n${money(amount)} ${trading.marketCurrency(coin)} disponibles para comprar QUSD.`;
  }),
);
bot.command("mode", (ctx) =>
  execute(ctx, async () => {
    const mode = argument(ctx.msg?.text);
    if (mode !== "simulation" && mode !== "real")
      throw new Error("Uso: /mode simulation|real");
    trading.setMode(mode);
    return `⚙️ <b>Modo ${mode === "real" ? "REAL" : "SIMULACIÓN"}</b>\nLa automatización continúa ${trading.isPaused() ? "pausada" : "activa"}; pulsa ▶️ Activar cuando estés listo.`;
  }),
);
bot.command("refresh", (ctx) =>
  execute(ctx, async () => {
    const value = argument(ctx.msg?.text);
    if (value !== "on" && value !== "off")
      throw new Error("Uso: /refresh on|off");
    trading.setRefresh(value === "on");
    return `🔄 Refresco automático ${value === "on" ? "<b>activado</b>" : "desactivado"}.`;
  }),
);
bot.command("offers", (ctx) => void showOwnOffers(ctx));
bot.command(
  "market",
  (ctx) =>
    void showMarket(ctx, parseMarket(argument(ctx.msg?.text)) ?? "BANK_CUP"),
);
bot.command("apply", (ctx) =>
  execute(ctx, async () => trading.applyManually(argument(ctx.msg?.text))),
);
bot.command("ack", (ctx) =>
  execute(ctx, async () => {
    await trading.acknowledge(argument(ctx.msg?.text));
    return "✅ Plazo de autocancelación detenido. Usa /paid UUID REFERENCIA después de transferir.";
  }),
);
bot.command("paid", (ctx) =>
  execute(ctx, async () => {
    const [uuid, ...reference] = argumentsOf(ctx.msg?.text);
    if (!uuid || !reference.length)
      throw new Error("Uso: /paid UUID REFERENCIA");
    await trading.markPaid(uuid, reference.join(" "));
    return "✅ <b>Pago marcado en QvaPay</b>\nEspera la confirmación de la contraparte.";
  }),
);
bot.command("received", (ctx) =>
  execute(ctx, async () => {
    await trading.confirmReceived(argument(ctx.msg?.text));
    return "✅ <b>Recepción confirmada</b>\nQUSD liberado.";
  }),
);
bot.command("cancel", (ctx) =>
  execute(ctx, async () => {
    await trading.cancel(argument(ctx.msg?.text));
    return "✖ Operación cancelada.";
  }),
);
bot.command("editoffer", (ctx) =>
  execute(ctx, async () => {
    const [uuid, amountText, rateText] = argumentsOf(ctx.msg?.text);
    const amount = Number(amountText),
      fiatRate = Number(rateText);
    if (!uuid || !Number.isFinite(amount) || !Number.isFinite(fiatRate))
      throw new Error("Uso: /editoffer UUID QUSD TASA_FIAT");
    await trading.editOwnOffer(uuid, amount, fiatRate);
    return "✅ Oferta propia actualizada.";
  }),
);
bot.command("canceloffer", (ctx) =>
  execute(ctx, async () => {
    await trading.cancelOwnOffer(argument(ctx.msg?.text));
    return "✖ Oferta propia cancelada.";
  }),
);
bot.command("createbuy", (ctx) => createOffer(ctx, "buy"));
bot.command("createsell", (ctx) => createOffer(ctx, "sell"));

bot.on("callback_query:data", async (ctx) => {
  const [action, uuid] = splitCallbackData(ctx.callbackQuery.data);
  // Telegram expira estos callbacks rápidamente; se responde antes de consultar QvaPay.
  await answerCallbackSafely(() => ctx.answerCallbackQuery());
  try {
    switch (action) {
      case "panel":
        return showPanelAction(ctx, uuid ?? "home");
      case "ack":
        await trading.acknowledge(requiredUuid(uuid));
        return showDashboard(
          ctx,
          "✅ Confirmaste que pagarás. Registra la referencia con /paid UUID REFERENCIA.",
        );
      case "cancel":
        await trading.cancel(requiredUuid(uuid));
        return showDashboard(ctx, "✖ Operación cancelada.");
      case "refresh":
        await trading.refreshOwnOffer(requiredUuid(uuid));
        return showOwnOffers(ctx, "🔄 Oferta refrescada.");
      case "cancelown":
        return confirmOwnCancel(ctx, requiredUuid(uuid));
      case "confirmcancel":
        await trading.cancelOwnOffer(requiredUuid(uuid));
        return showOwnOffers(ctx, "✖ Oferta propia cancelada.");
      case "apply":
        return confirmApply(ctx, requiredUuid(uuid));
      case "confirmapply":
        await trading.applyManually(requiredUuid(uuid));
        return showDashboard(
          ctx,
          "✅ Aplicación enviada. Revisa la operación activa.",
        );
      default:
        throw new Error("Acción desconocida.");
    }
  } catch (error) {
    await showDashboard(ctx, `⚠️ ${escapeHtml(errorMessage(error))}`);
  }
});

bot.catch(async (error) => {
  console.error("Error no controlado de Telegram:", error.error);
  store.audit(
    "telegram_error",
    error.error instanceof Error ? error.error.message : String(error.error),
  );
  try {
    await bot.api.sendMessage(
      String(config.adminChatId),
      "⚠️ Error inesperado del bot. Usa /logs para consultar el diagnóstico.",
    );
  } catch {
    /* sin canal alternativo */
  }
});

const scheduler = new Scheduler((name, error) => {
  const message = errorMessage(error);
  store.audit(`${name}_background_error`, message);
  console.error(`Error de tarea ${name}:`, message);
});
scheduler.register("scan", () => marketConfig.current().automation.scanIntervalSeconds * 1_000, async () => {
  if (!trading.isPaused()) await trading.scan();
});
scheduler.register("expire", 15_000, () => trading.expireOperations());
scheduler.register("refresh", 60_000, () => trading.refreshOwnOffers());
scheduler.register("fiat_sync", 30_000, () =>
  trading.syncFiatFromQva().then(() => undefined),
);
void bootstrap();

async function bootstrap(): Promise<void> {
  const reconciliations = await trading.reconcilePendingWorkflows();
  const unresolved = reconciliations.filter((item) => item.outcome === "unresolved");
  if (reconciliations.length)
    store.audit(
      "startup_reconciliation",
      `${reconciliations.length} flujo(s) revisados; ${unresolved.length} requieren atención.`,
    );
  scheduler.start();
  void scheduler.run("fiat_sync");
  void startPolling();
  console.log(
    unresolved.length
      ? `QvaApply iniciado con ${unresolved.length} conciliación(es) pendiente(s).`
      : "QvaApply iniciado. Envía /start desde el chat autorizado.",
  );
}

async function showPanelAction(ctx: Context, view: string): Promise<void> {
  if (view === "status" || view === "home") return showDashboard(ctx);
  if (view === "mine") return showOwnOffers(ctx);
  if (view === "market") return showMarket(ctx, "BANK_CUP");
  if (view.startsWith("market:")) {
    const coin = resolveMarket(view.slice("market:".length));
    if (!coin) throw new Error("Mercado no configurado.");
    return showMarket(ctx, coin);
  }
  if (view === "strategy") return showStrategy(ctx);
  if (view === "logs") return render(ctx, logsText(), backKeyboard());
  if (view === "activate") {
    await trading.activate();
    return showDashboard(ctx, "▶️ Automatización activada.");
  }
  if (view === "pause") {
    trading.setPaused(true);
    return showDashboard(ctx, "⏸ Automatización pausada.");
  }
  if (view === "scan") {
    const result = await trading.scan();
    return showDashboard(ctx, scanSummary(result));
  }
  throw new Error("Vista desconocida.");
}

async function showDashboard(ctx: Context, notice?: string): Promise<void> {
  const state = trading.operationalState();
  let balance = "No disponible";
  try {
    balance = `${money(await trading.qusdBalance())} QUSD`;
  } catch (error) {
    balance = `Error: ${escapeHtml(errorMessage(error))}`;
  }
  const last = state.lastScan
    ? `${relativeTime(state.lastScan.at)} · ${state.lastScan.inspected} revisadas · ${state.lastScan.candidates} candidatas`
    : "Aún no se ha ejecutado ningún escaneo";
  const fiat = trading
    .markets()
    .map(
      (market) =>
        `${market.label}: <b>${money(state.fiat[market.code] ?? 0)} ${market.currency}</b>`,
    )
    .join(" · ");
  const movements = trading
    .markets()
    .map((market) => `📒 ${market.label}: ${ledgerText(market.code)}`)
    .join("\n");
  const text = [
    "<b>QvaApply · Centro de operaciones</b>",
    "━━━━━━━━━━━━━━━━━━━━",
    `${state.paused ? "⏸ <b>PAUSADO</b>" : "▶️ <b>ACTIVO</b>"} · Modo: <b>${state.mode.toUpperCase()}</b>`,
    `💰 QvaPay: <b>${balance}</b>`,
    `💳 ${fiat}`,
    movements,
    `📦 Operaciones activas: <b>${state.active}</b> · Refresco: <b>${state.refresh ? "ON" : "OFF"}</b>`,
    "",
    `<b>Último escaneo</b>\n${last}`,
    notice ? `\n${notice}` : "",
  ]
    .filter(Boolean)
    .join("\n");
  return render(ctx, text, mainKeyboard(state.paused));
}

async function showOwnOffers(ctx: Context, notice?: string): Promise<void> {
  const offers = await trading.listOwnOffers();
  const text = [
    "<b>💼 Mis ofertas abiertas</b>",
    "━━━━━━━━━━━━━━━━━━━━",
    offers.length
      ? offers.slice(0, 8).map(ownOfferCard).join("\n\n")
      : "No hay ofertas abiertas detectadas.",
    notice ?? "",
  ]
    .filter(Boolean)
    .join("\n");
  const keyboard = new InlineKeyboard();
  for (const offer of offers.slice(0, 6))
    keyboard
      .text("🔄", `refresh:${offer.uuid}`)
      .text("✖", `cancelown:${offer.uuid}`)
      .row();
  keyboard.text("‹ Volver", "panel:home");
  return render(ctx, text, keyboard);
}

async function showMarket(ctx: Context, coin: FiatMarket): Promise<void> {
  const market = await trading.inspectMarket(coin);
  const shown = market.items.slice(0, 8);
  const text = [
    `<b>🔎 Mercado P2P · ${trading.marketLabel(coin)}</b>`,
    "━━━━━━━━━━━━━━━━━━━━",
    `Mostrando ${shown.length} de ${market.total} ofertas abiertas.`,
    "",
    shown.length
      ? shown.map(marketCard).join("\n\n")
      : "No hay ofertas abiertas en la respuesta de QvaPay.",
  ].join("\n");
  const keyboard = new InlineKeyboard();
  for (const item of shown
    .filter((item) => item.decision === "manual_sell")
    .slice(0, 4))
    keyboard.text("Aplicar venta manual", `apply:${item.offer.uuid}`).row();
  for (const configured of trading.markets())
    keyboard.text(configured.label, `panel:market:${configured.code}`);
  keyboard
    .row()
    .text("🔄 Escanear", "panel:scan")
    .text("‹ Volver", "panel:home");
  return render(ctx, text, keyboard);
}

async function showStrategy(ctx: Context): Promise<void> {
  const state = trading.operationalState();
  const markets = trading
    .markets()
    .map(
      (market) =>
        `🟢 ${market.label}: comprar hasta <b>${money(market.buyMaxRate)} ${market.currency}/QUSD</b> · vender desde <b>${money(market.sellMinRate)} ${market.currency}/QUSD</b>\n   Saldo: <b>${money(state.fiat[market.code] ?? 0)} ${market.currency}</b>`,
    );
  const text = [
    "<b>⚙️ Estrategia activa</b>",
    "━━━━━━━━━━━━━━━━━━━━",
    ...markets,
    `🛡 Reserva QUSD: <b>${money(trading.strategy().reserve)} QUSD</b>`,
    `⏱ Autocancelación: <b>${marketConfig.current().automation.autoCancelMinutes} min</b>`,
    `🔄 Refresco de propias: <b>${state.refresh ? "activo" : "apagado"}</b>`,
    "\nUsa /fiat cup|prepago|clasica, /mode y /refresh para modificar la estrategia.",
  ].join("\n");
  return render(ctx, text, backKeyboard());
}

async function confirmOwnCancel(ctx: Context, uuid: string): Promise<void> {
  return render(
    ctx,
    `<b>¿Cancelar esta oferta propia?</b>\n\n<code>${uuid}</code>\n\nLos fondos en custodia se gestionarán según el estado de QvaPay.`,
    new InlineKeyboard()
      .text("✖ Sí, cancelar", `confirmcancel:${uuid}`)
      .text("‹ Volver", "panel:mine"),
  );
}
async function confirmApply(ctx: Context, uuid: string): Promise<void> {
  return render(
    ctx,
    `<b>¿Aplicar manualmente a esta oferta?</b>\n\n<code>${uuid}</code>\n\nAplicar a una oferta de compra compromete QUSD. Confirma solo si deseas continuar.`,
    new InlineKeyboard()
      .text("✅ Confirmar aplicación", `confirmapply:${uuid}`)
      .text("‹ Volver", "panel:market"),
  );
}
async function render(
  ctx: Context,
  text: string,
  keyboard: InlineKeyboard,
): Promise<void> {
  const options = { parse_mode: "HTML" as const, reply_markup: keyboard };
  if (ctx.callbackQuery) {
    try {
      await ctx.editMessageText(text, options);
      return;
    } catch {
      /* Telegram puede rechazar texto sin cambios */
    }
  }
  await ctx.reply(text, options);
}
function mainKeyboard(paused: boolean): InlineKeyboard {
  const keyboard = new InlineKeyboard()
    .text("📊 Estado", "panel:status")
    .text("💼 Mis ofertas", "panel:mine")
    .row();
  for (const market of trading.markets())
    keyboard.text(`🔎 ${market.label}`, `panel:market:${market.code}`);
  return keyboard
    .row()
    .text("⚙️ Estrategia", "panel:strategy")
    .text("📜 Logs", "panel:logs")
    .row()
    .text(
      paused ? "▶️ Activar" : "⏸ Pausar",
      paused ? "panel:activate" : "panel:pause",
    )
    .row()
    .text("🔄 Escanear ahora", "panel:scan");
}
function backKeyboard(): InlineKeyboard {
  return new InlineKeyboard().text("‹ Volver al panel", "panel:home");
}
function ownOfferCard(offer: {
  uuid: string;
  type: string;
  coin: string;
  amount: number;
  receive: number;
  status: string;
  updated_at?: string;
}): string {
  const label = offer.type === "buy" ? "🔵 COMPRA" : "🟢 VENTA";
  const coin = trading.isMarket(offer.coin) ? offer.coin : "BANK_CUP";
  const currency = trading.marketCurrency(coin);
  const refreshed = trading.lastRefresh(offer.uuid);
  return `${label} · <b>${money(offer.amount)} QUSD</b> · ${trading.marketLabel(coin)}\nTasa: <b>${money(offer.receive / offer.amount)} ${currency}/QUSD</b> · Total: ${money(offer.receive)} ${currency}\nEstado: ${escapeHtml(offer.status)} · ${relativeTime(offer.updated_at)}\nRefresco local: ${refreshed ? relativeTime(refreshed) : "pendiente"}`;
}
function marketCard(item: MarketItem): string {
  const title =
    item.offer.type === "sell" ? "🟢 COMPRAR QUSD" : "🔵 VENDER QUSD";
  const tag =
    item.decision === "auto_buy"
      ? "✅ Autoelegible"
      : item.decision === "manual_sell"
        ? "👆 Acción manual"
        : "— Descartada";
  const coin = trading.isMarket(item.offer.coin) ? item.offer.coin : "BANK_CUP";
  const currency = trading.marketCurrency(coin);
  return `${title} · <b>${money(item.offer.amount)} QUSD</b>\nTasa: <b>${money(item.rate)} ${currency}/QUSD</b> · Total: ${money(item.offer.receive)} ${currency}\n${tag}: ${escapeHtml(item.reason)}\n<code>${item.offer.uuid}</code>`;
}
function logsText(): string {
  const logs = trading.logs();
  return [
    "<b>📜 Eventos recientes</b>",
    "━━━━━━━━━━━━━━━━━━━━",
    logs.length
      ? logs
          .map(
            (log) =>
              `• <b>${escapeHtml(log.action)}</b> · ${relativeTime(log.createdAt)}\n  ${escapeHtml(log.detail)}`,
          )
          .join("\n")
      : "No hay eventos registrados.",
  ].join("\n");
}
function scanSummary(result: {
  inspected: number;
  candidates: number;
  action?: string;
}): string {
  return `🔎 <b>Escaneo terminado</b>\n${result.inspected} ofertas revisadas · ${result.candidates} candidatas${result.action ? `\n${escapeHtml(result.action)}` : ""}`;
}
async function execute(
  ctx: Context,
  action: () => Promise<string>,
): Promise<void> {
  try {
    await ctx.reply(await action(), { parse_mode: "HTML" });
  } catch (error) {
    await ctx.reply(
      `⚠️ <b>No ejecutado</b>\n${escapeHtml(errorMessage(error))}`,
      { parse_mode: "HTML" },
    );
  }
}
async function createOffer(ctx: Context, type: "buy" | "sell"): Promise<void> {
  await execute(ctx, async () => {
    const [marketText, amountText, rateText] = argumentsOf(ctx.msg?.text);
    const coin = parseMarket(marketText);
    const amount = Number(amountText),
      fiatRate = Number(rateText);
    if (!coin || !Number.isFinite(amount) || !Number.isFinite(fiatRate))
      throw new Error(`Uso: /create${type} cup|prepago|clasica QUSD TASA_FIAT`);
    const offer = await trading.createOwnOffer(coin, type, amount, fiatRate);
    return `✅ Oferta ${type} en ${trading.marketLabel(coin)} creada\n<code>${offer.uuid}</code>`;
  });
}
function argumentsOf(text?: string): string[] {
  return text?.trim().split(/\s+/).slice(1) ?? [];
}
function argument(text?: string): string {
  return argumentsOf(text)[0] ?? "";
}
function requiredUuid(value?: string): string {
  if (!value) throw new Error("Identificador de oferta inválido.");
  return value;
}
function money(value: number): string {
  return new Intl.NumberFormat("es-CU", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}
function relativeTime(value?: string | number): string {
  const time =
    typeof value === "number" ? value : value ? Date.parse(value) : Number.NaN;
  if (!Number.isFinite(time)) return "sin fecha";
  const minutes = Math.max(0, Math.floor((Date.now() - time) / 60_000));
  return minutes < 1
    ? "ahora"
    : minutes < 60
      ? `hace ${minutes} min`
      : `hace ${Math.floor(minutes / 60)} h`;
}
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
function escapeHtml(value: string): string {
  return value.replace(
    /[&<>\"]/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[character] ??
      character,
  );
}
function ledgerText(coin: FiatMarket): string {
  const movements = trading.fiatMovements(coin, 2);
  return movements.length
    ? movements
        .map(
          (movement) =>
            `${movement.direction === "credit" ? "+" : "-"}${money(movement.amount)} ${trading.marketCurrency(coin)} · ${relativeTime(movement.createdAt)}`,
        )
        .join(" · ")
    : "sin movimientos";
}
function parseMarket(value?: string): FiatMarket | undefined {
  return value ? resolveMarket(value) : undefined;
}
function resolveMarket(value: string): FiatMarket | undefined {
  const normalized = value.trim().toLowerCase();
  const aliases: Record<string, string> = {
    cup: "BANK_CUP",
    usd: "BANDECPREPAGO",
    prepago: "BANDECPREPAGO",
    clasica: "CLASICA",
    clásica: "CLASICA",
  };
  const code = aliases[normalized] ?? value.trim().toUpperCase();
  return trading.isMarket(code) ? code : undefined;
}
function helpText(): string {
  return "<b>QvaApply · ayuda rápida</b>\n\n/start — panel operativo\n/activate — activar tras elegir modo\n/scan — escanear mercados activos\n/logs — eventos recientes\n/fiat cup|prepago|clasica IMPORTE — declarar saldo\n/market cup|prepago|clasica — ver mercado\n/createbuy cup|prepago|clasica QUSD TASA — crear compra\n/createsell cup|prepago|clasica QUSD TASA — crear venta\n/mode simulation|real — cambiar modo\n/offers — ofertas propias\n\nLas acciones con fondos solo funcionan en modo real, tras activar la automatización.";
}

let stopping = false;
let pollingRetry: NodeJS.Timeout | undefined;
async function startPolling(): Promise<void> {
  if (stopping) return;
  try {
    await bot.start({ drop_pending_updates: true });
  } catch (error) {
    if (stopping) return;
    const message = errorMessage(error);
    store.audit("telegram_polling_error", message);
    console.error(
      "Conexión de Telegram interrumpida; reintentando en 10 s:",
      message,
    );
    pollingRetry = setTimeout(() => void startPolling(), 10_000);
  }
}

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (stopping) return;
  stopping = true;
  console.log(`Cerrando QvaApply (${signal})...`);
  scheduler.stop();
  if (pollingRetry) clearTimeout(pollingRetry);
  try {
    await bot.stop();
  } catch {
    /* polling puede no haber iniciado */
  }
  await dashboardServer.close();
  store.close();
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));
