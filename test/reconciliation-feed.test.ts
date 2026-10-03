import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Store } from "../src/store.js";
import { TradingEngine } from "../src/trading.js";
import { QvaApiError } from "../src/qvapay.js";

for (const scenario of ["cancelled", "old", "reopened", "processing", "no-event", "403", "future", "early-receipt", "paid", "revision", "completed-event", "tie"] as const) {
  test(`conciliación segura con feed: ${scenario}`, async (t) => {
    let now = 1_790_000_000_000;
    t.mock.method(Date, "now", () => now);
    const store = new Store(mkdtempSync(join(tmpdir(), "qva-feed-reconcile-")));
    t.after(() => store.close());
    store.createMutationIntent({ intentId: "pending", operationUuid: "offer", kind: "apply", request: {} });
    store.updateMutationIntent("pending", "uncertain");
    if (scenario === "paid" || scenario === "revision") store.createOperation({
      uuid: "offer", offerType: "sell", coin: "BANK_CUP", amount: 10, receive: 9_200,
      rate: 920, state: scenario, autoApplied: true, cancelAt: null, createdAt: now,
    });
    let reads = 0;
    const trading = new TradingEngine(store, {
      getOffer: async () => { reads++; throw new QvaApiError(scenario === "403" ? 403 : 404, "No tienes permisos para ver esta oferta"); },
    } as never, {} as never, async () => undefined);
    now += 2_000;
    if (scenario !== "no-event") {
      store.enqueueMarketFeedEvent({ key: "cancel", event: "p2p.cancelled", receivedAt: scenario === "early-receipt" ? now - 3_000 : now,
        payload: { event: "p2p.cancelled", sent_at: new Date(now - (scenario === "old" ? 3_000 : scenario === "future" ? -100_000 : 1_000)).toISOString(), data: { uuid: "offer", status: "cancelled" } } });
    }
    if (scenario === "reopened" || scenario === "processing") {
      const event = scenario === "reopened" ? "p2p.reopened" : "p2p.applied";
      store.enqueueMarketFeedEvent({ key: "later", event, receivedAt: now,
        payload: { event, sent_at: new Date(now).toISOString(), data: { uuid: "offer", status: scenario === "reopened" ? "open" : "processing" } } });
    }
    if (scenario === "completed-event" || scenario === "tie") store.enqueueMarketFeedEvent({
      key: "other-terminal", event: "p2p.completed", receivedAt: now,
      payload: { event: "p2p.completed", sent_at: new Date(now - (scenario === "tie" ? 1_000 : 0)).toISOString(), data: { uuid: "offer", status: "completed" } },
    });
    assert.equal(await trading.reconcilePendingStandaloneMutations(), scenario === "cancelled" ? 1 : 0);
    assert.equal(store.hasUnresolvedMutation(), scenario !== "cancelled");
    assert.equal(store.getOperation("offer")?.state, scenario === "paid" || scenario === "revision" ? scenario : undefined);
    assert.equal(store.recentFiat("BANK_CUP", 10).length, 0);
    await trading.reconcilePendingStandaloneMutations();
    assert.equal(reads, 1, "no se repite GET inmediatamente, incluso tras reiniciar el servicio");
    if (scenario !== "cancelled") {
      now += 60_000;
      await trading.reconcilePendingStandaloneMutations();
      assert.equal(reads, 2);
    }
  });
}
