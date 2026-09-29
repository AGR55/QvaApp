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
  const raw = Buffer.from(JSON.stringify(payload()));
  const result = state.coordinator.acceptWebhook(raw, signed(raw, Date.parse("2026-09-24T12:00:10Z")));
  assert.deepEqual(result, { duplicate: false, queued: true });

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(state.ingested.length, 1);
  assert.equal(state.ingested[0]?.offer.amount, 25.5);
  assert.equal(state.ingested[0]?.offer.receive, 25_000);
  assert.equal(state.coordinator.status().pendingWebhookEvents, 0);
  assert.equal(state.coordinator.status().lastWebhookProcessedAt, Date.parse("2026-09-24T12:00:10Z"));

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

test("conmuta de forma exclusiva entre polling y tiempo real", async () => {
  const state = setup();
  await state.coordinator.pollNext();
  assert.equal(state.polls(), 1);
  assert.throws(() => state.coordinator.setMode("hybrid"), /secreto/i);
  state.coordinator.saveWebhookSecret(secret);
  assert.throws(() => state.coordinator.setMode("hybrid"), /credenciales/i);
  state.coordinator.saveStreamCredentials("app-id-tests", "app-secret-for-tests-2026");
  state.coordinator.setMode("hybrid");
  await state.coordinator.pollNext();
  assert.equal(state.polls(), 1);
  state.coordinator.setMode("polling");
  const raw = Buffer.from(JSON.stringify(payload("8c9e6679-7425-40de-944b-e07fc1f90ae7")));
  const accepted = state.coordinator.acceptWebhook(raw, signed(raw, Date.parse("2026-09-24T12:00:10Z")));
  assert.deepEqual(accepted, { duplicate: false, queued: false });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(state.ingested.length, 0);
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
