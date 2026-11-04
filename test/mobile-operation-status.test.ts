import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.js";
import { ChatCatalog } from "../src/chat-catalog.js";
import { MobileOperatorService } from "../src/mobile-operator.js";
import type { P2pOffer } from "../src/types.js";

const remote = (status = "processing"): P2pOffer => ({ uuid: "offer", type: "sell", coin: "BANK_CUP",
  amount: 10, receive: 1000, status, User: { uuid: "seller" }, Peer: { uuid: "me" } });

function setup(t: test.TestContext) {
  const store = new Store(mkdtempSync(join(tmpdir(), "qva-mobile-state-")));
  t.after(() => store.close());
  let now = 100_000;
  const catalog = new ChatCatalog(store, () => now);
  const mobile = new MobileOperatorService(store, {
    operations: () => store.visibleOperations(300), threads: () => catalog.list(), alerts: () => [], markets: () => [],
    markPaid: async () => { throw new Error("No mutations"); },
    confirmReceived: async () => { throw new Error("No mutations"); }, cancel: async () => { throw new Error("No mutations"); },
  });
  const local = () => store.createOperation({ uuid: "offer", offerType: "sell", coin: "BANK_CUP", amount: 10,
    receive: 1000, rate: 100, state: "acknowledged", autoApplied: true, cancelAt: null, createdAt: 1, counterpartyId: "seller" });
  return { store, catalog, mobile, local, advance: () => { now += 31_000; } };
}

test("a closed local operation cannot reappear as processing from the chat cache", t => {
  for (const status of ["completed", "cancelled"] as const) {
    const { store, catalog, mobile, local } = setup(t);
    local(); catalog.discover([remote()], "me");
    store.updateOperation("offer", status);
    assert.equal(catalog.list()[0]?.state, status);
    assert.equal(catalog.get("offer")?.state, status);
    assert.equal(mobile.operations(100)[0]?.status, status);
    assert.deepEqual(mobile.operations(100)[0]?.actions, []);
  }
});

test("remote closure overrides local revision in chat and mobile projection without financial mutation", t => {
  const { store, catalog, mobile, local } = setup(t);
  local(); store.updateOperation("offer", "revision");
  catalog.discover([remote("cancelled")], "me");
  assert.equal(catalog.get("offer")?.state, "cancelled");
  assert.equal(mobile.operations(100)[0]?.status, "cancelled");
  assert.deepEqual(mobile.operations(100)[0]?.actions, []);
  assert.equal(store.getOperation("offer")?.state, "revision", "a read projection does not reconcile money");
});

test("known cancelled conversations update even when QvaPay removes Peer; unknown offers stay hidden", t => {
  const { catalog, mobile } = setup(t);
  catalog.discover([remote()], "me");
  catalog.discover([{ ...remote("cancelled"), Peer: null }], "me");
  catalog.discover([{ ...remote("cancelled"), uuid: "unknown", Peer: null }], "me");
  assert.equal(mobile.operations(100).length, 1);
  assert.equal(mobile.operations(100)[0]?.status, "cancelled");
});

test("paid local state survives a processing snapshot and terminal states do not reopen from stale discovery", t => {
  const { store, catalog, mobile, local } = setup(t);
  local(); store.updateOperation("offer", "paid"); catalog.discover([remote()], "me");
  assert.equal(mobile.operations(100)[0]?.status, "paid");
  catalog.discover([remote("completed")], "me"); catalog.discover([remote()], "me");
  assert.equal(mobile.operations(100)[0]?.status, "completed");
});

test("closure of one range order cannot close its sibling", t => {
  const { catalog, mobile } = setup(t);
  catalog.discover([{ ...remote(), offer_kind: "flexible", Orders: [
    { uuid: "one", amount: 5, receive: 500, status: "cancelled", Taker: { uuid: "me" } },
    { uuid: "two", amount: 5, receive: 500, status: "processing", Taker: { uuid: "me" } },
  ] }], "me");
  assert.equal(mobile.operations(100).find(op => op.orderUuid === "one")?.status, "cancelled");
  assert.equal(mobile.operations(100).find(op => op.orderUuid === "two")?.status, "processing");
});

test("missing-page status refresh is bounded, fair, persistent and never infers cancellation on failure", async t => {
  const { store, catalog, advance } = setup(t);
  catalog.discover(["a", "b", "c", "d"].map(uuid => ({ ...remote(), uuid })), "me");
  const reads: string[] = [];
  const read = async (uuid: string) => { reads.push(uuid); if(uuid==="a") throw new Error("404"); return { ...remote("completed"), uuid }; };
  await catalog.refreshMissing(new Set(["d"]), "me", read);
  assert.equal(reads.length, 2);
  assert.equal(catalog.get("a")?.state, "processing");
  assert.equal(catalog.get("b")?.state, "completed");
  await catalog.refreshMissing(new Set(["d"]), "me", read);
  assert.deepEqual(reads, ["a", "b", "c"]);
  const restarted = new ChatCatalog(store, () => 100_000);
  await restarted.refreshMissing(new Set(["d"]), "me", read);
  assert.equal(reads.length, 3, "cooldown survives service recreation");
  advance(); await catalog.refreshMissing(new Set(["d"]), "me", read);
  assert.equal(reads.at(-1), "a");
});

test("missing-page refresh rejects a mismatched offer UUID and never runs without account identity", async t => {
  const { catalog } = setup(t);
  catalog.discover([remote()], "me");
  let reads=0;
  const read=async () => {reads++;return {...remote("cancelled"),uuid:"foreign"};};
  await catalog.refreshMissing(new Set(), "", read);
  assert.equal(reads,0);
  await catalog.refreshMissing(new Set(), "me", read);
  assert.equal(reads,1);
  assert.equal(catalog.get("offer")?.state,"processing");
});

test("cancelled range children update after Taker is removed without closing the parent or siblings", t => {
  const { catalog } = setup(t);
  const range: P2pOffer = { ...remote(), offer_kind: "flexible", status: "open", Orders: [
    { uuid: "one", amount: 5, receive: 500, status: "revision", Taker: { uuid: "me" } },
    { uuid: "two", amount: 5, receive: 500, status: "processing", Taker: { uuid: "me" } },
  ] };
  catalog.discover([range], "me");
  catalog.discover([{ ...range, Orders: [
    { uuid: "one", amount: 5, receive: 500, status: "cancelled" },
    { uuid: "unknown", amount: 5, receive: 500, status: "cancelled" },
  ] }], "me");
  assert.equal(catalog.get("offer", "one")?.state, "cancelled");
  assert.equal(catalog.get("offer", "two")?.state, "processing");
  assert.equal(catalog.get("offer", "unknown"), undefined);
});
