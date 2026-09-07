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

test("cancela, aplica y deja el pago fiat como acción humana", async () => {
  const { store, markets } = setup();
  const calls: string[] = [];
  const qva = {
    qusdBalance: async () => 10,
    listOffers: async () => [own],
    cancel: async (uuid: string) => void calls.push(`cancel:${uuid}`),
    apply: async (uuid: string) => void calls.push(`apply:${uuid}`),
    createOffer: async () => {
      throw new Error("no debe restaurar");
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
  assert.equal(store.getOperation("external")?.state, "applied");
  assert.equal(store.activeReservedQusd(), 0);
  assert.equal(store.workflowOwnOffers(result.workflow!.id)[0]?.state, "cancelled");
  store.close();
});

test("restaura la oferta original cuando aplicar es rechazado", async () => {
  const { store, markets } = setup();
  const restored: unknown[] = [];
  const qva = {
    qusdBalance: async () => 10,
    listOffers: async () => [own],
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

test("un resultado incierto no restaura ni libera la reserva", async () => {
  const { store, markets } = setup();
  let restores = 0;
  const qva = {
    qusdBalance: async () => 10,
    listOffers: async () => [own],
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
