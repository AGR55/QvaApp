import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Store } from "../src/store.js";

test("descarte masivo abarca más de una página y conserva historial y versiones nuevas", (t) => {
  const store = new Store(mkdtempSync(join(tmpdir(), "qva-bulk-dismiss-")));
  t.after(() => store.close());
  for (let i = 0; i < 45; i++) {
    const item = { uuid: `offer-${i}`, coin: "BANK_CUP", offerType: "sell" as const, amount: 10, receive: 10_000, rate: 1000, decision: "blocked" as const, reason: "mediana" };
    store.upsertTradingAlert(item);
    store.recordDecisionEvent(item);
  }
  const before = store.decisionEvents({ decision: "blocked", status: "pending", pageSize: 20 });
  assert.equal(before.items.length, 20);
  assert.equal(before.pending, 45);
  const newer = store.recordDecisionEvent({ uuid: "new", coin: "BANK_CUP", offerType: "sell", amount: 10, receive: 10_000, rate: 1000, decision: "blocked", reason: "new" });
  const manual = store.recordDecisionEvent({ uuid: "manual", coin: "BANK_CUP", offerType: "sell", amount: 10, receive: 10_000, rate: 1000, decision: "manual_review", reason: "manual" });
  store.createMutationIntent({ intentId: "money", kind: "apply", operationUuid: "pending-application", request: {} });
  store.updateMutationIntent("money", "uncertain");
  assert.equal(store.dismissAllBlockedDecisions(before.dismissThroughId), 45);
  assert.equal(store.dismissAllBlockedDecisions(before.dismissThroughId), 0);
  assert.equal(store.decisionEvents({ decision: "blocked", status: "pending" }).pending, 1);
  assert.equal(store.decisionEvents({ status: "all" }).total, 47);
  assert.equal(store.decisionEvent(newer.id)?.resolvedAt, null);
  assert.equal(store.decisionEvent(manual.id)?.resolvedAt, null);
  assert.equal(store.recentTradingAlerts(50).filter(x => x.resolution === "dismissed").length, 45);
  assert.equal(store.hasUnresolvedMutation(), true);
  assert.equal(store.getOperation("pending-application"), undefined);
});

for (const scenario of ["allowed", "submitted", "paid", "ledger", "stale", "workflow", "feed-processing", "feed-tie", "other-kind"] as const) {
  test(`CAS de revisión manual conserva protecciones: ${scenario}`, (t) => {
    const store = new Store(mkdtempSync(join(tmpdir(), "qva-manual-cas-")));
    t.after(() => store.close());
    store.createMutationIntent({ intentId: "intent", kind: scenario === "other-kind" ? "paid" : "apply", operationUuid: "offer", ...(scenario === "workflow" ? { workflowId: "workflow" } : {}), request: {} });
    if (scenario !== "submitted") store.updateMutationIntent("intent", "uncertain");
    const original = store.getMutationIntent("intent")!;
    if (scenario === "paid") store.createOperation({ uuid: "offer", coin: "BANK_CUP", offerType: "sell", amount: 10, receive: 10_000, rate: 1000, state: "paid", autoApplied: true, cancelAt: null, createdAt: Date.now() });
    if (scenario === "ledger") store.recordFiatMovement("offer", "BANK_CUP", "debit", 10_000, "test");
    if (scenario === "feed-processing") store.enqueueMarketFeedEvent({ key: "applied", event: "p2p.applied", receivedAt: Date.now(), payload: { event: "p2p.applied", sent_at: new Date().toISOString(), data: { uuid: "offer", status: "processing" } } });
    if (scenario === "feed-tie") {
      const sent_at = new Date().toISOString();
      for (const [event, status] of [["p2p.cancelled", "cancelled"], ["p2p.applied", "processing"]])
        store.enqueueMarketFeedEvent({ key: event!, event: event!, receivedAt: Date.now(), payload: { event, sent_at, data: { uuid: "offer", status } } });
    }
    const response = { source: "operator_attestation", actor: "admin_web", operatorConfirmed: true, outcome: "not_applied", reason: "Verifiqué manualmente la operación", evidence: "QvaPay no registra aplicación ni saldo comprometido", verifiedAt: Date.now() };
    const okay = store.resolveMutationIntentCAS("intent", original.updatedAt - (scenario === "stale" ? 1 : 0), response);
    assert.equal(okay, scenario === "allowed");
    assert.equal(store.getMutationIntent("intent")?.state, scenario === "allowed" ? "reconciled" : original.state);
    assert.equal(store.countAudit("mutation_manually_reviewed"), scenario === "allowed" ? 1 : 0);
    if (scenario === "allowed") {
      assert.equal(store.resolveMutationIntentCAS("intent", original.updatedAt, response), false);
      assert.equal(store.getOperation("offer"), undefined);
      assert.equal(store.hasFiatMovement("offer"), false);
      assert.equal((store.getMutationIntent("intent")?.response as typeof response).source, "operator_attestation");
    }
  });
}
