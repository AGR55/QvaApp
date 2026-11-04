import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AssistedPaymentService, paymentDestination } from "../src/assisted-payment.js";
import { Store } from "../src/store.js";
import type { P2pOffer } from "../src/types.js";
import { ChatCatalog } from "../src/chat-catalog.js";
import { buildDashboard } from "../src/http-dashboard.js";

const card = "9204123412345678";
const offer = (): P2pOffer => ({ uuid: "offer", type: "sell", coin: "BANK_CUP", amount: 10, receive: 1000,
  status: "processing", User: { uuid: "seller" }, Peer: { uuid: "me" },
  details: { "Tarjeta BPA": card, "Teléfono": "+53 5 123 4567" } });

function setup(t: test.TestContext) {
  const store = new Store(mkdtempSync(join(tmpdir(), "qva-assisted-payment-"))); t.after(() => store.close());
  store.createOperation({ uuid: "offer", offerType: "sell", coin: "BANK_CUP", amount: 10, receive: 1000,
    rate: 100, state: "applied", autoApplied: true, cancelAt: null, createdAt: 1, counterpartyId: "seller" });
  let remote = offer(), reads = 0;
  const qva = { profile: async () => ({ uuid: "me" }), getOffer: async () => { reads++; return remote; } };
  const service = new AssistedPaymentService(store, qva as never, () => ({ currency: "CUP" }), () => 1000);
  return { store, service, qva, reads: () => reads, set: (next: P2pOffer) => { remote = next; } };
}

test("extracts only structured, unique destinations and normalizes card and Cuban mobile", () => {
  assert.deepEqual(paymentDestination({ "Número de tarjeta": "9204 1234-1234 5678", "Teléfono destinatario": "+53 (5) 123-4567" }, "card"),
    { destination: card, confirmationPhone: "51234567" });
  assert.deepEqual(paymentDestination({ "Móvil": "5351234567", "Nota": "1234567890123456" }, "phone"), { destination: "51234567", confirmationPhone: null });
  assert.deepEqual(paymentDestination({ "Tarjeta": card }, "card"), { destination: card, confirmationPhone: null });
});

test("ambiguous, masked, injected or unlabelled fields fail closed instead of guessing", () => {
  for (const details of [
    { Tarjeta: `${card}*1#` }, { Tarjeta: "9204XXXXXXXX5678" }, { Tarjeta: 9204123412345678 },
    { Tarjeta: "0000000000000000" }, { Tarjeta: `${card} / 1234567890123456` },
    { Tarjeta: card, Cuenta: "1234567890123456" }, { Mensaje: `mi tarjeta es ${card}` },
    { Tarjeta: card, Teléfono: "51234567, 57654321" }, { Tarjeta: card, Teléfono: "51234567", Móvil: "57654321" },
    { "Tarjeta y teléfono": card }, { Tarjeta: card, Teléfono: "12345678" },
  ]) assert.throws(() => paymentDestination(details, "card"));
  assert.throws(() => paymentDestination({ "Tarjeta origen": card }, "card"));
  assert.throws(() => paymentDestination({ Teléfono: "51234567*1#" }, "phone"));
});

test("prepares a fresh exact-operation snapshot without money movements or marking paid", async t => {
  const { store, service, reads } = setup(t);
  const preview = await service.prepare("offer");
  assert.equal(preview.destination, card); assert.equal(preview.confirmationPhone, "51234567");
  assert.equal(preview.amount, "1000.00"); assert.equal(preview.currency, "CUP"); assert.equal(preview.execution, "form_review");
  assert.equal(preview.checkedAt, 1000); assert.equal(preview.expiresAt, 121000);
  assert.match(preview.fingerprint, /^[a-f0-9]{64}$/); assert.equal(reads(), 1);
  assert.equal(store.getOperation("offer")?.state, "applied"); assert.equal(store.recentFiat("BANK_CUP").length, 0);
  assert.equal((await service.prepare("offer")).fingerprint, preview.fingerprint);
});

test("refuses foreign operations before any remote request", async t => {
  const { service, reads } = setup(t);
  await assert.rejects(service.prepare("foreign"), /propia/); assert.equal(reads(), 0);
});

test("remote state, role, identity, amount, currency and exact UUID are mandatory", async t => {
  for (const patch of [
    { status: "paid" }, { status: "completed" }, { status: "cancelled" }, { status: "revision" },
    { uuid: "foreign" }, { coin: "CLASICA" }, { amount: 11 }, { receive: 1001 },
    { type: "buy" as const }, { Peer: { uuid: "foreign" } }, { User: { uuid: "foreign" } },
    { owner_uuid: "different" },
  ]) {
    const { service, set } = setup(t); set({ ...offer(), ...patch });
    await assert.rejects(service.prepare("offer"));
  }
});

test("local paid, revision and terminal operations cannot prepare", async t => {
  for (const state of ["paid", "revision", "cancelled", "completed"] as const) {
    const { store, service, reads } = setup(t); store.updateOperation("offer", state);
    await assert.rejects(service.prepare("offer")); assert.equal(reads(), 0);
  }
});

test("a local transition during remote verification invalidates the snapshot", async t => {
  const { store, service, qva } = setup(t);
  qva.getOffer = async () => { store.updateOperation("offer", "paid"); return offer(); };
  await assert.rejects(service.prepare("offer"), /cambió/);
});

test("fingerprint changes when a destination changes even if financial amounts do not", async t => {
  const { service, set } = setup(t); const first = await service.prepare("offer");
  set({ ...offer(), details: { Tarjeta: "1234567890123456", Teléfono: "51234567" } });
  assert.notEqual((await service.prepare("offer")).fingerprint, first.fingerprint);
});

test("a pending monetary intent blocks preparation before touching QvaPay", async t => {
  const { store, service, reads } = setup(t);
  store.createMutationIntent({ intentId: "pending", operationUuid: "offer",
    kind: "paid", request: { uuid: "offer" } });
  await assert.rejects(service.prepare("offer"), /conciliación/); assert.equal(reads(), 0);
});

test("a fiat amount needing rounding cannot be silently changed for a transfer", async t => {
  const { store, service, set } = setup(t);
  store.createOperation({ uuid: "fractional", offerType: "sell", coin: "BANK_CUP", amount: 1, receive: 1.234,
    rate: 1.234, state: "applied", autoApplied: true, cancelAt: null, createdAt: 1, counterpartyId: "seller" });
  set({ ...offer(), uuid: "fractional", amount: 1, receive: 1.234 });
  await assert.rejects(service.prepare("fractional"), /dos decimales/);
});

test("range child supplies amount and taker while parent processing and total cannot substitute", async t => {
  const { store, service, set } = setup(t);
  const remote: P2pOffer = { ...offer(), offer_kind: "flexible", amount: 100, receive: 10000, status: "open", Peer: null,
    Orders: [{ uuid: "child", amount: 10, receive: 1000, status: "processing", Taker: { uuid: "me" } }] };
  store.createOperation({ uuid: "range", orderUuid: "child", offerType: "sell", coin: "BANK_CUP", amount: 10,
    receive: 1000, rate: 100, state: "applied", autoApplied: true, cancelAt: null, createdAt: 1, counterpartyId: "seller" });
  set({ ...remote, uuid: "range" });
  assert.equal((await service.prepare("range", "child")).amount, "1000.00");
  await assert.rejects(service.prepare("range")); await assert.rejects(service.prepare("range", "sibling"));
});

test("creator purchases cannot mistake their own published card for the seller destination", async t => {
  const { store, service, set } = setup(t);
  const own: P2pOffer = { ...offer(), uuid: "own", type: "buy", User: { uuid: "me" }, Peer: { uuid: "seller" } };
  new ChatCatalog(store).discover([own], "me"); set(own);
  await assert.rejects(service.prepare("own"), /datos de pago propios/);
});

test("HTTP preview needs actions scope, exact params, no web session, and cannot invoke mutations", async t => {
  const token = "a".repeat(48); let calls = 0;
  const app = buildDashboard({
    checkMobileOperator: (value: string, write: boolean) => ({ ok: value === token && write, operatorId: "operator" }),
    prepareMobilePayment: async (uuid: string, order?: string) => { calls++; return { uuid, orderUuid: order, execution: "form_review" }; },
  } as never, { password: "clave-segura-de-pruebas", trustedOrigin: "http://localhost" });
  t.after(() => app.close()); const path = "/api/mobile/operations/offer/payment-preview?order=child";
  assert.equal((await app.inject({ url: path })).statusCode, 401);
  const response = await app.inject({ url: path, headers: { authorization: `Bearer ${token}` } });
  assert.equal(response.statusCode, 200); assert.equal(response.json().data.orderUuid, "child");
  assert.equal(response.headers["cache-control"], "no-store");
  const extra = await app.inject({ url: path + "&extra=1", headers: { authorization: `Bearer ${token}` } });
  assert.equal(extra.statusCode, 200, "unknown parameters are discarded by Fastify validation");
  assert.equal(extra.json().data.orderUuid, "child");
  assert.equal((await app.inject({ url: path.replace("child", "bad%2Avalue"), headers: { authorization: `Bearer ${token}` } })).statusCode, 400);
  assert.equal(calls, 2);
});
