import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Store } from "../src/store.js";
import { rate, TradingService } from "../src/trading.js";
import { Vault } from "../src/vault.js";
import { QvaMutationUncertainError } from "../src/qvapay.js";

test("calcula correctamente la tasa CUP por QUSD", () => {
  assert.equal(rate({ amount: 10, receive: 9_700 }), 970);
  assert.equal(rate({ amount: 34, receive: 34_340 }), 1010);
});

test("el vault cifra los tokens y permite recuperarlos", () => {
  const vault = new Vault("a".repeat(64));
  const encrypted = vault.encrypt("sesion-secreta");
  assert.notEqual(encrypted, "sesion-secreta");
  assert.equal(vault.decrypt(encrypted), "sesion-secreta");
});

test("el vault rechaza claves locales débiles", () => {
  assert.throws(() => new Vault("invalida"), /64 caracteres/);
});

test("el libro fiat registra cada movimiento una sola vez y separa CUP de USD", () => {
  const store = new Store(mkdtempSync(join(tmpdir(), "qvaapply-ledger-")));
  store.set("fiat_balance:BANK_CUP", "35050");
  store.set("fiat_balance:BANDECPREPAGO", "110");

  assert.equal(
    store.recordFiatMovement("offer-1", "BANK_CUP", "debit", 9700, "prueba"),
    true,
  );
  assert.equal(store.get("fiat_balance:BANK_CUP"), "25350");
  assert.equal(
    store.recordFiatMovement("offer-1", "BANK_CUP", "debit", 9700, "prueba"),
    false,
  );
  assert.equal(store.get("fiat_balance:BANK_CUP"), "25350");

  assert.equal(
    store.recordFiatMovement("offer-2", "BANDECPREPAGO", "credit", 5, "prueba"),
    true,
  );
  assert.equal(store.get("fiat_balance:BANDECPREPAGO"), "115");
  assert.deepEqual(
    store
      .recentFiat("BANK_CUP", 2)
      .map((movement) => [movement.uuid, movement.direction, movement.amount]),
    [["offer-1", "debit", 9700]],
  );
});

test("la conciliación omite una operación sin importe CUP y conserva el saldo", async () => {
  const store = new Store(mkdtempSync(join(tmpdir(), "qvaapply-fiat-sync-")));
  store.set("fiat_balance:BANK_CUP", "3050");
  store.set("fiat_ledger_started_at:BANK_CUP", String(Date.now() - 1_000));
  store.set("fiat_ledger_started_at:BANDECPREPAGO", String(Date.now() - 1_000));
  const qva = {
    profile: async () => ({ uuid: "me" }),
    listOffersPage: async () => ({
      offers: [
        {
          uuid: "missing-cup",
          type: "sell",
          coin: "BANK_CUP",
          amount: 10,
          receive: 0,
          status: "completed",
          updated_at: new Date().toISOString(),
          User: { uuid: "me" },
        },
      ],
      total: 1,
      currentPage: 1,
      perPage: 50,
    }),
  };
  const trading = new TradingService(
    store,
    qva as never,
    {} as never,
    async () => undefined,
  );

  assert.equal(await trading.syncFiatFromQva(), 0);
  assert.equal(store.get("fiat_balance:BANK_CUP"), "3050");
  assert.equal(store.countAudit("fiat_sync_skipped"), 1);

  await trading.syncFiatFromQva();
  assert.equal(store.countAudit("fiat_sync_skipped"), 1);
});

test("la conciliación USD actualiza únicamente Bandec Prepago", async () => {
  const store = new Store(mkdtempSync(join(tmpdir(), "qvaapply-usd-sync-")));
  store.set("fiat_balance:BANK_CUP", "3050");
  store.set("fiat_balance:BANDECPREPAGO", "110");
  store.set("fiat_ledger_started_at:BANK_CUP", String(Date.now() - 1_000));
  store.set("fiat_ledger_started_at:BANDECPREPAGO", String(Date.now() - 1_000));
  const qva = {
    profile: async () => ({ uuid: "me" }),
    listOffersPage: async () => ({
      offers: [
        {
          uuid: "usd-sale",
          type: "sell",
          coin: "BANDECPREPAGO",
          amount: 10,
          receive: 11.2,
          status: "completed",
          updated_at: new Date().toISOString(),
          User: { uuid: "me" },
        },
      ],
      total: 1,
      currentPage: 1,
      perPage: 50,
    }),
  };
  const trading = new TradingService(
    store,
    qva as never,
    {} as never,
    async () => undefined,
  );

  assert.equal(await trading.syncFiatFromQva(), 1);
  assert.equal(store.get("fiat_balance:BANK_CUP"), "3050");
  assert.equal(store.get("fiat_balance:BANDECPREPAGO"), "121.2");
});

test("Clásica descuenta 0.08 USD solo cuando sale fiat y no duplica la comisión", async () => {
  const store = new Store(mkdtempSync(join(tmpdir(), "qvaapply-classic-fee-")));
  store.set("fiat_balance:CLASICA", "20");
  store.set("fiat_ledger_started_at:CLASICA", String(Date.now() - 1_000));
  const qva = {
    profile: async () => ({ uuid: "me" }),
    listOffersPage: async () => ({
      offers: [
        {
          uuid: "classic-outgoing",
          type: "buy",
          coin: "CLASICA",
          amount: 10,
          receive: 10.4,
          status: "paid",
          updated_at: new Date().toISOString(),
          User: { uuid: "me" },
        },
        {
          uuid: "classic-incoming",
          type: "sell",
          coin: "CLASICA",
          amount: 5,
          receive: 5,
          status: "completed",
          updated_at: new Date().toISOString(),
          User: { uuid: "me" },
        },
      ],
      total: 2,
      currentPage: 1,
      perPage: 50,
    }),
  };
  const trading = new TradingService(
    store,
    qva as never,
    {} as never,
    async () => undefined,
  );

  assert.equal(await trading.syncFiatFromQva(), 2);
  assert.ok(Math.abs(Number(store.get("fiat_balance:CLASICA")) - 14.52) < 0.000001);
  assert.equal(await trading.syncFiatFromQva(), 0);
  assert.ok(Math.abs(Number(store.get("fiat_balance:CLASICA")) - 14.52) < 0.000001);
});

test("USD Prepago inicia en 110 y usa sus propios umbrales", async () => {
  const store = new Store(mkdtempSync(join(tmpdir(), "qvaapply-usd-market-")));
  const qva = {
    listOffersPage: async (params: { coin: string }) => ({
      offers:
        params.coin === "BANDECPREPAGO"
          ? [
              {
                uuid: "usd-buy",
                type: "sell",
                coin: "BANDECPREPAGO",
                amount: 10,
                receive: 10.6,
                status: "open",
              },
            ]
          : [
              {
                uuid: "cup-too-large",
                type: "sell",
                coin: "BANK_CUP",
                amount: 36,
                receive: 34_920,
                status: "open",
              },
            ],
      total: 1,
      currentPage: 1,
      perPage: 20,
    }),
    p2pAverages: async () => ({
      BANDECPREPAGO: { average_sell: 1.1, median_sell: 1.1 },
      BANK_CUP: { average_sell: 980, median_sell: 980 },
    }),
  };
  const config = {
    initialUsdFiatBalance: 110,
    buyQusdMaxRate: 970,
    sellQusdMinRate: 1010,
    buyQusdUsdMaxRate: 1.06,
    sellQusdUsdMinRate: 1.12,
    cupPurchaseMaxQusd: 35,
    priceGuardPercent: 15,
  };
  const trading = new TradingService(
    store,
    qva as never,
    config as never,
    async () => undefined,
  );

  assert.equal(trading.fiatBalance("BANDECPREPAGO"), 110);
  assert.equal(
    (await trading.inspectMarket("BANDECPREPAGO")).items[0]?.decision,
    "auto_buy",
  );
  assert.match(
    (await trading.inspectMarket("BANK_CUP")).items[0]?.reason ?? "",
    /25 QUSD/,
  );
});

test("Clásica no usa el saldo de Prepago aunque ambas operen en USD", async () => {
  const store = new Store(
    mkdtempSync(join(tmpdir(), "qvaapply-classic-isolation-")),
  );
  const qva = {
    listOffersPage: async (params: { coin: string }) => ({
      offers: [
        {
          uuid: "classic-sale",
          type: "sell",
          coin: params.coin,
          amount: 10,
          receive: 10,
          status: "open",
        },
      ],
      total: 1,
      currentPage: 1,
      perPage: 20,
    }),
    p2pAverages: async () => ({ CLASICA: { average_sell: 1, median_sell: 1 } }),
  };
  const config = {
    initialUsdFiatBalance: 110,
    buyQusdUsdMaxRate: 1.06,
    sellQusdUsdMinRate: 1.12,
    priceGuardPercent: 15,
  };
  const trading = new TradingService(
    store,
    qva as never,
    config as never,
    async () => undefined,
  );
  trading.setFiatBalance("BANDECPREPAGO", 110);
  trading.setFiatBalance("CLASICA", 0);

  assert.equal(
    (await trading.inspectMarket("CLASICA")).items[0]?.reason,
    "Saldo fiat declarado insuficiente",
  );
});

test("Clásica exige saldo para el importe y la comisión antes de crear una compra", async () => {
  const store = new Store(mkdtempSync(join(tmpdir(), "qvaapply-classic-create-fee-")));
  const qva = {
    listOffers: async () => [],
    createOffer: async () => { throw new Error("no debe crear"); },
  };
  const trading = new TradingService(
    store,
    qva as never,
    { realTradingAllowed: true } as never,
    async () => undefined,
  );
  store.set("mode", "real");
  trading.setFiatBalance("CLASICA", 10.4);

  await assert.rejects(
    () => trading.createOwnOffer("CLASICA", "buy", 10, 1.04),
    /Saldo Tarjeta Clásica insuficiente/,
  );
});

test("permite hasta el límite configurado de ofertas propias abiertas", async () => {
  const store = new Store(
    mkdtempSync(join(tmpdir(), "qvaapply-own-offer-limit-")),
  );
  store.set("mode", "real");
  let openOffers = 9;
  let created = 0;
  const qva = {
    listOffers: async () =>
      Array.from({ length: openOffers }, (_, index) => ({
        uuid: `open-${index}`,
        type: "buy",
        coin: "BANK_CUP",
        amount: 10,
        receive: 9700,
        status: "open",
      })),
    createOffer: async () => {
      created += 1;
      openOffers += 1;
      return {
        uuid: "new-offer",
        type: "buy",
        coin: "BANK_CUP",
        amount: 10,
        receive: 9700,
        status: "open",
      };
    },
  };
  const config = {
    initialUsdFiatBalance: 110,
    maxOpenOwnOffers: 10,
    cupPurchaseMaxQusd: 35,
    paymentDetails: {
      BANK_CUP: [{ name: "transfermovil", value: "123" }],
      BANDECPREPAGO: [],
    },
    realTradingAllowed: true,
  };
  const trading = new TradingService(
    store,
    qva as never,
    config as never,
    async () => undefined,
  );

  await trading.createOwnOffer("BANK_CUP", "sell", 10, 970);
  assert.equal(created, 1);
  await assert.rejects(
    () => trading.createOwnOffer("BANK_CUP", "sell", 10, 970),
    /máximo de 10 ofertas abiertas/,
  );
});

test("crea y edita ofertas CUP usando el total fiat conservador", async () => {
  const store = new Store(
    mkdtempSync(join(tmpdir(), "qvaapply-rounded-own-offer-")),
  );
  store.set("mode", "real");
  const ownOffer = {
    uuid: "own-rounded",
    type: "sell" as const,
    coin: "BANK_CUP",
    amount: 9,
    receive: 8_770,
    status: "open",
    details: { cuenta: "123" },
  };
  let createdReceive: number | undefined;
  let editedReceive: number | undefined;
  const qva = {
    listOffers: async () => [ownOffer],
    createOffer: async (request: { receive: number }) => {
      createdReceive = request.receive;
      return ownOffer;
    },
    editOffer: async (_uuid: string, request: { receive?: number }) => {
      editedReceive = request.receive;
      return ownOffer;
    },
  };
  const trading = new TradingService(
    store,
    qva as never,
    {
      realTradingAllowed: true,
      maxOpenOwnOffers: 10,
      paymentDetails: {
        BANK_CUP: [{ name: "cuenta", value: "123" }],
        BANDECPREPAGO: [],
      },
    } as never,
    async () => undefined,
  );

  await trading.createOwnOffer("BANK_CUP", "sell", 9, 973.7);
  await trading.editOwnOffer("own-rounded", 9, 973.7);

  assert.equal(createdReceive, 8_770);
  assert.equal(editedReceive, 8_770);
  store.close();
});

test("el reajuste puede reducir una oferta heredada por encima del limite actual", async () => {
  const store = new Store(
    mkdtempSync(join(tmpdir(), "qvaapply-rebalance-legacy-limit-")),
  );
  store.set("mode", "real");
  let edited: { amount?: number; receive?: number } | undefined;
  const qva = {
    editOffer: async (_uuid: string, request: { amount?: number; receive?: number }) => {
      edited = request;
      return undefined;
    },
  };
  const trading = new TradingService(
    store,
    qva as never,
    {
      realTradingAllowed: true,
      cupPurchaseMaxQusd: 25,
      initialCupFiatBalance: 100_000,
    } as never,
    async () => undefined,
  );

  await trading.editOwnOfferFromSnapshot(
    {
      uuid: "legacy-buy",
      coin: "BANK_CUP",
      type: "buy",
      rate: 973.7,
      currentAmount: 40,
    },
    30.12,
  );

  assert.deepEqual(edited, { amount: 30.12, receive: 29_320 });
  store.close();
});

test("cada turno de refresco actualiza como máximo una oferta vencida", async () => {
  const store = new Store(
    mkdtempSync(join(tmpdir(), "qvaapply-refresh-round-")),
  );
  store.set("paused", "false");
  store.set("mode", "real");
  store.set("refresh_enabled", "true");
  const refreshed: string[] = [];
  const qva = {
    listOffers: async () =>
      ["one", "two", "three"].map((uuid) => ({
        uuid,
        type: "buy",
        coin: "BANK_CUP",
        amount: 10,
        receive: 9700,
        status: "open",
      })),
    editOffer: async (uuid: string) => {
      refreshed.push(uuid);
      return { updated_at: new Date().toISOString() };
    },
  };
  const trading = new TradingService(
    store,
    qva as never,
    {
      initialUsdFiatBalance: 110,
      offerRefreshIntervalMs: 5 * 60_000,
      offerRefreshSpacingMs: 60_000,
    } as never,
    async () => undefined,
  );

  await trading.refreshOwnOffers();
  assert.deepEqual(refreshed, ["one"]);

  // El mínimo técnico de QvaPay no basta si Estrategia exige más separación.
  store.set("last_offer_edit_at", String(Date.now() - 20_001));
  await trading.refreshOwnOffers();
  assert.deepEqual(refreshed, ["one"]);

  store.set("last_offer_edit_at", String(Date.now() - 60_001));
  await trading.refreshOwnOffers();
  assert.deepEqual(refreshed, ["one", "two"]);
});

test("no inicia una segunda ronda mientras la primera está editando", async () => {
  const store = new Store(
    mkdtempSync(join(tmpdir(), "qvaapply-refresh-lock-")),
  );
  store.set("paused", "false");
  store.set("mode", "real");
  store.set("refresh_enabled", "true");
  let calls = 0;
  let release: (() => void) | undefined;
  const qva = {
    listOffers: async () => [
      {
        uuid: "one",
        type: "buy",
        coin: "BANK_CUP",
        amount: 10,
        receive: 9700,
        status: "open",
      },
    ],
    editOffer: async () => {
      calls += 1;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return { updated_at: new Date().toISOString() };
    },
  };
  const trading = new TradingService(
    store,
    qva as never,
    { initialUsdFiatBalance: 110, offerRefreshIntervalMs: 5 * 60_000 } as never,
    async () => undefined,
  );

  const firstRound = trading.refreshOwnOffers();
  await new Promise<void>((resolve) => setImmediate(resolve));
  await trading.refreshOwnOffers();
  assert.equal(calls, 1);
  release?.();
  await firstRound;
});

test("conserva la operación local si falla el mensaje de chat después de aplicar", async () => {
  const store = new Store(
    mkdtempSync(join(tmpdir(), "qvaapply-chat-after-apply-")),
  );
  store.set("mode", "real");
  store.set("fiat_balance:BANK_CUP", "10000");
  const notifications: string[] = [];
  const qva = {
    getOffer: async () => ({
      uuid: "applied",
      type: "sell",
      coin: "BANK_CUP",
      amount: 5,
      receive: 4_500,
      status: "open",
    }),
    apply: async () => undefined,
    sendChat: async () => {
      throw new Error("chat temporalmente indisponible");
    },
  };
  const config = {
    dataDir: mkdtempSync(join(tmpdir(), "qvaapply-chat-config-")),
    realTradingAllowed: true,
    priceGuardPercent: 15,
    autoCancelMs: 600_000,
    welcomeMessage: "Hola",
    paymentDetails: { BANK_CUP: [], BANDECPREPAGO: [] },
  };
  const trading = new TradingService(
    store,
    qva as never,
    config as never,
    async (message) => {
      notifications.push(message);
    },
  );

  await trading.applyManually("applied");

  assert.equal(store.getOperation("applied")?.state, "applied");
  assert.equal(store.recentMutationIntents(1)[0]?.state, "confirmed");
  assert.ok(
    notifications.some((message) => message.includes("no se pudo enviar")),
  );
});

test("marca como incierta una creación sin respuesta remota", async () => {
  const store = new Store(
    mkdtempSync(join(tmpdir(), "qvaapply-uncertain-create-")),
  );
  store.set("mode", "real");
  const qva = {
    listOffers: async () => [],
    createOffer: async () => {
      throw new QvaMutationUncertainError(
        "create",
        new Error("socket cerrado"),
      );
    },
  };
  const config = {
    dataDir: mkdtempSync(join(tmpdir(), "qvaapply-uncertain-config-")),
    realTradingAllowed: true,
    maxOpenOwnOffers: 10,
    welcomeMessage: "Hola",
    paymentDetails: {
      BANK_CUP: [{ name: "cuenta", value: "123" }],
      BANDECPREPAGO: [],
    },
  };
  const trading = new TradingService(
    store,
    qva as never,
    config as never,
    async () => undefined,
  );

  await assert.rejects(
    () => trading.createOwnOffer("BANK_CUP", "sell", 5, 980),
    /requiere conciliación/,
  );
  assert.equal(store.recentMutationIntents(1)[0]?.state, "uncertain");
});

test("concilia una edición incierta cuando la oferta propia ya coincide", async () => {
  const store = new Store(
    mkdtempSync(join(tmpdir(), "qvaapply-uncertain-edit-reconcile-")),
  );
  store.createMutationIntent({
    intentId: "uncertain-edit",
    operationUuid: "own-edit",
    kind: "edit_offer",
    request: { uuid: "own-edit", amount: 1.49, receive: 1.57514286 },
  });
  store.updateMutationIntent(
    "uncertain-edit",
    "uncertain",
    undefined,
    "No se recibió confirmación",
  );
  const qva = {
    listOffers: async () => [{
      uuid: "own-edit",
      type: "buy",
      coin: "CLASICA",
      amount: 1.49,
      receive: 1.58,
      status: "open",
    }],
  };
  const trading = new TradingService(
    store,
    qva as never,
    {} as never,
    async () => undefined,
  );

  assert.equal(await trading.reconcilePendingStandaloneMutations(), 1);
  assert.equal(store.hasUnresolvedMutation(), false);
  assert.equal(store.recentMutationIntents(1)[0]?.state, "reconciled");
  assert.equal(store.countAudit("standalone_offer_mutation_reconciled"), 1);
  store.close();
});

test("mantiene incierta una edición cuando la oferta remota no coincide", async () => {
  const store = new Store(
    mkdtempSync(join(tmpdir(), "qvaapply-uncertain-edit-mismatch-")),
  );
  store.createMutationIntent({
    intentId: "uncertain-edit-mismatch",
    operationUuid: "own-edit-mismatch",
    kind: "edit_offer",
    request: { uuid: "own-edit-mismatch", amount: 1.49, receive: 1.58 },
  });
  store.updateMutationIntent("uncertain-edit-mismatch", "uncertain");
  const qva = {
    listOffers: async () => [{
      uuid: "own-edit-mismatch",
      type: "buy",
      coin: "CLASICA",
      amount: 10,
      receive: 10.6,
      status: "open",
    }],
  };
  const trading = new TradingService(
    store,
    qva as never,
    {} as never,
    async () => undefined,
  );

  assert.equal(await trading.reconcilePendingStandaloneMutations(), 0);
  assert.equal(store.hasUnresolvedMutation(), true);
  assert.equal(store.recentMutationIntents(1)[0]?.state, "uncertain");
  store.close();
});

test("concilia creación y cancelación propias solo con evidencia remota", async () => {
  const store = new Store(
    mkdtempSync(join(tmpdir(), "qvaapply-own-mutations-reconcile-")),
  );
  store.createMutationIntent({
    intentId: "uncertain-create-own",
    kind: "create_offer",
    idempotencyKey: "create-key",
    request: {
      type: "sell",
      coin: "BANK_CUP",
      amount: 5,
      receive: 4_900,
    },
  });
  store.updateMutationIntent("uncertain-create-own", "uncertain");
  store.createMutationIntent({
    intentId: "uncertain-cancel-own",
    operationUuid: "cancelled-own",
    kind: "cancel_offer",
    request: { uuid: "cancelled-own" },
  });
  store.updateMutationIntent("uncertain-cancel-own", "uncertain");
  const qva = {
    listOffers: async () => [{
      uuid: "created-own",
      type: "sell",
      coin: "BANK_CUP",
      amount: 5,
      receive: 4_900,
      status: "open",
      created_at: new Date().toISOString(),
    }],
  };
  const trading = new TradingService(
    store,
    qva as never,
    {} as never,
    async () => undefined,
  );

  assert.equal(await trading.reconcilePendingStandaloneMutations(), 2);
  assert.equal(store.hasUnresolvedMutation(), false);
  assert.deepEqual(
    store.recentMutationIntents(2).map((intent) => intent.state),
    ["reconciled", "reconciled"],
  );
  assert.equal(store.countAudit("standalone_offer_mutation_reconciled"), 2);
  store.close();
});

test("concilia tras reinicio paid, received y cancel con evidencia remota", async () => {
  const store = new Store(
    mkdtempSync(join(tmpdir(), "qvaapply-operation-mutations-reconcile-")),
  );
  const cases = [
    { uuid: "pending-paid", kind: "paid", offerType: "sell", remote: "paid", expected: "paid" },
    { uuid: "pending-received", kind: "received", offerType: "buy", remote: "completed", expected: "completed" },
    { uuid: "pending-cancel", kind: "cancel", offerType: "sell", remote: "open", expected: "cancelled" },
  ] as const;
  for (const scenario of cases) {
    store.createOperation({
      uuid: scenario.uuid,
      offerType: scenario.offerType,
      coin: "BANK_CUP",
      amount: 5,
      receive: 4_900,
      rate: 980,
      state: "applied",
      autoApplied: false,
      cancelAt: null,
      createdAt: Date.now(),
    });
    store.createMutationIntent({
      intentId: `intent-${scenario.uuid}`,
      operationUuid: scenario.uuid,
      kind: scenario.kind,
      request: { uuid: scenario.uuid },
    });
    store.updateMutationIntent(`intent-${scenario.uuid}`, "uncertain");
  }
  const remoteStates = new Map<string, string>(
    cases.map((item) => [item.uuid, item.remote]),
  );
  const trading = new TradingService(
    store,
    {
      getOffer: async (uuid: string) => ({ uuid, status: remoteStates.get(uuid) }),
    } as never,
    {} as never,
    async () => undefined,
  );

  assert.equal(await trading.reconcilePendingStandaloneMutations(), 3);
  assert.equal(store.hasUnresolvedMutation(), false);
  for (const scenario of cases)
    assert.equal(store.getOperation(scenario.uuid)?.state, scenario.expected);
  store.close();
});

test("mantiene pendiente una mutación de Operación sin evidencia concluyente", async () => {
  const store = new Store(
    mkdtempSync(join(tmpdir(), "qvaapply-operation-mutation-inconclusive-")),
  );
  store.createOperation({
    uuid: "received-still-processing",
    offerType: "buy",
    coin: "BANK_CUP",
    amount: 5,
    receive: 4_900,
    rate: 980,
    state: "applied",
    autoApplied: false,
    cancelAt: null,
    createdAt: Date.now(),
  });
  store.createMutationIntent({
    intentId: "intent-received-still-processing",
    operationUuid: "received-still-processing",
    kind: "received",
    request: { uuid: "received-still-processing" },
  });
  store.updateMutationIntent("intent-received-still-processing", "uncertain");
  const trading = new TradingService(
    store,
    {
      getOffer: async () => ({
        uuid: "received-still-processing",
        status: "processing",
      }),
    } as never,
    {} as never,
    async () => undefined,
  );

  assert.equal(await trading.reconcilePendingStandaloneMutations(), 0);
  assert.equal(store.hasUnresolvedMutation(), true);
  assert.equal(store.getOperation("received-still-processing")?.state, "applied");
  store.close();
});

test("recupera una aplicación confirmada antes de proyectar la Operación local", async () => {
  const store = new Store(
    mkdtempSync(join(tmpdir(), "qvaapply-confirmed-apply-projection-")),
  );
  store.createMutationIntent({
    intentId: "confirmed-apply-without-operation",
    operationUuid: "applied-before-crash",
    kind: "apply",
    request: { uuid: "applied-before-crash", automatic: true },
  });
  store.updateMutationIntent("confirmed-apply-without-operation", "confirmed");
  const trading = new TradingService(
    store,
    {
      getOffer: async () => ({
        uuid: "applied-before-crash",
        type: "sell",
        coin: "BANK_CUP",
        amount: 5,
        receive: 4_900,
        status: "processing",
        User: { uuid: "counterparty" },
      }),
    } as never,
    {} as never,
    async () => undefined,
  );

  assert.equal(await trading.reconcilePendingStandaloneMutations(), 1);
  assert.equal(store.getOperation("applied-before-crash")?.state, "applied");
  assert.equal(store.getOperation("applied-before-crash")?.autoApplied, true);
  assert.equal(
    store.recentMutationIntents(1)[0]?.state,
    "reconciled",
  );
  store.close();
});

test("omite una edición si QvaPay ya refleja el mismo importe y total", async () => {
  const store = new Store(
    mkdtempSync(join(tmpdir(), "qvaapply-duplicate-edit-")),
  );
  store.set("mode", "real");
  store.createMutationIntent({
    intentId: "recent-confirmed-edit",
    operationUuid: "own-already-edited",
    kind: "edit_offer",
    request: {
      uuid: "own-already-edited",
      amount: 1.49,
      receive: 1.57514286,
    },
  });
  store.updateMutationIntent("recent-confirmed-edit", "confirmed");
  let edits = 0;
  const qva = {
    listOffers: async () => [{
      uuid: "own-already-edited",
      type: "buy",
      coin: "CLASICA",
      amount: 1.49,
      receive: 1.58,
      status: "open",
    }],
    editOffer: async () => {
      edits += 1;
    },
  };
  const trading = new TradingService(
    store,
    qva as never,
    { realTradingAllowed: true } as never,
    async () => undefined,
  );

  await trading.editOwnOffer(
    "own-already-edited",
    1.49,
    1.57514286 / 1.49,
  );

  assert.equal(edits, 0);
  assert.equal(store.recentMutationIntents().length, 1);
  assert.equal(store.countAudit("edit_offer_unchanged"), 1);
  store.close();
});

test("no reintenta automáticamente una cancelación cuyo resultado remoto es incierto", async () => {
  const store = new Store(
    mkdtempSync(join(tmpdir(), "qvaapply-uncertain-cancel-")),
  );
  store.set("mode", "real");
  store.createOperation({
    uuid: "uncertain-cancel",
    offerType: "sell",
    coin: "BANK_CUP",
    amount: 5,
    receive: 4_900,
    rate: 980,
    state: "applied",
    autoApplied: true,
    cancelAt: Date.now() - 1,
    createdAt: Date.now() - 600_000,
  });
  let cancelCalls = 0;
  const qva = {
    profile: async () => ({ uuid: "me" }),
    listChat: async () => [],
    getOffer: async () => ({ uuid: "uncertain-cancel", status: "open" }),
    cancel: async () => {
      cancelCalls += 1;
      throw new QvaMutationUncertainError(
        "cancel",
        new Error("socket cerrado"),
      );
    },
  };
  const notifications: string[] = [];
  const trading = new TradingService(
    store,
    qva as never,
    { autoCancelMs: 600_000 } as never,
    async (message) => {
      notifications.push(message);
    },
  );

  await trading.expireOperations();
  await trading.expireOperations();

  assert.equal(cancelCalls, 1);
  assert.equal(store.getOperation("uncertain-cancel")?.state, "applied");
  assert.equal(store.getOperation("uncertain-cancel")?.cancelAt, null);
  assert.equal(store.recentMutationIntents(1)[0]?.state, "uncertain");
  assert.equal(store.countAudit("auto_cancel_reconciliation_required"), 1);
  assert.ok(
    notifications.some((message) => message.includes("conciliación manual")),
  );
});

test("sincroniza estados terminales cambiados directamente en QvaPay", async () => {
  const store = new Store(
    mkdtempSync(join(tmpdir(), "qvaapply-remote-operation-sync-")),
  );
  store.set("mode", "real");
  const createdAt = Date.now() - 60_000;
  for (const [uuid, state] of [
    ["remote-completed", "paid"],
    ["remote-cancelled", "acknowledged"],
    ["remote-open", "applied"],
    ["remote-paid", "acknowledged"],
  ] as const)
    store.createOperation({
      uuid,
      offerType: "sell",
      coin: "BANK_CUP",
      amount: 5,
      receive: 4_900,
      rate: 980,
      state,
      autoApplied: true,
      cancelAt: null,
      createdAt,
    });
  const remoteStates = new Map([
    ["remote-completed", "completed"],
    ["remote-cancelled", "cancelled"],
    ["remote-open", "open"],
    ["remote-paid", "paid"],
  ]);
  const trading = new TradingService(
    store,
    {
      getOffer: async (uuid: string) => ({ uuid, status: remoteStates.get(uuid) }),
    } as never,
    { realTradingAllowed: true } as never,
    async () => undefined,
  );

  assert.equal(await trading.syncRemoteOperations(), 4);
  assert.equal(store.getOperation("remote-completed")?.state, "completed");
  assert.equal(store.getOperation("remote-cancelled")?.state, "cancelled");
  assert.equal(store.getOperation("remote-open")?.state, "cancelled");
  assert.equal(store.getOperation("remote-paid")?.state, "paid");
  assert.deepEqual(store.visibleOperations().map((item) => item.uuid), ["remote-paid"]);
});
