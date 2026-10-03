import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ReconciliationScheduler } from "../src/reconciliation-scheduler.js";
import { Store } from "../src/store.js";

test("aplica backoff exponencial persistido por intención y lo limita a 15 minutos", () => {
  const values = new Map<string, string>();
  const scheduler = new ReconciliationScheduler({
    get: (key) => values.get(key),
    set: (key, value) => void values.set(key, value),
  });
  const start = 1_800_000_000_000;

  assert.equal(scheduler.canAttempt("intent-a", start), true);
  assert.deepEqual(scheduler.recordFailure("intent-a", start), {
    attempts: 1,
    nextAttemptAt: start + 60_000,
  });
  assert.equal(scheduler.canAttempt("intent-a", start + 59_999), false);
  assert.equal(scheduler.canAttempt("intent-a", start + 60_000), true);

  let next = start;
  for (let attempts = 2; attempts <= 12; attempts += 1) {
    const record = scheduler.recordFailure("intent-a", next);
    assert.equal(record.attempts, attempts);
    assert.equal(record.nextAttemptAt - next, Math.min(15 * 60_000, 60_000 * 2 ** (attempts - 1)));
    next = record.nextAttemptAt;
  }
  assert.equal(scheduler.canAttempt("intent-b", start), true);
  assert.equal(scheduler.canAttempt("intent-a", next - 1), false);
});

test("clear elimina el backoff de una intención ya conciliada", () => {
  const values = new Map<string, string>();
  const scheduler = new ReconciliationScheduler({
    get: (key) => values.get(key),
    set: (key, value) => void values.set(key, value),
  });
  scheduler.recordFailure("intent-a", 1_800_000_000_000);
  scheduler.clear("intent-a");
  assert.equal(scheduler.canAttempt("intent-a", 1_800_000_000_001), true);
});

function feedEvent(
  store: Store,
  uuid: string,
  key: string,
  event: string,
  sentAt: string,
  receivedAt: number,
  status?: string,
): void {
  store.enqueueMarketFeedEvent({
    key,
    event,
    payload: {
      event,
      sent_at: sentAt,
      data: { uuid, ...(status ? { status } : {}) },
    },
    receivedAt,
  });
}

test("elige el estado feed por sent_at y no por el orden de recepción", () => {
  const store = new Store(mkdtempSync(join(tmpdir(), "qvaapply-feed-lifecycle-")));
  const uuid = "offer-lifecycle-1";
  feedEvent(store, uuid, "cancel-first", "p2p.cancelled", "2026-10-01T01:20:00Z", 100_000, "cancelled");
  feedEvent(store, uuid, "created-later-arrival", "p2p.created", "2026-10-01T01:19:00Z", 200_000, "open");
  assert.deepEqual(store.latestMarketFeedState(uuid), {
    event: "p2p.cancelled",
    status: "cancelled",
    sentAt: Date.parse("2026-10-01T01:20:00Z"),
    receivedAt: 100_000,
  });
  store.close();
});

test("reopened y applied posteriores desplazan cancelled como estado más reciente", () => {
  const store = new Store(mkdtempSync(join(tmpdir(), "qvaapply-feed-lifecycle-")));
  const uuid = "offer-lifecycle-2";
  feedEvent(store, uuid, "cancel", "p2p.cancelled", "2026-10-01T01:20:00Z", 100_000, "cancelled");
  feedEvent(store, uuid, "reopen", "p2p.reopened", "2026-10-01T01:21:00Z", 90_000, "open");
  assert.equal(store.latestMarketFeedState(uuid)?.event, "p2p.reopened");
  feedEvent(store, uuid, "apply", "p2p.applied", "2026-10-01T01:22:00Z", 80_000, "processing");
  assert.deepEqual(store.latestMarketFeedState(uuid), {
    event: "p2p.applied",
    status: "processing",
    sentAt: Date.parse("2026-10-01T01:22:00Z"),
    receivedAt: 80_000,
  });
  store.close();
});

test("no elige arbitrariamente eventos distintos empatados en sent_at", () => {
  const store = new Store(mkdtempSync(join(tmpdir(), "qvaapply-feed-lifecycle-")));
  const uuid = "offer-lifecycle-tie";
  const sentAt = "2026-10-01T01:22:00Z";
  feedEvent(store, uuid, "cancel", "p2p.cancelled", sentAt, 100_000, "cancelled");
  feedEvent(store, uuid, "apply", "p2p.applied", sentAt, 101_000, "processing");
  assert.equal(store.latestMarketFeedState(uuid), undefined);
  store.close();
});
