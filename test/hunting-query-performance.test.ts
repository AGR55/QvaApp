import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { Store } from "../src/store.js";

test("las intenciones pendientes por oferta usan el índice y conservan sus estados y exclusiones", () => {
  const directory = mkdtempSync(join(tmpdir(), "qva-hunting-query-"));
  let store = new Store(directory);
  const db = new DatabaseSync(join(directory, "qvaapply.sqlite"));
  try {
    const insert = db.prepare(`INSERT INTO mutation_intents(intent_id, operation_uuid, kind, state, request_json, created_at, updated_at)
      VALUES (?, ?, 'apply', ?, '{}', 1, 1)`);
    insert.run("submitted", "offer", "submitted");
    insert.run("uncertain", "offer", "uncertain");
    insert.run("confirmed", "closed", "confirmed");
    assert.equal(store.hasUnresolvedMutationForOffer("offer"), true);
    assert.equal(store.hasUnresolvedMutationForOffer("offer", "submitted"), true);
    assert.equal(store.hasUnresolvedMutationForOffer("closed"), false);
    assert.equal(store.hasUnresolvedMutationForOffer("missing"), false);
    db.prepare("UPDATE mutation_intents SET state='rejected' WHERE intent_id='uncertain'").run();
    assert.equal(store.hasUnresolvedMutationForOffer("offer", "submitted"), false);
    db.prepare("UPDATE mutation_intents SET state='uncertain' WHERE intent_id='confirmed'").run();
    assert.equal(store.hasUnresolvedMutationForOffer("closed"), true);
    const plan = db.prepare(`EXPLAIN QUERY PLAN SELECT 1 FROM mutation_intents WHERE operation_uuid = ?
      AND state IN ('submitted', 'uncertain') AND intent_id != ? LIMIT 1`).all("offer", "");
    assert.ok(plan.some(row => String(row.detail).includes("idx_mutation_intents_unresolved_offer")));
    store.close();
    store = new Store(directory);
    assert.equal(store.hasUnresolvedMutationForOffer("closed"), true);
  } finally {
    db.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("pausas invalidan la oferta y solo una reanudación posterior y explícita la habilita", () => {
  const directory = mkdtempSync(join(tmpdir(), "qva-hunting-pause-"));
  const store = new Store(directory);
  const uuid = "offer";
  const at = (second: number) => `2026-09-24T12:00:${String(second).padStart(2, "0")}Z`;
  const add = (event: string, second: number, data: Record<string, unknown> = {}) => store.enqueueMarketFeedEvent({
    key: `${event}:${second}`, event, receivedAt: Date.parse(at(second)),
    payload: { event, sent_at: at(second), data: { uuid, type: "sell", status: "open", ...data } },
  });
  try {
    add("p2p.created", 1);
    add("p2p.paused", 2, { pause: { reason: "owner", until: null } });
    assert.equal(store.nextMarketFeedEvent(Date.parse(at(10)), "opportunity")?.event, "p2p.created");
    assert.equal(store.nextMarketFeedEvent(Date.parse(at(10)), "state")?.event, "p2p.paused");
    assert.equal(store.latestMarketFeedState(uuid)?.status, "paused");
    assert.equal(store.hasPendingMarketFeedInvalidation(uuid, Date.parse(at(1))), true);
    assert.equal(store.hasPendingMarketFeedInvalidation(uuid), true);
    add("p2p.resumed", 3, { pause: { reason: "owner" } });
    assert.equal(store.latestMarketFeedState(uuid)?.status, "unknown");
    assert.equal(store.hasPendingMarketFeedInvalidation(uuid, Date.parse(at(1))), true);
    add("p2p.resumed", 4, { pause: null });
    assert.equal(store.latestMarketFeedState(uuid)?.status, "open");
    assert.equal(store.hasPendingMarketFeedInvalidation(uuid, Date.parse(at(1))), false);
    assert.equal(store.hasPendingMarketFeedInvalidation(uuid), false);
    store.completeMarketFeedEvent("p2p.created:1", "processed");
    assert.equal(store.nextMarketFeedEvent(Date.parse(at(10)), "opportunity")?.event, "p2p.resumed");
    add("p2p.paused", 4, { pause: { reason: "owner" } });
    assert.equal(store.latestMarketFeedState(uuid)?.status, "unknown");
    assert.equal(store.hasPendingMarketFeedInvalidation(uuid, Date.parse(at(1))), true);
    add("p2p.cancelled", 5, { status: "cancelled" });
    add("p2p.resumed", 6, { pause: null });
    assert.equal(store.hasPendingMarketFeedInvalidation(uuid, Date.parse(at(1))), true);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
