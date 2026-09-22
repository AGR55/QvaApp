import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { MarketConfigService } from "../src/market-config.js";
import { QvaApiError } from "../src/qvapay.js";
import { Store } from "../src/store.js";
import { TradingEngine } from "../src/trading.js";
import type { P2pOffer } from "../src/types.js";

function setup() {
  const dataDir = mkdtempSync(join(tmpdir(), "qvaapply-scan-integration-"));
  const store = new Store(dataDir);
  const cfg = {
    dataDir,
    initialUsdFiatBalance: 0,
    buyQusdMaxRate: 930,
    sellQusdMinRate: 1_000,
    buyQusdUsdMaxRate: 1.06,
    sellQusdUsdMinRate: 1.12,
    cupPurchaseMaxQusd: 150,
    maxOpenOwnOffers: 10,
    priceGuardPercent: 15,
    qusdReserve: 0,
    realTradingAllowed: true,
    autoCancelMs: 600_000,
    offerRefreshIntervalMs: 300_000,
    paymentDetails: { BANK_CUP: [], BANDECPREPAGO: [] },
  };
  const markets = new MarketConfigService(dataDir, cfg as never, store);
  const next = markets.current();
  next.risk.reviewedAt = Date.now();
  next.markets.forEach((market) => {
    market.active = market.code === "BANK_CUP";
  });
  next.markets[0]!.fiatBalance = 100_000;
  markets.save(next);
  store.set("fiat_balance:BANK_CUP", "100000");
  store.set("paused", "false");
  store.set("mode", "real");
  return { dataDir, store, cfg, markets };
}

test("producción arranca activa y respeta una parada de emergencia", () => {
  const first = setup();
  first.store.set("paused", "true");
  first.store.set("mode", "simulation");
  const active = new TradingEngine(
    first.store,
    {} as never,
    first.cfg as never,
    first.markets,
    async () => undefined,
  );
  active.initializeProductionState();
  assert.equal(active.mode(), "real");
  assert.equal(active.isPaused(), false);
  first.store.close();

  const second = setup();
  second.store.set("emergency_stop", "true");
  second.store.set("paused", "false");
  const stopped = new TradingEngine(
    second.store,
    {} as never,
    second.cfg as never,
    second.markets,
    async () => undefined,
  );
  stopped.initializeProductionState();
  assert.equal(stopped.mode(), "real");
  assert.equal(stopped.isPaused(), true);
  second.store.close();
});

test("el escaneo real libera QUSD retenido aunque la venta propia publique mejor tasa", async () => {
  const { store, cfg, markets } = setup();
  const target: P2pOffer = { uuid: "target-buy", type: "buy", coin: "BANK_CUP", amount: 20, receive: 20_400, status: "open", User: { uuid: "peer" } };
  const own: P2pOffer = { uuid: "own-sell", type: "sell", coin: "BANK_CUP", amount: 20, receive: 20_600, status: "open", details: { cuenta: "123" } };
  const calls: string[] = [];
  const qva = {
    listOffersPage: async () => ({ offers: [target], total: 1, currentPage: 1, perPage: 20 }),
    p2pAverages: async () => ({ BANK_CUP: { average_buy: 1_015, average_sell: 930 } }),
    qusdBalance: async () => 10,
    listOffers: async () => [own],
    getOffer: async () => own,
    cancel: async (uuid: string) => void calls.push(`cancel:${uuid}`),
    apply: async (uuid: string) => void calls.push(`apply:${uuid}`),
  };
  const trading = new TradingEngine(store, qva as never, cfg as never, markets, async () => undefined);

  const result = await trading.scan();

  assert.equal(result.action, "venta aplicada target-buy");
  assert.deepEqual(calls, ["cancel:own-sell", "apply:target-buy"]);
  assert.equal(store.getOperation(target.uuid)?.autoApplied, true);
  assert.equal(store.getOperation(target.uuid)?.referenceRate, 1_020);
  assert.equal(store.getTradeWorkflow(store.tradeWorkflows()[0]!.id)?.state, "applied");
  store.close();
});

test("Clásica bloquea una compra cuya comisión supera la tasa máxima efectiva", async () => {
  const { store, cfg, markets } = setup();
  const next = markets.current();
  next.markets.forEach((market) => {
    market.active = market.code === "CLASICA";
  });
  const classic = next.markets.find((market) => market.code === "CLASICA")!;
  classic.buyMaxRate = 1.06;
  classic.sellMinRate = 1.13;
  classic.outgoingTransferFee = 0.08;
  classic.fiatBalance = 20;
  markets.save(next);
  store.set("fiat_balance:CLASICA", "20");
  const target: P2pOffer = {
    uuid: "classic-fee-too-high",
    type: "sell",
    coin: "CLASICA",
    amount: 2,
    receive: 2.12,
    status: "open",
    User: { uuid: "peer" },
  };
  let applications = 0;
  const qva = {
    listOffersPage: async (params: { type?: string }) => ({
      offers: params.type === "sell" ? [target] : [],
      total: params.type === "sell" ? 1 : 0,
      currentPage: 1,
      perPage: 100,
    }),
    p2pAverages: async () => ({}),
    qusdBalance: async () => 100,
    apply: async () => void (applications += 1),
    sendChat: async () => undefined,
  };
  const trading = new TradingEngine(store, qva as never, cfg as never, markets, async () => undefined);
  store.markSeen(target.uuid);

  const result = await trading.scan();

  assert.equal(applications, 0);
  assert.equal(result.action, undefined);
  assert.match(
    store.decisionEvents({ page: 1, pageSize: 10 }).items[0]?.reason ?? "",
    /tasa efectiva 1\.10.*máximo de compra 1\.06/i,
  );
  store.close();
});

test("permite ajustar el cortafuegos de mediana por mercado sin relajar los demás", async () => {
  const { store, cfg, markets } = setup();
  const next = markets.current();
  next.automation.priceGuardPercent = 25;
  const bank = next.markets.find((market) => market.code === "BANK_CUP")!;
  bank.buyMaxRate = 190;
  bank.sellMinRate = 200;
  const etecsa = {
    ...bank,
    code: "ETECSA",
    label: "ETECSA",
    priceGuardPercent: 60,
  };
  next.markets.push(etecsa);
  markets.save(next);

  const offers = (coin: string): P2pOffer[] =>
    [200, 210, 220.41, 230, 350].map((offerRate, index) => ({
      uuid: `${coin}-${index}`,
      type: "buy",
      coin,
      amount: 2,
      receive: offerRate * 2,
      status: "open",
      User: { uuid: `peer-${index}` },
    }));
  const qva = {
    listOffersPage: async ({ coin }: { coin: string }) => ({
      offers: offers(coin),
      total: 5,
      currentPage: 1,
      perPage: 100,
    }),
    p2pAverages: async () => ({}),
  };
  const trading = new TradingEngine(
    store,
    qva as never,
    cfg as never,
    markets,
    async () => undefined,
  );

  const etecsaSnapshot = await trading.inspectMarketSide("ETECSA", "buy");
  const bankSnapshot = await trading.inspectMarketSide("BANK_CUP", "buy");

  assert.equal(etecsaSnapshot.average?.median_buy, 220.41);
  assert.equal(
    etecsaSnapshot.items.find((item) => item.offer.uuid === "ETECSA-4")?.decision,
    "manual_sell",
  );
  assert.equal(
    bankSnapshot.items.find((item) => item.offer.uuid === "BANK_CUP-4")?.decision,
    "blocked",
  );
  store.close();
});

test("ignora ofertas exclusivas VIP sin intentar aplicar ni sumar errores", async () => {
  const { store, cfg, markets } = setup();
  const target: P2pOffer = {
    uuid: "vip-only",
    type: "sell",
    coin: "BANK_CUP",
    amount: 10,
    receive: 9_200,
    status: "open",
    only_vip: true,
    User: { uuid: "peer" },
  };
  let applications = 0;
  const notifications: string[] = [];
  const qva = {
    listOffersPage: async () => ({ offers: [target], total: 1, currentPage: 1, perPage: 100 }),
    p2pAverages: async () => ({}),
    apply: async () => void (applications += 1),
  };
  const trading = new TradingEngine(
    store,
    qva as never,
    cfg as never,
    markets,
    async (message) => void notifications.push(message),
  );

  await trading.scan();

  assert.equal(applications, 0);
  assert.equal(Number(store.get("consecutive_errors") ?? 0), 0);
  assert.equal(store.decisionEvents({ page: 1, pageSize: 10 }).items.length, 0);
  assert.equal(store.recentTradingAlerts().length, 0);
  assert.deepEqual(notifications, []);
  store.close();
});

test("un rechazo o caída de QvaPay no activa el cortafuegos de errores internos", async () => {
  const { store, cfg, markets } = setup();
  const notifications: string[] = [];
  const qva = {
    listOffersPage: async () => {
      throw new QvaApiError(503, "Servicio P2P temporalmente no disponible");
    },
  };
  const trading = new TradingEngine(
    store,
    qva as never,
    cfg as never,
    markets,
    async (message) => void notifications.push(message),
  );

  await trading.scan();
  await trading.scan();
  await trading.scan();

  assert.equal(Number(store.get("consecutive_errors") ?? 0), 0);
  assert.equal(trading.isPaused(), false);
  assert.match(notifications.at(-1) ?? "", /QvaPay.*HTTP 503.*temporalmente no disponible/i);
  assert.ok(store.countAudit("scan_qvapay_error") >= 3);
  store.close();
});

test("un rechazo definitivo al aplicar queda explicado y no se reintenta", async () => {
  const { store, cfg, markets } = setup();
  const target: P2pOffer = {
    uuid: "account-rejected",
    type: "sell",
    coin: "BANK_CUP",
    amount: 10,
    receive: 9_200,
    status: "open",
    User: { uuid: "peer" },
  };
  const notifications: string[] = [];
  let applications = 0;
  const qva = {
    listOffersPage: async () => ({ offers: [target], total: 1, currentPage: 1, perPage: 100 }),
    p2pAverages: async () => ({}),
    qusdBalance: async () => 100,
    apply: async () => {
      applications += 1;
      throw new QvaApiError(403, "La contraparte bloqueó esta cuenta");
    },
  };
  const trading = new TradingEngine(
    store,
    qva as never,
    cfg as never,
    markets,
    async (message) => void notifications.push(message),
  );

  await trading.scan();
  await trading.scan();

  assert.equal(applications, 1);
  assert.equal(Number(store.get("consecutive_errors") ?? 0), 0);
  assert.match(
    store.decisionEvents({ page: 1, pageSize: 10 }).items[0]?.reason ?? "",
    /QvaPay.*HTTP 403.*bloqueó esta cuenta/i,
  );
  assert.match(notifications.at(-1) ?? "", /Compra automática bloqueada.*QvaPay.*HTTP 403/is);
  store.close();
});

test("concilia una aplicación incierta cuando QvaPay confirma la restricción VIP", async () => {
  const { store, cfg, markets } = setup();
  store.createMutationIntent({
    intentId: "uncertain-vip-apply",
    operationUuid: "vip-restricted-target",
    kind: "apply",
    request: { uuid: "vip-restricted-target", automatic: true },
  });
  store.updateMutationIntent(
    "uncertain-vip-apply",
    "uncertain",
    undefined,
    "No se recibió confirmación de QvaPay",
  );
  const qva = {
    getOffer: async () => {
      throw new QvaApiError(404, "No tienes VIP para ver esta oferta");
    },
  };
  const trading = new TradingEngine(store, qva as never, cfg as never, markets, async () => undefined);

  const reconciled = await trading.reconcilePendingStandaloneMutations();

  assert.equal(reconciled, 1);
  assert.equal(store.hasUnresolvedMutation(), false);
  assert.equal(store.recentMutationIntents(1)[0]?.state, "reconciled");
  assert.ok(store.countAudit("standalone_apply_reconciled") > 0);
  store.close();
});

test("detiene compra y venta por separado sin consultar el lado deshabilitado", async () => {
  const { store, cfg, markets } = setup();
  const queries: string[] = [];
  const qva = {
    listOffersPage: async (params: { type: string }) => {
      queries.push(params.type);
      return { offers: [], total: 0, currentPage: 1, perPage: 100 };
    },
    p2pAverages: async () => ({}),
  };
  const trading = new TradingEngine(store, qva as never, cfg as never, markets, async () => undefined);

  trading.updateHunting({ buyRunning: false, sellRunning: true });
  await trading.scan();
  assert.deepEqual(queries, ["buy"]);

  queries.length = 0;
  trading.updateHunting({ buyRunning: true, sellRunning: false });
  store.set("market_scan_round", "0");
  await trading.scan();
  assert.deepEqual(queries, ["sell"]);

  queries.length = 0;
  trading.updateHunting({
    sellRunning: true,
    market: { code: "BANK_CUP", huntBuyEnabled: false, huntSellEnabled: false },
  });
  store.set("market_scan_round", "0");
  await trading.scan();
  assert.deepEqual(queries, []);
  store.close();
});

test("conserva la selección y los precios de cacería por mercado", () => {
  const { store, cfg, markets, dataDir } = setup();
  const trading = new TradingEngine(store, {} as never, cfg as never, markets, async () => undefined);
  trading.updateHunting({
    market: {
      code: "BANK_CUP",
      huntBuyEnabled: false,
      huntSellEnabled: true,
      buyMaxRate: 925,
      sellMinRate: 1_025,
    },
  });

  const reopened = new MarketConfigService(dataDir, cfg as never, store);
  assert.equal(reopened.find("BANK_CUP")?.huntBuyEnabled, false);
  assert.equal(reopened.find("BANK_CUP")?.huntSellEnabled, true);
  assert.equal(reopened.find("BANK_CUP")?.buyMaxRate, 925);
  assert.equal(reopened.find("BANK_CUP")?.sellMinRate, 1_025);
  assert.ok(store.countAudit("hunting_control") > 0);
  store.close();
});

test("revalida la cacería de compra después de evaluar el riesgo", async () => {
  const { store, cfg, markets } = setup();
  const target: P2pOffer = { uuid: "stopped-before-apply", type: "sell", coin: "BANK_CUP", amount: 10, receive: 9_200, status: "open", User: { uuid: "peer" } };
  let applications = 0;
  let trading: TradingEngine;
  const qva = {
    listOffersPage: async (params: { type?: string }) => ({ offers: params.type === "sell" ? [target] : [], total: 1, currentPage: 1, perPage: 100 }),
    p2pAverages: async () => ({}),
    qusdBalance: async () => {
      trading.updateHunting({ buyRunning: false });
      return 100;
    },
    apply: async () => void (applications += 1),
  };
  trading = new TradingEngine(store, qva as never, cfg as never, markets, async () => undefined);

  const result = await trading.scan();

  assert.equal(result.action, "error");
  assert.equal(applications, 0);
  assert.equal(store.getOperation(target.uuid), undefined);
  store.close();
});

test("consulta hasta cien ofertas por lado y ordena por mejor tasa", async () => {
  const { store, cfg, markets } = setup();
  const queries: Record<string, unknown>[] = [];
  const qva = {
    listOffersPage: async (params: Record<string, unknown>) => {
      queries.push(params);
      return { offers: [], total: 0, currentPage: 1, perPage: 100 };
    },
    p2pAverages: async () => ({ BANK_CUP: { average_buy: 1_015, average_sell: 930 } }),
  };
  const trading = new TradingEngine(store, qva as never, cfg as never, markets, async () => undefined);

  await trading.scan();
  await trading.scan();

  assert.deepEqual(queries.map(({ take, type, orderBy, orderType }) => ({ take, type, orderBy, orderType })), [
    { take: 100, type: "sell", orderBy: "best_rate", orderType: "desc" },
    { take: 100, type: "buy", orderBy: "best_rate", orderType: "desc" },
    { take: 100, type: "sell", orderBy: "best_rate", orderType: "desc" },
  ]);
  store.close();
});

test("el cooldown queda visible como advertencia y no pierde la mejor compra", async () => {
  const { store, cfg, markets } = setup();
  const next = markets.current();
  next.risk.marketCooldownSeconds = 0;
  next.risk.counterpartyCooldownSeconds = 3_600;
  markets.save(next);
  store.createOperation({
    uuid: "previous-peer",
    offerType: "sell",
    coin: "BANK_CUP",
    amount: 1,
    receive: 925,
    rate: 925,
    state: "completed",
    autoApplied: true,
    cancelAt: null,
    createdAt: Date.now(),
    counterpartyId: "blocked-peer",
  });
  const offers: P2pOffer[] = [
    { uuid: "blocked-best", type: "sell", coin: "BANK_CUP", amount: 10, receive: 9_200, status: "open", User: { uuid: "blocked-peer" } },
    { uuid: "eligible-next", type: "sell", coin: "BANK_CUP", amount: 10, receive: 9_250, status: "open", User: { uuid: "new-peer" } },
  ];
  const applied: string[] = [];
  const qva = {
    listOffersPage: async (params: { type?: string }) => ({ offers: params.type === "sell" ? offers : [], total: offers.length, currentPage: 1, perPage: 100 }),
    p2pAverages: async () => ({ BANK_CUP: { average_buy: 1_015, average_sell: 930 } }),
    qusdBalance: async () => 100,
    apply: async (uuid: string) => void applied.push(uuid),
    sendChat: async () => undefined,
  };
  const trading = new TradingEngine(store, qva as never, cfg as never, markets, async () => undefined);

  const result = await trading.scan();

  assert.equal(result.action, "aplicada blocked-best");
  assert.deepEqual(applied, ["blocked-best"]);
  store.close();
});

test("el escaneo no muta si un límite global bloquea la compra automática", async () => {
  const { store, cfg, markets } = setup();
  const next = markets.current();
  next.risk.maxDailyAppliedQusd = 25;
  next.risk.marketCooldownSeconds = 0;
  markets.save(next);
  store.createOperation({
    uuid: "daily-volume-used",
    offerType: "sell",
    coin: "BANK_CUP",
    amount: 20,
    receive: 18_400,
    rate: 920,
    state: "completed",
    autoApplied: true,
    cancelAt: null,
    createdAt: Date.now(),
  });
  const target: P2pOffer = { uuid: "target-sell", type: "sell", coin: "BANK_CUP", amount: 10, receive: 9_200, status: "open", User: { uuid: "peer" } };
  let mutations = 0;
  const qva = {
    listOffersPage: async () => ({ offers: [target], total: 1, currentPage: 1, perPage: 20 }),
    p2pAverages: async () => ({ BANK_CUP: { average_buy: 1_015, average_sell: 930 } }),
    qusdBalance: async () => 100,
    apply: async () => void (mutations += 1),
  };
  const trading = new TradingEngine(store, qva as never, cfg as never, markets, async () => undefined);

  const result = await trading.scan();

  assert.equal(result.action, "bloqueada target-sell");
  assert.equal(mutations, 0);
  assert.equal(store.getOperation(target.uuid), undefined);
  store.close();
});

test("notifica una sola vez mientras una oferta conserve el mismo bloqueo de liquidez", async () => {
  const { store, cfg, markets } = setup();
  const target: P2pOffer = {
    uuid: "same-liquidity-block",
    type: "buy",
    coin: "BANK_CUP",
    amount: 20,
    receive: 20_400,
    status: "open",
    User: { uuid: "peer" },
  };
  const notifications: string[] = [];
  const qva = {
    listOffersPage: async (params: { type?: string }) => ({
      offers: params.type === "buy" ? [target] : [],
      total: params.type === "buy" ? 1 : 0,
      currentPage: 1,
      perPage: 100,
    }),
    p2pAverages: async () => ({}),
    qusdBalance: async () => 0,
    listOffers: async () => [],
  };
  const trading = new TradingEngine(
    store,
    qva as never,
    cfg as never,
    markets,
    async (message) => void notifications.push(message),
  );

  await trading.scan();
  // Simula una nueva ronda después del cooldown temporal que antes permitía
  // repetir indefinidamente la misma notificación.
  store.set(
    `risk_notice_at:${target.uuid}`,
    String(Date.now() - 5 * 60_000 - 1),
  );
  store.set("market_scan_round", "0");
  await trading.scan();

  assert.equal(
    notifications.filter((message) =>
      message.includes("Compra automática bloqueada"),
    ).length,
    1,
  );
  store.close();
});

test("reintenta una oferta bloqueada cuando mejora el saldo QUSD", async () => {
  const { store, cfg, markets } = setup();
  const target: P2pOffer = {
    uuid: "liquidity-recovers",
    type: "buy",
    coin: "BANK_CUP",
    amount: 20,
    receive: 20_400,
    status: "open",
    User: { uuid: "peer" },
  };
  let balance = 0;
  const applications: string[] = [];
  const qva = {
    listOffersPage: async (params: { type?: string }) => ({
      offers: params.type === "buy" ? [target] : [],
      total: params.type === "buy" ? 1 : 0,
      currentPage: 1,
      perPage: 100,
    }),
    p2pAverages: async () => ({}),
    qusdBalance: async () => balance,
    listOffers: async () => [],
    apply: async (uuid: string) => void applications.push(uuid),
  };
  const trading = new TradingEngine(
    store,
    qva as never,
    cfg as never,
    markets,
    async () => undefined,
  );

  const blocked = await trading.scan();
  balance = 30;
  store.set("market_scan_round", "0");
  const applied = await trading.scan();

  assert.equal(blocked.action, `bloqueada ${target.uuid}`);
  assert.equal(applied.action, `venta aplicada ${target.uuid}`);
  assert.deepEqual(applications, [target.uuid]);
  store.close();
});

test("la revisión manual omite precio pero nunca la parada de emergencia", async () => {
  const { store, cfg, markets } = setup();
  const target: P2pOffer = { uuid: "manual-blocked", type: "sell", coin: "BANK_CUP", amount: 10, receive: 9_200, status: "open", User: { uuid: "peer" } };
  store.syncTradingAlerts([{
    uuid: target.uuid, coin: target.coin, offerType: target.type, amount: target.amount,
    receive: target.receive, rate: 920, decision: "blocked", reason: "Bloqueo de mediana", referenceRate: 920,
  }]);
  let applications = 0;
  const qva = {
    getOffer: async () => target,
    qusdBalance: async () => 100,
    apply: async () => void (applications += 1),
    sendChat: async () => undefined,
  };
  const trading = new TradingEngine(store, qva as never, cfg as never, markets, async () => undefined);
  trading.setEmergencyStop(true, "prueba");

  await assert.rejects(() => trading.applyBlockedOffer(target.uuid), /emergencia/);
  assert.equal(applications, 0);
  assert.equal(store.tradingAlert(target.uuid)?.resolvedAt, null);

  trading.setEmergencyStop(false, "prueba");
  store.set("paused", "false");
  await trading.applyBlockedOffer(target.uuid);
  assert.equal(applications, 1);
  assert.equal(store.tradingAlert(target.uuid)?.resolution, "applied");
  store.close();
});

test("el cooldown persistido no bloquea una segunda operación protegida por los límites globales", async () => {
  const { store, cfg, markets } = setup();
  store.createOperation({
    uuid: "previous",
    offerType: "sell",
    coin: "BANK_CUP",
    amount: 1,
    receive: 920,
    rate: 920,
    state: "completed",
    autoApplied: true,
    cancelAt: null,
    createdAt: Date.now(),
    counterpartyId: "peer-previous",
  });
  const target: P2pOffer = { uuid: "target-cooldown", type: "sell", coin: "BANK_CUP", amount: 10, receive: 9_200, status: "open", User: { uuid: "peer-new" } };
  let mutations = 0;
  const qva = {
    listOffersPage: async () => ({ offers: [target], total: 1, currentPage: 1, perPage: 20 }),
    p2pAverages: async () => ({ BANK_CUP: { average_buy: 1_015, average_sell: 930 } }),
    qusdBalance: async () => 100,
    apply: async () => void (mutations += 1),
  };
  const trading = new TradingEngine(store, qva as never, cfg as never, markets, async () => undefined);

  const result = await trading.scan();

  assert.equal(result.action, "aplicada target-cooldown");
  assert.equal(mutations, 1);
  store.close();
});

test("cualquier mensaje propio posterior al saludo detiene la autocancelación", async () => {
  const { store, cfg, markets } = setup();
  const createdAt = Date.now() - 60_000;
  store.createOperation({
    uuid: "chat-ack", offerType: "sell", coin: "BANK_CUP", amount: 10,
    receive: 9_200, rate: 920, state: "applied", autoApplied: true,
    cancelAt: Date.now() + 60_000, createdAt,
  });
  store.set("chat:auto_message:chat-ack", JSON.stringify({ id: "automatic", sentAt: createdAt + 1_000 }));
  const qva = {
    profile: async () => ({ uuid: "me" }),
    listChat: async () => [
      { id: "automatic", peerId: "me", message: "Saludo", createdAt: createdAt + 1_000 },
      { id: "manual", peerId: "me", message: "Estoy pagando", createdAt: createdAt + 2_000 },
    ],
  };
  const trading = new TradingEngine(store, qva as never, cfg as never, markets, async () => undefined);

  await trading.syncChatAcknowledgements();

  assert.equal(store.getOperation("chat-ack")?.state, "acknowledged");
  assert.equal(store.getOperation("chat-ack")?.cancelAt, null);
  assert.ok(store.get("chat:ack_message:chat-ack")?.includes("manual"));
  store.close();
});

test("pausa automáticamente al alcanzar errores consecutivos configurados", async () => {
  const { store, cfg, markets } = setup();
  const qva = {
    listOffersPage: async () => { throw new Error("fallo de lectura"); },
  };
  const trading = new TradingEngine(store, qva as never, cfg as never, markets, async () => undefined);

  await trading.scan();
  await trading.scan();
  await trading.scan();

  assert.equal(store.get("consecutive_errors"), "3");
  assert.equal(trading.isPaused(), true);
  store.close();
});
