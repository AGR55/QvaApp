import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { OpportunityOrchestrator } from "../src/application/opportunity-orchestrator.js";
import { MarketConfigService } from "../src/market-config.js";
import { QvaApiError, QvaMutationUncertainError } from "../src/qvapay.js";
import { Store } from "../src/store.js";
import type { P2pOffer } from "../src/types.js";

const now = Date.parse("2026-09-06T12:00:00Z");
const target: P2pOffer = {
  uuid: "external",
  type: "buy",
  coin: "BANK_CUP",
  amount: 20,
  receive: 20_400,
  status: "open",
  updated_at: new Date(now - 2_000).toISOString(),
  User: { uuid: "other" },
};
const own: P2pOffer = {
  uuid: "own-sale",
  type: "sell",
  coin: "BANK_CUP",
  amount: 20,
  receive: 19_800,
  status: "open",
  details: { cuenta: "123" },
  message: "Oferta original",
};

function setup(reviewed = true) {
  const dataDir = mkdtempSync(join(tmpdir(), "qvaapply-orchestrator-"));
  const store = new Store(dataDir);
  store.set("paused", "false");
  const markets = new MarketConfigService(
    dataDir,
    {
      dataDir,
      qusdReserve: 0,
      maxOpenOwnOffers: 10,
      buyQusdMaxRate: 970,
      sellQusdMinRate: 1_010,
      cupPurchaseMaxQusd: 25,
      initialUsdFiatBalance: 0,
      paymentDetails: { BANK_CUP: [], BANDECPREPAGO: [] },
    } as never,
    store,
  );
  if (reviewed) {
    const config = markets.current();
    config.risk.reviewedAt = now;
    markets.save(config);
  }
  return { store, markets };
}

const input = {
  target,
  referenceRate: 1_015,
  expectedMarginPercent: 2,
  priceDecision: "eligible" as const,
  priceReason: "Supera el mínimo de venta.",
};

test("hidrata los datos de pago antes de cancelar y los conserva al reponer", async () => {
  const { store, markets } = setup();
  const config = markets.current();
  config.qusdReserve = 0;
  config.risk.minQusdReserve = 0;
  markets.save(config);
  const calls: string[] = [];
  const restored: Array<{
    amount: number;
    receive: number;
    details: Array<{ name: string; value: string }>;
  }> = [];
  const qva = {
    qusdBalance: async () => 10,
    listOffers: async () => [{ ...own, details: undefined }],
    getOffer: async () => own,
    cancel: async (uuid: string) => void calls.push(`cancel:${uuid}`),
    apply: async (uuid: string) => void calls.push(`apply:${uuid}`),
    createOffer: async (request: {
      amount: number;
      receive: number;
      details: Array<{ name: string; value: string }>;
    }) => {
      restored.push(request);
      return { ...own, ...request, uuid: "restored-surplus" };
    },
  };
  const orchestrator = new OpportunityOrchestrator(
    store,
    qva as never,
    markets,
    { now: () => now },
  );

  const result = await orchestrator.execute(input);

  assert.equal(result.decision.kind, "apply");
  assert.equal(result.workflow?.state, "applied");
  assert.deepEqual(calls, ["cancel:own-sale", "apply:external"]);
  assert.equal(restored.length, 1);
  assert.equal(restored[0]?.amount, 10);
  assert.equal(restored[0]?.receive, 9_900);
  assert.deepEqual(restored[0]?.details, [{ name: "cuenta", value: "123" }]);
  assert.equal(store.getOperation("external")?.state, "applied");
  assert.equal(store.activeReservedQusd(), 0);
  assert.equal(store.workflowOwnOffers(result.workflow!.id)[0]?.state, "restored");
  assert.ok(
    store
      .recentMutationIntents(10)
      .filter((intent) => intent.kind !== "restore_own_offer")
      .every((intent) => intent.workflowId === result.workflow!.id),
  );
  store.close();
});

test("no cancela ninguna oferta si QvaPay no entrega sus datos de pago", async () => {
  const { store, markets } = setup();
  const config = markets.current();
  config.qusdReserve = 0;
  config.risk.minQusdReserve = 0;
  markets.save(config);
  const calls: string[] = [];
  const qva = {
    qusdBalance: async () => 10,
    listOffers: async () => [{ ...own, details: undefined }],
    getOffer: async () => ({ ...own, details: undefined }),
    cancel: async () => void calls.push("cancel"),
    apply: async () => void calls.push("apply"),
    createOffer: async () => void calls.push("create"),
  };
  const orchestrator = new OpportunityOrchestrator(
    store,
    qva as never,
    markets,
    { now: () => now },
  );

  const result = await orchestrator.execute(input);

  assert.equal(result.decision.kind, "blocked");
  assert.match(result.decision.reasons.at(-1) ?? "", /datos de pago/i);
  assert.deepEqual(calls, []);
  assert.equal(store.recoverableWorkflows().length, 0);
  store.close();
});

test("restaura la oferta original cuando aplicar es rechazado", async () => {
  const { store, markets } = setup();
  const restored: unknown[] = [];
  const qva = {
    qusdBalance: async () => 10,
    listOffers: async () => [own],
    getOffer: async () => own,
    cancel: async () => undefined,
    apply: async () => {
      throw new QvaApiError(409, "La oferta ya no está disponible");
    },
    createOffer: async (request: unknown) => {
      restored.push(request);
      return { ...own, uuid: "restored-sale" };
    },
  };
  const orchestrator = new OpportunityOrchestrator(
    store,
    qva as never,
    markets,
    { now: () => now },
  );

  const result = await orchestrator.execute(input);

  assert.equal(result.decision.kind, "blocked");
  assert.match(result.decision.reasons.at(-1) ?? "", /QvaPay.*ya no está disponible/i);
  assert.equal(result.workflow?.state, "restored");
  assert.equal(restored.length, 1);
  assert.equal((restored[0] as { amount: number }).amount, own.amount);
  assert.equal((restored[0] as { receive: number }).receive, own.receive);
  assert.match(
    (restored[0] as { idempotencyKey: string }).idempotencyKey,
    /^[a-f0-9]{64}$/,
  );
  assert.equal(store.activeReservedQusd(), 0);
  store.close();
});

test("libera QUSD desde otro mercado y repone el excedente proporcional", async () => {
  const { store, markets } = setup();
  const config = markets.current();
  config.qusdReserve = 0;
  config.risk.minQusdReserve = 0;
  markets.save(config);
  const otherMarket: P2pOffer = {
    ...own,
    uuid: "classic-liquidity",
    coin: "CLASICA",
    amount: 30,
    receive: 31.5,
  };
  const calls: string[] = [];
  const restored: Array<{ coin: string; amount: number; receive: number }> = [];
  const qva = {
    qusdBalance: async () => 0,
    listOffers: async () => [otherMarket],
    getOffer: async () => otherMarket,
    cancel: async (uuid: string) => void calls.push(`cancel:${uuid}`),
    apply: async (uuid: string) => void calls.push(`apply:${uuid}`),
    createOffer: async (request: { coin: string; amount: number; receive: number }) => {
      restored.push(request);
      return { ...otherMarket, ...request, uuid: "classic-restored" };
    },
  };
  const orchestrator = new OpportunityOrchestrator(store, qva as never, markets, {
    now: () => now,
  });

  const result = await orchestrator.execute(input);

  assert.equal(result.applicationConfirmed, true);
  assert.deepEqual(calls, ["cancel:classic-liquidity", "apply:external"]);
  assert.equal(restored.length, 1);
  assert.equal(restored[0]?.coin, "CLASICA");
  assert.equal(restored[0]?.amount, 10);
  assert.equal(restored[0]?.receive, 10.5);
  store.close();
});

test("redondea hacia arriba el total CUP de una reposición parcial", async () => {
  const { store, markets } = setup();
  const config = markets.current();
  config.qusdReserve = 0;
  config.risk.minQusdReserve = 0;
  markets.save(config);
  const unevenOwn: P2pOffer = {
    ...own,
    receive: 19_801,
  };
  let restoredReceive: number | undefined;
  const qva = {
    qusdBalance: async () => 10,
    listOffers: async () => [{ ...unevenOwn, details: undefined }],
    getOffer: async () => unevenOwn,
    cancel: async () => undefined,
    apply: async () => undefined,
    createOffer: async (request: { receive: number }) => {
      restoredReceive = request.receive;
      return { ...unevenOwn, ...request, uuid: "rounded-restoration" };
    },
  };
  const orchestrator = new OpportunityOrchestrator(store, qva as never, markets, {
    now: () => now,
  });

  const result = await orchestrator.execute(input);

  assert.equal(result.applicationConfirmed, true);
  assert.equal(restoredReceive, 9_910);
  store.close();
});

test("conserva la aplicación confirmada si falla la reposición del excedente", async () => {
  const { store, markets } = setup();
  const config = markets.current();
  config.qusdReserve = 0;
  config.risk.minQusdReserve = 0;
  markets.save(config);
  let restorationAttempts = 0;
  const qva = {
    qusdBalance: async () => 10,
    listOffers: async () => [own],
    getOffer: async () => own,
    cancel: async () => undefined,
    apply: async () => undefined,
    createOffer: async () => {
      restorationAttempts += 1;
      throw new QvaApiError(400, "Límite de ofertas alcanzado");
    },
  };
  const orchestrator = new OpportunityOrchestrator(store, qva as never, markets, {
    now: () => now,
  });

  const result = await orchestrator.execute(input);

  assert.equal(result.applicationConfirmed, true);
  assert.equal(result.workflow?.state, "surplus_restore_failed");
  assert.equal(store.getOperation(target.uuid)?.state, "applied");
  assert.equal(restorationAttempts, 1);
  assert.equal(store.activeReservedQusd(), 0);
  store.close();
});

test("un resultado incierto no restaura ni libera la reserva", async () => {
  const { store, markets } = setup();
  let restores = 0;
  const qva = {
    qusdBalance: async () => 10,
    listOffers: async () => [own],
    getOffer: async () => own,
    cancel: async () => undefined,
    apply: async () => {
      throw new QvaMutationUncertainError("apply", new Error("timeout"));
    },
    createOffer: async () => {
      restores += 1;
      return own;
    },
  };
  const orchestrator = new OpportunityOrchestrator(
    store,
    qva as never,
    markets,
    { now: () => now },
  );

  const result = await orchestrator.execute(input);

  assert.equal(result.workflow?.state, "apply_uncertain");
  assert.equal(restores, 0);
  assert.equal(store.activeReservedQusd(), 20);
  assert.equal(store.hasUnresolvedMutation(), true);
  store.close();
});

test("no toca ofertas hasta revisar los límites conservadores", async () => {
  const { store, markets } = setup(false);
  let mutations = 0;
  const qva = {
    qusdBalance: async () => 10,
    listOffers: async () => [own],
    cancel: async () => void (mutations += 1),
    apply: async () => void (mutations += 1),
  };
  const orchestrator = new OpportunityOrchestrator(
    store,
    qva as never,
    markets,
    { now: () => now },
  );

  const result = await orchestrator.execute(input);

  assert.equal(result.decision.kind, "manual_review");
  assert.equal(result.workflow, undefined);
  assert.equal(mutations, 0);
  store.close();
});

test("concilia tras reinicio una aplicación confirmada sin repetirla", async () => {
  const { store, markets } = setup();
  const firstQva = {
    qusdBalance: async () => 10,
    listOffers: async () => [own],
    getOffer: async () => own,
    cancel: async () => undefined,
    apply: async () => {
      throw new QvaMutationUncertainError("apply", new Error("timeout"));
    },
  };
  const first = new OpportunityOrchestrator(store, firstQva as never, markets, {
    now: () => now,
  });
  const uncertain = await first.execute(input);
  let repeatedApplications = 0;
  const recovery = new OpportunityOrchestrator(
    store,
    {
      getOffer: async () => ({ ...target, status: "processing" }),
      apply: async () => void (repeatedApplications += 1),
    } as never,
    markets,
    { now: () => now + 60_000 },
  );

  const result = await recovery.reconcilePending();

  assert.equal(result[0]?.outcome, "applied");
  assert.equal(store.getTradeWorkflow(uncertain.workflow!.id)?.state, "applied");
  assert.equal(store.getOperation(target.uuid)?.state, "applied");
  assert.equal(store.activeReservedQusd(), 0);
  assert.equal(store.hasUnresolvedMutation(), false);
  assert.equal(repeatedApplications, 0);
  store.close();
});

test("concilia el rechazo remoto restaurando la venta propia", async () => {
  const { store, markets } = setup();
  const first = new OpportunityOrchestrator(
    store,
    {
      qusdBalance: async () => 10,
      listOffers: async () => [own],
      getOffer: async () => own,
      cancel: async () => undefined,
      apply: async () => {
        throw new QvaMutationUncertainError("apply", new Error("timeout"));
      },
    } as never,
    markets,
    { now: () => now },
  );
  await first.execute(input);
  let restored = 0;
  const recovery = new OpportunityOrchestrator(
    store,
    {
      getOffer: async (uuid: string) =>
        uuid === target.uuid
          ? { ...target, status: "open" }
          : { ...own, status: "cancelled" },
      listOffers: async () => [],
      createOffer: async () => {
        restored += 1;
        return { ...own, uuid: "restored-after-restart" };
      },
    } as never,
    markets,
    { now: () => now + 60_000 },
  );

  const result = await recovery.reconcilePending();

  assert.equal(result[0]?.outcome, "restored");
  assert.equal(restored, 1);
  assert.equal(store.activeReservedQusd(), 0);
  assert.equal(store.hasUnresolvedMutation(), false);
  store.close();
});

test("mantiene reserva y bloqueo cuando la conciliación no es concluyente", async () => {
  const { store, markets } = setup();
  const first = new OpportunityOrchestrator(
    store,
    {
      qusdBalance: async () => 10,
      listOffers: async () => [own],
      getOffer: async () => own,
      cancel: async () => undefined,
      apply: async () => {
        throw new QvaMutationUncertainError("apply", new Error("timeout"));
      },
    } as never,
    markets,
    { now: () => now },
  );
  await first.execute(input);
  const recovery = new OpportunityOrchestrator(
    store,
    {
      getOffer: async () => {
        throw new Error("QvaPay no responde");
      },
    } as never,
    markets,
  );

  const result = await recovery.reconcilePending();

  assert.equal(result[0]?.outcome, "unresolved");
  assert.equal(store.activeReservedQusd(), 20);
  assert.equal(store.hasUnresolvedMutation(), true);
  store.close();
});

test("reconoce una reposición idempotente ya creada después de un 409", async () => {
  const { store, markets } = setup();
  const qva = {
    qusdBalance: async () => 10,
    listOffers: async (params: { my?: boolean }) =>
      params.my ? [own] : [],
    getOffer: async () => own,
    cancel: async () => undefined,
    apply: async () => {
      throw new QvaApiError(409, "La oferta externa ya no está disponible");
    },
    createOffer: async () => {
      throw new QvaApiError(409, "Idempotency key already used");
    },
  };
  const orchestrator = new OpportunityOrchestrator(store, qva as never, markets, {
    now: () => now,
  });

  const result = await orchestrator.execute(input);

  assert.equal(result.workflow?.state, "restored");
  assert.equal(store.workflowOwnOffers(result.workflow!.id)[0]?.restoredUuid, own.uuid);
  assert.equal(store.activeReservedQusd(), 0);
  store.close();
});
