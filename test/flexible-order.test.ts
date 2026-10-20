import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sizeFlexibleOffer, orderForOperation, matchingRecoveryOrder } from "../src/flexible-order.js";
import { QvaPayClient } from "../src/qvapay.js";
import { Store } from "../src/store.js";
import type { P2pOffer } from "../src/types.js";

const offer: P2pOffer = { uuid: "parent", type: "sell", coin: "BANK_CUP", amount: 100,
  receive: 90000, status: "open", offer_kind: "flexible", available_amount: "70", order_min: "5", order_max: "30" };

test("dimensiona por saldo, disponible y máximo sin superar capital ni cambiar tasa", () => {
  for (const [capacity, limit, expected] of [[10.129, 25, 10.12], [100, 25, 25], [100, 100, 30]]) {
    const sized = sizeFlexibleOffer(offer, capacity!, limit!);
    assert.equal(sized?.amount, expected);
    assert.ok(Math.abs(sized!.receive / sized!.amount - 900) < 1e-9);
    assert.ok(sized!.amount <= capacity!);
  }
  assert.equal(sizeFlexibleOffer({ ...offer, available_amount: 8 }, 20)?.amount, 8);
  for (const capacity of [0, 4.99, NaN, Infinity]) assert.equal(sizeFlexibleOffer(offer, capacity), undefined);
  assert.equal(sizeFlexibleOffer({ ...offer, order_min: null }, 20), undefined);
  assert.equal(sizeFlexibleOffer({ ...offer, order_max: 2 }, 20), undefined);
  const fixed = { ...offer, offer_kind: "fixed" };
  assert.equal(sizeFlexibleOffer(fixed, 1), fixed);
});

test("el estado del padre nunca sustituye el estado de la orden y la recuperación exige dueño inequívoco", () => {
  const remote = { ...offer, Orders: [{ uuid: "child", amount: 10, receive: 9000, status: "paid", created_at: new Date(10000).toISOString(), Taker: { uuid: "me" } }] };
  assert.equal(orderForOperation(remote, "child").status, "paid");
  assert.throws(() => orderForOperation(remote));
  assert.throws(() => orderForOperation(remote, "another"));
  assert.equal(matchingRecoveryOrder(remote, 10, 10000, "me")?.uuid, "child");
  assert.equal(matchingRecoveryOrder(remote, 10, 10000, "other"), undefined);
  assert.equal(matchingRecoveryOrder({ ...remote, Orders: [{ ...remote.Orders[0]!, created_at: new Date(200000).toISOString() }] }, 10, 10000, "me"), undefined);
  assert.equal(matchingRecoveryOrder({ ...remote, Orders: [...remote.Orders, ...remote.Orders] }, 10, 10000, "me"), undefined);
});

test("transporte envía amount y dirige todas las acciones al ID de orden", async () => {
  let now = 1000;
  const calls: Array<{ url: string; body: unknown }> = [];
  const client = new QvaPayClient(() => "test", { now: () => now, sleep: async ms => { now += ms; },
    fetch: async (input, init) => {
      calls.push({ url: String(input), body: init?.body ? JSON.parse(String(init.body)) : undefined });
      return new Response(JSON.stringify(String(input).endsWith("/apply") ? { order: "child", amount: "10", receive: "9000" } : { status: "revision", chat: [] }));
    } });
  assert.deepEqual(await client.apply("parent", { amount: 10 }), { order: "child", amount: 10, receive: 9000 });
  assert.deepEqual(calls[0]?.body, { amount: 10 });
  await client.markPaid("parent", "tx", "child");
  await client.confirmReceived("parent", "child");
  assert.deepEqual(await client.cancel("parent", "child"), { status: "revision" });
  await client.listChat("parent", "child");
  await client.sendChat("parent", "Hola", "child");
  assert.ok(calls.slice(1).every(call => call.url.endsWith("?order=child")));
});

test("la orden sobrevive al reinicio y aparece en todas las lecturas de operaciones", () => {
  const directory = mkdtempSync(join(tmpdir(), "qva-order-store-"));
  let store = new Store(directory);
  store.createOperation({ uuid: "parent", orderUuid: "child", amount: 10, receive: 9000, rate: 900,
    coin: "BANK_CUP", offerType: "sell", state: "applied", autoApplied: true, cancelAt: null, createdAt: Date.now() });
  store.close(); store = new Store(directory);
  assert.equal(store.getOperation("parent")?.orderUuid, "child");
  assert.equal(store.activeOperations()[0]?.orderUuid, "child");
  assert.equal(store.visibleOperations()[0]?.orderUuid, "child");
  assert.equal(store.operations()[0]?.orderUuid, "child");
  store.close();
});

test("proyecta la fecha financiera de la hija y nunca una edición posterior del padre", () => {
  const child = { uuid: "child", amount: 10, receive: 9000, status: "completed", created_at: "2026-10-18T10:00:00Z",
    paid_at: "2026-10-19T10:00:00Z", released_at: "2026-10-19T10:05:00Z" };
  const remote = { ...offer, updated_at: "2026-10-20T10:00:00Z", Orders: [child] };
  assert.equal(orderForOperation(remote, "child").updated_at, child.paid_at);
  assert.equal(orderForOperation({ ...remote, type: "buy" }, "child").updated_at, child.released_at);
  assert.equal(orderForOperation({ ...remote, Orders: [{ ...child, paid_at: null }] }, "child").updated_at, child.released_at);
  assert.equal(orderForOperation({ ...remote, Orders: [{ ...child, paid_at: null, released_at: null }] }, "child").updated_at, child.created_at);
});
