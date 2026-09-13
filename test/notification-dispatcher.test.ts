import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { NotificationDispatcher } from "../src/notification-dispatcher.js";
import { Store } from "../src/store.js";

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
