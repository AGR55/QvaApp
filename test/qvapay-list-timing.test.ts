import assert from "node:assert/strict";
import test from "node:test";
import { QvaApiError, QvaConnectionError, QvaPayClient } from "../src/qvapay.js";
import type { ListTiming } from "../src/types.js";

test("mide cola y respuesta del listado, normaliza caché y aísla el callback", async () => {
  let clock = 0;
  const seen: ListTiming[] = [];
  const client = new QvaPayClient(() => "secret", {
    monotonicNow: () => clock,
    now: () => 1000,
    sleep: async ms => { clock += ms; },
    fetch: async () => { clock += 7; return new Response('{"data":[]}', { headers: { "X-Cache": " hIt " } }); },
    onListTiming: timing => { seen.push(timing); throw new Error("callback failed"); },
  });
  const first = await client.listOffersPage({ coin: "CUP" });
  const second = await client.listOffersPage({ coin: "CUP" });
  assert.equal(first.cacheStatus, "HIT");
  assert.deepEqual(first.timing, { queueMs: 0, responseMs: 7, totalMs: 7, attempts: 1, outcome: "success", status: 200, cacheStatus: "HIT" });
  assert.equal(second.timing?.queueMs, 2401);
  assert.deepEqual(seen, [first.timing, second.timing]);
  assert.equal(JSON.stringify(seen).includes("secret"), false);
});

test("contabiliza reintentos de red sin alterar errores HTTP ni exponer caché desconocida", async () => {
  let clock = 0, calls = 0;
  const seen: ListTiming[] = [];
  const client = new QvaPayClient(() => "token", {
    monotonicNow: () => clock,
    sleep: async ms => { clock += ms; },
    fetch: async () => {
      clock += 5;
      if (++calls === 1) throw new Error("network");
      return new Response('{"error":"busy"}', { status: 429, headers: { "X-Cache": "private arbitrary value" } });
    },
    onListTiming: timing => seen.push(timing),
  });
  await assert.rejects(client.listOffersPage({}), (error: unknown) => error instanceof QvaApiError && error.status === 429);
  assert.deepEqual(seen[0], { queueMs: 0, responseMs: 810, totalMs: 810, attempts: 2, outcome: "failed", status: 429 });
});

test("fallo de red y ausencia de sesión informan sin inventar respuesta", async () => {
  let clock = 0;
  const seen: ListTiming[] = [];
  const client = new QvaPayClient(() => "token", {
    monotonicNow: () => clock,
    sleep: async ms => { clock += ms; },
    fetch: async () => { clock += 2; throw new Error("offline"); },
    onListTiming: timing => seen.push(timing),
  });
  await assert.rejects(client.listOffersPage({}), QvaConnectionError);
  assert.deepEqual(seen[0], { queueMs: 0, responseMs: 2406, totalMs: 2406, attempts: 3, outcome: "failed" });
  const noSession = new QvaPayClient(() => undefined, { monotonicNow: () => clock, onListTiming: timing => seen.push(timing) });
  await assert.rejects(noSession.listOffersPage({}), QvaApiError);
  assert.deepEqual(seen[1], { queueMs: null, responseMs: null, totalMs: 0, attempts: 0, outcome: "failed" });
});
