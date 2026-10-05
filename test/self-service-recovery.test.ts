import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SelfServiceRecovery } from "../src/self-service-recovery.js";
import { Store } from "../src/store.js";
import type { MutationIntent } from "../src/store.js";

function setup() {
  const store = new Store(mkdtempSync(join(tmpdir(), "qvaapply-recovery-")));
  function createIntent(
    intentId: string,
    uuid: string,
    options: { workflowId?: string; kind?: string; state?: MutationIntent["state"] } = {},
  ) {
    store.createMutationIntent({
      intentId,
      operationUuid: uuid,
      ...(options.workflowId ? { workflowId: options.workflowId } : {}),
      kind: options.kind ?? "apply",
      request: { uuid, automatic: true },
    });
    if (options.state !== "submitted")
      store.updateMutationIntent(intentId, options.state ?? "uncertain", undefined, "Respuesta remota ambigua");
    return store.getMutationIntent(intentId)!;
  }
  return { store, createIntent };
}

test("lista incertidumbres con exposición, feed y retry sin exponer el request", () => {
  const { store, createIntent } = setup();
  createIntent("intent-list", "recovery-uuid");
  store.set("reconciliation_retry:intent-list", JSON.stringify({ attempts: 3, nextAttemptAt: Date.now() + 60_000 }));
  const service = new SelfServiceRecovery(store, {} as never);

  const result = service.list();

  assert.equal(result.blocked, true);
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0]?.manualEligible, true);
  assert.deepEqual(result.items[0]?.retry.attempts, 3);
  assert.equal("request" in result.items[0]!, false);
  store.close();
});

test("check concilia solo el intent solicitado, fuerza lectura y nunca repite apply", async () => {
  const { store, createIntent } = setup();
  createIntent("intent-one", "recovery-one");
  createIntent("intent-two", "recovery-two");
  store.set("reconciliation_retry:intent-one", JSON.stringify({ attempts: 1, nextAttemptAt: Date.now() + 60_000 }));
  store.set("reconciliation_last_check:intent-one", JSON.stringify({ checkedAt: Date.now() - 10, error: "QvaPay devolvió HTTP 404: permisos no determinados." }));
  const calls: unknown[] = [];
  const service = new SelfServiceRecovery(store, {
    reconcilePendingStandaloneMutations: async (options: unknown) => {
      calls.push(options);
      return 0;
    },
  } as never);

  const report = await service.check("intent-one");

  assert.deepEqual(calls, [{ intentId: "intent-one", force: true }]);
  assert.equal(report.outcome, "pending");
  assert.equal(report.retry.attempts, 1);
  assert.match(report.error ?? "", /HTTP 404/);
  assert.match(store.recentAudit(5)[0]?.detail ?? "", /admin_web comprobó la intención intent-one/);
  store.close();
});

test("check de workflow informa estado sin ejecutar conciliación ni compensación", async () => {
  const { store, createIntent } = setup();
  createIntent("workflow-intent", "workflow-target", { workflowId: "missing-workflow" });
  let calls = 0;
  const service = new SelfServiceRecovery(store, {
    reconcilePendingStandaloneMutations: async () => { calls += 1; return 0; },
  } as never);

  const report = await service.check("workflow-intent");

  assert.equal(report.outcome, "workflow_review_required");
  assert.match(report.message, /no se ejecutó ninguna compensación/i);
  assert.equal(calls, 0);
  store.close();
});

test("las comprobaciones manuales comparten un límite persistente sin impedir una consulta posterior", async () => {
  const { store, createIntent } = setup();
  createIntent("limited-one", "limited-one-target");
  createIntent("limited-two", "limited-two-target");
  let now = Date.now();
  let calls = 0;
  const engine = { reconcilePendingStandaloneMutations: async () => { calls++; return 0; } };
  const first = new SelfServiceRecovery(store, engine as never, () => now);
  const second = new SelfServiceRecovery(store, engine as never, () => now);
  await first.check("limited-one");
  await assert.rejects(second.check("limited-two"), /Espera unos segundos/);
  assert.equal(calls, 1);
  now += 10_000;
  await second.check("limited-two");
  assert.equal(calls, 2);
  store.close();
});

test("una oferta abierta permite declarar no aplicada, pero nunca cancelada", () => {
  const { store, createIntent } = setup();
  const intent = createIntent("open-manual", "open-target");
  store.enqueueMarketFeedEvent({ key: "open-event", event: "p2p.created", payload: {
    event: "p2p.created", sent_at: new Date().toISOString(), data: { uuid: "open-target", status: "open" },
  } });
  const service = new SelfServiceRecovery(store, {} as never);
  assert.deepEqual(service.list().items[0]?.manualOutcomes, ["not_applied"]);
  const input = { intentId: intent.intentId, expectedUpdatedAt: intent.updatedAt,
    reason: "Verifiqué manualmente la operación", evidence: "QvaPay no registra aplicación ni saldo comprometido", confirmed: true as const };
  assert.throws(() => service.resolveManual({ ...input, outcome: "cancelled" }), /oferta abierta/);
  assert.equal(store.resolveMutationIntentCAS(intent.intentId, intent.updatedAt, {
    source: "operator_attestation", actor: "admin_web", operatorConfirmed: true,
    outcome: "cancelled", reason: input.reason, evidence: input.evidence, verifiedAt: Date.now(),
  }), false);
  assert.equal(service.resolveManual({ ...input, outcome: "not_applied" }).state, "reconciled");
  store.close();
});

test("resolución manual CAS deja constancia como declaración y no confirmación remota", () => {
  const { store, createIntent } = setup();
  const intent = createIntent("manual-intent", "manual-target");
  createIntent("other-pending-intent", "other-pending-target");
  const service = new SelfServiceRecovery(store, {} as never);

  const report = service.resolveManual({
    intentId: intent.intentId,
    expectedUpdatedAt: intent.updatedAt,
    outcome: "not_applied",
    reason: "Revisé manualmente el historial de la oferta en QvaPay.",
    evidence: "La cuenta no muestra una aplicación ni una operación asociada al UUID.",
    confirmed: true,
  });

  const saved = store.getMutationIntent(intent.intentId)!;
  assert.equal(report.state, "reconciled");
  assert.deepEqual(saved.response, {
    source: "operator_attestation",
    actor: "admin_web",
    outcome: "not_applied",
    reason: "Revisé manualmente el historial de la oferta en QvaPay.",
    evidence: "La cuenta no muestra una aplicación ni una operación asociada al UUID.",
    verifiedAt: report.verifiedAt,
    operatorConfirmed: true,
  });
  assert.match(store.recentAudit(5)[0]?.detail ?? "", /No es confirmación remota de QvaPay/);
  assert.equal(store.hasUnresolvedMutation(), true, "resolver una intención no libera otras intenciones globales");
  store.close();
});

test("resolución manual rechaza revisión obsoleta y operaciones con exposición", () => {
  const { store, createIntent } = setup();
  const intent = createIntent("stale-manual", "active-target");
  store.createOperation({
    uuid: "active-target", offerType: "sell", coin: "BANK_CUP", amount: 10,
    receive: 9_200, rate: 920, state: "applied", autoApplied: true,
    cancelAt: null, createdAt: Date.now(),
  });
  const service = new SelfServiceRecovery(store, {} as never);

  const item = service.list().items.find((entry) => entry.intentId === intent.intentId)!;
  assert.equal(item.manualEligible, false);
  assert.match(item.manualBlockedReason ?? "", /operación local en estado applied/);
  assert.throws(() => service.resolveManual({
    intentId: intent.intentId,
    expectedUpdatedAt: intent.updatedAt - 1,
    outcome: "cancelled",
    reason: "Revisé manualmente el historial de la oferta en QvaPay.",
    evidence: "La cuenta muestra la cancelación de la operación asociada.",
    confirmed: true,
  }), /cambió/);
  assert.throws(() => service.resolveManual({
    intentId: intent.intentId,
    expectedUpdatedAt: intent.updatedAt,
    outcome: "cancelled",
    reason: "Revisé manualmente el historial de la oferta en QvaPay.",
    evidence: "La cuenta muestra la cancelación de la operación asociada.",
    confirmed: true,
  }), /estado applied/);
  assert.equal(store.getMutationIntent(intent.intentId)?.state, "uncertain");
  store.close();
});

test("bloquea la resolución manual cuando el orden del feed tiene un empate ambiguo", () => {
  const { store, createIntent } = setup();
  createIntent("feed-tie-intent", "feed-tie-target");
  const timestamp = new Date().toISOString();
  for (const [index, event] of ["p2p.created", "p2p.reopened"].entries())
    store.enqueueMarketFeedEvent({
      key: `feed-tie-${index}`,
      event,
      state: "ignored",
      payload: {
        event,
        sent_at: timestamp,
        data: { uuid: "feed-tie-target", status: "open" },
      },
    });
  const service = new SelfServiceRecovery(store, {} as never);

  const item = service.list().items[0]!;

  assert.equal(item.feed, undefined);
  assert.equal(item.manualEligible, false);
  assert.match(item.manualBlockedReason ?? "", /historial del feed es ambiguo/i);
  store.close();
});

test("p2p.completed posterior permite solo declarar revisión terminal sin inventar resultado remoto", () => {
  const { store, createIntent } = setup();
  const intent = createIntent("terminal-intent", "terminal-offer");
  store.enqueueMarketFeedEvent({ key: "terminal-event", event: "p2p.completed", receivedAt: Date.now(), payload: {
    event: "p2p.completed", sent_at: new Date(Date.now()).toISOString(), data: { uuid: "terminal-offer", status: "completed" },
  } });
  const service = new SelfServiceRecovery(store, {} as never);
  const item = service.list().items[0]!;
  assert.equal(item.manualEligible, true);
  assert.deepEqual(item.manualOutcomes, ["terminal_reviewed"]);
  const input = { intentId: intent.intentId, expectedUpdatedAt: intent.updatedAt,
    reason: "Revisé la oferta finalizada y mis operaciones en QvaPay.",
    evidence: "La oferta terminó, pero mi cuenta no muestra operación ni pago pendiente.", confirmed: true as const };
  assert.throws(() => service.resolveManual({ ...input, outcome: "not_applied" }), /oferta terminó/);
  assert.equal(service.resolveManual({ ...input, outcome: "terminal_reviewed" }).state, "reconciled");
  assert.equal((store.getMutationIntent(intent.intentId)?.response as { outcome: string }).outcome, "terminal_reviewed");
  assert.equal(store.getOperation("terminal-offer"), undefined);
  assert.equal(store.hasFiatMovement("terminal-offer"), false);
  store.close();
});

test("p2p.completed anterior a la intención no habilita resolución terminal", () => {
  const { store, createIntent } = setup();
  store.enqueueMarketFeedEvent({ key: "old-terminal", event: "p2p.completed", receivedAt: Date.now() - 5_000, payload: {
    event: "p2p.completed", sent_at: new Date(Date.now() - 5_000).toISOString(), data: { uuid: "old-offer", status: "completed" },
  } });
  const intent = createIntent("old-terminal-intent", "old-offer");
  const service = new SelfServiceRecovery(store, {} as never);
  assert.equal(service.list().items[0]?.manualEligible, false);
  assert.equal(store.resolveMutationIntentCAS(intent.intentId, intent.updatedAt, {
    source: "operator_attestation", actor: "admin_web", operatorConfirmed: true,
    outcome: "terminal_reviewed", reason: "Revisé la oferta en QvaPay", evidence: "No existe operación ni pago pendiente", verifiedAt: Date.now(),
  }), false);
  store.close();
});
