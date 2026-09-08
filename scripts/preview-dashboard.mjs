import { buildDashboard } from "../dist/http-dashboard.js";

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
  reviewedAt: now,
};
const markets = [
  { code: "BANK_CUP", label: "Transferencia CUP", currency: "CUP", active: true, fiatBalance: 45000, buyMaxRate: 930, sellMinRate: 1010, purchaseMaxQusd: 25, sellFeePercent: 0, paymentDetails: [{ name: "Cuenta", value: "•••• 1234" }] },
  { code: "BANDECPREPAGO", label: "USD Prepago", currency: "USD", active: true, fiatBalance: 110, buyMaxRate: 1.06, sellMinRate: 1.12, purchaseMaxQusd: 25, sellFeePercent: 0.25, paymentDetails: [] },
];
const automation = { scanIntervalSeconds: 15, autoCancelMinutes: 10, offerRefreshIntervalMinutes: 5, priceGuardPercent: 15, welcomeMessage: "Oferta aplicada por un bot. El pago fiat lo realiza manualmente el usuario." };
const config = { version: 3, qusdReserve: 10, maxOpenOffers: 10, automation, risk, markets };
const operation = { uuid: "op-demo-01", offerType: "buy", coin: "BANK_CUP", amount: 20, receive: 20400, rate: 1020, state: "applied", autoApplied: true, cancelAt: null, createdAt: now - 120000 };
const workflow = { id: "workflow-demo-01", targetOffer: { ...operation, type: "buy", status: "processing" }, riskDecision: { kind: "apply", reasons: ["Todos los límites pasaron."], checks: [] }, state: "applied", error: null, createdAt: now - 120000, updatedAt: now - 90000 };
const snapshot = {
  generatedAt: now,
  balance: 68.5,
  state: { paused: true, mode: "simulation", fiat: { BANK_CUP: 45000, BANDECPREPAGO: 110 }, refresh: false, active: 1, lastScan: { at: now - 30000, inspected: 38, candidates: 3, result: "Sin aplicación" } },
  ownOffers: [{ uuid: "own-01", type: "sell", coin: "BANK_CUP", amount: 25, receive: 25000, rate: 1000, status: "open", updatedAt: new Date(now).toISOString() }],
  market: {
    BANK_CUP: { total: 28, offers: [{ uuid: "market-01", type: "buy", coin: "BANK_CUP", amount: 20, receive: 20400, rate: 1020, status: "open", decision: "manual_sell", reason: "Venta elegible" }] },
    BANDECPREPAGO: { total: 10, offers: [{ uuid: "market-02", type: "sell", coin: "BANDECPREPAGO", amount: 15, receive: 15.6, rate: 1.04, status: "open", decision: "auto_buy", reason: "Compra automática elegible" }] },
  },
  averages: { BANK_CUP: { average_buy: 1015, average_sell: 930 }, BANDECPREPAGO: { average_buy: 1.12, average_sell: 1.05 } },
  transactions: [], strategy: { buyMax: { BANK_CUP: 930, BANDECPREPAGO: 1.06 }, sellMin: { BANK_CUP: 1010, BANDECPREPAGO: 1.12 }, reserve: 10, maxOpenOffers: 10 },
  markets: markets.map(({ paymentDetails, ...market }) => ({ ...market, paymentDetailsCount: paymentDetails.length })),
  availability: { qusd: { reported: 68.5, reserve: 10, available: 58.5, committedSell: 25 }, fiat: { BANK_CUP: { declared: 45000, committed: 0, available: 45000 }, BANDECPREPAGO: { declared: 110, committed: 0, available: 110 } } },
  discoveredMarkets: [], budget: {}, history: [], marketHistory: [],
  rankings: { rotation: [{ code: "BANK_CUP", label: "Transferencia CUP", observed: 210, eligible: 12 }], potential: [{ buy: "BANDECPREPAGO", sell: "BANK_CUP", amount: 15, profit: 450, marginPercent: 2.1 }] },
  activity: [{ createdAt: now - 30000, action: "scan", uuid: null, detail: "38 ofertas revisadas; sin mutaciones." }], alerts: [],
  risk: { limits: risk, usage: { exposureQusd: 20, dailyAppliedQusd: 35, activeOperations: 1, unresolvedMutation: false, emergencyStop: false } },
  recoverableWorkflows: [], workflows: [workflow], workflowOffers: {},
  capitalReservations: [{ workflowId: workflow.id, market: "BANK_CUP", amount: 20, state: "released", createdAt: now - 120000, releasedAt: now - 90000 }],
  mutationIntents: [{ intentId: "intent-demo", operationUuid: operation.uuid, kind: "apply", state: "confirmed", request: {}, createdAt: now - 100000, updatedAt: now - 90000 }],
  operations: [operation], integrity: { schemaVersion: 6, configRevisionChainValid: true },
  freshness: { balance: now, ownOffers: now, transactions: now, markets: { BANK_CUP: now, BANDECPREPAGO: now } },
};

const model = {
  snapshot: async () => snapshot,
  localSnapshot: () => snapshot,
  refreshBalance: async () => { throw new Error("QvaPay no respondió en la simulación de red lenta"); },
  refreshOwnOffers: async () => ({ data: snapshot.ownOffers, updatedAt: Date.now() }),
  refreshTransactions: async () => ({ data: snapshot.transactions, updatedAt: Date.now() }),
  refreshMarket: async (coin) => ({ data: snapshot.market[coin], updatedAt: Date.now() }),
  marketAnalytics: (coin) => ({ coin, history: snapshot.marketHistory }),
  config: () => config,
  configRevisions: () => [{ id: 1, createdAt: now, source: "preview", reason: "Datos de demostración", config, previousHash: null, hash: "0123456789abcdef" }],
  auditLog: () => snapshot.activity,
  setPaused: (value) => { snapshot.state.paused = value; },
  setMode: (value) => { snapshot.state.mode = value; },
  setRefresh: (value) => { snapshot.state.refresh = value; },
  setEmergencyStop: (value) => { snapshot.risk.usage.emergencyStop = value; snapshot.state.paused ||= value; },
};
const origin = `http://127.0.0.1:${port}`;
const app = buildDashboard(model, { password: "preview-segura-2026", trustedOrigin: origin });
await app.listen({ host: "127.0.0.1", port });
console.log(`Preview: ${origin} · contraseña: preview-segura-2026`);
