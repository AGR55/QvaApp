import { buildDashboard } from "../dist/http-dashboard.js";
import { buildTradingAnalytics } from "../dist/trading-analytics.js";

const port = Number(process.env.QVAAPPLY_PREVIEW_PORT || 3100);
if (!Number.isInteger(port) || port < 1024 || port > 65535)
  throw new Error("QVAAPPLY_PREVIEW_PORT debe ser un puerto válido.");
const now = Date.now();
const risk = {
  maxQusdPerOperation: 25,
  maxConcurrentQusdExposure: 50,
  maxDailyAppliedQusd: 100,
  maxConcurrentOperations: 2,
  minQusdReserve: 10,
  maxQuoteAgeSeconds: 45,
  minExpectedMarginPercent: 0.5,
  maxSlippagePercent: 1,
  maxConsecutiveErrors: 3,
  marketCooldownSeconds: 60,
  counterpartyCooldownSeconds: 300,
  reviewedAt: null,
};
const markets = [
  { code: "BANK_CUP", label: "Transferencia CUP", currency: "CUP", active: true, huntBuyEnabled: true, huntSellEnabled: true, fiatBalance: 45000, buyMaxRate: 930, sellMinRate: 1010, purchaseMaxQusd: 25, sellFeePercent: 0, outgoingTransferFee: 0, paymentDetails: [{ name: "Cuenta", value: "•••• 1234" }] },
  { code: "BANDECPREPAGO", label: "USD Prepago", currency: "USD", active: true, huntBuyEnabled: false, huntSellEnabled: false, fiatBalance: 110, buyMaxRate: 1.06, sellMinRate: 1.12, purchaseMaxQusd: 25, sellFeePercent: 0.25, outgoingTransferFee: 0, paymentDetails: [] },
  { code: "CLASICA", label: "Tarjeta Clásica", currency: "USD", active: true, huntBuyEnabled: true, huntSellEnabled: true, fiatBalance: 40, buyMaxRate: 1.04, sellMinRate: 1.12, purchaseMaxQusd: 25, sellFeePercent: 0, outgoingTransferFee: 0.08, paymentDetails: [{ name: "Tarjeta", value: "•••• 9876" }] },
];
const analyticsTransactions = Array.from({ length: 90 }, (_, i) => markets.flatMap((market, m) => {
  const amount = 8 + (i * 7 + m * 3) % 23;
  const price = market.currency === "CUP" ? 950 : 1.04;
  const at = now - (89 - i) * 86_400_000 - 7_200_000;
  return ["buy", "sell"].map((side, offset) => ({
    uuid: `preview-tx-${i}-${m}-${side}`, amount, createdAt: at + offset * 3_600_000,
    updatedAt: at + offset * 3_600_000, payerUuid: side === "sell" ? "preview-me" : "preview-other",
    recipientUuid: side === "buy" ? "preview-me" : "preview-other",
    p2p: { uuid: `preview-offer-${i}-${m}-${side}`, coin: market.code, amount,
      receive: amount * (side === "buy" ? price : price * (1.035 + i % 3 * .008)), status: "completed" },
  }));
})).flat();
const analyticsBalances = Array.from({ length: 90 }, (_, i) => ({
  createdAt: now - (89 - i) * 86_400_000, qusdBalance: 45 + i * .6 + Math.sin(i / 3) * 12,
  openOffers: 3, activeOperations: 1,
}));
const portfolioHistory = analyticsBalances.map((point, index) => ({ createdAt: point.createdAt,
  qusdFree: point.qusdBalance, qusdCommitted: 23 + index % 4,
  fiatQusd: 95 + index * .8, totalQusd: point.qusdBalance + 23 + index % 4 + 95 + index * .8 }));
const marketHistory = markets.flatMap((market, marketIndex) =>
  Array.from({ length: 12 }, (_, index) => {
    const base = market.currency === "CUP" ? 64_180 : 1.04 + marketIndex * .01;
    const increment = market.currency === "CUP" ? 3 : .0004;
    return {
      coin: market.code,
      medianBuy: base + index * increment + (index % 3) * increment * .5,
      medianSell: base + increment * 8 + index * increment * .7 - (index % 2) * increment,
      createdAt: now - (11 - index) * 5 * 60_000,
    };
  }),
);
const automation = { scanIntervalSeconds: 15, autoCancelMinutes: 10, offerRefreshIntervalMinutes: 5, priceGuardPercent: 15, welcomeMessage: "Oferta aplicada por un bot. El pago fiat lo realiza manualmente el usuario." };
const hunting = { buyRunning: true, sellRunning: true };
const config = { version: 3, qusdReserve: 10, maxOpenOffers: 10, hunting, automation, risk, markets };
const operation = { uuid: "op-demo-01", offerType: "buy", coin: "BANK_CUP", amount: 20, receive: 20400, rate: 1020, referenceRate: 1012, state: "applied", autoApplied: true, cancelAt: null, createdAt: now - 120000 };
const workflow = { id: "workflow-demo-01", targetOffer: { ...operation, type: "buy", status: "processing" }, riskDecision: { kind: "apply", reasons: ["Todos los límites pasaron."], checks: [] }, state: "applied", error: null, createdAt: now - 120000, updatedAt: now - 90000 };
const previewLogs = [
  { id: 1, createdAt: now - 280_000, action: "startup_reconciliation", uuid: null, detail: "5 flujos revisados; 5 requieren atención.", level: "warning", component: "system" },
  { id: 2, createdAt: now - 210_000, action: "scan_complete", uuid: null, detail: "379 ofertas · 0 candidatas · Sin aplicación", level: "info", component: "trading" },
  { id: 3, createdAt: now - 150_000, action: "opportunity_applied", uuid: "op-demo-01", detail: "Aplicación automática confirmada.", level: "success", component: "trading" },
  { id: 4, createdAt: now - 92_000, action: "fiat_sync_background_error", uuid: null, detail: "QvaPay no respondió dentro del tiempo esperado. Comprueba tu conexión e inténtalo de nuevo.", level: "error", component: "qvapay" },
  { id: 5, createdAt: now - 45_000, action: "price_guard_block", uuid: "blocked-demo-01", detail: "4.2% por encima de la mediana de compra.", level: "warning", component: "trading" },
  { id: 6, createdAt: now - 8_000, action: "market_reader_added", uuid: null, detail: "Cuenta lectora añadida: Exploradora secundaria.", level: "success", component: "system" },
];
const snapshot = {
  generatedAt: now,
  balance: 68.5,
  state: {
    paused: true,
    mode: "simulation",
    fiat: { BANK_CUP: 45000, BANDECPREPAGO: 110, CLASICA: 40 },
    refresh: false,
    active: 1,
    lastScan: { at: now - 30000, inspected: 38, candidates: 3, result: "Sin aplicación" },
    scanCoverage: {
      at: now - 30000,
      includedBuySide: true,
      markets: [
        { coin: "BANK_CUP", sides: ["sell", "buy"], total: 28, eligible: 2, blocked: 1 },
        { coin: "BANDECPREPAGO", sides: ["sell", "buy"], total: 10, eligible: 1, blocked: 0 },
      ],
    },
    mutationBudget: { applyReadyAt: now - 1, editReadyAt: now - 1, cancelReadyAt: now - 1 },
  },
  ownOffers: [{ uuid: "own-01", type: "buy", coin: "CLASICA", amount: 10, receive: 10.4, rate: 1.04, status: "open", updatedAt: new Date(now).toISOString() }],
  market: {
    BANK_CUP: { total: 28, offers: [{ uuid: "market-01", type: "buy", coin: "BANK_CUP", amount: 20, receive: 20400, rate: 1020, status: "open", decision: "manual_sell", reason: "Venta elegible" }] },
    BANDECPREPAGO: { total: 10, offers: [{ uuid: "market-02", type: "sell", coin: "BANDECPREPAGO", amount: 15, receive: 15.6, rate: 1.04, status: "open", decision: "auto_buy", reason: "Compra automática elegible" }] },
    CLASICA: { total: 12, offers: [{ uuid: "market-03", type: "sell", coin: "CLASICA", amount: 12, receive: 12.48, rate: 1.04, status: "open", decision: "auto_buy", reason: "Compra automática elegible" }] },
  },
  averages: { BANK_CUP: { average_buy: 1015, average_sell: 930, median_buy: 1012, median_sell: 932 }, BANDECPREPAGO: { average_buy: 1.12, average_sell: 1.05, median_buy: 1.115, median_sell: 1.047 }, CLASICA: { average_buy: 1.12, average_sell: 1.04, median_buy: 1.11, median_sell: 1.04 } },
  hunting, automation,
  transactions: [], strategy: { buyMax: { BANK_CUP: 930, BANDECPREPAGO: 1.06 }, sellMin: { BANK_CUP: 1010, BANDECPREPAGO: 1.12 }, reserve: 10, maxOpenOffers: 10 },
  markets: markets.map(({ paymentDetails, ...market }) => ({ ...market, paymentDetailsCount: paymentDetails.length })),
  availability: { qusd: { reported: 68.5, reserve: 10, available: 58.5, committedSell: 0 }, fiat: { BANK_CUP: { declared: 45000, committed: 0, available: 45000 }, BANDECPREPAGO: { declared: 110, committed: 0, available: 110 }, CLASICA: { declared: 8, committed: 10.48, available: 0 } } },
  discoveredMarkets: [], budget: {
    CLASICA: {
      coin: "CLASICA", available: 8, committed: 10.48, deficit: 2.48, invalid: [],
      adjustments: [{ uuid: "own-01", coin: "CLASICA", rate: 1.04, currentQusd: 10, proposedQusd: 7.61, currentFiat: 10.48, proposedFiat: 7.9944, releasedFiat: 2.4856, action: "edit" }],
    },
  }, history: analyticsBalances, marketHistory,
  rankings: { rotation: [{ code: "BANK_CUP", label: "Transferencia CUP", observed: 210, eligible: 12 }], potential: [{ buy: "BANDECPREPAGO", sell: "BANK_CUP", amount: 15, profit: 450, marginPercent: 2.1 }] },
  activity: [{ createdAt: now - 30000, action: "price_guard_block", uuid: "blocked-demo-01", detail: "4.2% por encima de la mediana de compra." }],
  alerts: [{ uuid: "blocked-demo-01", coin: "BANK_CUP", offerType: "buy", amount: 20, receive: 21080, rate: 1054, referenceRate: 1012, decision: "blocked", reason: "4.2% por encima de la mediana de compra", createdAt: now - 60000, updatedAt: now - 30000, resolvedAt: null }],
  risk: { limits: risk, usage: { exposureQusd: 20, dailyAppliedQusd: 35, activeOperations: 1, unresolvedMutation: false, emergencyStop: false } },
  recoverableWorkflows: [], workflows: [workflow], workflowOffers: {},
  capitalReservations: [{ workflowId: workflow.id, market: "BANK_CUP", amount: 20, state: "released", createdAt: now - 120000, releasedAt: now - 90000 }],
  cooperativeNetwork: {
    enabled: true,
    httpConnected: true,
    natsConnected: true,
    snapshot: {
      BANK_CUP: { coin: "BANK_CUP", fiat: 125000, price: 985, minimal: 5000, offersCount: 4 },
      BANDECPREPAGO: { coin: "BANDECPREPAGO", fiat: 430, price: 1.08, minimal: 20, offersCount: 3 },
    },
    contributions: {
      BANK_CUP: { coin: "BANK_CUP", fiat: 45000, minimal: 5000, price: 980, state: "confirmed", updatedAt: now - 15000 },
    },
    lastHttpAt: now - 30000,
    lastNatsAt: now - 15000,
    lastError: null,
  },
  mutationIntents: [{ intentId: "intent-demo", operationUuid: operation.uuid, kind: "apply", state: "confirmed", request: {}, createdAt: now - 100000, updatedAt: now - 90000 }],
  operations: [operation], integrity: { schemaVersion: 10, configRevisionChainValid: true },
  freshness: { balance: now, ownOffers: now, transactions: now, markets: { BANK_CUP: now, BANDECPREPAGO: now } },
};

let previewDecisionDismissed = false;
snapshot.cooperativeHunting = { enabled: true, qusdOwed: 6, executions: [{
  offer: { uuid: "cooperative-demo", coin: "BANK_CUP", type: "sell", status: "completed", amount: 10, receive: 9500 },
  phase: "completed", credited: true, createdAt: now - 180000, updatedAt: now,
  reservation: { externalId: "cooperative-demo", state: "completed", ownerFiat: 3800, contributions: [{ userId: "preview-friend", fiat: 5700, qusd: 6 }] },
}] };
let previewRecovery = [{ intentId: "preview-uncertain-apply", kind: "apply", state: "uncertain",
  operationUuid: "preview-external-offer", createdAt: now - 600000, updatedAt: now - 590000,
  error: "HTTP 404: No tienes permisos para ver esta oferta", manualEligible: true,
  retry: { attempts: 3, nextAttemptAt: now + 60000, eligible: false } }];
let previewChatRead = false;
const previewChatMessages = [
  { id: "chat-1", peerId: "preview-counterparty", sender: "counterparty", message: "Hola, confirmo los datos de pago.", createdAt: now - 85_000 },
  { id: "chat-2", peerId: "preview-me", sender: "own", message: "Perfecto, reviso la transferencia ahora.", createdAt: now - 45_000 },
];
const previewChatView = () => ({ uuid: "op-demo-01", messages: previewChatMessages, updatedAt: Date.now(), stale: false, unreadCount: previewChatRead ? 0 : 1 });
const model = {
  operationChatUnread: () => ({ "op-demo-01": previewChatRead ? 0 : 1 }),
  readOperationChat: () => previewChatView(),
  refreshOperationChat: async () => previewChatView(),
  markOperationChatRead: () => { previewChatRead = true; return previewChatView(); },
  sendOperationChat: async (_uuid, message) => {
    const id = `chat-${previewChatMessages.length + 1}`;
    previewChatMessages.push({ id, peerId: "preview-me", sender: "own", message, createdAt: Date.now() });
    return { id, chat: previewChatView() };
  },
  setCooperativeHunting: enabled => { snapshot.cooperativeHunting.enabled = enabled; },
  checkCooperativeHunting: async () => undefined,
  markCooperativeDistributed: uuid => {
    snapshot.cooperativeHunting.executions = snapshot.cooperativeHunting.executions.filter(job => job.offer.uuid !== uuid);
    snapshot.cooperativeHunting.qusdOwed = 0;
  },
  tradingAnalytics: (days = 30) => ({
    ...buildTradingAnalytics({ transactions: analyticsTransactions, accountUuid: "preview-me", fiat: [], markets, days, now }),
    balanceHistory: analyticsBalances.filter((point) => point.createdAt >= now - days * 86_400_000),
    portfolioHistory: portfolioHistory.filter((point) => point.createdAt >= now - days * 86_400_000),
    portfolioStatus: { reason: null, updatedAt: now },
    sync: { accountKnown: true, complete: true, limited: false, pages: 18, updatedAt: now },
  }),
  recoveryItems: () => ({ items: previewRecovery, blocked: previewRecovery.length > 0 }),
  checkRecoveryIntent: async (intentId) => ({ intentId, outcome: "pending", state: "uncertain", message: "No se obtuvo evidencia concluyente. Verifica el resultado en QvaPay.", updatedAt: now - 590000 }),
  resolveRecoveryIntent: ({ intentId }) => {
    previewRecovery = previewRecovery.filter(item => item.intentId !== intentId);
    return { intentId, state: "reconciled", actor: "admin_web" };
  },
  snapshot: async () => snapshot,
  localSnapshot: () => snapshot,
  smsDevices: () => [],
  paymentReceipts: () => [],
  pairSmsDevice: (label) => ({ device: { id: "preview-device", label, createdAt: Date.now(), revokedAt: null }, token: "preview-only-token" }),
  revokeSmsDevice: () => true,
  refreshBalance: async () => ({ data: snapshot.balance, updatedAt: Date.now() }),
  refreshOwnOffers: async () => ({ data: snapshot.ownOffers, updatedAt: Date.now() }),
  refreshTransactions: async () => ({ data: snapshot.transactions, updatedAt: Date.now() }),
  refreshMarket: async (coin) => ({ data: snapshot.market[coin], updatedAt: Date.now() }),
  marketAnalytics: async (coin) => {
    if (coin !== "BANK_CUP") await new Promise((resolve) => setTimeout(resolve, 350));
    return { coin, history: snapshot.marketHistory.filter((point) => point.coin === coin) };
  },
  config: () => config,
  configRevisions: () => [{ id: 1, createdAt: now, source: "preview", reason: "Datos de demostración", config, previousHash: null, hash: "0123456789abcdef" }],
  auditLog: () => snapshot.activity,
  operationalLogs: ({ after = 0, limit = 100, level, component, query } = {}) => {
    const normalizedQuery = query?.toLowerCase();
    const items = previewLogs.filter((item) =>
      item.id > after &&
      (!level || item.level === level) &&
      (!component || item.component === component) &&
      (!normalizedQuery || `${item.action} ${item.detail} ${item.uuid || ""}`.toLowerCase().includes(normalizedQuery))
    );
    return {
      items: after ? items.slice(0, limit) : items.slice(-limit).reverse(),
      hasMore: items.length > limit,
      newestId: previewLogs.at(-1).id,
    };
  },
  decisionEvents: ({ page = 1, pageSize = 20 } = {}) => ({
    items: previewDecisionDismissed ? [] : [{ id: 1, version: "preview-blocked-v1", ...snapshot.alerts[0], checks: [
      { code: "price_policy", label: "Política de precio", status: "fail", actual: "blocked", limit: "eligible", reason: "Supera la protección extrema de mediana." },
      { code: "operation_amount", label: "Importe por operación", status: "pass", actual: 20, limit: 25, reason: "Dentro del límite." },
      { code: "slippage", label: "Deslizamiento", status: "warning", actual: 4.15, limit: 1, reason: "Advertencia informativa; no bloquea por sí sola." },
    ] }],
    total: previewDecisionDismissed ? 0 : 1, pending: previewDecisionDismissed ? 0 : 1, dismissThroughId: 1, page, pageSize,
  }),
  dismissAllDecisionEvents: () => { const dismissed = previewDecisionDismissed ? 0 : 1; previewDecisionDismissed = true; return { dismissed }; },
  dismissDecisionEvent: () => undefined,
  setPaused: (value) => { snapshot.state.paused = value; },
  setMode: (value) => { snapshot.state.mode = value; },
  setRefresh: (value) => { snapshot.state.refresh = value; },
  setEmergencyStop: (value) => { snapshot.risk.usage.emergencyStop = value; snapshot.state.paused ||= value; },
  updateHunting: (values) => {
    if (values.buyRunning !== undefined) hunting.buyRunning = values.buyRunning;
    if (values.sellRunning !== undefined) hunting.sellRunning = values.sellRunning;
    if (values.market) Object.assign(markets.find((item) => item.code === values.market.code), values.market);
    snapshot.markets = markets.map(({ paymentDetails, ...market }) => ({ ...market, paymentDetailsCount: paymentDetails.length }));
  },
  createOwnOffer: async () => snapshot.ownOffers[0],
  editOwnOffer: async () => undefined,
  cancelOwnOffer: async () => undefined,
  budgetRebalancePreview: () => ({ plans: Object.values(snapshot.budget), updatedAt: now }),
  refreshBudgetRebalancePreview: async () => ({ plans: Object.values(snapshot.budget), updatedAt: Date.now() }),
  applyBudgetRebalance: async (adjustments) => ({ applied: adjustments.map((item) => item.uuid) }),
  previewBlockedOffer: async (uuid) => ({ uuid, coin: "BANK_CUP", offerType: "buy", amount: 20, receive: 21080, rate: 1054, referenceRate: 1012, deviationPercent: 4.15, plannedCancellations: [{ uuid: "own-01", amount: 10, rate: 1040 }], liquidityReason: "Se liberarán 10 QUSD de una oferta propia." }),
  applyBlockedOffer: async () => "Aplicación de demostración confirmada.",
  dismissBlockedOffer: () => undefined,
};
let previewReaders = [{
  id: "reader-demo-01",
  label: "Exploradora secundaria",
  role: "reader",
  enabled: true,
  intervalSeconds: 3,
  health: "healthy",
  lastSuccessAt: now - 1_500,
  lastAttemptAt: now - 1_500,
  nextEligibleAt: now + 1_500,
  consecutiveErrors: 0,
  lastError: null,
  createdAt: now - 86_400_000,
  updatedAt: now - 1_500,
}];
const marketAccounts = {
  list: () => previewReaders,
  add: async ({ label, intervalSeconds }) => {
    const account = {
      id: `reader-preview-${previewReaders.length + 1}`,
      label,
      role: "reader",
      enabled: true,
      intervalSeconds,
      health: "healthy",
      lastSuccessAt: Date.now(),
      lastAttemptAt: Date.now(),
      nextEligibleAt: Date.now() + intervalSeconds * 1_000,
      consecutiveErrors: 0,
      lastError: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    previewReaders = [...previewReaders, account];
    return account;
  },
  update: async (id, changes) => {
    previewReaders = previewReaders.map((account) => account.id === id
      ? { ...account, ...changes, updatedAt: Date.now() }
      : account);
    return previewReaders.find((account) => account.id === id);
  },
  rotate: async (id) => {
    const account = previewReaders.find((item) => item.id === id);
    if (account) account.updatedAt = Date.now();
    return account;
  },
  remove: (id) => { previewReaders = previewReaders.filter((account) => account.id !== id); },
};
const marketSource = {
  status: () => ({
    mode: "polling",
    accounts: [
      { id: "primary", label: "Cuenta principal", role: "primary", enabled: true, intervalSeconds: 3, health: "healthy", lastSuccessAt: Date.now() - 500, lastError: null },
      ...previewReaders,
    ],
    healthyAccounts: 1 + previewReaders.filter((account) => account.enabled && account.health === "healthy").length,
    effectiveCadenceSeconds: 3 / (1 + previewReaders.filter((account) => account.enabled && account.health === "healthy").length),
    estimatedRequestsPerMinute: 20 * (1 + previewReaders.filter((account) => account.enabled && account.health === "healthy").length),
    webhookUrl: `${origin}/webhooks/qvapay/p2p-feed`,
    webhookSecretConfigured: false,
    streamCredentialsConfigured: false,
    streamPhase: "idle",
    lastStreamReceivedAt: null,
    lastWebhookReceivedAt: null,
    lastWebhookProcessedAt: null,
    pendingWebhookEvents: 0,
    failedWebhookEvents: 0,
  }),
};
const origin = `http://127.0.0.1:${port}`;
const app = buildDashboard(
  model,
  { password: "preview-segura-2026", trustedOrigin: origin },
  undefined,
  marketAccounts,
  marketSource,
);
await app.listen({ host: "127.0.0.1", port });
console.log(`Preview: ${origin} · contraseña: preview-segura-2026`);
