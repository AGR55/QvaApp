import assert from "node:assert/strict";
import test from "node:test";
import { buildDashboard } from "../src/http-dashboard.js";

const password = "contraseña-local-segura-2026";
const origin = "http://127.0.0.1:3000";

test("Fastify protege datos, origen y mutaciones con sesión y CSRF", async () => {
  const controls: boolean[] = [];
  const readModel = {
    setPaused: async (value: boolean) => void controls.push(value),
  };
  const app = buildDashboard(readModel as never, {
    password,
    trustedOrigin: origin,
  });

  const anonymous = await app.inject({ method: "GET", url: "/api/config" });
  assert.equal(anonymous.statusCode, 401);
  assert.equal(anonymous.headers["x-frame-options"], "DENY");

  const wrongOrigin = await app.inject({
    method: "POST",
    url: "/api/session",
    headers: { origin: "http://malicioso.example", "content-type": "application/json" },
    payload: { password },
  });
  assert.equal(wrongOrigin.statusCode, 403);

  const login = await app.inject({
    method: "POST",
    url: "/api/session",
    headers: { origin, "content-type": "application/json" },
    payload: { password },
  });
  assert.equal(login.statusCode, 201);
  const cookie = String(login.headers["set-cookie"]).split(";", 1)[0]!;
  const csrf = login.json<{ data: { csrfToken: string } }>().data.csrfToken;

  const withoutCsrf = await app.inject({
    method: "PUT",
    url: "/api/control",
    headers: { origin, cookie, "content-type": "application/json" },
    payload: { paused: true },
  });
  assert.equal(withoutCsrf.statusCode, 403);

  const accepted = await app.inject({
    method: "PUT",
    url: "/api/control",
    headers: { origin, cookie, "content-type": "application/json", "x-csrf-token": csrf },
    payload: { paused: true },
  });
  assert.equal(accepted.statusCode, 204);
  assert.deepEqual(controls, [true]);

  const simulation = await app.inject({
    method: "PUT",
    url: "/api/control",
    headers: { origin, cookie, "content-type": "application/json", "x-csrf-token": csrf },
    payload: { mode: "simulation" },
  });
  assert.equal(simulation.statusCode, 400);
  await app.close();
});

test("Fastify sirve identidad visual e iconos solo desde la carpeta pública", async () => {
  const app = buildDashboard({} as never, { password, trustedOrigin: origin });
  const page = await app.inject({ method: "GET", url: "/" });
  assert.match(page.body, /href=\"\/logo\/isotipo\.webp\"/);
  const icon = await app.inject({ method: "GET", url: "/icons/qusd.png" });
  assert.equal(icon.statusCode, 200);
  assert.match(String(icon.headers["content-type"]), /image\/png/);
  const logo = await app.inject({ method: "GET", url: "/logo/logotipo.webp" });
  assert.equal(logo.statusCode, 200);
  assert.match(String(logo.headers["content-type"]), /image\/webp/);
  const signinImage = await app.inject({ method: "GET", url: "/images/signin-picture.webp" });
  assert.equal(signinImage.statusCode, 200);
  assert.match(String(signinImage.headers["content-type"]), /image\/webp/);
  const traversal = await app.inject({ method: "GET", url: "/icons/%2e%2e%2fpackage.json" });
  assert.equal(traversal.statusCode, 404);
  const imageTraversal = await app.inject({ method: "GET", url: "/images/%2e%2e%2fpackage.json" });
  assert.equal(imageTraversal.statusCode, 404);
  await app.close();
});

test("permite subir un icono de mercado desde Estrategia", async () => {
  const uploads: unknown[] = [];
  const readModel = {
    saveMarketIcon: (input: unknown) => {
      uploads.push(input);
      return { url: "/market-icons/hash.png" };
    },
  };
  const app = buildDashboard(readModel as never, { password, trustedOrigin: origin });
  const login = await app.inject({
    method: "POST",
    url: "/api/session",
    headers: { origin, "content-type": "application/json" },
    payload: { password },
  });
  const cookie = String(login.headers["set-cookie"]).split(";", 1)[0]!;
  const csrf = login.json<{ data: { csrfToken: string } }>().data.csrfToken;
  const response = await app.inject({
    method: "POST",
    url: "/api/market-icons",
    headers: { origin, cookie, "content-type": "application/json", "x-csrf-token": csrf },
    payload: {
      name: "etecsa.png",
      mimeType: "image/png",
      base64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB",
    },
  });
  assert.equal(response.statusCode, 201);
  assert.equal(response.json<{ data: { url: string } }>().data.url, "/market-icons/hash.png");
  assert.equal(uploads.length, 1);
  await app.close();
});

test("Fastify rechaza cuerpos inválidos antes de llegar al dominio", async () => {
  const app = buildDashboard({} as never, { password, trustedOrigin: origin });
  const login = await app.inject({
    method: "POST",
    url: "/api/session",
    headers: { origin, "content-type": "application/json" },
    payload: { password },
  });
  const cookie = String(login.headers["set-cookie"]).split(";", 1)[0]!;
  const csrf = login.json<{ data: { csrfToken: string } }>().data.csrfToken;
  const invalid = await app.inject({
    method: "POST",
    url: "/api/offers",
    headers: { origin, cookie, "content-type": "application/json", "x-csrf-token": csrf },
    payload: { coin: "BANK_CUP", type: "sell", amount: -1, rate: 900 },
  });
  assert.equal(invalid.statusCode, 400);
  await app.close();
});

test("previsualiza y aplica un reajuste de capital con confirmación CSRF", async () => {
  const calls: unknown[] = [];
  const job = { id: "rebalance-1", state: "pending", adjustments: [], createdAt: 1, updatedAt: 1 };
  const preview = { plans: [{ coin: "CLASICA", deficit: 2.5, adjustments: [] }], updatedAt: 123 };
  const readModel = {
    budgetRebalancePreview: () => preview,
    refreshBudgetRebalancePreview: async () => ({ ...preview, updatedAt: 456 }),
    startBudgetRebalance: (adjustments: unknown) => {
      calls.push(adjustments);
      return job;
    },
    rebalanceJob: (id: string) => id === job.id ? job : undefined,
  };
  const app = buildDashboard(readModel as never, { password, trustedOrigin: origin });
  const login = await app.inject({ method: "POST", url: "/api/session", headers: { origin, "content-type": "application/json" }, payload: { password } });
  const cookie = String(login.headers["set-cookie"]).split(";", 1)[0]!;
  const csrf = login.json<{ data: { csrfToken: string } }>().data.csrfToken;
  const headers = { origin, cookie, "content-type": "application/json", "x-csrf-token": csrf };

  const cachedPreview = await app.inject({ method: "POST", url: "/api/offers/rebalance/preview", headers, payload: {} });
  assert.equal(cachedPreview.statusCode, 200);
  assert.equal(cachedPreview.json<{ data: { plans: { coin: string }[]; updatedAt: number } }>().data.plans[0]!.coin, "CLASICA");
  assert.equal(cachedPreview.json<{ data: { updatedAt: number } }>().data.updatedAt, 123);

  const refreshedPreview = await app.inject({ method: "POST", url: "/api/offers/rebalance/preview", headers, payload: { refresh: true } });
  assert.equal(refreshedPreview.statusCode, 200);
  assert.equal(refreshedPreview.json<{ data: { updatedAt: number } }>().data.updatedAt, 456);

  const applied = await app.inject({
    method: "POST",
    url: "/api/offers/rebalance/apply",
    headers,
    payload: { adjustments: [{ uuid: "offer-1", amount: 8.25 }] },
  });
  assert.equal(applied.statusCode, 202);
  assert.deepEqual(calls, [[{ uuid: "offer-1", amount: 8.25 }]]);
  const progress = await app.inject({ method: "GET", url: "/api/offers/rebalance/rebalance-1", headers: { cookie } });
  assert.equal(progress.statusCode, 200);
  assert.equal(progress.json<{ data: { id: string } }>().data.id, "rebalance-1");
  await app.close();
});

test("Fastify valida y aplica controles de cacería por mercado", async () => {
  const updates: unknown[] = [];
  const app = buildDashboard({ updateHunting: (value: unknown) => updates.push(value) } as never, { password, trustedOrigin: origin });
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
    url: "/api/hunting",
    headers: { origin, cookie, "content-type": "application/json", "x-csrf-token": csrf },
    payload: { market: { code: "BANDECPREPAGO", huntSellEnabled: false, sellMinRate: 1.13 } },
  });

  assert.equal(response.statusCode, 204);
  assert.deepEqual(updates, [{ market: { code: "BANDECPREPAGO", huntSellEnabled: false, sellMinRate: 1.13 } }]);
  await app.close();
});

test("Fastify previsualiza, aplica y descarta ofertas bloqueadas con confirmación explícita", async () => {
  const calls: string[] = [];
  const readModel = {
    previewBlockedOffer: async (uuid: string) => ({ uuid, rate: 1_010 }),
    applyBlockedOffer: async (uuid: string) => { calls.push(`apply:${uuid}`); return "confirmada"; },
    dismissBlockedOffer: (uuid: string) => void calls.push(`dismiss:${uuid}`),
  };
  const app = buildDashboard(readModel as never, { password, trustedOrigin: origin });
  const login = await app.inject({ method: "POST", url: "/api/session", headers: { origin, "content-type": "application/json" }, payload: { password } });
  const cookie = String(login.headers["set-cookie"]).split(";", 1)[0]!;
  const csrf = login.json<{ data: { csrfToken: string } }>().data.csrfToken;
  const headers = { origin, cookie, "content-type": "application/json", "x-csrf-token": csrf };

  const preview = await app.inject({ method: "POST", url: "/api/blocked-offers/blocked-1/preview", headers, payload: {} });
  assert.equal(preview.statusCode, 200);
  assert.equal(preview.json<{ data: { uuid: string } }>().data.uuid, "blocked-1");
  const rejected = await app.inject({ method: "POST", url: "/api/blocked-offers/blocked-1/apply", headers, payload: { overridePriceGuard: false } });
  assert.equal(rejected.statusCode, 400);
  const applied = await app.inject({ method: "POST", url: "/api/blocked-offers/blocked-1/apply", headers, payload: { overridePriceGuard: true } });
  assert.equal(applied.statusCode, 200);
  const dismissed = await app.inject({ method: "POST", url: "/api/blocked-offers/blocked-2/dismiss", headers, payload: {} });
  assert.equal(dismissed.statusCode, 204);
  assert.deepEqual(calls, ["apply:blocked-1", "dismiss:blocked-2"]);
  await app.close();
});

test("Fastify permite iniciar sesión desde localhost cuando se configuró loopback", async () => {
  const app = buildDashboard({} as never, { password, trustedOrigin: origin });
  const login = await app.inject({
    method: "POST",
    url: "/api/session",
    headers: { origin: "http://localhost:3000", "content-type": "application/json" },
    payload: { password },
  });

  assert.equal(login.statusCode, 201);
  assert.match(String(login.headers["set-cookie"]), /HttpOnly; SameSite=Strict/);
  await app.close();
});

test("Fastify devuelve un rechazo de dominio como error de cliente seguro", async () => {
  const readModel = {
    setPaused: async () => {
      throw new Error("QvaPay no tiene una sesión válida.");
    },
  };
  const app = buildDashboard(readModel as never, { password, trustedOrigin: origin });
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
    url: "/api/control",
    headers: { origin, cookie, "content-type": "application/json", "x-csrf-token": csrf },
    payload: { paused: false },
  });

  assert.equal(response.statusCode, 400);
  assert.equal(response.json<{ error: string }>().error, "QvaPay no tiene una sesión válida.");
  await app.close();
});

test("Fastify exige que la parada de emergencia sea atómica", async () => {
  let mutations = 0;
  const readModel = {
    setEmergencyStop: () => void (mutations += 1),
    setPaused: async () => void (mutations += 1),
  };
  const app = buildDashboard(readModel as never, { password, trustedOrigin: origin });
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
    url: "/api/control",
    headers: { origin, cookie, "content-type": "application/json", "x-csrf-token": csrf },
    payload: { emergencyStop: true, paused: false },
  });

  assert.equal(response.statusCode, 400);
  assert.equal(mutations, 0);
  await app.close();
});

test("el arranque del panel responde solo con SQLite y no consulta QvaPay", async () => {
  let remoteCalls = 0;
  const readModel = {
    localSnapshot: () => ({ generatedAt: 123, markets: [], freshness: {} }),
    snapshot: async () => {
      remoteCalls += 1;
      throw new Error("no debe ejecutarse");
    },
  };
  const app = buildDashboard(readModel as never, { password, trustedOrigin: origin });
  const login = await app.inject({
    method: "POST",
    url: "/api/session",
    headers: { origin, "content-type": "application/json" },
    payload: { password },
  });
  const cookie = String(login.headers["set-cookie"]).split(";", 1)[0]!;

  const response = await app.inject({
    method: "GET",
    url: "/api/dashboard",
    headers: { cookie },
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.json<{ source: string }>().source, "sqlite");
  assert.equal(remoteCalls, 0);
  await app.close();
});

test("una lectura remota fallida conserva la copia SQLite y marca su antigüedad", async () => {
  const cachedAt = Date.now() - 60_000;
  const readModel = {
    refreshBalance: async () => {
      throw new Error("conexión inestable");
    },
    localSnapshot: () => ({
      balance: 18.5,
      freshness: {
        balance: cachedAt,
        ownOffers: null,
        transactions: null,
        markets: {},
      },
    }),
  };
  const app = buildDashboard(readModel as never, { password, trustedOrigin: origin });
  const login = await app.inject({
    method: "POST",
    url: "/api/session",
    headers: { origin, "content-type": "application/json" },
    payload: { password },
  });
  const cookie = String(login.headers["set-cookie"]).split(";", 1)[0]!;

  const response = await app.inject({
    method: "GET",
    url: "/api/live/balance",
    headers: { cookie },
  });
  const payload = response.json<{
    data: number;
    updatedAt: number;
    stale: boolean;
    error: string;
  }>();

  assert.equal(response.statusCode, 200);
  assert.equal(payload.data, 18.5);
  assert.equal(payload.updatedAt, cachedAt);
  assert.equal(payload.stale, true);
  assert.match(payload.error, /inestable/);
  await app.close();
});

test("expone decisiones paginadas y protege la resolución con CSRF", async () => {
  const dismissed: number[] = [];
  const readModel = {
    decisionEvents: (options: unknown) => ({ items: [], total: 0, pending: 0, page: 2, pageSize: 5, options }),
    dismissDecisionEvent: (id: number) => void dismissed.push(id),
  };
  const app = buildDashboard(readModel as never, { password, trustedOrigin: origin });
  const login = await app.inject({ method: "POST", url: "/api/session", headers: { origin, "content-type": "application/json" }, payload: { password } });
  const cookie = String(login.headers["set-cookie"]).split(";", 1)[0]!;
  const csrf = login.json<{ data: { csrfToken: string } }>().data.csrfToken;
  const listed = await app.inject({ method: "GET", url: "/api/decision-events?decision=blocked&status=pending&page=2&pageSize=5", headers: { cookie } });
  assert.equal(listed.statusCode, 200);
  assert.equal(listed.json<{ data: { page: number } }>().data.page, 2);
  const rejected = await app.inject({ method: "POST", url: "/api/decision-events/7/dismiss", headers: { origin, cookie, "content-type": "application/json" }, payload: {} });
  assert.equal(rejected.statusCode, 403);
  const accepted = await app.inject({ method: "POST", url: "/api/decision-events/7/dismiss", headers: { origin, cookie, "content-type": "application/json", "x-csrf-token": csrf }, payload: {} });
  assert.equal(accepted.statusCode, 204);
  assert.deepEqual(dismissed, [7]);
  await app.close();
});

test("expone avisos persistentes y permite confirmarlos", async () => {
  const acknowledged: string[] = [];
  const readModel = {
    notifications: () => [{ id: "operation-applied:one", type: "operation-applied" }],
    acknowledgeNotification: (id: string) => void acknowledged.push(id),
  };
  const app = buildDashboard(readModel as never, { password, trustedOrigin: origin });
  const login = await app.inject({ method: "POST", url: "/api/session", headers: { origin, "content-type": "application/json" }, payload: { password } });
  const cookie = String(login.headers["set-cookie"]).split(";", 1)[0]!;
  const csrf = login.json<{ data: { csrfToken: string } }>().data.csrfToken;

  const listed = await app.inject({ method: "GET", url: "/api/notifications", headers: { cookie } });
  assert.equal(listed.statusCode, 200);
  assert.equal(listed.json<{ data: { id: string }[] }>().data[0]?.id, "operation-applied:one");

  const accepted = await app.inject({
    method: "POST",
    url: "/api/notifications/operation-applied%3Aone/ack",
    headers: { origin, cookie, "content-type": "application/json", "x-csrf-token": csrf },
    payload: {},
  });
  assert.equal(accepted.statusCode, 204);
  assert.deepEqual(acknowledged, ["operation-applied:one"]);
  await app.close();
});

test("el service worker usa la identidad de QvaApply en avisos persistentes", async () => {
  const app = buildDashboard({} as never, { password, trustedOrigin: origin });
  const worker = await app.inject({ method: "GET", url: "/service-worker.js" });
  assert.equal(worker.statusCode, 200);
  assert.match(worker.body, /icon:\s*"\/logo\/isotipo\.webp"/);
  assert.match(worker.body, /requireInteraction:\s*payload\.type === "operation-applied"/);
  await app.close();
});

test("permite cancelar una operación con cuerpo vacío y reserva reference para paid", async () => {
  const calls: string[] = [];
  const readModel = {
    cancelOperation: async (uuid: string) => void calls.push(`cancel:${uuid}`),
    markPaid: async (uuid: string, reference: string) => void calls.push(`paid:${uuid}:${reference}`),
  };
  const app = buildDashboard(readModel as never, { password, trustedOrigin: origin });
  const login = await app.inject({ method: "POST", url: "/api/session", headers: { origin, "content-type": "application/json" }, payload: { password } });
  const cookie = String(login.headers["set-cookie"]).split(";", 1)[0]!;
  const csrf = login.json<{ data: { csrfToken: string } }>().data.csrfToken;
  const headers = { origin, cookie, "content-type": "application/json", "x-csrf-token": csrf };

  const cancelled = await app.inject({ method: "POST", url: "/api/operations/operation-1/cancel", headers, payload: {} });
  const invalidPaid = await app.inject({ method: "POST", url: "/api/operations/operation-2/paid", headers, payload: {} });

  assert.equal(cancelled.statusCode, 204);
  assert.equal(invalidPaid.statusCode, 400);
  assert.deepEqual(calls, ["cancel:operation-1"]);
  await app.close();
});

test("registra y elimina Web Push solo con sesión, origen y CSRF", async () => {
  const subscriptions: string[] = [];
  const push = {
    publicKey: () => "public-key",
    subscribe: (value: { endpoint: string }) => { subscriptions.push(value.endpoint); return value; },
    unsubscribe: (endpoint: string) => { subscriptions.splice(subscriptions.indexOf(endpoint), 1); return true; },
  };
  const app = buildDashboard({} as never, { password, trustedOrigin: origin }, push as never);
  const login = await app.inject({ method: "POST", url: "/api/session", headers: { origin, "content-type": "application/json" }, payload: { password } });
  const cookie = String(login.headers["set-cookie"]).split(";", 1)[0]!;
  const csrf = login.json<{ data: { csrfToken: string } }>().data.csrfToken;
  assert.equal((await app.inject({ method: "GET", url: "/api/push/public-key", headers: { cookie } })).statusCode, 200);
  const headers = { origin, cookie, "content-type": "application/json", "x-csrf-token": csrf };
  const body = { endpoint: "https://push.example/device", expirationTime: null, keys: { p256dh: "key", auth: "auth" } };
  assert.equal((await app.inject({ method: "POST", url: "/api/push/subscriptions", headers, payload: body })).statusCode, 201);
  assert.equal((await app.inject({ method: "DELETE", url: "/api/push/subscriptions", headers, payload: { endpoint: body.endpoint } })).statusCode, 204);
  assert.deepEqual(subscriptions, []);
  await app.close();
});
