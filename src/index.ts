import { Bot, Context, InlineKeyboard } from "grammy";
import { config } from "./config.js";
import { QvaPayClient } from "./qvapay.js";
import { Session } from "./session.js";
import { Store } from "./store.js";
import { TradingEngine } from "./trading.js";
import { MarketConfigService } from "./market-config.js";
import type { FiatMarket } from "./types.js";
import { answerCallbackSafely, isMessageNotModified, splitCallbackData, TelegramRenderGuard } from "./telegram-runtime.js";
import { Vault } from "./vault.js";
import { DashboardReadModel } from "./dashboard.js";
import { startDashboard } from "./http-dashboard.js";
import { Scheduler } from "./scheduler.js";
import { WebPushService } from "./web-push.js";
import { NotificationDispatcher } from "./notification-dispatcher.js";
import { OfferRaceMonitor } from "./offer-race-monitor.js";
import { HuntingSyncCoordinator } from "./hunting-sync.js";
import { CooperativeHunter } from "./cooperative-hunter.js";
import {
  HuntingRateSessions,
  TELEGRAM_COMMANDS,
  decodeHuntingAction,
  encodeHuntingAction,
  type HuntingSide,
  type PendingRateEdit,
} from "./telegram-menu.js";
import { MarketAccountService } from "./market-accounts.js";
import { PollingMarketSource, weightedMarketJobs } from "./market-source.js";
import { MarketSourceCoordinator } from "./market-feed.js";
import {
  CooperativeContributionSessions,
  decodeCooperativeAction,
  encodeCooperativeAction,
  type CooperativeDraft,
} from "./cooperative-menu.js";

if (!config.realTradingAllowed)
  throw new Error(
    "QvaApply opera únicamente en real; configura CONFIRM_REAL_TRADING=true antes de iniciar.",
  );

const store = new Store(config.dataDir);
const marketConfig = new MarketConfigService(config.dataDir, config, store);
const vault = new Vault(config.encryptionKey);
const session = new Session(store, vault);
const marketAccounts = new MarketAccountService(store, vault);
const huntingSync = new HuntingSyncCoordinator(
  config.huntingSync,
  store,
  vault,
);
const qva = new QvaPayClient(() => session.token(), {
  throttleState: store,
  onApplyTiming: timing => store.audit("offer_apply_timing",JSON.stringify(timing),timing.uuid),
});
const bot = new Bot(config.telegramToken);
const huntingRates = new HuntingRateSessions();
const cooperativeContributions = new CooperativeContributionSessions();
const telegramRenderGuard = new TelegramRenderGuard();
const webPush = new WebPushService(store);
const notifications = new NotificationDispatcher(store, {
  telegram: async (notification) => {
    const keyboard = notification.operationUuid && notification.kind === "operation-applied"
      ? new InlineKeyboard()
          .text("✅ Voy a pagar", `ack:${notification.operationUuid}`)
          .text("✖ Cancelar", `cancel:${notification.operationUuid}`)
      : undefined;
    await bot.api.sendMessage(String(config.adminChatId), notification.message, {
      ...(keyboard ? { reply_markup: keyboard } : {}),
    });
  },
  webPush: async (notification) => {
    if (notification.kind === "offer-taken" || notification.kind === "offer-rejected") return;
    const event = notification.payload;
    if (notification.kind === "blocked-offer")
      await webPush.notifyBlocked(event.alert as never);
    else if (notification.kind === "recovery-blocked")
      await webPush.notifyRecovery(event as { intentId: string; uuid?: string });
    else if (notification.kind === "rebalance-completed" || notification.kind === "rebalance-attention")
      await webPush.notifyRebalance(event as never);
    else await webPush.notifyOperation(event as never);
  },
});
const trading = new TradingEngine(
  store,
  qva,
  config,
  marketConfig,
  async (message, uuid, event) => {
    if (event) {
      await notifications.publish({
        message,
        ...(uuid ? { operationUuid: uuid } : {}),
        event,
      });
      return;
    }
    const keyboard = uuid
      ? new InlineKeyboard()
          .text("✅ Voy a pagar", `ack:${uuid}`)
          .text("✖ Cancelar", `cancel:${uuid}`)
      : undefined;
    const deliveries = await Promise.allSettled([
      bot.api.sendMessage(String(config.adminChatId), message, {
        ...(keyboard ? { reply_markup: keyboard } : {}),
      }),
    ]);
    deliveries.forEach((result) => {
      if (result.status === "rejected") store.audit(
        "notification_warning",
        `Telegram: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`,
        uuid,
      );
    });
  },
);
const pollingMarketSource = new PollingMarketSource(
  store,
  marketAccounts,
  qva,
  () => marketConfig.current().automation.scanIntervalSeconds,
  () => weightedMarketJobs({
    markets: trading.markets().filter(market => market.active || huntingSync.aggregate(market.code)).map((market) => ({
      code: market.code,
      buyEnabled: trading.huntEnabled(market.code, "buy") || Boolean(huntingSync.aggregate(market.code)),
      sellEnabled: trading.huntEnabled(market.code, "sell"),
    })),
  }),
);
const cooperativeHunter = new CooperativeHunter(store, huntingSync, qva, {
  ownBusy: () => trading.ownDecisionBusy(),
  safetyReason: offer => trading.cooperativeSafetyReason(offer),
  canReserveOwn: (coin, fiat) => trading.cooperativeOwnCapacity(coin, fiat),
  ownerCost: (coin, fiat) => trading.cooperativeOwnerCost(coin, fiat),
  projectState: (event, offer) => trading.ingestMarketStateEvent(event, offer),
  notify: (message, uuid) => notifications.publish({ message, operationUuid: uuid,
    event: { kind: message.startsWith("⚠️") ? "reconciliation-required" : "operation-applied", uuid } }),
});
trading.observeSecondaryOpportunities((offer, receivedAt) => cooperativeHunter.enqueue(offer, receivedAt));
const raceMonitor = new OfferRaceMonitor(store,input=>notifications.publish(input),coin=>{
  const market=trading.market(coin);
  return market && (trading.huntEnabled(coin,"buy") || trading.huntEnabled(coin,"sell")) ? market.label : undefined;
},offer=>trading.isOwnMarketOffer(offer));
const traceFailure=(error:unknown)=>store.audit("offer_trace_error",error instanceof Error ? error.message : String(error));
const marketSource = new MarketSourceCoordinator(
  store,
  vault,
  pollingMarketSource,
  new URL("/webhooks/qvapay/p2p-feed", config.dashboardTrustedOrigin).toString(),
  async (offer, receivedAt, event, sentAt) => {
    const result=await trading.ingestMarketOffer(offer, receivedAt, event, sentAt);
    void raceMonitor.evaluated(offer,receivedAt,sentAt,result.action ?? "Sin acción").catch(traceFailure);
    return result;
  },
  () => !trading.isPaused(),
  Date.now,
  {},
  async (event, offer, receivedAt, sentAt) => {
    await trading.ingestMarketStateEvent(event, offer, receivedAt);
    cooperativeHunter.onState(event, offer);
    if(event==="p2p.applied") void raceMonitor.taken(offer,receivedAt,sentAt).catch(traceFailure);
  },
);
marketSource.start();
const dashboardReadModel = new DashboardReadModel(
  trading,
  qva,
  config,
  store,
  marketConfig,
  async (job, event) => {
    const completed = job.adjustments.filter((item) => item.state === "completed").length;
    const message = event === "completed"
      ? `✅ Reajuste completado: ${completed} oferta(s) actualizadas.`
      : `⚠️ El reajuste aplicó ${completed} de ${job.adjustments.length} cambio(s) y requiere atención.`;
    await notifications.publish({
      message,
      event: {
        kind: event === "completed" ? "rebalance-completed" : "rebalance-attention",
        uuid: job.id,
        alert: { uuid: job.id, reason: job.error ?? message },
      },
    });
  },
  huntingSync,
  cooperativeHunter,
);
const dashboardServer = await startDashboard(
  dashboardReadModel,
  config.dashboardPort,
  {
    password: config.dashboardAdminPassword,
    trustedOrigin: config.dashboardTrustedOrigin,
    secureCookies: config.dashboardSecureCookies,
  },
  webPush,
  config.dashboardHost,
  marketAccounts,
  marketSource,
);

bot.use(async (ctx, next) => {
  if (!ctx.chat || BigInt(ctx.chat.id) !== config.adminChatId) {
    if (ctx.callbackQuery)
      await answerCallbackSafely(() =>
        ctx.answerCallbackQuery({ text: "No autorizado" }),
      );
    return;
  }
  telegramRenderGuard.begin(String(ctx.chat.id));
  await next();
});
bot.use(async (ctx, next) => {
  const text = ctx.msg?.text;
  if (text?.startsWith("/") && !text.startsWith("/cancel")) {
    huntingRates.cancel(chatKey(ctx));
    cooperativeContributions.cancel(chatKey(ctx));
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
    return "▶️ <b>Automatización activada</b>";
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
      throw new Error(`Uso: /fiat ${marketHint()} IMPORTE`);
    trading.setFiatBalance(coin, amount);
    return `💳 <b>Saldo ${trading.marketLabel(coin)} actualizado</b>\n${money(amount)} ${trading.marketCurrency(coin)} disponibles para comprar QUSD.`;
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
bot.command("hunting", (ctx) => void showHunting(ctx));
bot.command("network", (ctx) => void showCooperativeNetwork(ctx));
bot.command("coop", (ctx) => void showCooperativeNetwork(ctx));
bot.command("markets", (ctx) => void showMarkets(ctx));
bot.command("operations", (ctx) => void showOperations(ctx));
bot.command("strategy", (ctx) => void showStrategy(ctx));
bot.command("automation", (ctx) => void showAutomation(ctx));
bot.command(
  "market",
  (ctx) =>
    void showMarket(ctx, parseMarket(argument(ctx.msg?.text)) ?? defaultMarket()),
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
bot.command("cancel", (ctx) => {
  if (!argument(ctx.msg?.text) && cooperativeContributions.cancel(chatKey(ctx)))
    return void showCooperativeNetwork(ctx, "Edición del aporte cancelada.");
  if (!argument(ctx.msg?.text) && huntingRates.cancel(chatKey(ctx)))
    return void showHunting(ctx, "Edición de tasa cancelada.");
  return execute(ctx, async () => {
    await trading.cancel(argument(ctx.msg?.text));
    return "✖ Operación cancelada.";
  });
});
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

bot.on("message:text", async (ctx) => {
  if (ctx.msg.text.startsWith("/")) return;
  const cooperative = cooperativeContributions.current(chatKey(ctx));
  if (cooperative) {
    try {
      await continueCooperativeContribution(ctx, ctx.msg.text);
    } catch (error) {
      await ctx.reply(
        `⚠️ ${escapeHtml(errorMessage(error))}\n\nEscribe un número positivo o usa /cancel.`,
        {
          parse_mode: "HTML",
          reply_markup: {
            force_reply: true,
            input_field_placeholder: "Ejemplo: 390,5",
          },
        },
      );
    }
    return;
  }
  const pending = huntingRates.current(chatKey(ctx));
  if (!pending) return;
  try {
    const confirmation = huntingRates.propose(chatKey(ctx), ctx.msg.text);
    await showRateConfirmation(ctx, confirmation);
  } catch (error) {
    await ctx.reply(
      `⚠️ ${escapeHtml(errorMessage(error))}\n\nEscribe la tasa exacta o usa /cancel.`,
      {
        parse_mode: "HTML",
        reply_markup: {
          force_reply: true,
          input_field_placeholder: "Ejemplo: 930 o 1,125",
        },
      },
    );
  }
});

bot.on("callback_query:data", async (ctx) => {
  const [action, uuid] = splitCallbackData(ctx.callbackQuery.data);
  if (action !== "hunt") huntingRates.cancel(chatKey(ctx));
  if (action !== "coop") cooperativeContributions.cancel(chatKey(ctx));
  // Telegram expira estos callbacks rápidamente; se responde antes de consultar QvaPay.
  await answerCallbackSafely(() => ctx.answerCallbackQuery());
  try {
    switch (action) {
      case "panel":
        return showPanelAction(ctx, uuid ?? "home");
      case "hunt":
        return handleHuntingAction(ctx, ctx.callbackQuery.data);
      case "coop":
        return handleCooperativeAction(ctx, ctx.callbackQuery.data);
      case "automation":
        trading.setRefresh(!trading.refreshEnabled());
        return showAutomation(ctx, "Estado del refresco actualizado.");
      case "ack":
        await trading.acknowledge(requiredUuid(uuid));
        return showDashboard(
          ctx,
          "✅ Confirmaste que pagarás. Registra la referencia con /paid UUID REFERENCIA.",
        );
      case "cancel":
        await trading.cancel(requiredUuid(uuid));
        return showDashboard(ctx, "✖ Operación cancelada.");
      case "received":
        await trading.confirmReceived(requiredUuid(uuid));
        return showOperations(ctx, "✅ Recepción confirmada y QUSD liberado.");
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
scheduler.register("scan", 250, async () => {
  if (trading.isPaused()) return;
  if (marketSource.mode() === "hybrid" && await marketSource.processNext()) return;
  const update = await marketSource.pollNext();
  if (update) await trading.ingestMarketUpdate(update, { realtimeRecovery: marketSource.mode() === "hybrid" });
});
scheduler.register("expire", 15_000, () => trading.expireOperations());
scheduler.register("chat_ack", 15_000, () => trading.syncChatAcknowledgements());
scheduler.register("operation_sync", 30_000, () =>
  trading.syncRemoteOperations().then(() => undefined),
);
scheduler.register("mutation_reconcile", 60_000, () =>
  trading.reconcilePendingStandaloneMutations().then(() => undefined),
);
scheduler.register("refresh", 5_000, () => trading.refreshOwnOffers());
scheduler.register("fiat_sync", 30_000, () =>
  trading.syncFiatFromQva().then(() => undefined),
);
scheduler.register("notifications", 15_000, () => notifications.deliverDue());
scheduler.register("recovery_alerts", 10_000, async () => {
  for (const intent of store.unresolvedMutationIntents()) {
    if (intent.state !== "uncertain") continue;
    await notifications.publish({
      message: `🚨 QvaApply detuvo nuevas operaciones por una intención incierta (${intent.kind}). Oferta: ${intent.operationUuid ?? "sin UUID"}. Revisa Auditoría → Recuperación de intenciones. No repitas el pago ni la aplicación sin comprobar QvaPay. https://qvapply.honux.tech/?view=auditoria`,
      ...(intent.operationUuid ? { operationUuid: intent.operationUuid } : {}),
      event: { kind: "recovery-blocked", intentId: intent.intentId, ...(intent.operationUuid ? { uuid: intent.operationUuid } : {}) },
    });
  }
});
scheduler.register("sms_receipts", 15_000, () => dashboardReadModel.processPendingPaymentReceipts());
scheduler.register("capital_rebalance", 5_000, () => dashboardReadModel.runBudgetRebalances());
scheduler.register("dashboard_cache", 30_000, () =>
  dashboardReadModel.refreshCache(),
);
scheduler.register("portfolio_commitments", 60_000, () =>
  dashboardReadModel.refreshPortfolioCommitments().then(() => undefined),
);
scheduler.register("completed_offer_history", 60_000, () =>
  dashboardReadModel.refreshCompletedOfferHistory(),
);
scheduler.register("cooperative_reconcile", 60_000, () =>
  huntingSync.reconcile(),
);
scheduler.register("cooperative_capacity", 5_000, () =>
  huntingSync.syncCapacity(),
);
scheduler.register("cooperative_hunt_reconcile", 30_000, () => cooperativeHunter.reconcile());
void bootstrap();

async function installTelegramMenu(): Promise<void> {
  const chatId = Number(config.adminChatId);
  if (!Number.isSafeInteger(chatId)) {
    store.audit("telegram_menu_error", "El chat administrador no es representable por Telegram.");
    return;
  }
  const results = await Promise.allSettled([
    bot.api.setMyCommands(TELEGRAM_COMMANDS, {
      scope: { type: "chat", chat_id: chatId },
    }),
    bot.api.setChatMenuButton({
      chat_id: chatId,
      menu_button: { type: "commands" },
    }),
  ]);
  for (const result of results)
    if (result.status === "rejected")
      store.audit("telegram_menu_error", errorMessage(result.reason));
}

async function bootstrap(): Promise<void> {
  trading.initializeProductionState();
  await huntingSync.start();
  await installTelegramMenu();
  const standaloneReconciled =
    await trading.reconcilePendingStandaloneMutations();
  const reconciliations = await trading.reconcilePendingWorkflows();
  const unresolved = reconciliations.filter((item) => item.outcome === "unresolved");
  if (reconciliations.length)
    store.audit(
      "startup_reconciliation",
      `${reconciliations.length} flujo(s) revisados; ${unresolved.length} requieren atención.`,
    );
  if (standaloneReconciled)
    store.audit(
      "startup_mutation_reconciliation",
      `${standaloneReconciled} mutación(es) independiente(s) resuelta(s) con QvaPay.`,
    );
  scheduler.start();
  void scheduler.run("notifications");
  void scheduler.run("recovery_alerts");
  void scheduler.run("sms_receipts");
  void scheduler.run("capital_rebalance");
  void scheduler.run("fiat_sync");
  void scheduler.run("cooperative_capacity");
  void scheduler.run("operation_sync");
  void scheduler.run("dashboard_cache");
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
  if (view === "market" || view === "markets") return showMarkets(ctx);
  if (view.startsWith("market:")) {
    const coin = resolveMarket(view.slice("market:".length));
    if (!coin) throw new Error("Mercado no configurado.");
    return showMarket(ctx, coin);
  }
  if (view === "strategy") return showStrategy(ctx);
  if (view === "hunting") return showHunting(ctx);
  if (view === "network") return showCooperativeNetwork(ctx);
  if (view === "operations") return showOperations(ctx);
  if (view === "automation") return showAutomation(ctx);
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

async function showHunting(ctx: Context, notice?: string): Promise<void> {
  const current = marketConfig.current();
  const observations = Object.fromEntries(
    trading.markets().map((market) => [
      market.code,
      dashboardReadModel.marketSideObservations(market.code),
    ]),
  );
  const text = [
    "<b>🎯 Cacería automática</b>",
    "━━━━━━━━━━━━━━━━━━━━",
    `Compra global: <b>${current.hunting.buyRunning ? "ACTIVA" : "DETENIDA"}</b>`,
    `Venta global: <b>${current.hunting.sellRunning ? "ACTIVA" : "DETENIDA"}</b>`,
    "",
    ...current.markets.map(
      (market) =>
        (() => {
          const sides = observations[market.code];
          const observed = (side: "buy" | "sell") => {
            const value = sides?.[side];
            return value
              ? `${value.data.median === undefined ? "sin mediana" : `${money(value.data.median)} (${value.data.samples} ofertas de ${side === "buy" ? "compra" : "venta"})`} · ${relativeTime(value.updatedAt)}`
              : "sin observación";
          };
          return `${market.active ? "🟢" : "⚪"} <b>${escapeHtml(market.label)}</b> · compra ${market.huntBuyEnabled ? "ON" : "OFF"} · venta ${market.huntSellEnabled ? "ON" : "OFF"}\n   Mediana compra: <b>${observed("buy")}</b>\n   Mediana venta: <b>${observed("sell")}</b>`;
        })(),
    ),
    notice ? `\n${escapeHtml(notice)}` : "",
  ]
    .filter(Boolean)
    .join("\n");
  const keyboard = new InlineKeyboard()
    .text(
      current.hunting.buyRunning ? "⏸ Detener compra" : "▶️ Iniciar compra",
      encodeHuntingAction({ type: "global-toggle", side: "buy" }),
    )
    .text(
      current.hunting.sellRunning ? "⏸ Detener venta" : "▶️ Iniciar venta",
      encodeHuntingAction({ type: "global-toggle", side: "sell" }),
    )
    .row();
  for (const market of current.markets)
    keyboard
      .text(
        `${market.active ? "🟢" : "⚪"} ${market.label}`,
        encodeHuntingAction({ type: "market", coin: market.code }),
      )
      .row();
  keyboard.text("‹ Volver al panel", "panel:home");
  return render(ctx, text, keyboard);
}

async function showHuntingMarket(
  ctx: Context,
  coin: FiatMarket,
  notice?: string,
): Promise<void> {
  const current = marketConfig.current();
  const market = current.markets.find((item) => item.code === coin);
  if (!market) throw new Error("Mercado de cacería inválido.");
  const buyEffective =
    market.active && current.hunting.buyRunning && market.huntBuyEnabled;
  const sellEffective =
    market.active && current.hunting.sellRunning && market.huntSellEnabled;
  const text = [
    `<b>🎯 Cacería · ${escapeHtml(market.label)}</b>`,
    "━━━━━━━━━━━━━━━━━━━━",
    `Mercado: <b>${market.active ? "ACTIVO" : "INACTIVO"}</b>`,
    `Compra: <b>${market.huntBuyEnabled ? "ON" : "OFF"}</b> · ${buyEffective ? "buscando" : "detenida"}`,
    `Máximo de compra: <b>${rateText(market.buyMaxRate)} ${escapeHtml(market.currency)}/QUSD</b>`,
    "",
    `Venta: <b>${market.huntSellEnabled ? "ON" : "OFF"}</b> · ${sellEffective ? "buscando" : "detenida"}`,
    `Mínimo de venta: <b>${rateText(market.sellMinRate)} ${escapeHtml(market.currency)}/QUSD</b>`,
    notice ? `\n${escapeHtml(notice)}` : "",
  ]
    .filter(Boolean)
    .join("\n");
  const keyboard = new InlineKeyboard()
    .text(
      market.huntBuyEnabled ? "⏸ Compra" : "▶️ Compra",
      encodeHuntingAction({
        type: "market-toggle",
        side: "buy",
        coin,
      }),
    )
    .text(
      market.huntSellEnabled ? "⏸ Venta" : "▶️ Venta",
      encodeHuntingAction({
        type: "market-toggle",
        side: "sell",
        coin,
      }),
    )
    .row()
    .text(
      "✏️ Máximo de compra",
      encodeHuntingAction({ type: "rate-edit", side: "buy", coin }),
    )
    .row()
    .text(
      "✏️ Mínimo de venta",
      encodeHuntingAction({ type: "rate-edit", side: "sell", coin }),
    )
    .row()
    .text("‹ Todas las monedas", encodeHuntingAction({ type: "home" }));
  return render(ctx, text, keyboard);
}

async function handleHuntingAction(
  ctx: Context,
  callbackData: string,
): Promise<void> {
  try {
    const action = decodeHuntingAction(callbackData);
    if (
      action.type !== "rate-edit" &&
      action.type !== "rate-confirm" &&
      action.type !== "rate-cancel"
    )
      huntingRates.cancel(chatKey(ctx));
    if (action.type === "home") return showHunting(ctx);
    if (action.type === "global-toggle") {
      const current = marketConfig.current().hunting;
      const running =
        action.side === "buy" ? current.buyRunning : current.sellRunning;
      trading.updateHunting(
        action.side === "buy"
          ? { buyRunning: !running }
          : { sellRunning: !running },
      );
      return showHunting(
        ctx,
        `Cacería global de ${sideLabel(action.side).toLowerCase()} ${running ? "detenida" : "iniciada"}.`,
      );
    }
    if (action.type === "market") return showHuntingMarket(ctx, action.coin);
    if (action.type === "market-toggle") {
      const market = requiredHuntingMarket(action.coin);
      const enabled =
        action.side === "buy"
          ? market.huntBuyEnabled
          : market.huntSellEnabled;
      trading.updateHunting({
        market:
          action.side === "buy"
            ? { code: action.coin, huntBuyEnabled: !enabled }
            : { code: action.coin, huntSellEnabled: !enabled },
      });
      return showHuntingMarket(
        ctx,
        action.coin,
        `${sideLabel(action.side)} ${enabled ? "detenida" : "iniciada"} para ${market.label}.`,
      );
    }
    if (action.type === "rate-edit") {
      const market = requiredHuntingMarket(action.coin);
      const previousRate =
        action.side === "buy" ? market.buyMaxRate : market.sellMinRate;
      huntingRates.begin(
        chatKey(ctx),
        action.coin,
        action.side,
        previousRate,
      );
      await ctx.reply(
        `<b>${sideRateLabel(action.side)} · ${escapeHtml(market.label)}</b>\n\nValor actual: <b>${rateText(previousRate)} ${escapeHtml(market.currency)}/QUSD</b>\n\nEscribe la nueva tasa exacta o usa /cancel.`,
        {
          parse_mode: "HTML",
          reply_markup: {
            force_reply: true,
            input_field_placeholder: "Ejemplo: 930 o 1,125",
          },
        },
      );
      return;
    }
    if (action.type === "rate-cancel") {
      const pending = huntingRates.cancel(chatKey(ctx), action.token);
      return pending
        ? showHuntingMarket(ctx, pending.coin, "Edición de tasa cancelada.")
        : showHunting(ctx, "No había una edición pendiente.");
    }
    const confirmed = huntingRates.confirm(chatKey(ctx), action.token);
    trading.updateHunting({
      market:
        confirmed.side === "buy"
          ? { code: confirmed.coin, buyMaxRate: confirmed.proposedRate }
          : { code: confirmed.coin, sellMinRate: confirmed.proposedRate },
    });
    return showHuntingMarket(
      ctx,
      confirmed.coin,
      `${sideRateLabel(confirmed.side)} actualizada a ${rateText(confirmed.proposedRate)}.`,
    );
  } catch (error) {
    return showHunting(ctx, `No se pudo completar: ${errorMessage(error)}`);
  }
}

async function showRateConfirmation(
  ctx: Context,
  pending: PendingRateEdit & { stage: "confirm" },
): Promise<void> {
  const market = requiredHuntingMarket(pending.coin);
  return render(
    ctx,
    [
      "<b>Confirmar nueva tasa de caza</b>",
      "━━━━━━━━━━━━━━━━━━━━",
      `Mercado: <b>${escapeHtml(market.label)}</b>`,
      `Lado: <b>${sideLabel(pending.side)}</b>`,
      `Anterior: <b>${rateText(pending.previousRate)} ${escapeHtml(market.currency)}/QUSD</b>`,
      `Nueva: <b>${rateText(pending.proposedRate)} ${escapeHtml(market.currency)}/QUSD</b>`,
      "",
      "La estrategia no cambiará hasta que confirmes.",
    ].join("\n"),
    new InlineKeyboard()
      .text(
        "✅ Guardar tasa",
        encodeHuntingAction({
          type: "rate-confirm",
          token: pending.token,
        }),
      )
      .text(
        "✖ Cancelar",
        encodeHuntingAction({ type: "rate-cancel", token: pending.token }),
      ),
  );
}

async function showMarkets(ctx: Context): Promise<void> {
  const markets = trading.markets();
  const text = [
    "<b>🔎 Mercados P2P</b>",
    "━━━━━━━━━━━━━━━━━━━━",
    ...markets.map(
      (market) =>
        `${market.active ? "🟢" : "⚪"} ${escapeHtml(market.label)} · ${escapeHtml(market.currency)}`,
    ),
    "",
    "Elige un mercado para consultar sus ofertas.",
  ].join("\n");
  const keyboard = new InlineKeyboard();
  for (const market of markets)
    keyboard
      .text(
        `${market.active ? "🟢" : "⚪"} ${market.label}`,
        `panel:market:${market.code}`,
      )
      .row();
  keyboard.text("‹ Volver al panel", "panel:home");
  return render(ctx, text, keyboard);
}

async function showOperations(ctx: Context, notice?: string): Promise<void> {
  const operations = dashboardReadModel.localSnapshot().operations.slice(0, 8);
  const text = [
    "<b>📦 Operaciones activas</b>",
    "━━━━━━━━━━━━━━━━━━━━",
    operations.length
      ? operations
          .map(
            (operation) =>
              `${operation.offerType === "sell" ? "🟢 COMPRA" : "🔵 VENTA"} · <b>${money(operation.amount)} QUSD</b> · ${escapeHtml(trading.marketLabel(operation.coin))}\nEstado: <b>${escapeHtml(operation.state)}</b> · Tasa: ${rateText(operation.rate)}\n<code>${operation.uuid}</code>`,
          )
          .join("\n\n")
      : "No hay operaciones activas.",
    notice ?? "",
  ]
    .filter(Boolean)
    .join("\n");
  const keyboard = new InlineKeyboard();
  for (const operation of operations) {
    if (operation.state === "applied")
      keyboard.text("✅ Voy a pagar", `ack:${operation.uuid}`);
    if (operation.state === "paid")
      keyboard.text("✅ Confirmar recepción", `received:${operation.uuid}`);
    if (operation.state === "applied" || operation.state === "acknowledged")
      keyboard.text("✖ Cancelar", `cancel:${operation.uuid}`);
    keyboard.row();
  }
  keyboard.text("‹ Volver al panel", "panel:home");
  return render(ctx, text, keyboard);
}

async function showAutomation(ctx: Context, notice?: string): Promise<void> {
  const state = trading.operationalState();
  const text = [
    "<b>🤖 Automatización</b>",
    "━━━━━━━━━━━━━━━━━━━━",
    `Motor: <b>${state.paused ? "PAUSADO" : "ACTIVO"}</b>`,
    `Refresco de ofertas propias: <b>${state.refresh ? "ON" : "OFF"}</b>`,
    notice ? `\n${escapeHtml(notice)}` : "",
  ]
    .filter(Boolean)
    .join("\n");
  return render(
    ctx,
    text,
    new InlineKeyboard()
      .text(
        state.paused ? "▶️ Activar motor" : "⏸ Pausar motor",
        state.paused ? "panel:activate" : "panel:pause",
      )
      .row()
      .text(
        state.refresh ? "⏸ Detener refresco" : "▶️ Activar refresco",
        "automation:refresh",
      )
      .row()
      .text("🔄 Escanear ahora", "panel:scan")
      .row()
      .text("‹ Volver al panel", "panel:home"),
  );
}

async function showDashboard(ctx: Context, notice?: string): Promise<void> {
  const snapshot = dashboardReadModel.localSnapshot();
  const target = await renderWithTarget(
    ctx,
    dashboardText(snapshot, notice),
    mainKeyboard(snapshot.state.paused),
  );
  if (!target || isFresh(snapshot.freshness.balance, 30_000)) return;
  void dashboardReadModel.refreshBalance().then(
    () => updateProgressive(
      target,
      dashboardText(dashboardReadModel.localSnapshot(), notice),
      mainKeyboard(trading.isPaused()),
    ),
    (error) => updateProgressive(
      target,
      dashboardText(dashboardReadModel.localSnapshot(), notice, errorMessage(error)),
      mainKeyboard(trading.isPaused()),
    ),
  );
}

function dashboardText(
  snapshot: ReturnType<DashboardReadModel["localSnapshot"]>,
  notice?: string,
  balanceError?: string,
): string {
  const state = snapshot.state;
  const balance = snapshot.freshness.balance === null
    ? "Sin dato local"
    : `${money(snapshot.balance)} QUSD · ${relativeTime(snapshot.freshness.balance)}`;
  const last = state.lastScan
    ? `${relativeTime(state.lastScan.at)} · ${state.lastScan.inspected} revisadas · ${state.lastScan.candidates} candidatas`
    : "Aún no se ha ejecutado ningún escaneo";
  const unresolved = snapshot.unresolvedMutations.slice(0, 3);
  const mutationWarning = snapshot.risk.usage.unresolvedMutation
    ? [
        "⚠️ <b>BLOQUEO DE MUTACIÓN</b>",
        ...unresolved.map((intent) =>
          `${escapeHtml(intent.kind)} · ${escapeHtml(intent.state)} desde ${relativeTime(intent.createdAt)}${intent.error ? " · " + escapeHtml(intent.error) : " · requiere conciliación"}`,
        ),
      ].join("\n")
    : "";
  const feed = marketSource.status();
  const feedAt = Math.max(
    feed.lastStreamReceivedAt ?? 0,
    feed.lastWebhookReceivedAt ?? 0,
    feed.lastWebhookProcessedAt ?? 0,
  );
  const feedStatus = `📡 Feed P2P (${feed.mode}): ${feedAt ? "evento " + relativeTime(feedAt) : "sin eventos recibidos"}${feed.lastEventOutcome ? " · " + escapeHtml(feed.lastEventOutcome) : ""}${feed.lastWebhookError || feed.lastStreamError ? " · ⚠️ " + escapeHtml(feed.lastWebhookError ?? feed.lastStreamError ?? "") : ""}`;
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
    `${state.paused ? "⏸ <b>INACTIVO</b>" : "▶️ <b>ACTIVO</b>"}`,
    `💰 QvaPay: <b>${balance}</b>${balanceError ? `\n   ⚠️ No se pudo actualizar: ${escapeHtml(balanceError)}` : ""}`,
    `💳 ${fiat}`,
    movements,
    `📦 Operaciones activas: <b>${state.active}</b> · Refresco: <b>${state.refresh ? "ON" : "OFF"}</b>`,
    "",
    `<b>Último escaneo</b>\n${last}`,
    feedStatus,
    mutationWarning,
    notice ? `\n${notice}` : "",
  ]
    .filter(Boolean)
    .join("\n");
  return text;
}

async function showCooperativeNetwork(ctx: Context, notice?: string): Promise<void> {
  const network = huntingSync.state();
  const aggregates = Object.values(network.snapshot).sort((a, b) =>
    a.coin.localeCompare(b.coin),
  );
  const text = [
    "<b>📡 Red cooperativa</b>",
    "━━━━━━━━━━━━━━━━━━━━",
    `HTTP: <b>${network.httpConnected ? "CONECTADO" : "SIN CONEXIÓN"}</b> · NATS: <b>${network.natsConnected ? "CONECTADO" : "SIN CONEXIÓN"}</b>`,
    network.lastNatsAt || network.lastHttpAt
      ? `Última sincronización: ${relativeTime(network.lastNatsAt ?? network.lastHttpAt ?? undefined)}`
      : "Aún no se ha recibido un snapshot.",
    "",
    aggregates.length
      ? aggregates
          .map((item) => {
            const market = trading.market(item.coin);
            const marketName = market?.label ?? item.coin;
            const currency = market?.currency ?? item.coin;
            return `💱 <b>${escapeHtml(marketName)}</b>: ${money(item.fiat)} ${escapeHtml(currency)} · ${item.offersCount} bot(s)\n   Precio medio: ${money(item.price)} · Mínimo medio: ${money(item.minimal)}`;
          })
          .join("\n\n")
      : "No hay liquidez cooperativa publicada.",
    network.lastError ? `\n⚠️ ${escapeHtml(network.lastError)}` : "",
    notice ? `\n${escapeHtml(notice)}` : "",
    "\n🛡 Este panel solo gestiona aportes; no ejecuta ni liquida cacerías.",
  ]
    .filter(Boolean)
    .join("\n");
  const keyboard = new InlineKeyboard()
    .text("🔄 Actualizar", encodeCooperativeAction({ type: "refresh" }))
    .row();
  for (const market of trading.markets()) {
    const current = network.contributions[market.code];
    keyboard.text(
      `${current ? "✏️" : "➕"} ${market.label}`,
      encodeCooperativeAction({ type: "edit", coin: market.code }),
    );
    if (current)
      keyboard.text(
        "🗑 Retirar",
        encodeCooperativeAction({ type: "withdraw", coin: market.code }),
      );
    keyboard.row();
  }
  keyboard.text("‹ Volver al panel", "panel:home");
  return render(ctx, text, keyboard);
}

async function handleCooperativeAction(ctx: Context, data: string): Promise<void> {
  const action = decodeCooperativeAction(data);
  switch (action.type) {
    case "home":
      cooperativeContributions.cancel(chatKey(ctx));
      return showCooperativeNetwork(ctx);
    case "refresh":
      await huntingSync.reconcile();
      await huntingSync.syncCapacity();
      return showCooperativeNetwork(ctx, "✅ Red reconciliada con Sync Core.");
    case "edit": {
      const market = trading.market(action.coin);
      if (!market) throw new Error("Ese mercado no está configurado en QvaApply.");
      cooperativeContributions.begin(chatKey(ctx), market.code);
      await ctx.reply(
        `<b>${networkContributionLabel(action.coin)}</b>\n\nEscribe el precio objetivo.`,
        {
          parse_mode: "HTML",
          reply_markup: {
            force_reply: true,
            input_field_placeholder: "Precio objetivo",
          },
        },
      );
      return;
    }
    case "withdraw":
      if (!huntingSync.state().contributions[action.coin])
        throw new Error("No existe un aporte local activo para ese mercado.");
      return render(
        ctx,
        `<b>¿Retirar el aporte de ${networkContributionLabel(action.coin)}?</b>\n\nLa capacidad dejará de estar disponible para nuevas cacerías conjuntas.`,
        new InlineKeyboard()
          .text(
            "🗑 Sí, retirar",
            encodeCooperativeAction({ type: "withdraw-confirm", coin: action.coin }),
          )
          .row()
          .text("‹ Cancelar", encodeCooperativeAction({ type: "home" })),
      );
    case "withdraw-confirm":
      await huntingSync.withdraw(action.coin);
      return showCooperativeNetwork(ctx, `✅ Aporte de ${networkContributionLabel(action.coin)} retirado.`);
    case "confirm": {
      const contribution = cooperativeContributions.confirm(chatKey(ctx), action.token);
      await huntingSync.publish(contribution);
      return showCooperativeNetwork(ctx, `✅ Aporte de ${networkContributionLabel(contribution.coin)} confirmado.`);
    }
    case "cancel":
      cooperativeContributions.cancel(chatKey(ctx), action.token);
      return showCooperativeNetwork(ctx, "Edición del aporte cancelada.");
  }
}

async function continueCooperativeContribution(ctx: Context, input: string): Promise<void> {
  const session = cooperativeContributions.accept(chatKey(ctx), input);
  if (session.stage === "minimal") {
    await cooperativePrompt(ctx, "Escribe el importe mínimo que debe tener una operación.", "Importe mínimo");
    return;
  }
  if (session.stage !== "confirm") return;
  const contribution: CooperativeDraft = {
    coin: session.coin,
    price: session.price!,
    minimal: session.minimal!,
  };
  await ctx.reply(cooperativeConfirmationText(contribution), {
    parse_mode: "HTML",
    reply_markup: new InlineKeyboard()
      .text("✅ Publicar", encodeCooperativeAction({ type: "confirm", token: session.token }))
      .text("✖ Cancelar", encodeCooperativeAction({ type: "cancel", token: session.token })),
  });
}

async function cooperativePrompt(ctx: Context, text: string, placeholder: string): Promise<void> {
  await ctx.reply(text, {
    reply_markup: { force_reply: true, input_field_placeholder: placeholder },
  });
}

function cooperativeConfirmationText(contribution: CooperativeDraft): string {
  const market = trading.market(contribution.coin);
  const currency = market?.currency ?? contribution.coin;
  return [
    "<b>Confirmar aporte cooperativo</b>",
    "━━━━━━━━━━━━━━━━━━━━",
    `Mercado: <b>${networkContributionLabel(contribution.coin)}</b>`,
    `Precio objetivo: <b>${money(contribution.price)}</b>`,
    `Mínimo: <b>${money(contribution.minimal)} ${escapeHtml(currency)}</b>`,
    `Fiat disponible: <b>${money(trading.fiatBalance(contribution.coin))} ${escapeHtml(currency)}</b>`,
  ].join("\n");
}

function networkContributionLabel(coin: string): string {
  return escapeHtml(trading.market(coin)?.label ?? coin);
}

async function showOwnOffers(ctx: Context, notice?: string): Promise<void> {
  const snapshot = dashboardReadModel.localSnapshot();
  const offers = snapshot.ownOffers;
  const target = await renderWithTarget(ctx, ownOffersText(offers, notice), ownOffersKeyboard(offers));
  if (!target || isFresh(snapshot.freshness.ownOffers, 30_000)) return;
  void dashboardReadModel.refreshOwnOffers().then(
    () => {
      const latest = dashboardReadModel.localSnapshot().ownOffers;
      return updateProgressive(target, ownOffersText(latest, notice), ownOffersKeyboard(latest));
    },
    (error) => updateProgressive(
      target,
      ownOffersText(dashboardReadModel.localSnapshot().ownOffers, notice, errorMessage(error)),
      ownOffersKeyboard(dashboardReadModel.localSnapshot().ownOffers),
    ),
  );
}

function ownOffersText(
  offers: ReturnType<DashboardReadModel["localSnapshot"]>["ownOffers"],
  notice?: string,
  refreshError?: string,
): string {
  return [
    "<b>💼 Mis ofertas abiertas</b>",
    "━━━━━━━━━━━━━━━━━━━━",
    offers.length
      ? offers.slice(0, 8).map((offer) => ownOfferCard({
          ...offer,
          ...(offer.updatedAt === undefined ? {} : { updated_at: offer.updatedAt }),
        })).join("\n\n")
      : "Sin ofertas locales guardadas.",
    refreshError ? "⚠️ No se pudo actualizar: " + escapeHtml(refreshError) : "",
    notice ?? "",
  ]
    .filter(Boolean)
    .join("\n");
}

function ownOffersKeyboard(
  offers: ReturnType<DashboardReadModel["localSnapshot"]>["ownOffers"],
): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  for (const offer of offers.slice(0, 6))
    keyboard
      .text("🔄", `refresh:${offer.uuid}`)
      .text("✖", `cancelown:${offer.uuid}`)
      .row();
  keyboard.text("‹ Volver", "panel:home");
  return keyboard;
}

async function showMarket(ctx: Context, coin: FiatMarket): Promise<void> {
  const initial = dashboardReadModel.localSnapshot();
  const cached = initial.market[coin] ?? { offers: [], total: 0 };
  const target = await renderWithTarget(
    ctx,
    marketText(coin, cached, dashboardReadModel.marketSideObservations(coin)),
    marketKeyboard(cached.offers),
  );
  if (!target) return;
  const observations = dashboardReadModel.marketSideObservations(coin);
  const staleSides = (["sell", "buy"] as const).filter((side) =>
    !isFresh(observations[side]?.updatedAt ?? null, 30_000),
  );
  if (!staleSides.length) return;
  void (async () => {
    const errors: Partial<Record<"buy" | "sell", string>> = {};
    for (const side of staleSides) {
      if (!telegramRenderGuard.isCurrent(target.key, target.revision)) return;
      try {
        await dashboardReadModel.refreshMarketSide(coin, side);
        delete errors[side];
      } catch (error) {
        errors[side] = errorMessage(error);
      }
      const latest = dashboardReadModel.localSnapshot();
      await updateProgressive(
        target,
        marketText(coin, latest.market[coin] ?? { offers: [], total: 0 }, dashboardReadModel.marketSideObservations(coin), errors),
        marketKeyboard((latest.market[coin] ?? { offers: [], total: 0 }).offers),
      );
    }
  })();
}

function marketText(
  coin: FiatMarket,
  market: ReturnType<DashboardReadModel["localSnapshot"]>["market"][FiatMarket],
  observations: ReturnType<DashboardReadModel["marketSideObservations"]>,
  errors: Partial<Record<"buy" | "sell", string>> = {},
): string {
  const sideText = (side: "buy" | "sell") => {
    const label = side === "buy" ? "Compra" : "Venta";
    const observation = observations[side];
    if (errors[side]) return label + ": error al actualizar (" + escapeHtml(errors[side]!) + ")";
    if (!observation) return label + ": sin observación local · actualizando";
    const median = observation.data.median === undefined
      ? "sin mediana"
      : money(observation.data.median) + " (" + observation.data.samples + " ofertas de " + (side === "buy" ? "compra" : "venta") + ")";
    return label + ": " + median + " · " + relativeTime(observation.updatedAt);
  };
  const shown = market.offers.slice(0, 8);
  return [
    "<b>🔎 Mercado P2P · " + trading.marketLabel(coin) + "</b>",
    "━━━━━━━━━━━━━━━━━━━━",
    "Medianas observadas · " + sideText("buy") + "\n" + sideText("sell"),
    "Mostrando " + shown.length + " de " + market.total + " ofertas abiertas.",
    "",
    shown.length ? shown.map((item) => marketViewCard(item, coin)).join("\n\n") : "Sin ofertas locales guardadas.",
  ].join("\n");
}

function marketViewCard(
  item: ReturnType<DashboardReadModel["localSnapshot"]>["market"][FiatMarket]["offers"][number],
  coin: FiatMarket,
): string {
  const title = item.type === "sell" ? "🟢 COMPRAR QUSD" : "🔵 VENDER QUSD";
  const tag = item.decision === "auto_buy"
    ? "✅ Autoelegible"
    : item.decision === "manual_sell"
      ? "👆 Acción manual"
      : "— Descartada";
  return title + " · <b>" + money(item.amount) + " QUSD</b>\nTasa: <b>" + money(item.rate) + " " + trading.marketCurrency(coin) + "/QUSD</b> · Total: " + money(item.receive) + " " + trading.marketCurrency(coin) + "\n" + tag + ": " + escapeHtml(item.reason) + "\n<code>" + item.uuid + "</code>";
}

function marketKeyboard(
  offers: ReturnType<DashboardReadModel["localSnapshot"]>["market"][FiatMarket]["offers"],
): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  for (const item of offers.filter((offer) => offer.decision === "manual_sell").slice(0, 4))
    keyboard.text("Aplicar venta manual", "apply:" + item.uuid).row();
  for (const configured of trading.markets())
    keyboard.text(configured.label, "panel:market:" + configured.code);
  return keyboard.row().text("🔄 Escanear", "panel:scan").text("‹ Volver", "panel:home");
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
    `\nUsa /fiat ${marketHint()} IMPORTE y /refresh para modificar la estrategia.`,
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
  await renderWithTarget(ctx, text, keyboard);
}

async function renderWithTarget(
  ctx: Context,
  text: string,
  keyboard: InlineKeyboard,
): Promise<{ key: string; revision: number; chatId: number; messageId: number } | undefined> {
  const options = { parse_mode: "HTML" as const, reply_markup: keyboard };
  const key = chatKey(ctx);
  const revision = telegramRenderGuard.begin(key);
  const callbackMessage = ctx.callbackQuery?.message;
  const callbackTarget = callbackMessage && "chat" in callbackMessage
    ? { chatId: callbackMessage.chat.id, messageId: callbackMessage.message_id }
    : undefined;
  if (ctx.callbackQuery) {
    try {
      await ctx.editMessageText(text, options);
      return callbackTarget ? { key, revision, ...callbackTarget } : undefined;
    } catch (error) {
      if (isMessageNotModified(error))
        return callbackTarget ? { key, revision, ...callbackTarget } : undefined;
      /* Telegram puede rechazar texto sin cambios */
    }
  }
  const sent = await ctx.reply(text, options);
  return { key, revision, chatId: sent.chat.id, messageId: sent.message_id };
}

async function updateProgressive(
  target: { key: string; revision: number; chatId: number; messageId: number },
  text: string,
  keyboard: InlineKeyboard,
): Promise<void> {
  if (!telegramRenderGuard.isCurrent(target.key, target.revision)) return;
  try {
    await bot.api.editMessageText(target.chatId, target.messageId, text, {
      parse_mode: "HTML",
      reply_markup: keyboard,
    });
  } catch (error) {
    if (!isMessageNotModified(error))
      console.warn("No se pudo actualizar el panel progresivo de Telegram:", errorMessage(error));
  }
}

function isFresh(updatedAt: number | null, maxAgeMs: number): boolean {
  return updatedAt !== null && Date.now() - updatedAt < maxAgeMs;
}
function mainKeyboard(paused: boolean): InlineKeyboard {
  const keyboard = new InlineKeyboard()
    .text("📊 Estado", "panel:status")
    .text("💼 Mis ofertas", "panel:mine")
    .row()
    .text("🎯 Cacería", "panel:hunting")
    .text("🤝 Cacerías conjuntas", "panel:network")
    .row()
    .text("📦 Operaciones", "panel:operations")
    .text("🔎 Mercados", "panel:markets")
    .row()
    .text("⚙️ Estrategia", "panel:strategy");
  return keyboard
    .row()
    .text("🤖 Automatización", "panel:automation")
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
  const coin = trading.isMarket(offer.coin) ? offer.coin : defaultMarket();
  const currency = trading.marketCurrency(coin);
  const refreshed = trading.lastRefresh(offer.uuid);
  return `${label} · <b>${money(offer.amount)} QUSD</b> · ${trading.marketLabel(coin)}\nTasa: <b>${money(offer.receive / offer.amount)} ${currency}/QUSD</b> · Total: ${money(offer.receive)} ${currency}\nEstado: ${escapeHtml(offer.status)} · ${relativeTime(offer.updated_at)}\nRefresco local: ${refreshed ? relativeTime(refreshed) : "pendiente"}`;
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
      throw new Error(`Uso: /create${type} ${marketHint()} QUSD TASA_FIAT`);
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
function requiredHuntingMarket(coin: FiatMarket) {
  const market = trading.market(coin);
  if (!market) throw new Error("Mercado de cacería inválido.");
  return market;
}
function chatKey(ctx: Context): string {
  return String(ctx.chat?.id ?? config.adminChatId);
}
function sideLabel(side: HuntingSide): string {
  return side === "buy" ? "Compra" : "Venta";
}
function sideRateLabel(side: HuntingSide): string {
  return side === "buy" ? "Máximo de compra" : "Mínimo de venta";
}
function money(value: number): string {
  return new Intl.NumberFormat("es-CU", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}
function rateText(value: number): string {
  return new Intl.NumberFormat("es-CU", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 6,
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
  const configured = trading.markets().find(
    (market) =>
      market.code.toLowerCase() === normalized ||
      market.label.trim().toLowerCase() === normalized,
  );
  const code = configured?.code ?? aliases[normalized] ?? value.trim().toUpperCase();
  return trading.isMarket(code) ? code : undefined;
}
function defaultMarket(): FiatMarket {
  const market = trading.activeMarkets()[0] ?? trading.markets()[0];
  if (!market) throw new Error("No hay mercados configurados.");
  return market.code;
}
function marketHint(): string {
  return trading.markets().map((market) => market.code.toLowerCase()).join("|");
}
function helpText(): string {
  const markets = marketHint();
  return `<b>QvaApply · ayuda rápida</b>\n\nUsa el botón <b>Menú</b> de Telegram para acceder a todas las áreas sin memorizar comandos.\n\n<b>Comandos avanzados</b>\n/network — consultar la red cooperativa\n/coop — gestionar el aporte de QvaApply\n/fiat ${markets} IMPORTE — declarar saldo\n/market ${markets} — abrir un mercado concreto\n/createbuy ${markets} QUSD TASA — crear compra\n/createsell ${markets} QUSD TASA — crear venta\n/editoffer UUID QUSD TASA — editar una oferta\n/canceloffer UUID — cancelar una oferta\n/paid UUID REFERENCIA — registrar un pago\n/received UUID — confirmar recepción`;
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
  await cooperativeHunter.stop();
  marketSource.stop();
  if (pollingRetry) clearTimeout(pollingRetry);
  try {
    await bot.stop();
  } catch {
    /* polling puede no haber iniciado */
  }
  await dashboardServer.close();
  await huntingSync.stop();
  store.close();
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));
