import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Store } from "../src/store.js";
import { TradingService } from "../src/trading.js";
import type { P2pOffer, P2pOrder } from "../src/types.js";

const now = Date.now();
const order = (uuid: string, status: string, receive: number, taker = "other", updatedAt = now): P2pOrder => ({
  uuid, status, amount: receive, receive, updated_at: new Date(updatedAt).toISOString(), Taker: { uuid: taker },
});
const range = (uuid: string, type: "buy" | "sell", Orders: P2pOrder[], owner = "me"): P2pOffer => ({
  uuid, type, coin: "CLASICA", amount: 1000, receive: 1000, status: "open", offer_kind: "flexible",
  User: { uuid: owner }, Peer: null, updated_at: new Date(now).toISOString(), Orders,
});
function fixture(offers: P2pOffer[]) {
  const store = new Store(mkdtempSync(join(tmpdir(), "qva-flex-fiat-")));
  store.set("fiat_balance:CLASICA", "100");
  store.set("fiat_ledger_started_at:CLASICA", String(now - 60_000));
  const requests: unknown[] = [];
  const qva = {
    profile: async () => ({ uuid: "me" }),
    listOffersPage: async (params: unknown) => {
      requests.push(params);
      return { offers, total: offers.length, currentPage: 1, perPage: 50 };
    },
    getOffer: async (uuid: string) => offers.find(item => item.uuid === uuid)!,
  };
  const trading = new TradingService(store, qva as never, {} as never, async () => undefined);
  return { store, trading, requests };
}

test("contabiliza cada orden propia y su comisión una vez sin liquidar el padre", async () => {
  const s = fixture([
    range("own-buy", "buy", [order("paid-order", "paid", 10), order("completed-order", "completed", 20), order("cancelled-order", "cancelled", 60), order("processing-order", "processing", 50)]),
    range("own-sell", "sell", [order("income-order", "completed", 15), order("unconfirmed-income", "paid", 80)]),
  ]);
  assert.equal(await s.trading.syncFiatFromQva(), 3);
  assert.ok(Math.abs(Number(s.store.get("fiat_balance:CLASICA")) - 84.84) < 1e-9);
  assert.deepEqual(s.store.recentFiat("CLASICA", 10).map(row => row.uuid).sort(), ["completed-order", "income-order", "paid-order"]);
  assert.equal(await s.trading.syncFiatFromQva(), 0);
  assert.equal(s.requests.length, 4, "solo usa las consultas periódicas existentes cuando incluyen órdenes");
  s.store.close();
});

test("solo importa la participación propia en órdenes ajenas y usa la fecha hija para la base manual", async () => {
  const s = fixture([
    range("external-sell", "sell", [order("our-payment", "completed", 10, "me"), order("other-payment", "completed", 60)], "someone"),
    range("external-buy", "buy", [order("our-income", "completed", 5, "me"), order("other-income", "completed", 60)], "someone"),
    range("historic", "buy", [order("old-paid", "completed", 80, "other", now - 5000)]),
  ]);
  s.store.set("fiat_balance_declared_at:CLASICA", String(now - 1000));
  assert.equal(await s.trading.syncFiatFromQva(), 3);
  assert.ok(Math.abs(Number(s.store.get("fiat_balance:CLASICA")) - 94.92) < 1e-9);
  assert.equal(s.store.hasFiatMovement("old-paid"), true, "conserva evidencia histórica sin volver a descontar");
  s.store.close();
});

test("la sincronización periódica y local comparten el ID de orden y no duplican un libro antiguo", async () => {
  const s = fixture([range("our-take", "sell", [order("our-child", "completed", 10, "me")], "other")]);
  s.store.createOperation({ uuid: "our-take", orderUuid: "our-child", amount: 10, receive: 10,
    rate: 1, coin: "CLASICA", offerType: "sell", state: "applied", autoApplied: true, cancelAt: null, createdAt: now });
  assert.equal(await s.trading.syncFiatFromQva(), 1);
  await s.trading.syncRemoteOperations();
  assert.equal(s.store.recentFiat("CLASICA", 10).length, 1);
  assert.equal(s.store.hasFiatMovement("our-take"), true, "la reserva de la operación reconoce el movimiento de su orden");
  assert.ok(Math.abs(Number(s.store.get("fiat_balance:CLASICA")) - 89.92) < 1e-9);
  s.store.close();

  const old = fixture([range("legacy-take", "sell", [order("legacy-child", "completed", 10, "me")], "other")]);
  old.store.createOperation({ uuid: "legacy-take", orderUuid: "legacy-child", amount: 10, receive: 10,
    rate: 1, coin: "CLASICA", offerType: "sell", state: "applied", autoApplied: true, cancelAt: null, createdAt: now });
  old.store.recordFiatMovement("legacy-take", "CLASICA", "debit", 10.08, "Versión anterior");
  assert.equal(await old.trading.syncFiatFromQva(), 0);
  await old.trading.syncRemoteOperations();
  assert.equal(old.store.recentFiat("CLASICA", 10).length, 1);
  old.store.close();
});

test("usa paid_at y released_at de cada hija en vez de la fecha de edición del padre", async () => {
  const { updated_at: _outgoingUpdatedAt, ...outgoingBase } = order("paid-now", "completed", 10);
  const { updated_at: _incomingUpdatedAt, ...incomingBase } = order("received-now", "completed", 5);
  const { updated_at: _oldUpdatedAt, ...oldBase } = order("old-received", "completed", 80);
  const outgoing = { ...outgoingBase, created_at: new Date(now - 5000).toISOString(),
    paid_at: new Date(now).toISOString(), released_at: new Date(now).toISOString() };
  const incoming = { ...incomingBase, created_at: new Date(now - 5000).toISOString(),
    released_at: new Date(now).toISOString() };
  const old = { ...oldBase, created_at: new Date(now - 10000).toISOString(),
    released_at: new Date(now - 5000).toISOString() };
  const s = fixture([range("old-parent-buy", "buy", [outgoing]), range("edited-parent-sell", "sell", [incoming, old])]);
  s.store.set("fiat_balance_declared_at:CLASICA", String(now - 1000));
  assert.equal(await s.trading.syncFiatFromQva(), 3);
  assert.ok(Math.abs(Number(s.store.get("fiat_balance:CLASICA")) - 94.92) < 1e-9);
  s.store.close();
});

test("el detalle autenticado se limita a tres consultas por ciclo y rota entre padres", async () => {
  const offers = Array.from({ length: 6 }, (_, i) => range(`parent-${i}`, "sell", [order(`child-${i}`, "completed", 1)]));
  const s = fixture(offers);
  const calls: string[] = [];
  const qva = {
    profile: async () => ({ uuid: "me" }),
    listOffersPage: async () => ({ offers: offers.map(({ Orders: _orders, ...offer }) => offer), total: offers.length, currentPage: 1, perPage: 50 }),
    getOffer: async (uuid: string) => { calls.push(uuid); return offers.find(offer => offer.uuid === uuid)!; },
  };
  (s.trading as unknown as { qva: unknown }).qva = qva;
  assert.equal(await s.trading.syncFiatFromQva(), 3);
  assert.equal(calls.length, 3);
  assert.equal(await s.trading.syncFiatFromQva(), 3);
  assert.equal(calls.length, 6);
  assert.equal(new Set(calls).size, 6, "ningún padre monopoliza el presupuesto");
  assert.equal(await s.trading.syncFiatFromQva(), 0);
  assert.equal(calls.length, 6, "reutiliza detalle reciente sin peticiones extra");
  s.store.close();
});

test("un detalle fallido no impide conciliar otra oferta", async () => {
  const broken = range("broken-parent", "sell", []);
  const good = range("good-parent", "sell", [order("good-child", "completed", 7)]);
  const s = fixture([broken, good]);
  (s.trading as unknown as { qva: unknown }).qva = {
    profile: async () => ({ uuid: "me" }),
    listOffersPage: async () => ({ offers: [{ ...broken, Orders: undefined }, good], total: 2, currentPage: 1, perPage: 50 }),
    getOffer: async () => { throw new Error("Detalle temporalmente no disponible"); },
  };
  assert.equal(await s.trading.syncFiatFromQva(), 1);
  assert.equal(s.store.get("fiat_balance:CLASICA"), "107");
  assert.equal(s.store.countAudit("fiat_sync_warning"), 1);
  await s.trading.syncFiatFromQva();
  assert.equal(s.store.countAudit("fiat_sync_warning"), 1);
  s.store.close();
});

test("vuelve a consultar la hija aunque el padre conserve su timestamp", async t => {
  let clock = now;
  t.mock.method(Date, "now", () => clock);
  let child = order("changing-child", "processing", 12);
  const parent = range("unchanged-parent", "sell", []);
  const s = fixture([]);
  t.after(() => s.store.close());
  let reads = 0;
  (s.trading as unknown as { qva: unknown }).qva = {
    profile: async () => ({ uuid: "me" }),
    listOffersPage: async () => ({ offers: [{ ...parent, Orders: undefined }], total: 1, currentPage: 1, perPage: 50 }),
    getOffer: async () => { reads += 1; return { ...parent, Orders: [child] }; },
  };
  assert.equal(await s.trading.syncFiatFromQva(), 0);
  child = { ...child, status: "completed", released_at: new Date(now + 61_000).toISOString() };
  clock += 61_000;
  assert.equal(await s.trading.syncFiatFromQva(), 1);
  assert.equal(reads, 2);
  assert.equal(s.store.get("fiat_balance:CLASICA"), "112");
});
