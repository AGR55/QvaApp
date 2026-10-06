import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.js";
import { CooperativeHunter } from "../src/cooperative-hunter.js";
import { QvaApiError, QvaMutationUncertainError, QvaPayClient } from "../src/qvapay.js";
import type { P2pOffer } from "../src/types.js";

const offer: P2pOffer = { uuid: "group-offer", type: "sell", coin: "BANK_CUP", amount: 10, receive: 1000, status: "open" };
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
async function until(check: () => boolean) { for (let i=0;i<50 && !check();i++) await tick(); assert.ok(check()); }
function setup() {
  const store = new Store(mkdtempSync(join(tmpdir(),"qva-coop-hunter-")));
  const actions: string[] = [];
  let busy = false, error: Error | undefined;
  const sync = { isEnabled: () => true,
    aggregate: () => ({ coin: "BANK_CUP", fiat: 2000, price: 100, minimal: 10, offersCount: 2 }),
    reserve: async () => { actions.push("reserve"); return { externalId: offer.uuid, state: "reserved" as const, ownerFiat: 400,
      contributions: [{ userId: "friend", fiat: 600, qusd: 6 }] }; },
    settle: async (_uuid: string, outcome: "commit" | "release") => { actions.push(outcome); },
  };
  const hunter = new CooperativeHunter(store,sync,{ secondaryApplyAvailable: () => true,
    applySecondary: async (_uuid, guard) => { if (!await guard()) throw new QvaApiError(409,"yield"); actions.push("apply"); if (error) throw error; },
    getOffer: async () => ({ ...offer, status: "processing", Peer: { uuid: "me" } }),
  },{ ownBusy: () => busy, safetyReason: () => undefined, canReserveOwn: () => true, ownerCost: (_coin, fiat) => fiat, notify: async () => { actions.push("notify"); } });
  return { hunter,store,actions, setBusy: (value: boolean) => { busy=value; }, setError: (value: Error) => { error=value; } };
}

test("own decision wins before any cooperative reservation or network call", async () => {
  const s=setup(); s.setBusy(true); s.hunter.enqueue(offer,Date.now()); await tick(); await tick();
  assert.deepEqual(s.actions,[]); s.hunter.stop(); s.store.close();
});
test("cooperative apply reserves first, records only owner's fiat share and commits afterward", async () => {
  const s=setup(); s.hunter.enqueue(offer,Date.now()); await until(() => s.actions.includes("commit"));
  assert.deepEqual(s.actions.slice(0,3),["reserve","apply","commit"]);
  assert.equal(s.store.get(`cooperative_owner_fiat:${offer.uuid}`),"400");
  assert.equal(s.store.getOperation(offer.uuid)?.receive,1000);
  s.hunter.enqueue(offer,Date.now()); await tick(); assert.equal(s.actions.filter(item => item==="apply").length,1);
  s.hunter.onState("p2p.completed",{ ...offer,status:"completed" });
  assert.equal(s.store.get("cooperative_qusd_owed"),"6");
  s.hunter.markDistributed(offer.uuid); assert.equal(s.store.get("cooperative_qusd_owed"),"0"); s.store.close();
});
test("definitive QvaPay rejection refunds the reservation; uncertain response retains it", async () => {
  const first=setup(); first.setError(new QvaApiError(404,"offer taken")); first.hunter.enqueue(offer,Date.now());
  await until(() => first.actions.includes("release")); assert.equal(first.store.get(`cooperative_owner_fiat:${offer.uuid}`),""); first.store.close();
  const second=setup(); second.setError(new QvaMutationUncertainError("apply",new Error("timeout"))); second.hunter.enqueue(offer,Date.now());
  await until(() => second.hunter.executions()[0]?.phase==="uncertain");
  assert.ok(!second.actions.includes("release")); assert.equal(second.store.hasUnresolvedMutation(),false); second.store.close();
});
test("cooperative quota leaves a slot for personal apply without waiting for cooperative response", async () => {
  const state = new Map<string,string>(); let release!: () => void; const sent: string[]=[];
  const qva = new QvaPayClient(() => "token", { throttleState: { get: key => state.get(key),set: (key,value) => { state.set(key,value); } },
    fetch: async input => { const url=String(input); sent.push(url); if (url.includes("group/apply")) await new Promise<void>(resolve => { release=resolve; }); return Response.json({}); } });
  const group=qva.applySecondary("group",() => true); await until(() => Boolean(release));
  assert.equal(qva.secondaryApplyAvailable(),false);
  await qva.apply("personal"); assert.equal(sent.length,2); release(); await group;
  await assert.rejects(qva.applySecondary("other",() => true), error => error instanceof QvaApiError && error.code==="LOCAL_SECONDARY_YIELD");
});
