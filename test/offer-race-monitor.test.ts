import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Store } from "../src/store.js";
import { OfferRaceMonitor } from "../src/offer-race-monitor.js";
import { NotificationDispatcher } from "../src/notification-dispatcher.js";
import type { P2pOffer } from "../src/types.js";

const offer: P2pOffer = { uuid: "race", type: "sell", coin: "CLASICA", amount: 10, receive: 10.9, only_vip: false, status: "processing" };
const sentAt = new Date(1000).toISOString();
function setup() {
  const store = new Store(mkdtempSync(join(tmpdir(), "qva-race-monitor-")));
  const messages: string[] = [];
  const dispatcher = new NotificationDispatcher(store, {
    telegram: async n => { messages.push(n.message); }, webPush: async () => undefined,
  }, () => 2000);
  const monitor = new OfferRaceMonitor(store, input => dispatcher.publish(input),
    coin => coin === "CLASICA" ? "Clásica" : undefined, o => o.owner_uuid === "me", () => 2000);
  return { store, messages, dispatcher, monitor };
}

test("solo confirma ocupación con evento no VIP; deduplica y registra otra reapertura", async t => {
  const { store, messages, monitor } = setup(); t.after(() => store.close());
  const withoutVip = { ...offer }; delete withoutVip.only_vip;
  await monitor.taken(withoutVip, 2000, sentAt);
  for (const variant of [{ only_vip: true }, { owner_uuid: "me" }, { coin: "OTHER" }])
    await monitor.taken({ ...offer, ...variant }, 2000, sentAt);
  assert.equal(messages.length, 0);
  await monitor.evaluated(offer, 1100, sentAt, "QvaPay rechazó: HTTP 404 permiso denegado");
  assert.equal(messages.length, 1);
  assert.match(messages[0]!, /no confirma/);
  store.audit("offer_apply_timing", JSON.stringify({ queuedAt: 1101, dispatchedAt: 1103, finishedAt: 1900 }), offer.uuid);
  await monitor.taken(offer, 2000, sentAt);
  await monitor.taken(offer, 2000, sentAt);
  assert.equal(messages.length, 2);
  assert.match(messages[1]!, /Recepción → envío: 3 ms/);
  assert.match(messages[1]!, /respuesta QvaPay: 797 ms/);
  assert.match(messages[1]!, /no identifica/);
  await monitor.taken(offer, 3000, new Date(3000).toISOString());
  assert.equal(messages.length, 3);
  assert.equal(store.pendingUserNotifications().length, 0, "las trazas no entierran avisos operativos web");
});

test("aplicaciones propias pendientes, inciertas, confirmadas y cooperativas no son carreras perdidas", async t => {
  const { store, messages, monitor } = setup(); t.after(() => store.close());
  store.createMutationIntent({ intentId: "own", operationUuid: offer.uuid, kind: "apply", request: {} });
  for (const state of ["submitted", "uncertain", "confirmed"] as const) {
    store.updateMutationIntent("own", state);
    await monitor.taken(offer, 2000, sentAt);
  }
  assert.equal(messages.length, 0);
  store.updateMutationIntent("own", "rejected");
  store.set(`cooperative_owner_fiat:${offer.uuid}`, "0");
  await monitor.taken(offer, 2000, sentAt);
  assert.equal(messages.length, 0);
  store.set(`cooperative_owner_fiat:${offer.uuid}`, "");
  await monitor.taken(offer, 2000, sentAt);
  assert.equal(messages.length, 1);
});

test("un evento adelantado a la respuesta de rechazo se concilia después sin duplicar", async t => {
  const { store, messages, monitor } = setup(); t.after(() => store.close());
  store.createMutationIntent({ intentId: "own", operationUuid: offer.uuid, kind: "apply", request: {} });
  store.enqueueMarketFeedEvent({ key: "applied", event: "p2p.applied", receivedAt: 1900,
    payload: { event: "p2p.applied", sent_at: sentAt, data: offer } });
  await monitor.taken(offer, 1900, sentAt);
  assert.equal(messages.length, 0);
  store.updateMutationIntent("own", "rejected");
  await monitor.evaluated(offer, 1100, sentAt, "QvaPay rechazó HTTP 404");
  assert.equal(messages.length, 2);
  assert.match(messages[1]!, /Oferta ocupada/);
});

test("un aviso operativo nuevo adelanta a trazas ya encoladas", async t => {
  const { store } = setup(); t.after(() => store.close());
  for (const id of ["trace-1", "trace-2"])
    store.enqueueNotification({ id, kind: "offer-taken", message: id, payload: {}, createdAt: 1000 });
  const delivered: string[] = [];
  const dispatcher = new NotificationDispatcher(store, {
    telegram: async n => {
      delivered.push(n.id);
      if (delivered.length === 1) store.enqueueNotification({ id: "critical", kind: "operation-applied", message: "critical", payload: {}, createdAt: 1500 });
    }, webPush: async () => undefined,
  }, () => 2000);
  await dispatcher.deliverDue();
  assert.deepEqual(delivered, ["trace-1", "critical", "trace-2"]);
});
