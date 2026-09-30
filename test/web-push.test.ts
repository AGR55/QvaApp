import assert from "node:assert/strict";
import test from "node:test";
import { WebPushService } from "../src/web-push.js";

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
  const service = new WebPushService({
    get: (key) => values.get(key),
    set: (key, value) => void values.set(key, value),
  }, runtime);
  return { service, sent, expired };
}

const subscription = (suffix: string) => ({
  endpoint: `https://push.example/${suffix}`,
  expirationTime: null,
  keys: { p256dh: `key-${suffix}`, auth: `auth-${suffix}` },
});

const alert = {
  uuid: "blocked-1", coin: "BANK_CUP", offerType: "buy" as const,
  amount: 20, receive: 21_080, rate: 1_054, referenceRate: 1_012,
  reason: "Precio sobre la mediana", updatedAt: 1_000,
};

test("inicializa el runtime real de web-push bajo ESM", () => {
  const values = new Map<string, string>();
  const service = new WebPushService({
    get: (key) => values.get(key),
    set: (key, value) => void values.set(key, value),
  });

  assert.match(service.publicKey(), /^[A-Za-z0-9_-]{40,}$/);
});

test("persiste una suscripción y envía una alerta bloqueada una sola vez", async () => {
  const { service, sent } = fixture();
  service.subscribe(subscription("one"));

  await service.notifyBlocked(alert);
  await service.notifyBlocked(alert);

  assert.equal(service.publicKey(), "public-key");
  assert.equal(sent.length, 1);
  assert.equal((sent[0]?.payload.alert as { uuid: string }).uuid, "blocked-1");
});

test("reemplaza una suscripción repetida y elimina endpoints vencidos", async () => {
  const { service, expired } = fixture();
  service.subscribe(subscription("one"));
  service.subscribe({ ...subscription("one"), keys: { p256dh: "new", auth: "new" } });
  service.subscribe(subscription("two"));
  expired.add(subscription("one").endpoint);

  await service.notifyBlocked(alert);

  assert.deepEqual(service.subscriptions().map((item) => item.endpoint), [subscription("two").endpoint]);
  assert.equal(service.unsubscribe(subscription("two").endpoint), true);
  assert.equal(service.subscriptions().length, 0);
});

test("rechaza endpoints o claves Push no válidos", () => {
  const { service } = fixture();
  assert.throws(() => service.subscribe({ endpoint: "http://inseguro", keys: {} }), /inválida/);
});

test("notifica aplicaciones y conciliaciones con rutas contextuales", async () => {
  const { service, sent } = fixture();
  service.subscribe(subscription("phone"));

  await service.notifyOperation({ uuid: "operation-1", coin: "BANK_CUP", amount: 8, kind: "operation-applied" });
  await service.notifyOperation({ uuid: "operation-2", coin: "BANK_CUP", amount: 9, kind: "reconciliation-required" });
  await service.notifyOperation({ uuid: "owned-offer", coin: "BANK_CUP", amount: 9, kind: "own-offer-applied" });
  await service.notifyOperation({ uuid: "owned-offer", coin: "BANK_CUP", amount: 9, kind: "own-offer-applied", eventVersion: "cycle-1:updated-2026-09-30T10:05:00Z" });

  assert.equal(sent.length, 4);
  assert.match(String(sent[0]?.payload.url), /view=operaciones/);
  assert.match(String(sent[1]?.payload.url), /view=auditoria/);
  assert.match(String(sent[2]?.payload.url), /view=operaciones/);
  assert.notEqual(sent[2]?.payload.version, sent[3]?.payload.version);
});
