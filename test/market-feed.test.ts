import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildDashboard } from "../src/http-dashboard.js";
import {
  MarketFeedRequestError,
  MarketSourceCoordinator,
} from "../src/market-feed.js";
import type { PollingMarketSource } from "../src/market-source.js";
import { Store } from "../src/store.js";
import type { P2pOffer } from "../src/types.js";
import { Vault } from "../src/vault.js";

const secret = "feed-secret-for-tests-2026";
const webhookUrl = "https://qvaapply.example/webhooks/qvapay/p2p-feed";

function payload(
  uuid = "7c9e6679-7425-40de-944b-e07fc1f90ae7",
  event = "p2p.created",
) {
  return {
    event,
    sent_at: "2026-09-24T12:00:00Z",
    data: {
      uuid,
      type: "sell",
      coin: "BANK_CUP",
      amount: "25.5",
      receive: "25000",
      status: "open",
      updated_at: "2026-09-24T12:00:00Z",
    },
  };
}

function setup(canProcess: () => boolean = () => true, streamPayload?: unknown) {
  let now = Date.parse("2026-09-24T12:00:10Z");
  let polls = 0;
  const ingested: Array<{ offer: P2pOffer; receivedAt: number }> = [];
  const store = new Store(mkdtempSync(join(tmpdir(), "qvaapply-market-feed-")));
  const polling = {
    pollNext: async () => {
      polls += 1;
      return undefined;
    },
    status: () => ({
      mode: "polling" as const,
      accounts: [],
      healthyAccounts: 1,
      effectiveCadenceSeconds: 3,
      estimatedRequestsPerMinute: 20,
    }),
  } as unknown as PollingMarketSource;
  const coordinator = new MarketSourceCoordinator(
    store,
    new Vault("a".repeat(64)),
    polling,
    webhookUrl,
    async (offer, receivedAt) => void ingested.push({ offer, receivedAt }),
    canProcess,
    () => now,
    {
      fetch: async () => new Response(streamPayload
        ? `retry: 60000\nevent: p2p.reopened\ndata: ${JSON.stringify(streamPayload)}\n\n`
        : "retry: 60000\n\n", {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      }),
      wait: async () => new Promise<void>(() => undefined),
    },
  );
  return {
    store,
    coordinator,
    ingested,
    polls: () => polls,
    setNow(value: number) { now = value; },
  };
}

function enableRealtime(coordinator: MarketSourceCoordinator): void {
  coordinator.saveWebhookSecret(secret);
  coordinator.saveStreamCredentials("app-id-tests", "app-secret-for-tests-2026");
  coordinator.setMode("hybrid");
}

function signed(raw: Buffer, timestamp: number) {
  return {
    signature: `sha256=${createHmac("sha256", secret).update(raw).digest("hex")}`,
    timestamp: String(Math.floor(timestamp / 1_000)),
  };
}

test("acepta, deduplica y procesa inmediatamente una oferta firmada", async () => {
  const state = setup();
  enableRealtime(state.coordinator);
  const source = payload();
  const raw = Buffer.from(JSON.stringify({
    ...source,
    data: { ...source.data, details: { Cuenta: "1234567890123456" } },
  }));
  const result = state.coordinator.acceptWebhook(raw, signed(raw, Date.parse("2026-09-24T12:00:10Z")));
  assert.deepEqual(result, { duplicate: false, queued: true });

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(state.ingested.length, 1);
  assert.equal(state.ingested[0]?.offer.amount, 25.5);
  assert.equal(state.ingested[0]?.offer.receive, 25_000);
  assert.equal(state.coordinator.status().pendingWebhookEvents, 0);
  assert.equal(state.coordinator.status().lastWebhookProcessedAt, Date.parse("2026-09-24T12:00:10Z"));
  assert.equal(state.coordinator.status().lastDeliveryLagMs, 10_000);
  assert.equal(state.coordinator.status().lastEventLatencyMs, 0);
  assert.match(state.coordinator.status().lastEventOutcome ?? "", /procesada|aplicada|p2p/i);
  const processedAudit = state.store.recentAudit(20).find((entry) => entry.action === "market_feed_processed");
  assert.match(processedAudit?.detail ?? "", /p2p\.created.*BANK_CUP/);
  assert.doesNotMatch(processedAudit?.detail ?? "", /1234567890123456|Cuenta/);

  const duplicate = state.coordinator.acceptWebhook(raw, signed(raw, Date.parse("2026-09-24T12:00:10Z")));
  assert.deepEqual(duplicate, { duplicate: true, queued: false });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(state.ingested.length, 1);
  state.store.close();
});

test("procesa reaperturas y deduplica el mismo evento entre stream y webhook", async () => {
  const reopened = payload("bc9e6679-7425-40de-944b-e07fc1f90ae7", "p2p.reopened");
  const state = setup(() => true, reopened);
  enableRealtime(state.coordinator);
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(state.ingested.length, 1);
  assert.equal(state.ingested[0]?.offer.uuid, reopened.data.uuid);

  const raw = Buffer.from(JSON.stringify(reopened));
  const duplicate = state.coordinator.acceptWebhook(
    raw,
    signed(raw, Date.parse("2026-09-24T12:00:10Z")),
  );
  assert.deepEqual(duplicate, { duplicate: true, queued: false });
  assert.equal(state.ingested.length, 1);
  state.coordinator.stop();
  state.store.close();
});

test("recibe pausas y reanudaciones por webhook y stream conservando pause", async () => {
  const state = setup();
  const opportunities: Array<{ uuid: string; event: string; pause: unknown }> = [];
  const states: Array<{ uuid: string; event: string; pause: unknown }> = [];
  const now = Date.parse("2026-09-24T12:00:10Z");
  const streamed = { ...payload("stream-resumed", "p2p.resumed"), data: { ...payload().data, uuid: "stream-resumed", pause: null } };
  const streamedPaused = { ...payload("stream-paused", "p2p.paused"), data: { ...payload().data, uuid: "stream-paused", pause: { reason: "owner", until: null } } };
  const coordinator = new MarketSourceCoordinator(state.store, new Vault("a".repeat(64)),
    { pollNext: async () => undefined, status: () => state.coordinator.status() } as unknown as PollingMarketSource,
    webhookUrl, async (offer, _receivedAt, event) => { opportunities.push({ uuid: offer.uuid, event, pause: offer.pause }); },
    () => true, () => now,
    { fetch: async () => new Response(`event: p2p.resumed\ndata: ${JSON.stringify(streamed)}\n\nevent: p2p.paused\ndata: ${JSON.stringify(streamedPaused)}\n\n`), wait: async () => new Promise<void>(() => undefined) },
    async (event, offer) => { states.push({ uuid: offer.uuid, event, pause: offer.pause }); });
  try {
    enableRealtime(coordinator);
    const pause = { reason: "taker_left", until: "2026-09-24T12:05:00Z" };
    for (const [event, uuid, value] of [["p2p.paused", "webhook-paused", pause], ["p2p.resumed", "webhook-resumed", null], ["p2p.created", "unknown-pause", "unexpected"]] as const) {
      const body = payload(uuid, event);
      const raw = Buffer.from(JSON.stringify({ ...body, data: { ...body.data, pause: value } }));
      assert.equal(coordinator.acceptWebhook(raw, signed(raw, now)).queued, true);
    }
    await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setImmediate(resolve));
    assert.ok(states.some(item => item.uuid === "webhook-paused" && item.event === "p2p.paused" && JSON.stringify(item.pause) === JSON.stringify(pause)));
    assert.ok(states.some(item => item.uuid === "stream-paused" && item.event === "p2p.paused" && JSON.stringify(item.pause) === JSON.stringify(streamedPaused.data.pause)));
    assert.ok(opportunities.some(item => item.uuid === "webhook-resumed" && item.event === "p2p.resumed" && item.pause === null));
    assert.ok(opportunities.some(item => item.uuid === "stream-resumed" && item.event === "p2p.resumed" && item.pause === null));
    assert.ok(opportunities.some(item => item.uuid === "unknown-pause" && item.pause === "unexpected"));
  } finally {
    coordinator.stop(); state.store.close();
  }
});

test("distingue ciclos de pausa por sent_at y deduplica la misma entrega entre canales", async () => {
  const uuid = "pause-cycles";
  const base = payload(uuid, "p2p.resumed");
  const first = { ...base, sent_at: "2026-09-24T12:00:01Z", data: { ...base.data, pause: null } };
  const state = setup(() => false, first);
  try {
    enableRealtime(state.coordinator);
    await new Promise(resolve => setImmediate(resolve));
    const send = (value: unknown) => {
      const raw = Buffer.from(JSON.stringify(value));
      return state.coordinator.acceptWebhook(raw, signed(raw, Date.parse("2026-09-24T12:00:10Z")));
    };
    assert.deepEqual(send(first), { duplicate: true, queued: false });
    for (const [event, second, pause] of [
      ["p2p.paused", "02", { reason: "owner", until: null }],
      ["p2p.resumed", "03", null],
      ["p2p.paused", "04", { reason: "owner", until: null }],
      ["p2p.resumed", "05", null],
    ] as const) {
      const next = { ...base, event, sent_at: `2026-09-24T12:00:${second}Z`, data: { ...base.data, pause } };
      assert.deepEqual(send(next), { duplicate: false, queued: true });
      assert.deepEqual(send(next), { duplicate: true, queued: false });
    }
    assert.equal(state.coordinator.status().pendingWebhookEvents, 5);
    await new Promise(resolve => setImmediate(resolve));
  } finally {
    state.coordinator.stop(); state.store.close();
  }
});

test("procesa dos reaperturas legítimas del mismo UUID en ciclos distintos", async () => {
  const state = setup();
  enableRealtime(state.coordinator);
  const first = payload("cc9e6679-7425-40de-944b-e07fc1f90ae7", "p2p.reopened");
  const second = {
    ...first,
    sent_at: "2026-09-24T12:00:05Z",
    data: { ...first.data, updated_at: "2026-09-24T12:00:05Z" },
  };
  for (const event of [first, second]) {
    const raw = Buffer.from(JSON.stringify(event));
    assert.equal(
      state.coordinator.acceptWebhook(raw, signed(raw, Date.parse("2026-09-24T12:00:10Z"))).queued,
      true,
    );
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(state.ingested.length, 2);
  state.coordinator.stop();
  state.store.close();
});

test("drena una ráfaga del feed sin esperar un tick del scheduler por oferta", async () => {
  let releaseFirst: (() => void) | undefined;
  const firstBlocked = new Promise<void>((resolve) => { releaseFirst = resolve; });
  let calls = 0;
  const state = setup();
  const coordinator = new MarketSourceCoordinator(
    state.store,
    new Vault("a".repeat(64)),
    { pollNext: async () => undefined, status: () => state.coordinator.status() } as unknown as PollingMarketSource,
    webhookUrl,
    async () => {
      calls += 1;
      if (calls === 1) await firstBlocked;
    },
    () => true,
    () => Date.parse("2026-09-24T12:00:10Z"),
    { fetch: async () => new Response("retry: 60000\n\n", { status: 200 }) },
  );
  enableRealtime(coordinator);
  for (const uuid of [
    "dc9e6679-7425-40de-944b-e07fc1f90ae7",
    "ec9e6679-7425-40de-944b-e07fc1f90ae7",
    "fc9e6679-7425-40de-944b-e07fc1f90ae7",
  ]) {
    const raw = Buffer.from(JSON.stringify(payload(uuid)));
    coordinator.acceptWebhook(raw, signed(raw, Date.parse("2026-09-24T12:00:10Z")));
  }
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 3, "las siguientes ofertas avanzan mientras la primera espera respuesta");
  releaseFirst?.();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 3);
  coordinator.stop();
  state.store.close();
});

test("integra los seis eventos del feed por stream o webhook", async () => {
  const state = setup();
  const opportunities: string[] = [];
  const lifecycle: string[] = [];
  const coordinator = new MarketSourceCoordinator(
    state.store,
    new Vault("a".repeat(64)),
    { pollNext: async () => undefined, status: () => state.coordinator.status() } as unknown as PollingMarketSource,
    webhookUrl,
    async (offer) => void opportunities.push(offer.uuid),
    () => true,
    () => Date.parse("2026-09-24T12:00:10Z"),
    { fetch: async () => new Response("retry: 60000\n\n", { status: 200 }) },
    async (event, offer) => void lifecycle.push(`${event}:${offer.uuid}`),
  );
  enableRealtime(coordinator);
  const events = [
    "p2p.created",
    "p2p.reopened",
    "p2p.applied",
    "p2p.paid",
    "p2p.completed",
    "p2p.cancelled",
  ];
  for (const [index, event] of events.entries()) {
    const value = payload(`${index + 1}c9e6679-7425-40de-944b-e07fc1f90ae7`, event);
    const raw = Buffer.from(JSON.stringify(value));
    assert.equal(
      coordinator.acceptWebhook(raw, signed(raw, Date.parse("2026-09-24T12:00:10Z"))).queued,
      true,
    );
  }
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(opportunities.length, 2);
  assert.deepEqual(
    lifecycle.map((item) => item.split(":", 1)[0]),
    ["p2p.applied", "p2p.paid", "p2p.completed", "p2p.cancelled"],
  );
  coordinator.stop();
  state.store.close();
});

test("una consulta lenta de estado no retiene una nueva oportunidad del feed", async () => {
  const state = setup();
  let active = false;
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const opportunities: string[] = [];
  const coordinator = new MarketSourceCoordinator(state.store, new Vault("a".repeat(64)),
    { pollNext: async () => undefined, status: () => state.coordinator.status() } as unknown as PollingMarketSource,
    webhookUrl, async offer => { opportunities.push(offer.uuid); }, () => active,
    () => Date.parse("2026-09-24T12:00:10Z"),
    { fetch: async () => new Response("retry: 60000\n\n", { status: 200 }), wait: async () => new Promise<void>(() => undefined) },
    async () => { await blocked; });
  try {
    enableRealtime(coordinator);
    await new Promise(resolve => setImmediate(resolve));
    for (const body of [payload("state-slow", "p2p.paid"), payload("fresh-opportunity")]) {
      if (body.event === "p2p.paid") body.data.status = "paid";
      state.store.enqueueMarketFeedEvent({ key: body.data.uuid, event: body.event, payload: body,
        receivedAt: Date.parse("2026-09-24T12:00:10Z") });
    }
    active = true;
    void coordinator.processNext();
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(opportunities, ["fresh-opportunity"]);
  } finally {
    release();
    await new Promise(resolve => setImmediate(resolve));
    coordinator.stop(); state.store.close();
  }
});

test("una oportunidad nueva ocupa un hueco libre sin esperar respuestas remotas", async () => {
  const state = setup();
  const started: string[] = [];
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const now = Date.parse("2026-09-24T12:00:10Z");
  const coordinator = new MarketSourceCoordinator(state.store, new Vault("a".repeat(64)),
    { pollNext: async () => undefined, status: () => state.coordinator.status() } as unknown as PollingMarketSource,
    webhookUrl, async offer => { started.push(offer.uuid); await blocked; }, () => true, () => now,
    { fetch: async () => new Response("retry: 60000\n\n", { status: 200 }), wait: async () => new Promise<void>(() => undefined) });
  try {
    enableRealtime(coordinator);
    const submit = async (uuid: string, type: "buy" | "sell") => {
      const value = payload(uuid);
      value.data.type = type;
      const raw = Buffer.from(JSON.stringify(value));
      coordinator.acceptWebhook(raw, signed(raw, now));
      await new Promise(resolve => setImmediate(resolve));
    };
    await submit("first-buy", "buy");
    assert.deepEqual(started, ["first-buy"]);
    await submit("second-sell", "sell");
    assert.deepEqual(started, ["first-buy", "second-sell"]);
    await submit("third-sell", "sell");
    await submit("fourth-sell", "sell");
    await submit("fifth-buy", "buy");
    assert.deepEqual(started, ["first-buy", "second-sell", "third-sell"]);
    release();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(started.length, 5);
  } finally {
    release();
    await new Promise(resolve => setImmediate(resolve));
    coordinator.stop(); state.store.close();
  }
});

test("mide la espera en cola por lado con reloj monotónico", async () => {
  const state = setup();
  let monotonic = 100;
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const now = Date.parse("2026-09-24T12:00:10Z");
  const coordinator = new MarketSourceCoordinator(state.store, new Vault("a".repeat(64)),
    { pollNext: async () => undefined, status: () => state.coordinator.status() } as unknown as PollingMarketSource,
    webhookUrl, async offer => { if (offer.uuid === "first-buy") await blocked; }, () => true, () => now,
    { fetch: async () => new Response("retry: 60000\n\n"), wait: async () => new Promise<void>(() => undefined) },
    async () => undefined, () => monotonic);
  try {
    enableRealtime(coordinator);
    const submit = (uuid: string) => {
      const value = payload(uuid);
      value.data.type = "buy";
      const raw = Buffer.from(JSON.stringify(value));
      coordinator.acceptWebhook(raw, signed(raw, now));
    };
    submit("first-buy");
    await new Promise(resolve => setImmediate(resolve));
    monotonic = 200;
    submit("second-buy");
    await new Promise(resolve => setImmediate(resolve));
    monotonic = 850;
    release();
    await new Promise(resolve => setImmediate(resolve));
    const entry = state.store.recentAudit(30).find(row => row.action === "market_feed_queue_timing" && row.detail.includes("second-buy"));
    assert.deepEqual(JSON.parse(entry!.detail), { uuid: "second-buy", side: "buy", queueMs: 650, clock: "monotonic" });
  } finally {
    release();
    await new Promise(resolve => setImmediate(resolve));
    coordinator.stop(); state.store.close();
  }
});

test("limita marcas monotónicas mientras está pausado y usa reloj persistido para eventos antiguos", async () => {
  let active = false;
  const state = setup(() => active);
  const now = Date.parse("2026-09-24T12:00:10Z");
  const timestamps = (state.coordinator as unknown as { receivedMonotonic: Map<string, number> }).receivedMonotonic;
  try {
    enableRealtime(state.coordinator);
    const submit = (uuid: string) => {
      const raw = Buffer.from(JSON.stringify(payload(uuid)));
      state.coordinator.acceptWebhook(raw, signed(raw, now));
    };
    submit("old-event");
    for (let i = 0; i < 1_023; i++) timestamps.set(`synthetic-${i}`, i);
    submit("new-event");
    assert.equal(timestamps.size, 1_024);
    state.setNow(now + 750);
    active = true;
    await state.coordinator.processNext();
    const entry = state.store.recentAudit(30).find(row => row.action === "market_feed_queue_timing" && row.detail.includes("old-event"));
    assert.deepEqual(JSON.parse(entry!.detail), { uuid: "old-event", side: "sell", queueMs: 750, clock: "wall" });
    state.coordinator.stop();
    assert.equal(timestamps.size, 0);
  } finally {
    state.coordinator.stop(); state.store.close();
  }
});

test("un evento aplicado en cola invalida la oportunidad antes de consumir apply", async () => {
  const state = setup();
  const opportunities: string[] = [];
  const lifecycle: string[] = [];
  const coordinator = new MarketSourceCoordinator(
    state.store,
    new Vault("a".repeat(64)),
    { pollNext: async () => undefined, status: () => state.coordinator.status() } as unknown as PollingMarketSource,
    webhookUrl,
    async (offer) => void opportunities.push(offer.uuid),
    () => true,
    () => Date.parse("2026-09-24T12:00:10Z"),
    { fetch: async () => new Response("retry: 60000\n\n", { status: 200 }) },
    async (event) => void lifecycle.push(event),
  );
  enableRealtime(coordinator);
  const uuid = "4c9e6679-7425-40de-944b-e07fc1f90ae7";
  for (const event of ["p2p.created", "p2p.applied"]) {
    const value = payload(uuid, event);
    const raw = Buffer.from(JSON.stringify(value));
    coordinator.acceptWebhook(raw, signed(raw, Date.parse("2026-09-24T12:00:10Z")));
  }
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(opportunities, []);
  assert.deepEqual(lifecycle, ["p2p.applied"]);
  coordinator.stop();
  state.store.close();
});

test("los estados y avisos no esperan una aplicación pendiente de respuesta o cuota", async () => {
  const state = setup();
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const lifecycle: string[] = [];
  const coordinator = new MarketSourceCoordinator(state.store, new Vault("a".repeat(64)),
    { pollNext: async () => undefined, status: () => state.coordinator.status() } as unknown as PollingMarketSource,
    webhookUrl, async () => { await blocked; }, () => true,
    () => Date.parse("2026-09-24T12:00:10Z"),
    { fetch: async () => new Response("retry: 60000\n\n", { status: 200 }) },
    async event => { lifecycle.push(event); });
  enableRealtime(coordinator);
  const first = Buffer.from(JSON.stringify(payload()));
  coordinator.acceptWebhook(first, signed(first, Date.parse("2026-09-24T12:00:10Z")));
  await new Promise(resolve => setImmediate(resolve));
  const source = payload("another-operation", "p2p.completed");
  const next = Buffer.from(JSON.stringify({ ...source, data: { ...source.data, status: "completed" } }));
  coordinator.acceptWebhook(next, signed(next, Date.parse("2026-09-24T12:00:10Z")));
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(lifecycle, ["p2p.completed"]);
  assert.equal(state.coordinator.status().pendingWebhookEvents, 1);
  release();
  await new Promise(resolve => setImmediate(resolve));
  coordinator.stop();
  state.store.close();
});

test("rechaza firma inválida y timestamp fuera de la ventana", async () => {
  const state = setup();
  enableRealtime(state.coordinator);
  const raw = Buffer.from(JSON.stringify(payload()));
  assert.throws(
    () => state.coordinator.acceptWebhook(raw, {
      signature: "sha256=" + "0".repeat(64),
      timestamp: String(Date.parse("2026-09-24T12:00:10Z") / 1_000),
    }),
    (error) => error instanceof MarketFeedRequestError && error.status === 401,
  );
  assert.throws(
    () => state.coordinator.acceptWebhook(raw, signed(raw, Date.parse("2026-09-24T11:50:00Z"))),
    (error) => error instanceof MarketFeedRequestError && error.status === 401,
  );
  assert.equal(state.coordinator.status().pendingWebhookEvents, 0);
  await new Promise((resolve) => setImmediate(resolve));
  state.store.close();
});

test("conmuta entre polling y tiempo real con una lectura de recuperación acotada", async () => {
  const state = setup();
  await state.coordinator.pollNext();
  assert.equal(state.polls(), 1);
  assert.throws(() => state.coordinator.setMode("hybrid"), /secreto/i);
  state.coordinator.saveWebhookSecret(secret);
  assert.throws(() => state.coordinator.setMode("hybrid"), /credenciales/i);
  state.coordinator.saveStreamCredentials("app-id-tests", "app-secret-for-tests-2026");
  state.coordinator.setMode("hybrid");
  await state.coordinator.pollNext();
  assert.equal(state.polls(), 2);
  state.coordinator.setMode("polling");
  const raw = Buffer.from(JSON.stringify(payload("8c9e6679-7425-40de-944b-e07fc1f90ae7")));
  const accepted = state.coordinator.acceptWebhook(raw, signed(raw, Date.parse("2026-09-24T12:00:10Z")));
  assert.deepEqual(accepted, { duplicate: false, queued: false });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(state.ingested.length, 0);
  await state.coordinator.pollNext();
  assert.equal(state.polls(), 3);
  state.store.close();
});

test("conserva pendiente una entrega mientras la automatización está pausada", async () => {
  let active = false;
  const state = setup(() => active);
  enableRealtime(state.coordinator);
  const raw = Buffer.from(JSON.stringify(payload("ac9e6679-7425-40de-944b-e07fc1f90ae7")));
  state.coordinator.acceptWebhook(raw, signed(raw, Date.parse("2026-09-24T12:00:10Z")));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(state.ingested.length, 0);
  assert.equal(state.coordinator.status().pendingWebhookEvents, 1);

  active = true;
  assert.equal(await state.coordinator.processNext(), true);
  assert.equal(state.ingested.length, 1);
  assert.equal(state.coordinator.status().pendingWebhookEvents, 0);
  state.store.close();
});

test("el endpoint público verifica el cuerpo crudo sin sesión", async () => {
  const state = setup();
  enableRealtime(state.coordinator);
  const app = buildDashboard(
    {} as never,
    { password: "contraseña-local-segura-2026", trustedOrigin: "http://127.0.0.1:3000" },
    undefined,
    undefined,
    state.coordinator,
  );
  const body = JSON.stringify(payload("9c9e6679-7425-40de-944b-e07fc1f90ae7"));
  const raw = Buffer.from(body);
  const response = await app.inject({
    method: "POST",
    url: "/webhooks/qvapay/p2p-feed",
    headers: {
      "content-type": "application/json",
      "x-qvapay-signature": signed(raw, Date.parse("2026-09-24T12:00:10Z")).signature,
      "x-qvapay-timestamp": signed(raw, Date.parse("2026-09-24T12:00:10Z")).timestamp,
    },
    payload: body,
  });
  assert.equal(response.statusCode, 202);
  assert.equal(response.json<{ queued: boolean }>().queued, true);

  const rejected = await app.inject({
    method: "POST",
    url: "/webhooks/qvapay/p2p-feed",
    headers: {
      "content-type": "application/json",
      "x-qvapay-signature": "sha256=" + "0".repeat(64),
      "x-qvapay-timestamp": String(Date.parse("2026-09-24T12:00:10Z") / 1_000),
    },
    payload: body,
  });
  assert.equal(rejected.statusCode, 401);
  await app.close();
  state.store.close();
});

test("la API autenticada guarda credenciales cifradas sin devolverlas", async () => {
  const state = setup();
  const password = "contraseña-local-segura-2026";
  const origin = "https://qvaapply.example";
  const app = buildDashboard(
    {} as never,
    { password, trustedOrigin: origin, secureCookies: true },
    undefined,
    undefined,
    state.coordinator,
  );
  const login = await app.inject({
    method: "POST",
    url: "/api/session",
    headers: { origin, "content-type": "application/json" },
    payload: { password },
  });
  const cookie = String(login.headers["set-cookie"]).split(";", 1)[0]!;
  const csrf = login.json<{ data: { csrfToken: string } }>().data.csrfToken;
  const response = await app.inject({
    method: "PUT",
    url: "/api/market-source/stream-credentials",
    headers: {
      origin,
      cookie,
      "content-type": "application/json",
      "x-csrf-token": csrf,
    },
    payload: {
      appId: "app-id-private",
      appSecret: "app-secret-private-2026",
    },
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json<{ data: { streamCredentialsConfigured: boolean } }>().data.streamCredentialsConfigured, true);
  assert.doesNotMatch(response.body, /app-id-private|app-secret-private/);
  assert.doesNotMatch(state.store.get("market_feed_app_id") ?? "", /app-id-private/);
  assert.doesNotMatch(state.store.get("market_feed_app_secret") ?? "", /app-secret-private/);
  await app.close();
  state.store.close();
});

test("el feed de rangos evalúa cada cambio de disponible y el cierre invalida sin operar órdenes", async () => {
  const s=setup();enableRealtime(s.coordinator);
  const uuid="flexible-feed-offer";
  const send=async(event:string,available:number,second:number)=>{
    const body={...payload(uuid,event),sent_at:`2026-09-24T12:00:${second}Z`,data:{...payload(uuid,event).data,offer_kind:"flexible",available_amount:String(available),order_min:"5",order_max:"25"}};
    const raw=Buffer.from(JSON.stringify(body));s.coordinator.acceptWebhook(raw,signed(raw,Date.parse(body.sent_at)));
    await s.coordinator.processNext();await new Promise(resolve=>setImmediate(resolve));
  };
  try {
    await send("p2p.range_created",25,10);
    await send("p2p.range_updated",15,11);
    assert.deepEqual(s.ingested.map(row=>Number(row.offer.available_amount)),[25,15]);
    await send("p2p.range_closed",0,12);
    assert.equal(s.ingested.length,2);
    assert.equal(s.store.hasPendingMarketFeedInvalidation(uuid,Date.parse("2026-09-24T12:00:11Z")),true);
    assert.notEqual(s.store.latestMarketFeedState(uuid)?.status,"open");
  } finally {s.coordinator.stop();s.store.close();}
});
