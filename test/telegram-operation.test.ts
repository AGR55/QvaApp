import assert from "node:assert/strict";
import test from "node:test";
import type { DurableNotification, Operation } from "../src/store.js";
import {
  canCancelOperation, canMarkPaid, cooperativeNotificationText,
  operationNotificationText, parseTransactionId, PaymentReferenceSessions,
} from "../src/telegram-operation.js";

const operation: Operation = {
  uuid: "offer-1", offerType: "sell", coin: "CLASICA", amount: 40.86,
  receive: 44.13, rate: 1.08, state: "applied", autoApplied: true,
  cancelAt: null, createdAt: Date.now(), counterpartyId: "<amigo&1>",
};
const notification = {
  kind: "operation-applied", operationUuid: operation.uuid, message: "Texto anterior",
  payload: {},
} as DurableNotification;

test("el aviso de operación separa importe, siguiente paso y referencia con HTML seguro", () => {
  const text = operationNotificationText(notification, operation, () => "Clásica", () => "USD");
  assert.match(text, /<b>💸 Compra de QUSD aplicada<\/b>/);
  assert.match(text, /Debes enviar: <b>44\.13 USD<\/b>/);
  assert.match(text, /Contraparte: <code>&lt;amigo&amp;1&gt;<\/code>/);
  assert.match(text, /<b>👉 Siguiente paso<\/b>/);
  assert.match(text, /Operación: <code>offer-1<\/code>/);
  assert.doesNotMatch(text, /Cancelar/);
});

test("el aviso cooperativo presenta aporte y reparto en bloques", () => {
  const text = cooperativeNotificationText({ uuid: "group", amount: 40.86, receive: 44.13,
    coin: "CLASICA", ownerFiat: 20, owedQusd: 18.25 });
  assert.match(text, /Tu aporte: <b>20\.00 CLASICA<\/b>/);
  assert.match(text, /Después reparte <b>18\.25 QUSD<\/b>/);
  assert.match(text, /🆔 <code>group<\/code>/);
});

test("solo una operación activa puede ofrecer pago o cancelación", () => {
  assert.equal(canMarkPaid(operation), true);
  assert.equal(canCancelOperation(operation), true);
  for (const state of ["paid", "completed", "cancelled", "revision"] as const) {
    assert.equal(canMarkPaid({ ...operation, state }), false);
    assert.equal(canCancelOperation({ ...operation, state }), false);
  }
  assert.equal(canMarkPaid({ ...operation, offerType: "buy" }), false);
  const completed = operationNotificationText(notification, { ...operation, state: "completed" }, () => "Clásica", () => "USD");
  assert.match(completed, /Operación completada/);
  assert.doesNotMatch(completed, /registra el ID/);
});

test("la captura del ID caduca, se cancela y rechaza entradas multilínea", () => {
  let now = 100;
  const sessions = new PaymentReferenceSessions(() => now);
  sessions.start("chat", "offer-1", 77);
  assert.deepEqual(sessions.current("chat"), { uuid: "offer-1", messageId: 77 });
  assert.equal(parseTransactionId("  TX-123  "), "TX-123");
  assert.throws(() => parseTransactionId("TX\n123"));
  sessions.cancel("chat");
  assert.equal(sessions.current("chat"), undefined);
  sessions.start("chat", "offer-2");
  now += 10 * 60_000;
  assert.equal(sessions.current("chat"), undefined);
});
