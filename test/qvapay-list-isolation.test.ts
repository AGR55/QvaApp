import assert from "node:assert/strict";
import test from "node:test";
import { QvaApiError, QvaPayClient } from "../src/qvapay.js";

test("un listado esperando presupuesto no retiene lecturas normales ni preflight de edición", async () => {
  let release!: () => void, entered!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  const paths: string[] = [];
  const client = new QvaPayClient(() => "token", {
    sleep: async () => undefined,
    listBudget: { waitForDispatch: async () => { entered(); await blocked; return undefined; }, noteRateLimit: () => undefined },
    fetch: async input => {
      const path = new URL(String(input)).pathname;
      paths.push(path);
      return new Response(JSON.stringify(path === "/user" ? { uuid: "owner" } : { data: [] }));
    },
  });
  const list = client.listOffersPage({});
  try {
    await started;
    assert.equal((await client.profile()).uuid, "owner");
    await assert.rejects(client.editOffer("own", { amount: 1, receive: 100 }, { beforeDispatch: () => false }),
      (error: unknown) => error instanceof QvaApiError && error.code === "LOCAL_CONDITIONS_CHANGED");
    assert.deepEqual(paths, ["/user"], "ni listado ni edición fueron enviados");
  } finally {
    release();
    await list;
  }
  assert.ok(paths.includes("/p2p"));
});

test("el intervalo general parte del envío real del listado tras esperar presupuesto", async () => {
  let now = 10_000;
  const sleeps: number[] = [];
  const client = new QvaPayClient(() => "token", {
    now: () => now,
    sleep: async ms => { sleeps.push(ms); now += ms; },
    listBudget: { waitForDispatch: async () => { now += 10_000; return undefined; }, noteRateLimit: () => undefined },
    fetch: async input => new Response(JSON.stringify(new URL(String(input)).pathname === "/user" ? { uuid: "owner" } : { data: [] })),
  });
  await client.listOffersPage({});
  await client.profile();
  assert.deepEqual(sleeps, [1_667]);
});
