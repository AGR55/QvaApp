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
  store.recordMarketObservation({ coin: "BANK_CUP", medianSell: 930, openOffers: 20, eligible: 0 });
  return { dataDir, store, cfg, markets };
}

test("el sondeo compra con fiat sin consultar el saldo QUSD", async t => {
  const { store, cfg, markets } = setup();
  t.after(() => store.close());
  let balanceReads = 0;
  const trading = new TradingEngine(store, {
    listOffersPage: async (params: { type?: string }) => ({ offers: params.type === "sell"
      ? [{ uuid: "fiat-without-qusd-read", type: "sell", coin: "BANK_CUP", amount: 10, receive: 9200, status: "open" }] : [],
      total: 1, currentPage: 1, perPage: 100 }),
    p2pAverages: async () => ({ BANK_CUP: { median_sell: 930 } }),
    qusdBalance: async () => { balanceReads++; throw new Error("lectura innecesaria"); },
    apply: async () => undefined,
    sendChat: async () => ({}),
  } as never, cfg as never, markets, async () => undefined);
  const result = await trading.scan();
  assert.equal(balanceReads, 0);
  assert.equal(result.action, "aplicada fiat-without-qusd-read");
  assert.ok(store.getOperation("fiat-without-qusd-read"));
});

test("el sondeo aplica la primera página fresca sin esperar otros mercados o lados", async t => {
  const { store, cfg, markets } = setup();
  t.after(() => store.close());
  const config = markets.current();
  config.markets.find(market => market.code === "CLASICA")!.active = true;
  markets.save(config);
  store.saveRemoteResource("market:CLASICA", { offers: [{ uuid: "keep-classic", type: "sell" }] });
  store.saveRemoteResource("market:BANK_CUP", { offers: [{ uuid: "keep-buy-side", type: "buy" }] });
  store.upsertTradingAlert({ uuid: "keep-alert", coin: "CLASICA", offerType: "sell", amount: 10,
    receive: 11, rate: 1.1, decision: "blocked", reason: "Pendiente" });
  store.upsertTradingAlert({ uuid: "keep-buy-alert", coin: "BANK_CUP", offerType: "buy", amount: 10,
    receive: 11000, rate: 1100, decision: "blocked", reason: "Pendiente" });
  const trading = new TradingEngine(store, {
    p2pAverages: async () => ({ BANK_CUP: { median_sell: 930 } }),
    apply: async () => undefined, sendChat: async () => ({}),
  } as never, cfg as never, markets, async () => undefined);
  const result = await trading.ingestMarketUpdate({ coin: "BANK_CUP", side: "sell",
    page: { offers: [{ uuid: "first-fresh-page", type: "sell", coin: "BANK_CUP", amount: 10, receive: 9200, status: "open" }], total: 1, currentPage: 1, perPage: 100 },
    scannedAt: Date.now(), sourceAccountId: "primary" });
  assert.equal(result.action, "aplicada first-fresh-page");
  assert.ok(store.getOperation("first-fresh-page"));
  assert.deepEqual(store.loadRemoteResource("market:CLASICA")?.data, { offers: [{ uuid: "keep-classic", type: "sell" }] });
  assert.equal(store.tradingAlert("keep-alert")?.resolvedAt, null);
  assert.equal(store.tradingAlert("keep-buy-alert")?.resolvedAt, null);
  assert.ok(store.loadRemoteResource<{ offers: P2pOffer[] }>("market:BANK_CUP")?.data.offers.some(offer => offer.uuid === "keep-buy-side"));
});

test("el feed decide sin esperar los promedios de una lectura de recuperación", async t => {
  const { store, cfg, markets } = setup();
  t.after(() => store.close());
  let release!: () => void;
  let averaging!: () => void;
  const started = new Promise<void>(resolve => { averaging = resolve; });
  const blocked = new Promise<void>(resolve => { release = resolve; });
  let applies = 0;
  const trading = new TradingEngine(store, {
    p2pAverages: async () => { averaging(); await blocked; return {}; },
    apply: async () => { applies++; }, sendChat: async () => ({}),
  } as never, cfg as never, markets, async () => undefined);
  const background = trading.ingestMarketUpdate({ coin: "BANK_CUP", side: "sell",
    page: { offers: [], total: 0, currentPage: 1, perPage: 100 }, scannedAt: Date.now(), sourceAccountId: "primary" });
  await started;
  const offer = trading.ingestMarketOffer({ uuid: "fast-over-background", type: "sell", coin: "BANK_CUP", amount: 10, receive: 9200, status: "open" });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(applies, 1);
  release();
  await Promise.all([offer, background]);
});

test("una ráfaga concurrente del feed no comparte el mismo saldo fiat", async t => {
  const { store, cfg, markets } = setup();
  t.after(() => store.close());
  store.set("fiat_balance:BANK_CUP", "10000");
  const applications: string[] = [];
  const trading = new TradingEngine(store, {
    apply: async (uuid: string) => { await new Promise(resolve => setImmediate(resolve)); applications.push(uuid); },
    sendChat: async () => ({}),
  } as never, cfg as never, markets, async () => undefined);
  await Promise.all([1, 2, 3].map(i => trading.ingestMarketOffer({ uuid: `burst-${i}`, type: "sell", coin: "BANK_CUP", amount: 10, receive: i === 1 ? 9500 : 9200, status: "open" })));
  assert.equal(applications.length, 1);
  assert.equal(store.activeOperations().length, 1);
});

test("la recuperación en tiempo real evalúa una página sin esperar todos los mercados", async t => {
  const { store, cfg, markets } = setup();
  t.after(() => store.close());
  let applies = 0;
  const trading = new TradingEngine(store, {
    p2pAverages: async () => { throw new Error("no esperar promedios para recuperar el feed"); },
    apply: async () => { applies++; }, sendChat: async () => ({}),
  } as never, cfg as never, markets, async () => undefined);
  await trading.ingestMarketUpdate({ coin: "BANK_CUP", side: "sell",
    page: { offers: [{ uuid: "recovery-now", type: "sell", coin: "BANK_CUP", amount: 10, receive: 9200, status: "open" }], total: 1, currentPage: 1, perPage: 100 },
    scannedAt: Date.now(), sourceAccountId: "primary" }, { realtimeRecovery: true });
  assert.equal(applies, 1);
});

test("las ofertas propias del feed no gastan intentos de aplicación", async t => {
  const { store, cfg, markets } = setup();
  t.after(() => store.close());
  store.set("analytics_account_uuid", "me");
  const trading = new TradingEngine(store, { apply: async () => { throw new Error("no aplicar a una oferta propia"); } } as never,
    cfg as never, markets, async () => undefined);
  const result = await trading.ingestMarketOffer({ uuid: "own-feed-offer", type: "sell", coin: "BANK_CUP", owner_uuid: "me",
    amount: 10, receive: 9200, status: "open" });
  assert.match(result.action ?? "", /oferta propia/);
  assert.equal(store.recentMutationIntents(10).length, 0);
});

for (const lifecycle of ["none", "applied", "cancelled"] as const) {
  test(`aplicación 404 ambigua conserva evidencia del feed recibida durante el envío: ${lifecycle}`, async () => {
    const { store, cfg, markets } = setup();
    const offer: P2pOffer = { uuid: "inaccessible-feed", type: "sell", coin: "BANK_CUP", amount: 10, receive: 9_200, status: "open" };
    const trading = new TradingEngine(store, {
      apply: async () => {
        if (lifecycle !== "none") store.enqueueMarketFeedEvent({
      key: lifecycle, event: `p2p.${lifecycle}`, receivedAt: Date.now(),
      payload: { event: `p2p.${lifecycle}`, sent_at: new Date(Date.now() - 1_000).toISOString(), data: { uuid: offer.uuid, status: lifecycle === "applied" ? "processing" : "cancelled" } },
        });
        throw new QvaApiError(404, "No tienes permisos para ver esta oferta");
      },
    } as never, cfg as never, markets, async () => undefined);
    const result = await trading.ingestMarketOffer(offer, Date.now(), "p2p.created", new Date().toISOString());
    assert.match(result.action!, /causa no determinada/);
    if (lifecycle === "none") assert.doesNotMatch(result.action!, /ocupada|cancelada|VIP/);
    else assert.match(result.action!, lifecycle === "applied" ? /ocupada por una aplicación/ : /oferta cancelada/);
    store.close();
  });
}

test("producción respeta la pausa solicitada y la parada de emergencia", () => {
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
  assert.equal(active.isPaused(), true);
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

test("el arranque libera una pausa automática heredada sin borrar una pausa manual", () => {
  const { store, cfg, markets } = setup();
  const trading = new TradingEngine(store, {} as never, cfg as never, markets, async () => undefined);
  trading.setPaused(true, "protección automática por errores");
  trading.initializeProductionState();
  assert.equal(trading.isPaused(), false);
  trading.setPaused(true, "panel web");
  trading.initializeProductionState();
  assert.equal(trading.isPaused(), true);
  store.close();
});

test("la declaración manual de fiat se distingue de un movimiento automático", () => {
  const { store, cfg, markets } = setup();
  const trading = new TradingEngine(store, {} as never, cfg as never, markets, async () => undefined);
  trading.setFiatBalance("BANK_CUP", 90_000);
  assert.ok(store.get("cooperative_balance_declared:BANK_CUP"));
  const firstDeclaration = store.get("cooperative_balance_declared:BANK_CUP");
  trading.setFiatBalance("BANK_CUP", 90_000);
  assert.notEqual(store.get("cooperative_balance_declared:BANK_CUP"), firstDeclaration);
  store.set("cooperative_balance_declared:BANK_CUP", "");
  store.recordFiatMovement("movement-1", "BANK_CUP", "debit", 1_000, "test");
  assert.equal(store.get("cooperative_balance_declared:BANK_CUP"), "");
  const config = markets.current();
  config.markets.find((market) => market.code === "BANK_CUP")!.fiatBalance = 85_000;
  trading.saveConfig(config, "panel");
  assert.ok(store.get("cooperative_balance_declared:BANK_CUP"));
  store.close();
});

test("el escaneo real libera QUSD retenido aunque la venta propia publique mejor tasa", async () => {
  const { store, cfg, markets } = setup();
  const target: P2pOffer = { uuid: "target-buy", type: "buy", coin: "BANK_CUP", amount: 20, receive: 20_400, status: "open", User: { uuid: "peer" } };
  const own: P2pOffer = { uuid: "own-sell", type: "sell", coin: "BANK_CUP", amount: 20, receive: 20_600, status: "open", details: { cuenta: "123" } };
  const calls: string[] = [];
  const qva = {
    listOffersPage: async () => ({ offers: [target], total: 1, currentPage: 1, perPage: 20 }),
    p2pAverages: async () => ({ BANK_CUP: { average_buy: 1_015, average_sell: 930, median_sell: 930 } }),
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
    p2pAverages: async () => ({ BANK_CUP: { median_sell: 930 } }),
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
    p2pAverages: async () => ({ BANK_CUP: { median_sell: 930 } }),
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
    p2pAverages: async () => ({ BANK_CUP: { median_sell: 930 } }),
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

test("descarta antes del refresco ofertas viejas de mercados inactivos, pausados o VIP explícitos", async () => {
  const cases: Array<{
    label: string;
    configure: (trading: TradingEngine, markets: MarketConfigService) => void;
    offer?: Partial<P2pOffer>;
  }> = [
    {
      label: "mercado inactivo",
      configure: (_trading, markets) => {
        const next = markets.current();
        next.markets.find((market) => market.code === "BANK_CUP")!.active = false;
        markets.save(next);
      },
      offer: { coin: "BANK_CUP" },
    },
    {
      label: "cacería detenida",
      configure: (trading) => trading.updateHunting({ buyRunning: false }),
      offer: { coin: "BANK_CUP" },
    },
    {
      label: "bot pausado",
      configure: (trading) => trading.setPaused(true),
      offer: { coin: "BANK_CUP" },
    },
    {
      label: "VIP explícito",
      configure: () => undefined,
      offer: { coin: "BANK_CUP", only_vip: 1 },
    },
  ];
  for (const [index, scenario] of cases.entries()) {
    const { store, cfg, markets } = setup();
    let refreshes = 0;
    const qva = {
      getOffer: async () => {
        refreshes += 1;
        throw new Error("No se debe consultar la oferta descartada");
      },
      apply: async () => {
        throw new Error("No se debe aplicar la oferta descartada");
      },
    };
    const trading = new TradingEngine(store, qva as never, cfg as never, markets, async () => undefined);
    scenario.configure(trading, markets);
    const offer: P2pOffer = {
      uuid: `stale-gate-${index}`,
      type: "sell",
      coin: "BANK_CUP",
      amount: 10,
      receive: 9_200,
      status: "open",
      ...scenario.offer,
    };
    const result = await trading.ingestMarketOffer(
      offer,
      Date.now() - 10_000,
      "p2p.created",
      new Date(Date.now() - 10_000).toISOString(),
    );
    assert.equal(refreshes, 0, scenario.label);
    assert.equal(result.candidates, 0, scenario.label);
    store.close();
  }
});

test("interpreta only_vip string 0 como falso y string 1 como restricción explícita", async () => {
  const { store, cfg, markets } = setup();
  let applications = 0;
  const qva = {
    apply: async () => { applications += 1; },
  };
  const trading = new TradingEngine(store, qva as never, cfg as never, markets, async () => undefined);
  const offer = (uuid: string, only_vip: string): P2pOffer => ({
    uuid,
    type: "sell",
    coin: "BANK_CUP",
    amount: 10,
    receive: 9_200,
    status: "open",
    only_vip: only_vip as unknown as number,
  });

  const allowed = await trading.ingestMarketOffer(
    offer("vip-string-zero", "0"),
    Date.now(),
    "p2p.created",
    new Date().toISOString(),
  );
  const rejected = await trading.ingestMarketOffer(
    offer("vip-string-one", "1"),
    Date.now(),
    "p2p.created",
    new Date().toISOString(),
  );

  assert.equal(allowed.action, "aplicada vip-string-zero");
  assert.equal(rejected.action, "Oferta exclusiva para usuarios VIP");
  assert.equal(applications, 1);
  store.close();
});

test("clasifica no disponible y límite de ofertas con la evidencia textual de QvaPay", async () => {
  const cases = [
    {
      status: 409,
      message: "La oferta no está disponible para aplicar",
      expected: /oferta no disponible indicada por QvaPay/i,
    },
    {
      status: 400,
      message: "No puedes aplicar a más de 10 ofertas P2P",
      expected: /límite de operaciones de la cuenta/i,
    },
  ];
  for (const [index, scenario] of cases.entries()) {
    const { store, cfg, markets } = setup();
    const target: P2pOffer = {
      uuid: `classification-${index}`,
      type: "sell",
      coin: "BANK_CUP",
      amount: 10,
      receive: 9_200,
      status: "open",
    };
    const qva = {
      listOffersPage: async () => ({ offers: [target], total: 1, currentPage: 1, perPage: 100 }),
      p2pAverages: async () => ({ BANK_CUP: { median_sell: 930 } }),
      qusdBalance: async () => 100,
      apply: async () => { throw new QvaApiError(scenario.status, scenario.message); },
    };
    const trading = new TradingEngine(store, qva as never, cfg as never, markets, async () => undefined);
    await trading.scan();
    const reason = store.decisionEvents({ page: 1, pageSize: 10 }).items[0]?.reason ?? "";
    assert.match(reason, scenario.expected);
    store.close();
  }
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
    p2pAverages: async () => ({ BANK_CUP: { median_sell: 930 } }),
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
  assert.match(
    store.decisionEvents({ page: 1, pageSize: 10 }).items[0]?.reason ?? "",
    /causa no determinada/i,
  );
  assert.doesNotMatch(
    store.decisionEvents({ page: 1, pageSize: 10 }).items[0]?.reason ?? "",
    /restricción VIP explícita/i,
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
    p2pAverages: async () => ({ BANK_CUP: { median_sell: 930 } }),
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

test("guarda las tasas con un déficit contable en otro mercado y las conserva tras sincronizar y reiniciar", async t => {
  const { store, cfg, markets, dataDir } = setup();
  t.after(() => store.close());
  store.set("fiat_balance:CLASICA", "-219");
  let applied = 0;
  const trading = new TradingEngine(store, {
    p2pAverages: async () => ({ BANK_CUP: { median_sell: 930 } }),
    apply: async () => { applied++; }, sendChat: async () => ({}),
  } as never, cfg as never, markets, async () => undefined);
  trading.updateHunting({ market: { code: "BANK_CUP", buyMaxRate: 925, sellMinRate: 1025 } });
  markets.updateBalance("CLASICA", -219);
  markets.updateBalance("BANK_CUP", 99999);
  assert.equal(trading.market("BANK_CUP")?.buyMaxRate, 925);
  assert.equal(trading.market("BANK_CUP")?.sellMinRate, 1025);
  assert.equal(trading.fiatBalance("CLASICA"), -219);
  const reopened = new MarketConfigService(dataDir, cfg as never, store);
  assert.equal(reopened.find("BANK_CUP")?.buyMaxRate, 925);
  assert.equal(reopened.find("BANK_CUP")?.sellMinRate, 1025);
  assert.equal(reopened.current().markets.find(m => m.code === "CLASICA")?.fiatBalance, -219);
  const invalid = markets.current();
  invalid.markets.find(m => m.code === "CLASICA")!.fiatBalance = -300;
  assert.throws(() => markets.save(invalid), /Saldo de CLASICA/);
  await trading.ingestMarketUpdate({ coin: "BANK_CUP", side: "sell",
    page: { offers: [{ uuid: "old-rate-only", type: "sell", coin: "BANK_CUP", amount: 10, receive: 9270, status: "open" }], total: 1, currentPage: 1, perPage: 100 },
    scannedAt: Date.now(), sourceAccountId: "primary" });
  assert.equal(applied, 0, "el motor rechaza una oferta que solo cumple la tasa antigua");
  assert.equal(store.getOperation("old-rate-only"), undefined);
});

test("revalida la cacería de compra después de evaluar el riesgo", async () => {
  const { store, cfg, markets } = setup();
  const target: P2pOffer = { uuid: "stopped-before-apply", type: "sell", coin: "BANK_CUP", amount: 10, receive: 9_200, status: "open", User: { uuid: "peer" } };
  let applications = 0;
  let trading: TradingEngine;
  const qva = {
    listOffersPage: async (params: { type?: string }) => ({ offers: params.type === "sell" ? [target] : [], total: 1, currentPage: 1, perPage: 100 }),
    p2pAverages: async () => ({ BANK_CUP: { median_sell: 930 } }),
    apply: async () => void (applications += 1),
  };
  trading = new TradingEngine(store, qva as never, cfg as never, markets, async () => undefined);

  const dailyAppliedQusd = store.dailyAppliedQusd.bind(store);
  store.dailyAppliedQusd = (since) => {
    // Stop between the risk evaluation and the continuation that applies.
    queueMicrotask(() => trading.updateHunting({ buyRunning: false }));
    return dailyAppliedQusd(since);
  };

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
    p2pAverages: async () => ({ BANK_CUP: { average_buy: 1_015, average_sell: 930, median_sell: 930 } }),
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

test("evalúa una página secundaria pero aplica únicamente con el gateway principal", async () => {
  const { store, cfg, markets } = setup();
  const target: P2pOffer = {
    uuid: "secondary-discovery",
    type: "sell",
    coin: "BANK_CUP",
    amount: 10,
    receive: 9_200,
    status: "open",
    User: { uuid: "peer" },
  };
  const applications: string[] = [];
  let primaryListings = 0;
  const qva = {
    listOffersPage: async () => {
      primaryListings += 1;
      return { offers: [], total: 0, currentPage: 1, perPage: 100 };
    },
    p2pAverages: async () => ({ BANK_CUP: { median_sell: 930 } }),
    qusdBalance: async () => 100,
    apply: async (uuid: string) => void applications.push(uuid),
    sendChat: async () => undefined,
  };
  const trading = new TradingEngine(
    store,
    qva as never,
    cfg as never,
    markets,
    async () => undefined,
  );
  trading.updateHunting({ sellRunning: false });

  const result = await trading.ingestMarketUpdate({
    coin: "BANK_CUP",
    side: "sell",
    page: { offers: [target], total: 1, currentPage: 1, perPage: 100 },
    scannedAt: Date.now(),
    sourceAccountId: "secondary-reader",
  });

  assert.equal(result.action, `aplicada ${target.uuid}`);
  assert.deepEqual(applications, [target.uuid]);
  assert.equal(primaryListings, 0);
  store.close();
});

test("procesa una oferta del webhook sin esperar listado ni promedios remotos", async () => {
  const { store, cfg, markets } = setup();
  const fastConfig = markets.current();
  fastConfig.risk.reviewedAt = null;
  fastConfig.risk.maxQusdPerOperation = 1;
  fastConfig.risk.maxDailyAppliedQusd = 1;
  fastConfig.markets.find((market) => market.code === "BANK_CUP")!.purchaseMaxQusd = 1;
  markets.save(fastConfig);
  store.set("consecutive_errors", "99");
  const target: P2pOffer = {
    uuid: "webhook-discovery",
    type: "sell",
    coin: "BANK_CUP",
    amount: 10,
    receive: 9_200,
    status: "open",
  };
  const applications: string[] = [];
  const qva = {
    listOffersPage: async () => { throw new Error("no debe listar"); },
    p2pAverages: async () => { throw new Error("no debe consultar promedios"); },
    qusdBalance: async () => { throw new Error("una compra con fiat no debe consultar QUSD"); },
    apply: async (uuid: string) => void applications.push(uuid),
    sendChat: async () => undefined,
  };
  const trading = new TradingEngine(store, qva as never, cfg as never, markets, async () => undefined);
  trading.updateHunting({ sellRunning: false });

  const result = await trading.ingestMarketOffer(target, Date.now());

  assert.equal(result.action, `aplicada ${target.uuid}`);
  assert.deepEqual(applications, [target.uuid]);
  assert.equal(store.getOperation(target.uuid)?.autoApplied, true);
  const market = store.loadRemoteResource<{ offers: P2pOffer[] }>("market:BANK_CUP");
  assert.equal(market?.data.offers[0]?.uuid, target.uuid);
  store.close();
});

test("vende QUSD desde el feed por precio y saldo sin listar el mercado", async () => {
  const { store, cfg, markets } = setup();
  const target: P2pOffer = {
    uuid: "webhook-fast-sell",
    type: "buy",
    coin: "BANK_CUP",
    amount: 10,
    receive: 10_200,
    status: "open",
    offer_kind: "fixed",
  };
  const applications: string[] = [];
  let balanceReads = 0;
  const qva = {
    listOffers: async () => { throw new Error("no debe listar ofertas propias"); },
    listOffersPage: async () => { throw new Error("no debe listar el mercado"); },
    p2pAverages: async () => { throw new Error("no debe consultar promedios"); },
    qusdBalance: async () => { balanceReads += 1; return 25; },
    apply: async (uuid: string) => void applications.push(uuid),
    sendChat: async () => undefined,
  };
  const trading = new TradingEngine(store, qva as never, cfg as never, markets, async () => undefined);

  const result = await trading.ingestMarketOffer(target, Date.now());

  assert.equal(result.action, `venta aplicada ${target.uuid}`);
  assert.deepEqual(applications, [target.uuid]);
  assert.equal(balanceReads, 1);
  assert.equal(store.getOperation(target.uuid)?.offerType, "buy");
  store.close();
});

test("una entrega tardía cede paso sin consultar ni gastar cupo de apply", async () => {
  const { store, cfg, markets } = setup();
  const target: P2pOffer = {
    uuid: "delayed-feed-offer",
    type: "sell",
    coin: "BANK_CUP",
    amount: 10,
    receive: 9_200,
    status: "open",
  };
  let applications = 0;
  let detailReads = 0;
  const qva = {
    getOffer: async () => { detailReads += 1; return { ...target, status: "processing" }; },
    apply: async () => void (applications += 1),
  };
  const trading = new TradingEngine(store, qva as never, cfg as never, markets, async () => undefined);

  const result = await trading.ingestMarketOffer(
    target,
    Date.now(),
    "p2p.created",
    new Date(Date.now() - 30_000).toISOString(),
  );

  assert.match(result.action!, /antigua.*observación fresca/);
  assert.equal(detailReads, 0);
  assert.equal(applications, 0);
  assert.equal(store.isSeen(target.uuid), false);
  await trading.ingestMarketOffer(target, Date.now(), "p2p.created", new Date().toISOString());
  assert.equal(applications, 1, "una observación nueva puede volver a evaluar la misma oferta");
  store.close();
});

test("los eventos paid y completed sustituyen la espera de sincronización periódica", async () => {
  const { store, cfg, markets } = setup();
  const trading = new TradingEngine(store, {} as never, cfg as never, markets, async () => undefined);
  const buying: P2pOffer = {
    uuid: "feed-paid-operation",
    type: "sell",
    coin: "BANK_CUP",
    amount: 10,
    receive: 9_200,
    status: "paid",
  };
  store.createOperation({
    uuid: buying.uuid,
    offerType: "sell",
    coin: buying.coin,
    amount: buying.amount,
    receive: buying.receive,
    rate: buying.receive / buying.amount,
    state: "applied",
    autoApplied: true,
    cancelAt: null,
    createdAt: Date.now(),
  });

  await trading.ingestMarketStateEvent("p2p.paid", buying, Date.now());
  await trading.ingestMarketStateEvent("p2p.completed", { ...buying, status: "completed" }, Date.now());

  assert.equal(store.getOperation(buying.uuid)?.state, "completed");
  assert.equal(store.recentFiat("BANK_CUP").filter((entry) => entry.uuid === buying.uuid).length, 1);

  const selling: P2pOffer = {
    uuid: "feed-completed-operation",
    type: "buy",
    coin: "BANK_CUP",
    amount: 5,
    receive: 5_100,
    status: "completed",
  };
  store.createOperation({
    uuid: selling.uuid,
    offerType: "buy",
    coin: selling.coin,
    amount: selling.amount,
    receive: selling.receive,
    rate: selling.receive / selling.amount,
    state: "applied",
    autoApplied: true,
    cancelAt: null,
    createdAt: Date.now(),
  });
  await trading.ingestMarketStateEvent("p2p.completed", selling, Date.now());
  assert.equal(store.getOperation(selling.uuid)?.state, "completed");
  assert.equal(store.recentFiat("BANK_CUP").filter((entry) => entry.uuid === selling.uuid).length, 1);
  store.close();
});

test("registra ofertas propias recientes y conserva la detección del feed tras reiniciar", async () => {
  const { store, dataDir, cfg, markets } = setup();
  const notices: Array<{ kind: string; uuid?: string; coin?: string; amount?: number; eventVersion?: string }> = [];
  const ownOffer: P2pOffer = {
    uuid: "new-own-offer", type: "sell", coin: "BANK_CUP", amount: 12,
    receive: 11_400, status: "open", updated_at: "2026-09-30T10:00:00Z",
  };
  const config = markets.current();
  config.markets.find((market) => market.code === "BANK_CUP")!.paymentDetails = [{ name: "Cuenta", value: "123456" }];
  markets.save(config);
  const trading = new TradingEngine(store, {
    listOffers: async () => [],
    createOffer: async () => ownOffer,
  } as never, cfg as never, markets, async (_message, _uuid, event) => {
    if (event?.kind === "own-offer-applied") notices.push(event);
  });
  await trading.createOwnOffer("BANK_CUP", "sell", 12, 950);
  assert.match(store.get("trading:owned_offer_uuids") ?? "", /new-own-offer/);
  store.close();

  const restartedStore = new Store(dataDir);
  const restartedMarkets = new MarketConfigService(dataDir, cfg as never, restartedStore);
  const restartedTrading = new TradingEngine(restartedStore, {} as never, cfg as never, restartedMarkets, async (_message, _uuid, event) => {
    if (event?.kind === "own-offer-applied") notices.push(event);
  });
  await restartedTrading.ingestMarketStateEvent("p2p.applied", { ...ownOffer, status: "processing" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(notices[0]?.kind, "own-offer-applied");
  assert.equal(notices[0]?.uuid, "new-own-offer");
  assert.equal(notices[0]?.coin, "BANK_CUP");
  assert.equal(notices[0]?.amount, 12);

  await restartedTrading.ingestMarketStateEvent("p2p.applied", { ...ownOffer, uuid: "someone-elses-offer" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(notices.length, 1);

  restartedStore.set("paused", "true");
  await restartedTrading.ingestMarketOffer({ ...ownOffer, status: "open" }, Date.now(), "p2p.reopened");
  await restartedTrading.ingestMarketStateEvent("p2p.applied", { ...ownOffer, status: "processing" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(notices.length, 2);
  assert.notEqual(notices[0]?.eventVersion, notices[1]?.eventVersion);

  const externallyCreated: P2pOffer = { ...ownOffer, uuid: "ui-created-offer" };
  const refreshingTrading = new TradingEngine(restartedStore, {
    listOffers: async () => [externallyCreated],
  } as never, cfg as never, restartedMarkets, async (_message, _uuid, event) => {
    if (event?.kind === "own-offer-applied") notices.push(event);
  });
  await refreshingTrading.listOwnOffers();
  await restartedTrading.ingestMarketStateEvent("p2p.applied", { ...externallyCreated, status: "processing" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(notices[2]?.uuid, "ui-created-offer");
  restartedStore.close();
});

test("no evalúa una instantánea multicuentas que ya está obsoleta", async () => {
  const { store, cfg, markets } = setup();
  const next = markets.current();
  next.risk.maxQuoteAgeSeconds = 5;
  markets.save(next);
  const target: P2pOffer = {
    uuid: "stale-secondary-discovery",
    type: "sell",
    coin: "BANK_CUP",
    amount: 10,
    receive: 9_200,
    status: "open",
    User: { uuid: "peer" },
  };
  let applications = 0;
  const qva = {
    p2pAverages: async () => ({ BANK_CUP: { median_sell: 930 } }),
    qusdBalance: async () => 100,
    apply: async () => void (applications += 1),
  };
  const trading = new TradingEngine(
    store,
    qva as never,
    cfg as never,
    markets,
    async () => undefined,
  );
  trading.updateHunting({ sellRunning: false });

  const result = await trading.ingestMarketUpdate({
    coin: "BANK_CUP",
    side: "sell",
    page: { offers: [target], total: 1, currentPage: 1, perPage: 100 },
    scannedAt: Date.now() - 5_001,
    sourceAccountId: "secondary-reader",
  });

  assert.equal(result.action, "calentando mercado");
  assert.equal(applications, 0);
  store.close();
});

test("no inunda auditoría con resultados de escaneo idénticos", async () => {
  const { store, cfg, markets } = setup();
  const qva = { p2pAverages: async () => ({ BANK_CUP: { median_sell: 930 } }) };
  const trading = new TradingEngine(
    store,
    qva as never,
    cfg as never,
    markets,
    async () => undefined,
  );
  trading.updateHunting({ sellRunning: false });
  const update = {
    coin: "BANK_CUP" as const,
    side: "sell" as const,
    page: { offers: [], total: 0, currentPage: 1, perPage: 100 },
    scannedAt: Date.now(),
    sourceAccountId: "secondary-reader",
  };

  await trading.ingestMarketUpdate(update);
  await trading.ingestMarketUpdate({ ...update, scannedAt: Date.now() });

  assert.equal(store.countAudit("scan_complete"), 1);
  assert.match(store.get("last_scan") ?? "", /Sin aplicación/);
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
    p2pAverages: async () => ({ BANK_CUP: { average_buy: 1_015, average_sell: 930, median_sell: 930 } }),
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
    p2pAverages: async () => ({ BANK_CUP: { average_buy: 1_015, average_sell: 930, median_sell: 930 } }),
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
    p2pAverages: async () => ({ BANK_CUP: { median_sell: 930 } }),
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
    p2pAverages: async () => ({ BANK_CUP: { median_sell: 930 } }),
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
    p2pAverages: async () => ({ BANK_CUP: { average_buy: 1_015, average_sell: 930, median_sell: 930 } }),
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

test("registra errores consecutivos sin detener la cacería", async () => {
  const { store, cfg, markets } = setup();
  const qva = {
    listOffersPage: async () => { throw new Error("fallo de lectura"); },
  };
  const trading = new TradingEngine(store, qva as never, cfg as never, markets, async () => undefined);

  await trading.scan();
  await trading.scan();
  await trading.scan();

  assert.equal(store.get("consecutive_errors"), "3");
  assert.equal(trading.isPaused(), false);
  store.close();
});

test("compra flexible usa saldo parcial sin lecturas adicionales y reserva la orden", async () => {
  const { store, cfg, markets } = setup();
  store.set("fiat_balance:BANK_CUP", "9500");
  const calls: unknown[] = [];
  const qva = {
    apply: async (_uuid: string, options: { amount: number; beforeDispatch: (ms: number) => Promise<boolean> }) => {
      assert.equal(await options.beforeDispatch(0), true);
      calls.push(options.amount);
      return { order: "order-one", amount: options.amount, receive: options.amount * 920 };
    },
    getOffer: async () => { assert.fail("la decisión no consulta detalle"); },
    qusdBalance: async () => { assert.fail("comprar QUSD no consulta saldo QUSD"); },
    sendChat: async () => ({}),
  };
  const engine = new TradingEngine(store, qva as never, cfg as never, markets, async () => undefined);
  const result = await engine.ingestMarketOffer({ uuid: "flex-partial", type: "sell", coin: "BANK_CUP",
    amount: 100, receive: 92000, status: "open", offer_kind: "flexible", available_amount: 80, order_min: 5, order_max: 40 });
  assert.equal(result.candidates, 1);
  const operation = store.getOperation("flex-partial")!;
  assert.equal(operation.orderUuid, "order-one");
  assert.ok(operation.amount >= 5 && operation.amount < 11);
  assert.ok(operation.receive + markets.current().markets[0]!.outgoingTransferFee <= 9500);
  assert.equal(calls.length, 1);
  await new Promise(resolve => setImmediate(resolve));
  store.close();
});

test("sin mínimo financiable no aplica una flexible ni consulta QvaPay", async () => {
  const { store, cfg, markets } = setup();
  store.set("fiat_balance:BANK_CUP", "1000");
  const engine = new TradingEngine(store, { apply: async () => assert.fail("no debe aplicar") } as never, cfg as never, markets, async () => undefined);
  const result = await engine.ingestMarketOffer({ uuid: "flex-small", type: "sell", coin: "BANK_CUP", amount: 100,
    receive: 92000, status: "open", offer_kind: "flexible", available_amount: 50, order_min: 5, order_max: 20 });
  assert.equal(result.candidates, 0);
  assert.equal(store.activeOperations().length, 0);
  store.close();
});

test("venta flexible mantiene reserva QUSD y usa orden para pago, disputa y sincronización", async () => {
  const { store, cfg, markets } = setup();
  const current = markets.current(); current.risk.minQusdReserve = 10; markets.save(current);
  const actions: unknown[] = [];
  let orderStatus = "processing";
  const parent: P2pOffer = { uuid: "flex-sell", type: "buy", coin: "BANK_CUP", amount: 100, receive: 100000,
    status: "open", offer_kind: "flexible", available_amount: 100, order_min: 5, order_max: 40 };
  const qva = {
    qusdBalance: async () => 22.5,
    listOffers: async () => [],
    apply: async (_uuid: string, options: { amount: number; beforeDispatch: (ms: number) => Promise<boolean> }) => {
      assert.equal(await options.beforeDispatch(0), true);
      return { order: "sell-child", amount: options.amount, receive: options.amount * 1000 };
    },
    getOffer: async () => ({ ...parent, Orders: [{ uuid: "sell-child", amount: 12.5, receive: 12500, status: orderStatus }] }),
    cancel: async (uuid: string, order: string) => { actions.push([uuid, order]); orderStatus = "revision"; return { status: "revision" }; },
    sendChat: async () => ({}),
  };
  const engine = new TradingEngine(store, qva as never, cfg as never, markets, async () => undefined);
  assert.equal((await engine.ingestMarketOffer(parent)).candidates, 1);
  assert.equal(store.getOperation(parent.uuid)?.amount, 12.5);
  await engine.cancel(parent.uuid);
  assert.deepEqual(actions, [["flex-sell", "sell-child"]]);
  assert.equal(store.getOperation(parent.uuid)?.state, "revision");
  orderStatus = "completed";
  await engine.syncRemoteOperations();
  assert.equal(store.getOperation(parent.uuid)?.state, "completed");
  assert.equal(store.hasFiatMovement(parent.uuid), true);
  await new Promise(resolve => setImmediate(resolve)); store.close();
});

test("venta flexible libera QUSD congelado, aplica por orden y repone el sobrante", async t => {
  const { store, cfg, markets } = setup();
  t.after(() => store.close());
  const config = markets.current(); config.risk.minQusdReserve = 5; markets.save(config);
  const parent: P2pOffer = { uuid: "flex-escrow", type: "buy", coin: "BANK_CUP", amount: 100,
    receive: 102000, status: "open", offer_kind: "flexible", available_amount: 100, order_min: 5, order_max: 20 };
  const own: P2pOffer = { uuid: "escrow-sale", type: "sell", coin: "BANK_CUP", amount: 30,
    receive: 30000, status: "open", details: { cuenta: "123" } };
  let balance = 5;
  const actions: string[] = [];
  const engine = new TradingEngine(store, {
    qusdBalance: async () => balance,
    listOffers: async () => [own], getOffer: async (uuid: string) => uuid === own.uuid ? own : parent,
    cancel: async () => { actions.push("cancel"); balance += 30; },
    apply: async (_uuid: string, options: { amount: number; beforeDispatch?: (ms: number) => Promise<boolean> }) => {
      assert.equal(options.amount, 20);
      if (options.beforeDispatch) assert.equal(await options.beforeDispatch(0), true);
      assert.ok(balance >= options.amount + 5);
      actions.push("apply"); balance -= options.amount;
      return { order: "escrow-child", amount: options.amount, receive: options.amount * 1020 };
    },
    createOffer: async (body: { amount: number }) => { assert.equal(body.amount, 10); actions.push("restore"); return { uuid: "restored-sale" }; },
    sendChat: async () => ({}),
  } as never, cfg as never, markets, async () => undefined);
  assert.equal((await engine.ingestMarketOffer(parent)).candidates, 1);
  assert.deepEqual(actions, ["cancel", "apply", "restore"]);
  assert.equal(store.getOperation(parent.uuid)?.orderUuid, "escrow-child");
  assert.equal(store.getOperation(parent.uuid)?.amount, 20);
  await new Promise(resolve => setImmediate(resolve));
});

test("venta flexible ya financiada conserva la ruta rápida sin listar ni cancelar ventas propias", async t => {
  const { store, cfg, markets } = setup(); t.after(() => store.close());
  let balanceReads = 0;
  const offer: P2pOffer = { uuid: "funded-flex", type: "buy", coin: "BANK_CUP", amount: 100,
    receive: 102000, status: "open", offer_kind: "flexible", available_amount: 100, order_min: 5, order_max: 20 };
  const engine = new TradingEngine(store, {
    qusdBalance: async () => { balanceReads++; return 100; },
    listOffers: async () => assert.fail("no debe listar ofertas propias"),
    cancel: async () => assert.fail("no debe cancelar ofertas propias"),
    apply: async (_uuid: string, options: { amount: number }) => ({ order: "funded-child", amount: options.amount, receive: options.amount * 1020 }),
    sendChat: async () => ({}),
  } as never, cfg as never, markets, async () => undefined);
  assert.equal((await engine.ingestMarketOffer(offer)).candidates, 1);
  assert.equal(store.getOperation(offer.uuid)?.amount, 20);
  assert.equal(balanceReads, 1);
  await new Promise(resolve => setImmediate(resolve));
});

test("una aplicación flexible incierta se recupera por orden propia y no por estado del padre", async () => {
  const { store, cfg, markets } = setup();
  store.set("analytics_account_uuid", "me");
  const createdAt = Date.now();
  store.createMutationIntent({ intentId: "flex-uncertain", operationUuid: "parent-uncertain", kind: "apply",
    request: { offerKind: "flexible", amount: 10, receive: 9200, automatic: true, coin: "BANK_CUP", offerType: "sell" } });
  store.updateMutationIntent("flex-uncertain", "uncertain", undefined, "timeout");
  const remote: P2pOffer = { uuid: "parent-uncertain", type: "sell", coin: "BANK_CUP", amount: 100, receive: 92000,
    status: "open", offer_kind: "flexible", Orders: [] };
  const engine = new TradingEngine(store, { getOffer: async () => remote } as never, cfg as never, markets, async () => undefined);
  await engine.reconcilePendingStandaloneMutations({ intentId: "flex-uncertain", force: true });
  assert.equal(store.getMutationIntent("flex-uncertain")?.state, "uncertain");
  remote.Orders = [{ uuid: "found-order", amount: 10, receive: 9200, status: "paid", created_at: new Date(createdAt).toISOString(), Taker: { uuid: "me" } }];
  await engine.reconcilePendingStandaloneMutations({ intentId: "flex-uncertain", force: true });
  assert.equal(store.getMutationIntent("flex-uncertain")?.state, "reconciled");
  assert.equal(store.getOperation(remote.uuid)?.orderUuid, "found-order");
  assert.equal(store.getOperation(remote.uuid)?.state, "paid");
  assert.equal(store.getOperation(remote.uuid)?.amount, 10);
  store.close();
});
