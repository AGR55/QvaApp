import { Bot, Context, InlineKeyboard } from "grammy";
import { installTelegramRecovery } from "./telegram-recovery.js";
import { SelfServiceRecovery } from "./self-service-recovery.js";
import { config } from "./config.js";
import { QvaPayClient } from "./qvapay.js";
import { Session } from "./session.js";
import { Store } from "./store.js";
import { TradingEngine } from "./trading.js";
import { MarketConfigService } from "./market-config.js";
import type { FiatMarket } from "./types.js";
import { answerCallbackSafely, isMessageNotModified, splitCallbackData, TelegramRenderGuard } from "./telegram-runtime.js";
import { canCancelOperation, canMarkPaid, operationNotificationText, parseTransactionId, PaymentReferenceSessions } from "./telegram-operation.js";
import { Vault } from "./vault.js";
import { DashboardReadModel } from "./dashboard.js";
import { startDashboard } from "./http-dashboard.js";
import { Scheduler } from "./scheduler.js";
import { WebPushService } from "./web-push.js";
import { NotificationDispatcher } from "./notification-dispatcher.js";
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
const clearedAckDeadlines = store.clearAutomaticCancellationDeadlines();
if (clearedAckDeadlines) store.audit("ack_timeout_disabled", `Plazos de cancelación por falta de ACK retirados: ${clearedAckDeadlines}.`);
const marketConfig = new MarketConfigService(config.dataDir, config, store);
void store.refreshConfigIntegrity();
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
const paymentReferences = new PaymentReferenceSessions();
const telegramRenderGuard = new TelegramRenderGuard();
const webPush = new WebPushService(store);
const notifications = new NotificationDispatcher(store, {
  telegram: async (notification) => {
    const operation = notification.operationUuid ? store.getOperation(notification.operationUuid) : undefined;
    const cooperative = notification.message.startsWith("<b>🤝 Cacería conjunta");
    const keyboard = notification.operationUuid && notification.kind === "operation-applied" && !cooperative && canMarkPaid(operation) &&
      !store.hasUnresolvedMutationForOffer(notification.operationUuid)
      ? new InlineKeyboard()
          .text("💸 Registrar pago", `pay:${notification.operationUuid}`)
      : undefined;
    await bot.api.sendMessage(String(config.adminChatId), operationNotificationText(
      notification, operation, coin => trading.isMarket(coin) ? trading.marketLabel(coin) : coin,
      coin => trading.isMarket(coin) ? trading.marketCurrency(coin) : coin,
    ), {
      parse_mode: "HTML",
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
      }, { waitForDelivery: false });
      return;
    }
    store.audit("telegram_info_suppressed", message, uuid);
  },
);
huntingSync.setAccountingRefresh(async () => {
  const after = Number(store.get("cooperative_participation_cursor") ?? 0);
  const items = await huntingSync.participations(after);
  store.recordCooperativeParticipations(items, coin => trading.markets().find(market => market.code === coin)?.outgoingTransferFee ?? 0);
}, coin => trading.cooperativeSyncFiat(coin), coin => trading.cooperativePublishFiat(coin));
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
    event: { kind: message.startsWith("⚠️") ? "reconciliation-required" : "operation-applied", uuid } }, { waitForDelivery: false }),
});
trading.observeSecondaryOpportunities((offer, receivedAt) => cooperativeHunter.enqueue(offer, receivedAt));
const marketSource = new MarketSourceCoordinator(
  store,
  vault,
  pollingMarketSource,
  new URL("/webhooks/qvapay/p2p-feed", config.dashboardTrustedOrigin).toString(),
  (offer, receivedAt, event, sentAt) => trading.ingestMarketOffer(offer, receivedAt, event, sentAt),
  () => !trading.isPaused(),
  Date.now,
  {},
  async (event, offer, receivedAt) => {
    await trading.ingestMarketStateEvent(event, offer, receivedAt);
    cooperativeHunter.onState(event, offer);
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
  if (ctx.callbackQuery?.data?.startsWith("recovery:")) {
    huntingRates.cancel(chatKey(ctx)); cooperativeContributions.cancel(chatKey(ctx)); paymentReferences.cancel(chatKey(ctx));
  }
  if (text?.startsWith("/") && !text.startsWith("/cancel")) {
    huntingRates.cancel(chatKey(ctx));
    cooperativeContributions.cancel(chatKey(ctx));
    paymentReferences.cancel(chatKey(ctx));
  }
  await next();
});

installTelegramRecovery(bot, new SelfServiceRecovery(store, trading, Date.now, "admin_telegram"));

bot.command(["start", "panel", "status"], (ctx) => void showDashboard(ctx));
bot.command("help", (ctx) => ctx.reply(helpText(), { parse_mode: "HTML" }));
bot.command("balance", (ctx) =>
  execute(
    ctx,
    async () =>
      `<b>💰 Saldo disponible</b>\n\n<b>${money(await trading.qusdBalance())} QUSD</b> en QvaPay.`,
  ),
);
bot.command("activate", (ctx) =>
  execute(ctx, async () => {
    await trading.activate();
    return "<b>▶️ Automatización activada</b>\n\nLas cacerías habilitadas vuelven a buscar ofertas.";
  }),
);
bot.command("pause", (ctx) => {
  trading.setPaused(true);
  return ctx.reply(
    "<b>⏸ Automatización pausada</b>\n\nNo se iniciarán nuevas operaciones hasta que la actives.",
    { parse_mode: "HTML" },
  );
});
bot.command("resume", (ctx) =>
  execute(ctx, async () => {
    await trading.activate();
    return "<b>▶️ Automatización activada</b>\n\nLas cacerías habilitadas vuelven a buscar ofertas.";
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
    return `<b>💳 Saldo actualizado · ${escapeHtml(trading.marketLabel(coin))}</b>\n\nDisponible para comprar: <b>${money(amount)} ${escapeHtml(trading.marketCurrency(coin))}</b>.`;
  }),
);
bot.command("refresh", (ctx) =>
  execute(ctx, async () => {
    const value = argument(ctx.msg?.text);
    if (value !== "on" && value !== "off")
      throw new Error("Uso: /refresh on|off");
    trading.setRefresh(value === "on");
    return `<b>🔄 Refresco de ofertas ${value === "on" ? "activado" : "desactivado"}</b>\n\n${value === "on" ? "Las ofertas propias se actualizarán automáticamente." : "Las ofertas propias dejarán de actualizarse automáticamente."}`;
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
    return "<b>✅ Operación reconocida</b>\n\nDespués de transferir, registra el ID con <code>/paid UUID ID</code>.";
  }),
);
bot.command("paid", (ctx) =>
  execute(ctx, async () => {
    const [uuid, ...reference] = argumentsOf(ctx.msg?.text);
    if (!uuid || !reference.length)
      throw new Error("Uso: /paid UUID REFERENCIA");
    await trading.markPaid(uuid, parseTransactionId(reference.join(" ")));
    return `<b>✅ Pago registrado en QvaPay</b>\n\n🆔 Operación: <code>${escapeHtml(uuid)}</code>\n⏳ Espera la confirmación de la contraparte.`;
  }),
);
bot.command("received", (ctx) =>
  execute(ctx, async () => {
    const uuid = argument(ctx.msg?.text);
    await trading.confirmReceived(uuid);
    return `<b>✅ Recepción confirmada</b>\n\nLos QUSD de <code>${escapeHtml(uuid)}</code> quedaron liberados.`;
  }),
);
bot.command("cancel", (ctx) => {
  if (!argument(ctx.msg?.text) && paymentReferences.current(chatKey(ctx))) {
    paymentReferences.cancel(chatKey(ctx));
    return void ctx.reply("<b>✖ Registro de pago cancelado</b>\n\nLa operación sigue activa.", { parse_mode: "HTML" });
  }
  if (!argument(ctx.msg?.text) && cooperativeContributions.cancel(chatKey(ctx)))
    return void showCooperativeNetwork(ctx, "Edición del aporte cancelada.");
  if (!argument(ctx.msg?.text) && huntingRates.cancel(chatKey(ctx)))
    return void showHunting(ctx, "Edición de tasa cancelada.");
  return execute(ctx, async () => {
    const uuid = argument(ctx.msg?.text);
    await trading.cancel(uuid);
    return `<b>${store.getOperation(uuid)?.state === "revision" ? "⚖️ Orden en disputa" : "✖ Operación cancelada"}</b>\n\n🆔 <code>${escapeHtml(uuid)}</code>`;
  });
});
bot.command("editoffer", (ctx) =>
  execute(ctx, async () => {
    const [uuid, amountText, rateInput] = argumentsOf(ctx.msg?.text);
    const amount = Number(amountText),
      fiatRate = Number(rateInput);
    if (!uuid || !Number.isFinite(amount) || !Number.isFinite(fiatRate))
      throw new Error("Uso: /editoffer UUID QUSD TASA_FIAT");
    await trading.editOwnOffer(uuid, amount, fiatRate);
    return `<b>✅ Oferta actualizada</b>\n\n🆔 <code>${escapeHtml(uuid)}</code>\n💰 Importe: <b>${money(amount)} QUSD</b>\n💱 Tasa: <b>${rateText(fiatRate)}</b>`;
  }),
);
bot.command("canceloffer", (ctx) =>
  execute(ctx, async () => {
    const uuid = argument(ctx.msg?.text);
    await trading.cancelOwnOffer(uuid);
    return `<b>✖ Oferta propia cancelada</b>\n\n🆔 <code>${escapeHtml(uuid)}</code>`;
  }),
);
bot.command("createbuy", (ctx) => createOffer(ctx, "buy"));
bot.command("createsell", (ctx) => createOffer(ctx, "sell"));

bot.on("message:text", async (ctx) => {
  if (ctx.msg.text.startsWith("/")) return;
  const payment = paymentReferences.current(chatKey(ctx));
  if (payment) {
    try {
      const reference = parseTransactionId(ctx.msg.text);
      await trading.markPaid(payment.uuid, reference);
      paymentReferences.cancel(chatKey(ctx));
      if (payment.messageId) {
        try { await bot.api.editMessageReplyMarkup(ctx.chat.id, payment.messageId); }
        catch (error) { store.audit("telegram_button_refresh_warning", errorMessage(error), payment.uuid); }
      }
      await ctx.reply(`<b>✅ Pago registrado en QvaPay</b>\n\n🧾 ID de transacción: <code>${escapeHtml(reference)}</code>\n🆔 Operación: <code>${escapeHtml(payment.uuid)}</code>\n\n⏳ Espera la confirmación de la contraparte.`, { parse_mode: "HTML" });
    } catch (error) {
      const uncertain = store.hasUnresolvedMutationForOffer(payment.uuid);
      if (uncertain) paymentReferences.cancel(chatKey(ctx));
      await ctx.reply(`<b>⚠️ Pago sin confirmar</b>\n\n${escapeHtml(errorMessage(error))}\n\n${uncertain ? "La operación se está conciliando con QvaPay. No vuelvas a enviar el ID." : "Corrige el ID de transacción o usa /cancel para salir."}`, {
        parse_mode: "HTML",
        ...(!uncertain ? { reply_markup: { force_reply: true as const, input_field_placeholder: "ID de transacción" } } : {}),
      });
    }
    return;
  }
  const cooperative = cooperativeContributions.current(chatKey(ctx));
  if (cooperative) {
    try {
      await continueCooperativeContribution(ctx, ctx.msg.text);
    } catch (error) {
      await ctx.reply(
        `<b>⚠️ Aporte no válido</b>\n\n${escapeHtml(errorMessage(error))}\n\nEscribe un número positivo o usa /cancel.`,
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
      `<b>⚠️ Tasa no válida</b>\n\n${escapeHtml(errorMessage(error))}\n\nEscribe la tasa exacta o usa /cancel.`,
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
  if (action !== "pay") paymentReferences.cancel(chatKey(ctx));
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
        return confirmOperationCancel(ctx, requiredUuid(uuid));
      case "confirmopcancel":
        await trading.cancel(requiredUuid(uuid));
        return showOperations(ctx, store.getOperation(requiredUuid(uuid))?.state === "revision" ? "⚖️ La orden quedó en disputa; QvaPay revisará el caso." : "✖ Operación cancelada.");
      case "pay": {
        const id = requiredUuid(uuid);
        const operation = store.getOperation(id);
        if (!canMarkPaid(operation)) throw new Error("Esta operación ya no permite registrar un pago.");
        if (store.hasUnresolvedMutationForOffer(id)) throw new Error("Esta operación está pendiente de conciliación.");
        paymentReferences.start(chatKey(ctx), id, ctx.callbackQuery.message?.message_id);
        return ctx.reply(`<b>💸 Registrar pago</b>\n\nEnvía solo el ID de la transacción para la oferta <code>${escapeHtml(id)}</code>.\n\nUsa /cancel para salir.`, {
          parse_mode: "HTML", reply_markup: { force_reply: true, input_field_placeholder: "ID de transacción" },
        });
      }
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

bot.catch((error) => {
  console.error("Error no controlado de Telegram:", error.error);
  store.audit(
    "telegram_error",
    error.error instanceof Error ? error.error.message : String(error.error),
  );
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
scheduler.register("operation_sync", 30_000, () =>
  trading.syncRemoteOperations().then(() => undefined),
);
scheduler.register("operation_chat", 15_000, () => dashboardReadModel.syncOperationChats());
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
    if (store.get(`recovery_ack:${intent.intentId}`)) {
      store.acknowledgeRecoveryNotifications(intent.intentId, intent.operationUuid);
      continue;
    }
    if (intent.state !== "uncertain") continue;
    await notifications.publish({
      message: `⚠️ Operación pendiente de conciliación\n\nAcción: ${intent.kind}\n🆔 Oferta: ${intent.operationUuid ?? "sin UUID"}\n\nLas demás cacerías continúan. No repitas esta operación hasta comprobar su estado.\n\n🔎 Usa /recovery para comprobar, registrar evidencia o reconocer el aviso.\n🌐 https://qvapply.honux.tech/?view=auditoria`,
      ...(intent.operationUuid ? { operationUuid: intent.operationUuid } : {}),
      event: { kind: "recovery-blocked", intentId: intent.intentId, ...(intent.operationUuid ? { uuid: intent.operationUuid } : {}) },
    });
  }
});
scheduler.register("sms_receipts", 15_000, () => dashboardReadModel.processPendingPaymentReceipts());
scheduler.register("capital_rebalance", 5_000, () => dashboardReadModel.runBudgetRebalances());
scheduler.register("dashboard_cache", 30_000, () =>
  dashboardReadModel.refreshCache({ refreshMarkets: false }),
);
scheduler.register("hunting_liquidity", 10_000, () => trading.prepareHuntingLiquidity());
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
  const text = blocks(
    "<b>🎯 Cacerías automáticas</b>",
    `🌐 Compra: <b>${current.hunting.buyRunning ? "activa" : "detenida"}</b>\n🌐 Venta: <b>${current.hunting.sellRunning ? "activa" : "detenida"}</b>`,
    current.markets.map(
      (market) =>
        (() => {
          const sides = observations[market.code];
          const observed = (side: "buy" | "sell") => {
            const value = sides?.[side];
            return value
              ? `${value.data.median === undefined ? "sin mediana" : `${money(value.data.median)} (${value.data.samples} ofertas de ${side === "buy" ? "compra" : "venta"})`} · ${relativeTime(value.updatedAt)}`
              : "sin observación";
          };
          return `${market.active ? "🟢" : "⚪"} <b>${escapeHtml(market.label)}</b>\n• Compra: ${market.huntBuyEnabled ? "activa" : "detenida"} · mediana ${observed("buy")}\n• Venta: ${market.huntSellEnabled ? "activa" : "detenida"} · mediana ${observed("sell")}`;
        })(),
    ).join("\n\n"),
    notice ? `📌 ${escapeHtml(notice)}` : "",
  );
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
  const text = blocks(
    `<b>🎯 Cacería · ${escapeHtml(market.label)}</b>`,
    `💱 Mercado: <b>${market.active ? "activo" : "inactivo"}</b>`,
    `<b>🔵 Compra</b> · ${buyEffective ? "buscando" : "detenida"}\nMáximo: <b>${rateText(market.buyMaxRate)} ${escapeHtml(market.currency)}/QUSD</b>`,
    `<b>🟢 Venta</b> · ${sellEffective ? "buscando" : "detenida"}\nMínimo: <b>${rateText(market.sellMinRate)} ${escapeHtml(market.currency)}/QUSD</b>`,
    notice ? `📌 ${escapeHtml(notice)}` : "",
  );
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
    blocks(
      "<b>✏️ Confirmar tasa de cacería</b>",
      `🪙 Mercado: <b>${escapeHtml(market.label)}</b>\n🎯 Lado: <b>${sideLabel(pending.side)}</b>`,
      `Tasa actual: <b>${rateText(pending.previousRate)} ${escapeHtml(market.currency)}/QUSD</b>\nNueva tasa: <b>${rateText(pending.proposedRate)} ${escapeHtml(market.currency)}/QUSD</b>`,
      "La nueva tasa se aplicará al confirmar.",
    ),
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
  const text = blocks(
    "<b>🔎 Mercados P2P</b>",
    markets.map(
      (market) =>
        `${market.active ? "🟢" : "⚪"} <b>${escapeHtml(market.label)}</b> · ${escapeHtml(market.currency)}`,
    ).join("\n"),
    "Elige un mercado para consultar sus ofertas.",
  );
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
  const text = blocks(
    "<b>📦 Operaciones activas</b>",
    operations.length
      ? operations
          .map(
            (operation, index) =>
              `<b>${index + 1}. ${operation.offerType === "sell" ? "💸 Compra de QUSD" : "🪙 Venta de QUSD"} · ${escapeHtml(trading.marketLabel(operation.coin))}</b>\n` +
              `💰 <b>${money(operation.amount)} QUSD</b>\n💸 Fiat: <b>${money(operation.receive)} ${escapeHtml(trading.marketCurrency(operation.coin))}</b>\n📍 Estado: <b>${operationStateLabel(operation.state)}</b>\n🆔 <code>${escapeHtml(operation.uuid)}</code>`,
          )
          .join("\n\n")
      : "No hay operaciones activas.",
    notice ? `📌 ${escapeHtml(notice)}` : "",
  );
  const keyboard = new InlineKeyboard();
  for (const [index, operation] of operations.entries()) {
    if (operation.offerType === "buy" && operation.state === "paid")
      keyboard.text(`✅ Recibido #${index + 1}`, `received:${operation.uuid}`);
    if (!store.hasUnresolvedMutationForOffer(operation.uuid)) {
      if (canMarkPaid(operation)) keyboard.text(`💸 Pagar #${index + 1}`, `pay:${operation.uuid}`);
      if (canCancelOperation(operation)) keyboard.text(`✖ Cancelar #${index + 1}…`, `cancel:${operation.uuid}`);
    }
    keyboard.row();
  }
  keyboard.text("‹ Volver al panel", "panel:home");
  return render(ctx, text, keyboard);
}

async function showAutomation(ctx: Context, notice?: string): Promise<void> {
  const state = trading.operationalState();
  const text = blocks(
    "<b>🤖 Automatización</b>",
    `🎯 Cacerías: <b>${state.paused ? "pausadas" : "activas"}</b>\n🔄 Refresco de ofertas propias: <b>${state.refresh ? "activo" : "apagado"}</b>`,
    notice ? `📌 ${escapeHtml(notice)}` : "",
  );
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
  const unresolved = snapshot.unresolvedMutations.filter(intent => !store.get(`recovery_ack:${intent.intentId}`)).slice(0, 3);
  const mutationWarning = unresolved.length > 0
    ? [
        "<b>⚠️ Operaciones en conciliación</b>",
        ...unresolved.map((intent) =>
          `• ${escapeHtml(intent.kind)} · ${escapeHtml(intent.state)} · ${relativeTime(intent.createdAt)}${intent.error ? "\n  " + escapeHtml(intent.error) : ""}`,
        ),
      ].join("\n")
    : "";
  const feed = marketSource.status();
  const feedAt = Math.max(
    feed.lastStreamReceivedAt ?? 0,
    feed.lastWebhookReceivedAt ?? 0,
    feed.lastWebhookProcessedAt ?? 0,
  );
  const feedStatus = `📡 Feed P2P: <b>${escapeHtml(feed.mode)}</b> · ${feedAt ? "último evento " + relativeTime(feedAt) : "sin eventos recibidos"}${feed.lastEventOutcome ? "\nResultado: " + escapeHtml(feed.lastEventOutcome) : ""}${feed.lastWebhookError || feed.lastStreamError ? "\n⚠️ " + escapeHtml(feed.lastWebhookError ?? feed.lastStreamError ?? "") : ""}`;
  const fiat = trading
    .markets()
    .map(
      (market) =>
        `• ${escapeHtml(market.label)}: <b>${money(state.fiat[market.code] ?? 0)} ${escapeHtml(market.currency)}</b>`,
    )
    .join("\n");
  const movements = trading
    .markets()
    .map((market) => `📒 ${market.label}: ${ledgerText(market.code)}`)
    .join("\n");
  const text = blocks(
    `<b>🏠 QvaApply · Panel</b>\n${state.paused ? "⏸ Cacerías pausadas" : "▶️ Cacerías activas"}`,
    `💰 Saldo QvaPay: <b>${balance}</b>${balanceError ? `\n⚠️ No se pudo actualizar: ${escapeHtml(balanceError)}` : ""}\n📦 Operaciones activas: <b>${state.active}</b>\n🔄 Refresco: <b>${state.refresh ? "activo" : "apagado"}</b>`,
    `<b>💳 Saldos fiat</b>\n${fiat}`,
    `<b>📒 Últimos movimientos</b>\n${movements}`,
    `<b>🔎 Último escaneo</b>\n${last}`,
    feedStatus,
    mutationWarning,
    notice ? `📌 ${notice}` : "",
  );
  return text;
}

async function showCooperativeNetwork(ctx: Context, notice?: string): Promise<void> {
  const network = huntingSync.state();
  const aggregates = Object.values(network.snapshot).sort((a, b) =>
    a.coin.localeCompare(b.coin),
  );
  const text = blocks(
    "<b>🤝 Red cooperativa</b>",
    `🌐 HTTP: <b>${network.httpConnected ? "conectado" : "sin conexión"}</b>\n📡 NATS: <b>${network.natsConnected ? "conectado" : "sin conexión"}</b>`,
    network.lastNatsAt || network.lastHttpAt
      ? `Última sincronización: ${relativeTime(network.lastNatsAt ?? network.lastHttpAt ?? undefined)}`
      : "Aún no se ha recibido un snapshot.",
    aggregates.length
      ? aggregates
          .map((item) => {
            const market = trading.market(item.coin);
            const marketName = market?.label ?? item.coin;
            const currency = market?.currency ?? item.coin;
            return `💱 <b>${escapeHtml(marketName)}</b>\n• Aporte: <b>${money(item.fiat)} ${escapeHtml(currency)}</b> · ${item.offersCount} bots\n• Precio medio: ${money(item.price)} · mínimo: ${money(item.minimal)}`;
          })
          .join("\n\n")
      : "No hay liquidez cooperativa publicada.",
    network.lastError ? `⚠️ ${escapeHtml(network.lastError)}` : "",
    notice ? `📌 ${escapeHtml(notice)}` : "",
    "🛡 Este panel gestiona aportes para las cacerías conjuntas.",
  );
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
        `<b>➕ Aporte cooperativo · ${networkContributionLabel(action.coin)}</b>\n\n💱 Escribe el precio objetivo por QUSD.\n\nUsa /cancel para salir.`,
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
    await cooperativePrompt(ctx, "<b>💰 Aporte cooperativo</b>\n\nEscribe el importe fiat mínimo para participar en una operación.\n\nUsa /cancel para salir.", "Importe mínimo");
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
    parse_mode: "HTML",
    reply_markup: { force_reply: true, input_field_placeholder: placeholder },
  });
}

function cooperativeConfirmationText(contribution: CooperativeDraft): string {
  const market = trading.market(contribution.coin);
  const currency = market?.currency ?? contribution.coin;
  return blocks(
    "<b>✅ Confirmar aporte cooperativo</b>",
    `🪙 Mercado: <b>${networkContributionLabel(contribution.coin)}</b>\n💱 Precio objetivo: <b>${money(contribution.price)}</b>\n💰 Mínimo: <b>${money(contribution.minimal)} ${escapeHtml(currency)}</b>\n💳 Fiat disponible: <b>${money(trading.fiatBalance(contribution.coin))} ${escapeHtml(currency)}</b>`,
    "El aporte se publicará al confirmar.",
  );
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
  return blocks(
    "<b>💼 Mis ofertas abiertas</b>",
    offers.length
      ? offers.slice(0, 8).map((offer, index) => ownOfferCard({
          ...offer,
          ...(offer.updatedAt === undefined ? {} : { updated_at: offer.updatedAt }),
        }, index + 1)).join("\n\n")
      : "Sin ofertas locales guardadas.",
    refreshError ? "⚠️ No se pudo actualizar: " + escapeHtml(refreshError) : "",
    notice ? `📌 ${escapeHtml(notice)}` : "",
  );
}

function ownOffersKeyboard(
  offers: ReturnType<DashboardReadModel["localSnapshot"]>["ownOffers"],
): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  for (const [index, offer] of offers.slice(0, 6).entries())
    keyboard
      .text(`🔄 Refrescar #${index + 1}`, `refresh:${offer.uuid}`)
      .text(`✖ Cancelar #${index + 1}`, `cancelown:${offer.uuid}`)
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
    if (errors[side]) return `• ${label}: ⚠️ ${escapeHtml(errors[side]!)}`;
    if (!observation) return `• ${label}: actualizando…`;
    const median = observation.data.median === undefined
      ? "sin mediana"
      : money(observation.data.median) + " (" + observation.data.samples + " ofertas de " + (side === "buy" ? "compra" : "venta") + ")";
    return `• ${label}: ${median} · ${relativeTime(observation.updatedAt)}`;
  };
  const shown = market.offers.slice(0, 8);
  return blocks(
    `<b>🔎 Mercado P2P · ${escapeHtml(trading.marketLabel(coin))}</b>`,
    `<b>📊 Medianas observadas</b>\n${sideText("buy")}\n${sideText("sell")}`,
    `Mostrando <b>${shown.length} de ${market.total}</b> ofertas abiertas.`,
    shown.length ? shown.map((item, index) => marketViewCard(item, coin, index + 1)).join("\n\n") : "Sin ofertas locales guardadas.",
  );
}

function marketViewCard(
  item: ReturnType<DashboardReadModel["localSnapshot"]>["market"][FiatMarket]["offers"][number],
  coin: FiatMarket,
  index: number,
): string {
  const title = item.type === "sell" ? "🟢 COMPRAR QUSD" : "🔵 VENDER QUSD";
  const tag = item.decision === "auto_buy"
    ? "✅ Autoelegible"
    : item.decision === "manual_sell"
      ? "👆 Acción manual"
      : "— Descartada";
  const currency = escapeHtml(trading.marketCurrency(coin));
  return `<b>${index}. ${title}</b>\n💰 Importe: <b>${money(item.amount)} QUSD</b>\n💱 Tasa: <b>${money(item.rate)} ${currency}/QUSD</b>\n💸 Total: <b>${money(item.receive)} ${currency}</b>\n${tag}: ${escapeHtml(item.reason)}\n🆔 <code>${escapeHtml(item.uuid)}</code>`;
}

function marketKeyboard(
  offers: ReturnType<DashboardReadModel["localSnapshot"]>["market"][FiatMarket]["offers"],
): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  for (const [index, item] of offers.entries())
    if (item.decision === "manual_sell" && index < 8)
      keyboard.text(`👆 Aplicar #${index + 1}`, "apply:" + item.uuid).row();
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
        `🪙 <b>${escapeHtml(market.label)}</b>\n• Comprar hasta: <b>${money(market.buyMaxRate)} ${escapeHtml(market.currency)}/QUSD</b>\n• Vender desde: <b>${money(market.sellMinRate)} ${escapeHtml(market.currency)}/QUSD</b>\n• Saldo fiat: <b>${money(state.fiat[market.code] ?? 0)} ${escapeHtml(market.currency)}</b>`,
    );
  const text = blocks(
    "<b>⚙️ Estrategia activa</b>",
    markets.join("\n\n"),
    `🛡 Reserva: <b>${money(trading.strategy().reserve)} QUSD</b>\n🔄 Refresco: <b>${state.refresh ? "activo" : "apagado"}</b>`,
    `Para ajustar: <code>/fiat ${marketHint()} IMPORTE</code> · <code>/refresh on|off</code>`,
  );
  return render(ctx, text, backKeyboard());
}

async function confirmOwnCancel(ctx: Context, uuid: string): Promise<void> {
  return render(
    ctx,
    blocks("<b>⚠️ Cancelar oferta propia</b>", `🆔 <code>${escapeHtml(uuid)}</code>`, "La oferta dejará de estar disponible. QvaPay gestionará los fondos según su estado.", "Confirma solo si deseas cancelarla."),
    new InlineKeyboard()
      .text("✖ Sí, cancelar", `confirmcancel:${uuid}`)
      .text("‹ Volver", "panel:mine"),
  );
}
async function confirmOperationCancel(ctx: Context, uuid: string): Promise<void> {
  const operation = store.getOperation(uuid);
  if (!canCancelOperation(operation)) throw new Error("Esta operación ya no se puede cancelar.");
  if (store.hasUnresolvedMutationForOffer(uuid)) throw new Error("Esta operación está pendiente de conciliación.");
  return render(ctx,
    blocks("<b>⚠️ Cancelar operación</b>", `💰 <b>${money(operation!.amount)} QUSD</b> · ${escapeHtml(trading.marketLabel(operation!.coin))}\n🆔 <code>${escapeHtml(uuid)}</code>`, operation!.orderUuid && operation!.offerType === "buy" ? "Cancelar esta orden abre una disputa en QvaPay. Los fondos siguen comprometidos hasta su resolución." : "QvaPay comprobará el estado antes de cancelar. Confirma solo si deseas continuar."),
    new InlineKeyboard().text("✖ Sí, cancelar", `confirmopcancel:${uuid}`).text("‹ Volver", "panel:operations"),
  );
}
async function confirmApply(ctx: Context, uuid: string): Promise<void> {
  return render(
    ctx,
    blocks("<b>👆 Aplicar manualmente</b>", `🆔 Oferta: <code>${escapeHtml(uuid)}</code>`, "Aplicar a una oferta de compra compromete QUSD. Confirma solo si deseas continuar."),
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
    .text("⚙️ Estrategia", "panel:strategy")
    .text("🔎 Conciliaciones", "recovery:list");
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
}, index: number): string {
  const label = offer.type === "buy" ? "🔵 COMPRA" : "🟢 VENTA";
  const coin = trading.isMarket(offer.coin) ? offer.coin : defaultMarket();
  const currency = trading.marketCurrency(coin);
  const refreshed = trading.lastRefresh(offer.uuid);
  return `<b>${index}. ${label} · ${escapeHtml(trading.marketLabel(coin))}</b>\n💰 Importe: <b>${money(offer.amount)} QUSD</b>\n💱 Tasa: <b>${money(offer.receive / offer.amount)} ${escapeHtml(currency)}/QUSD</b>\n💸 Total: <b>${money(offer.receive)} ${escapeHtml(currency)}</b>\n📍 ${escapeHtml(offer.status)} · ${relativeTime(offer.updated_at)}\n🔄 Refresco: ${refreshed ? relativeTime(refreshed) : "pendiente"}\n🆔 <code>${escapeHtml(offer.uuid)}</code>`;
}
function logsText(): string {
  const logs = trading.logs();
  return blocks(
    "<b>📜 Eventos recientes</b>",
    logs.length
      ? logs
          .map(
            (log) =>
              `• <b>${escapeHtml(log.action)}</b> · ${relativeTime(log.createdAt)}\n  ${escapeHtml(log.detail)}`,
          )
          .join("\n\n")
      : "No hay eventos registrados.",
  );
}
function scanSummary(result: {
  inspected: number;
  candidates: number;
  action?: string;
}): string {
  return blocks("<b>🔎 Escaneo terminado</b>", `📊 Ofertas revisadas: <b>${result.inspected}</b>\n🎯 Candidatas: <b>${result.candidates}</b>`, result.action ? `✅ ${escapeHtml(result.action)}` : "");
}
async function execute(
  ctx: Context,
  action: () => Promise<string>,
): Promise<void> {
  try {
    await ctx.reply(await action(), { parse_mode: "HTML" });
  } catch (error) {
    await ctx.reply(
      `<b>⚠️ Acción no completada</b>\n\n${escapeHtml(errorMessage(error))}`,
      { parse_mode: "HTML" },
    );
  }
}
async function createOffer(ctx: Context, type: "buy" | "sell"): Promise<void> {
  await execute(ctx, async () => {
    const [marketText, amountText, rateInput] = argumentsOf(ctx.msg?.text);
    const coin = parseMarket(marketText);
    const amount = Number(amountText),
      fiatRate = Number(rateInput);
    if (!coin || !Number.isFinite(amount) || !Number.isFinite(fiatRate))
      throw new Error(`Uso: /create${type} ${marketHint()} QUSD TASA_FIAT`);
    const offer = await trading.createOwnOffer(coin, type, amount, fiatRate);
    return blocks(`<b>✅ Oferta de ${type === "buy" ? "compra" : "venta"} creada</b>`, `🪙 Mercado: <b>${escapeHtml(trading.marketLabel(coin))}</b>\n💰 Importe: <b>${money(amount)} QUSD</b>\n💱 Tasa: <b>${rateText(fiatRate)} ${escapeHtml(trading.marketCurrency(coin))}/QUSD</b>`, `🆔 <code>${escapeHtml(offer.uuid)}</code>`);
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
function operationStateLabel(state: string): string {
  const labels: Record<string, string> = {
    applied: "pendiente de pago", acknowledged: "pendiente de pago",
    paid: "pago registrado", revision: "en revisión",
    cancelled: "cancelada", completed: "completada", failed: "fallida",
  };
  return labels[state] ?? escapeHtml(state);
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
function blocks(...parts: string[]): string {
  return parts.filter(Boolean).join("\n\n");
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
  return blocks(
    "<b>❓ Ayuda de QvaApply</b>",
    "Abre <b>Menú</b> para gestionar cacerías, mercados, ofertas y operaciones con botones.",
    `<b>🎯 Cacerías y mercados</b>\n<code>/hunting</code> · estado y tasas\n<code>/network</code> · red cooperativa\n<code>/market ${markets}</code> · ofertas de un mercado`,
    `<b>💼 Ofertas propias</b>\n<code>/createbuy ${markets} QUSD TASA</code>\n<code>/createsell ${markets} QUSD TASA</code>\n<code>/editoffer UUID QUSD TASA</code>\n<code>/canceloffer UUID</code>`,
    "<b>💸 Operaciones</b>\n<code>/recovery</code> · conciliaciones y evidencia\n<code>/paid UUID ID</code> · registrar pago\n<code>/received UUID</code> · confirmar recepción\n<code>/cancel UUID</code> · cancelar operación",
    `<b>⚙️ Ajustes</b>\n<code>/fiat ${markets} IMPORTE</code> · declarar saldo\n<code>/refresh on|off</code> · refresco de ofertas\n<code>/pause</code> · pausar cacerías\n<code>/resume</code> · reanudarlas`,
  );
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
  await notifications.deliverDue();
  store.close();
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));
