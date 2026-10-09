import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { NotificationDispatcher } from "../src/notification-dispatcher.js";
import { Store } from "../src/store.js";

test("publicar en segundo plano persiste sin esperar una entrega bloqueada", async () => {
  const store = new Store(mkdtempSync(join(tmpdir(), "qvaapply-notify-latency-")));
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const dispatcher = new NotificationDispatcher(store, {
    telegram: async () => { await blocked; throw new Error("sin conexión"); },
    webPush: async () => undefined,
  });
  let published = false;
  const publishing = dispatcher.publish({ message: "Aplicada", event: { kind: "operation-applied", uuid: "fast" } },
    { waitForDelivery: false }).then(() => { published = true; });
  try {
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(published, true, "la red no debe retener la decisión de cacería");
    assert.equal(store.pendingUserNotifications()[0]?.id, "operation-applied:fast");
  } finally {
    release();
    await publishing;
    await dispatcher.deliverDue();
  }
  assert.equal(store.pendingNotificationDeliveries(Date.now() + 60_000)[0]?.telegramAttempts, 1);
  store.close();
});

test("Telegram entrega solo inicios de operación y agota avisos antiguos pendientes", async () => {
  const store = new Store(mkdtempSync(join(tmpdir(), "qvaapply-quiet-telegram-")));
  const telegram: string[] = [];
  const dispatcher = new NotificationDispatcher(store, {
    telegram: async item => { telegram.push(item.kind); },
    webPush: async () => undefined,
  });
  for (const kind of ["offer-taken", "offer-rejected", "blocked-offer", "recovery-blocked", "reconciliation-required", "rebalance-attention", "operation-applied", "own-offer-applied"] as const)
    store.enqueueNotification({ id: kind, kind, message: kind, payload: {}, createdAt: Date.now() });

  await dispatcher.deliverDue();
  assert.deepEqual(telegram.sort(), ["operation-applied", "own-offer-applied"].sort());
  assert.equal(store.pendingNotificationDeliveries().length, 0);
  await dispatcher.deliverDue();
  assert.equal(telegram.length, 2, "ningún aviso silenciado debe volver por reintento");
  store.close();
});

test("persiste y reintenta Telegram sin duplicar Web Push", async () => {
  const store = new Store(mkdtempSync(join(tmpdir(), "qvaapply-notifications-")));
  let now = 1_000;
  let telegramCalls = 0;
  let pushCalls = 0;
  const dispatcher = new NotificationDispatcher(
    store,
    {
      telegram: async () => {
        telegramCalls += 1;
        if (telegramCalls === 1) throw new Error("Telegram temporalmente caído");
      },
      webPush: async () => void (pushCalls += 1),
    },
    () => now,
  );
  const notification = {
    message: "Aplicación confirmada",
    operationUuid: "operation-1",
    event: {
      kind: "operation-applied" as const,
      uuid: "operation-1",
      coin: "BANK_CUP",
      amount: 10,
    },
  };

  await dispatcher.publish(notification);
  assert.equal(telegramCalls, 1);
  assert.equal(pushCalls, 1);
  assert.equal(store.pendingUserNotifications()[0]?.id, "operation-applied:operation-1");

  now += 15_000;
  await dispatcher.deliverDue();
  assert.equal(telegramCalls, 2);
  assert.equal(pushCalls, 1);

  await dispatcher.publish(notification);
  assert.equal(telegramCalls, 2);
  assert.equal(pushCalls, 1);
  store.close();
});

test("mantiene el aviso web hasta que el usuario lo confirma", async () => {
  const store = new Store(mkdtempSync(join(tmpdir(), "qvaapply-notice-ack-")));
  const dispatcher = new NotificationDispatcher(
    store,
    { telegram: async () => undefined, webPush: async () => undefined },
  );
  await dispatcher.publish({
    message: "Aplicación confirmada",
    operationUuid: "operation-2",
    event: {
      kind: "operation-applied",
      uuid: "operation-2",
      coin: "CLASICA",
      amount: 4,
    },
  });

  assert.equal(store.pendingUserNotifications().length, 1);
  assert.equal(store.acknowledgeNotification("operation-applied:operation-2"), true);
  assert.equal(store.pendingUserNotifications().length, 0);
  store.close();
});

test("deduplica el mismo ciclo y conserva la segunda aplicación después de reabrir", async () => {
  const store = new Store(mkdtempSync(join(tmpdir(), "qvaapply-own-offer-notice-")));
  let pushCalls = 0;
  const dispatcher = new NotificationDispatcher(store, {
    telegram: async () => { throw new Error("Telegram fuera de servicio"); },
    webPush: async () => { pushCalls += 1; },
  });
  const notification = {
    message: "Tomaron tu oferta",
    operationUuid: "offer-owned-1",
    event: { kind: "own-offer-applied" as const, uuid: "offer-owned-1", coin: "BANK_CUP", amount: 8, eventVersion: "cycle-0:updated-2026-09-30T10:00:00Z" },
  };

  await dispatcher.publish(notification);
  await dispatcher.publish(notification);
  assert.equal(pushCalls, 1);
  assert.equal(store.pendingUserNotifications()[0]?.id, "own-offer-applied:offer-owned-1:cycle-0:updated-2026-09-30T10:00:00Z");
  assert.equal(store.pendingUserNotifications().length, 1);

  await dispatcher.publish({
    ...notification,
    event: { ...notification.event, eventVersion: "cycle-1:updated-2026-09-30T10:05:00Z" },
  });
  assert.equal(pushCalls, 2);
  assert.equal(store.pendingUserNotifications().length, 2);
  store.close();
});

test("el bloqueo incierto produce aviso persistente único y se retira al resolver", async () => {
  const store = new Store(mkdtempSync(join(tmpdir(), "qvaapply-recovery-notice-")));
  let telegramCalls = 0;
  const dispatcher = new NotificationDispatcher(store, {
    telegram: async () => { telegramCalls++; },
    webPush: async () => undefined,
  });
  store.createMutationIntent({ intentId: "i-recovery", kind: "apply", operationUuid: "offer", request: {} });
  store.updateMutationIntent("i-recovery", "uncertain");
  const input = { message: "QvaApply detuvo nuevas operaciones", operationUuid: "offer",
    event: { kind: "recovery-blocked" as const, intentId: "i-recovery", uuid: "offer" } };
  await dispatcher.publish(input);
  await dispatcher.publish(input);
  assert.equal(telegramCalls, 0);
  assert.equal(store.pendingUserNotifications()[0]?.id, "recovery-blocked:i-recovery");
  store.updateMutationIntent("i-recovery", "reconciled");
  assert.equal(store.pendingUserNotifications().length, 0);
  store.close();
});

test("un bloqueo ya resuelto no vuelve a notificar en los reintentos", async () => {
  const store = new Store(mkdtempSync(join(tmpdir(), "qvaapply-recovery-stale-")));
  const dispatcher = new NotificationDispatcher(store, {
    telegram: async () => { throw new Error("Telegram sin red"); },
    webPush: async () => undefined,
  });
  store.createMutationIntent({ intentId: "i-stale", kind: "apply", operationUuid: "offer-stale", request: {} });
  store.updateMutationIntent("i-stale", "uncertain");
  await dispatcher.publish({ message: "Bloqueo", event: { kind: "recovery-blocked", intentId: "i-stale", uuid: "offer-stale" } });
  assert.equal(store.pendingUserNotifications().length, 1);
  store.updateMutationIntent("i-stale", "reconciled");
  assert.equal(store.pendingNotificationDeliveries(Date.now() + 60_000).length, 0);
  store.close();
});
