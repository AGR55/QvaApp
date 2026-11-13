/**
 * Escenarios de contrato: `test/web-push.test.ts`.
 *
 * Runtime de Web Push inyectado; sin red ni claves reales. La VAPID real del
 * proveedor se observa como booleano + longitud porque se genera al azar.
 */
import assert from "node:assert/strict";
import { WebPushService } from "../../../src/web-push.js";
import type { ContractScenario } from "../../../lib/contract/scenario.js";

function fixture() {
  const values = new Map<string, string>();
  const sent: { endpoint: string; payload: Record<string, unknown> }[] = [];
  const expired = new Set<string>();
  const runtime = {
    generateVAPIDKeys: () => ({ publicKey: "public-key", privateKey: "private-key" }),
    setVapidDetails: () => undefined,
    sendNotification: async (subscription: { endpoint: string }, payload: string) => {
      if (expired.has(subscription.endpoint)) throw { statusCode: 410 };
      sent.push({ endpoint: subscription.endpoint, payload: JSON.parse(payload) as Record<string, unknown> });
    },
  };
  const service = new WebPushService(
    {
      get: (key) => values.get(key),
      set: (key, value) => void values.set(key, value),
    },
    runtime,
  );
  return { service, sent, expired };
}

const subscription = (suffix: string) => ({
  endpoint: `https://push.example/${suffix}`,
  expirationTime: null,
  keys: { p256dh: `key-${suffix}`, auth: `auth-${suffix}` },
});

const alert = {
  uuid: "blocked-1",
  coin: "BANK_CUP",
  offerType: "buy" as const,
  amount: 20,
  receive: 21_080,
  rate: 1_054,
  referenceRate: 1_012,
  reason: "Precio sobre la mediana",
  updatedAt: 1_000,
};

const scenarios: ContractScenario[] = [
  {
    id: "web-push/01-real-esm-vapid",
    file: "test/web-push.test.ts",
    source: "test/web-push.test.ts:36",
    async run(ctx) {
      const values = new Map<string, string>();
      const service = new WebPushService({
        get: (key) => values.get(key),
        set: (key, value) => void values.set(key, value),
      });
      const key = service.publicKey();
      ctx.value("publicKey", { matches: /^[A-Za-z0-9_-]{40,}$/.test(key), length: key.length });
      assert.match(key, /^[A-Za-z0-9_-]{40,}$/);
    },
  },
  {
    id: "web-push/02-subscribe-notify-once",
    file: "test/web-push.test.ts",
    source: "test/web-push.test.ts:46",
    async run(ctx) {
      const { service, sent } = fixture();
      service.subscribe(subscription("one"));

      await ctx.observe("notifyBlocked#1", service.notifyBlocked(alert));
      await ctx.observe("notifyBlocked#2", service.notifyBlocked(alert));

      ctx.value("publicKey", service.publicKey());
      ctx.value("sent", sent);
      ctx.effect("sendNotification", sent.map((item) => item.endpoint));

      assert.equal(service.publicKey(), "public-key");
      assert.equal(sent.length, 1);
      assert.equal((sent[0]?.payload.alert as { uuid: string }).uuid, "blocked-1");
    },
  },
  {
    id: "web-push/03-replace-subscription-expired",
    file: "test/web-push.test.ts",
    source: "test/web-push.test.ts:58",
    async run(ctx) {
      const { service, expired } = fixture();
      service.subscribe(subscription("one"));
      service.subscribe({ ...subscription("one"), keys: { p256dh: "new", auth: "new" } });
      service.subscribe(subscription("two"));
      expired.add(subscription("one").endpoint);

      await ctx.observe("notifyBlocked", service.notifyBlocked(alert));

      const remaining = service.subscriptions().map((item) => item.endpoint);
      const unsubscribed = service.unsubscribe(subscription("two").endpoint);
      ctx.value("subscriptions", { remaining, unsubscribed, final: service.subscriptions().length });

      assert.deepEqual(remaining, [subscription("two").endpoint]);
      assert.equal(unsubscribed, true);
      assert.equal(service.subscriptions().length, 0);
    },
  },
  {
    id: "web-push/04-reject-invalid-endpoint",
    file: "test/web-push.test.ts",
    source: "test/web-push.test.ts:72",
    async run(ctx) {
      const { service } = fixture();
      const outcome = await ctx.observe(
        "subscribe",
        Promise.resolve().then(() => service.subscribe({ endpoint: "http://inseguro", keys: {} })),
      );
      assert.equal(outcome.ok, false);
      if (!outcome.ok) assert.match(outcome.error.message, /inválida/);
      assert.throws(() => service.subscribe({ endpoint: "http://inseguro", keys: {} }), /inválida/);
    },
  },
  {
    id: "web-push/05-operation-contextual-routes",
    file: "test/web-push.test.ts",
    source: "test/web-push.test.ts:77",
    async run(ctx) {
      const { service, sent } = fixture();
      service.subscribe(subscription("phone"));

      await ctx.observe(
        "notifyOperation:applied",
        service.notifyOperation({ uuid: "operation-1", coin: "BANK_CUP", amount: 8, kind: "operation-applied" }),
      );
      await ctx.observe(
        "notifyOperation:reconciliation",
        service.notifyOperation({ uuid: "operation-2", coin: "BANK_CUP", amount: 9, kind: "reconciliation-required" }),
      );
      await ctx.observe(
        "notifyOperation:own-offer",
        service.notifyOperation({ uuid: "owned-offer", coin: "BANK_CUP", amount: 9, kind: "own-offer-applied" }),
      );
      await ctx.observe(
        "notifyOperation:own-offer-version",
        service.notifyOperation({
          uuid: "owned-offer",
          coin: "BANK_CUP",
          amount: 9,
          kind: "own-offer-applied",
          eventVersion: "cycle-1:updated-2026-09-30T10:05:00Z",
        }),
      );

      ctx.value("sent", sent);
      ctx.effect(
        "sendNotification",
        sent.map((item) => ({ endpoint: item.endpoint, url: item.payload.url, version: item.payload.version })),
      );

      assert.equal(sent.length, 4);
      assert.match(String(sent[0]?.payload.url), /view=operaciones/);
      assert.match(String(sent[1]?.payload.url), /view=auditoria/);
      assert.match(String(sent[2]?.payload.url), /view=operaciones/);
      assert.notEqual(sent[2]?.payload.version, sent[3]?.payload.version);
    },
  },
];

export { scenarios };
