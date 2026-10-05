import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildDashboard } from "../src/http-dashboard.js";
import { MarketAccountService } from "../src/market-accounts.js";
import { PaymentSmsService } from "../src/payment-sms.js";
import { Store } from "../src/store.js";
import { Vault } from "../src/vault.js";

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

test("la entrega móvil exige Bearer y acepta únicamente campos estructurados", async () => {
  const stored: unknown[] = [];
  const readModel = {
    pairSmsDevice: (label: string) => ({ device: { id: "device-1", label }, token: "a".repeat(43) }),
    receivePaymentReceipt: async (token: string, input: unknown) => {
      assert.equal(token, "a".repeat(43));
      stored.push(input);
      return { duplicate: false, receipt: { id: "receipt-1", state: "review" } };
    },
  };
  const app = buildDashboard(readModel as never, { password, trustedOrigin: origin });

  const noToken = await app.inject({ method: "POST", url: "/api/mobile/payment-receipts", headers: { "content-type": "application/json" }, payload: {} });
  assert.equal(noToken.statusCode, 401);
  const invalid = await app.inject({
    method: "POST", url: "/api/mobile/payment-receipts",
    headers: { authorization: `Bearer ${"a".repeat(43)}`, "content-type": "application/json" },
    payload: { sms: "texto íntegro del SMS" },
  });
  assert.equal(invalid.statusCode, 400);
  const accepted = await app.inject({
    method: "POST", url: "/api/mobile/payment-receipts",
    headers: { authorization: `Bearer ${"a".repeat(43)}`, "content-type": "application/json" },
    payload: { bank: "BPA", sender: "BPA", currency: "CUP", amount: 100, beneficiaryMasked: "1234****5678", transactionId: "TX-1", receivedAt: Date.now() },
  });
  assert.equal(accepted.statusCode, 202);
  assert.equal(accepted.json<{ status: string }>().status, "review");
  assert.equal(stored.length, 1);
  const hidden = await app.inject({ method: "GET", url: "/api/mobile/payment-receipts" });
  assert.equal(hidden.statusCode, 401);
  await app.close();
});

test("device-check valida Bearer/revocación sin abrir las rutas administrativas", async () => {
  const store = new Store(mkdtempSync(join(tmpdir(), "qvaapply-http-device-check-")));
  const service = new PaymentSmsService(store, {} as never, { markPaid: async () => undefined }, () => "CUP");
  const paired = service.pairDevice("Android de prueba");
  const app = buildDashboard({ checkSmsDevice: (token: string) => service.checkDevice(token) } as never, {
    password,
    trustedOrigin: origin,
  });

  const valid = await app.inject({
    method: "GET", url: "/api/mobile/device-check",
    headers: { authorization: `Bearer ${paired.token}` },
  });
  assert.equal(valid.statusCode, 200);
  assert.deepEqual(valid.json(), { ok: true });

  const invalid = await app.inject({
    method: "GET", url: "/api/mobile/device-check",
    headers: { authorization: `Bearer ${"b".repeat(43)}` },
  });
  assert.equal(invalid.statusCode, 401);
  service.revokeDevice(paired.device.id);
  const revoked = await app.inject({
    method: "GET", url: "/api/mobile/device-check",
    headers: { authorization: `Bearer ${paired.token}` },
  });
  assert.equal(revoked.statusCode, 401);

  const admin = await app.inject({ method: "GET", url: "/api/mobile/devices" });
  assert.equal(admin.statusCode, 401);
  const nearMatch = await app.inject({ method: "GET", url: "/api/mobile/device-check/extra" });
  assert.equal(nearMatch.statusCode, 401);
  await app.close();
  store.close();
});

test("expone logs operativos autenticados con filtros acotados", async () => {
  const calls: unknown[] = [];
  const readModel = {
    operationalLogs: (options: unknown) => {
      calls.push(options);
      return { items: [], hasMore: false, newestId: 0 };
    },
  };
  const app = buildDashboard(readModel as never, {
    password,
    trustedOrigin: origin,
  });

  const anonymous = await app.inject({ method: "GET", url: "/api/logs" });
  assert.equal(anonymous.statusCode, 401);

  const login = await app.inject({
    method: "POST",
    url: "/api/session",
    headers: { origin, "content-type": "application/json" },
    payload: { password },
  });
  const cookie = String(login.headers["set-cookie"]).split(";", 1)[0]!;
  const listed = await app.inject({
    method: "GET",
    url: "/api/logs?after=7&limit=80&level=error&component=qvapay&query=fiat&since=3600000",
    headers: { cookie },
  });
  assert.equal(listed.statusCode, 200);
  assert.deepEqual(calls, [{
    after: 7,
    limit: 80,
    level: "error",
    component: "qvapay",
    query: "fiat",
    since: 3_600_000,
  }]);

  const invalid = await app.inject({
    method: "GET",
    url: "/api/logs?level=critical&limit=9999",
    headers: { cookie },
  });
  assert.equal(invalid.statusCode, 400);
  await app.close();
});

test("gestiona cuentas lectoras sin exponer sus tokens", async () => {
  const store = new Store(mkdtempSync(join(tmpdir(), "qvaapply-http-readers-")));
  const accounts = new MarketAccountService(
    store,
    new Vault("a".repeat(64)),
    () => ({
      listOffersPage: async () => ({
        offers: [], total: 0, currentPage: 1, perPage: 1,
      }),
    }),
  );
  const source = {
    status: () => ({
      mode: "polling" as const,
      accounts: [],
      healthyAccounts: 1,
      effectiveCadenceSeconds: 3,
      estimatedRequestsPerMinute: 20,
    }),
  };
  const app = buildDashboard(
    {} as never,
    { password, trustedOrigin: origin },
    undefined,
    accounts,
    source,
  );
  const login = await app.inject({
    method: "POST",
    url: "/api/session",
    headers: { origin, "content-type": "application/json" },
    payload: { password },
  });
  const cookie = String(login.headers["set-cookie"]).split(";", 1)[0]!;
  const csrf = login.json<{ data: { csrfToken: string } }>().data.csrfToken;
  const headers = {
    origin,
    cookie,
    "content-type": "application/json",
    "x-csrf-token": csrf,
  };

  const created = await app.inject({
    method: "POST",
    url: "/api/market-readers",
    headers,
    payload: {
      label: "Observadora web",
      token: "reader-token-from-browser",
      intervalSeconds: 3,
    },
  });
  assert.equal(created.statusCode, 201);
  assert.doesNotMatch(created.body, /reader-token|encryptedToken|fingerprint/);
  const id = created.json<{ data: { id: string } }>().data.id;

  const listed = await app.inject({
    method: "GET",
    url: "/api/market-source",
    headers: { cookie },
  });
  assert.equal(listed.statusCode, 200);
  assert.equal(listed.json<{ data: { readers: unknown[] } }>().data.readers.length, 1);
  assert.doesNotMatch(listed.body, /reader-token|encryptedToken|fingerprint/);

  const disabled = await app.inject({
    method: "PUT",
    url: `/api/market-readers/${id}`,
    headers,
    payload: { enabled: false },
  });
  assert.equal(disabled.statusCode, 200);
  assert.equal(disabled.json<{ data: { enabled: boolean } }>().data.enabled, false);

  const rotated = await app.inject({
    method: "PUT",
    url: `/api/market-readers/${id}/token`,
    headers,
    payload: { token: "reader-token-rotated-safely" },
  });
  assert.equal(rotated.statusCode, 200);
  assert.doesNotMatch(rotated.body, /rotated-safely/);

  const removed = await app.inject({
    method: "DELETE",
    url: `/api/market-readers/${id}`,
    headers,
    payload: {},
  });
  assert.equal(removed.statusCode, 204);
  await app.close();
  store.close();
});

test("Fastify sirve identidad visual e iconos solo desde la carpeta pública", async () => {
  const app = buildDashboard({} as never, { password, trustedOrigin: origin });
  const page = await app.inject({ method: "GET", url: "/" });
  assert.match(page.body, /href=\"\/logo\/isotipo\.webp\"/);
  assert.match(page.body, /src="\/logo\/logotipo\.webp"/);
  assert.match(page.body, /src="\/auth\/login\.js"/);
  assert.doesNotMatch(page.body, /src="\/dashboard\/app\.js"/);
  assert.doesNotMatch(page.body, /fonts\.(?:googleapis|gstatic)\.com/);
  const icon = await app.inject({ method: "GET", url: "/icons/qusd.png" });
  assert.equal(icon.statusCode, 200);
  assert.match(String(icon.headers["content-type"]), /image\/png/);
  assert.match(String(icon.headers["cache-control"]), /public, max-age=86400/);
  const logo = await app.inject({ method: "GET", url: "/logo/logotipo.webp" });
  assert.equal(logo.statusCode, 200);
  assert.match(String(logo.headers["content-type"]), /image\/webp/);
  assert.match(String(logo.headers["cache-control"]), /public, max-age=86400/);
  const signinImage = await app.inject({ method: "GET", url: "/images/signin-picture.webp" });
  assert.equal(signinImage.statusCode, 404);
  const appScript = await app.inject({ method: "GET", url: "/dashboard/app.js" });
  assert.equal(appScript.headers["cache-control"], "public, no-cache, must-revalidate");
  const unchanged = await app.inject({ method: "GET", url: "/dashboard/app.js", headers: { "if-none-match": String(appScript.headers.etag) } });
  assert.equal(unchanged.statusCode, 304);
  const traversal = await app.inject({ method: "GET", url: "/icons/%2e%2e%2fpackage.json" });
  assert.equal(traversal.statusCode, 404);
  const imageTraversal = await app.inject({ method: "GET", url: "/images/%2e%2e%2fpackage.json" });
  assert.equal(imageTraversal.statusCode, 404);
  await app.close();
});

test("el documento autenticado incluye sesión y snapshot local sin una segunda lectura", async () => {
  let localReads = 0;
  const config = { risk: {}, markets: [] };
  const snapshot = {
    generatedAt: 123,
    markets: [],
    freshness: {},
    marker: "</template><script>alert('no')</script>",
  };
  const app = buildDashboard(
    {
      localSnapshot: () => {
        localReads += 1;
        return snapshot;
      },
      snapshot: async () => {
        throw new Error("El HTML no debe consultar QvaPay.");
      },
      config: () => config,
      configRevisions: () => [{ id: "revision-1" }],
    } as never,
    { password, trustedOrigin: origin },
  );
  const login = await app.inject({
    method: "POST",
    url: "/api/session",
    headers: { origin, "content-type": "application/json" },
    payload: { password },
  });
  const cookie = String(login.headers["set-cookie"]).split(";", 1)[0]!;
  const page = await app.inject({ method: "GET", url: "/", headers: { cookie } });

  assert.equal(page.statusCode, 200);
  assert.equal(page.headers["cache-control"], "no-store");
  assert.equal(page.headers.vary, "Cookie");
  assert.equal(localReads, 1);
  assert.doesNotMatch(page.body, /<script>alert\('no'\)<\/script>/);
  const encoded = page.body.match(
    /<template id="qvaapply-bootstrap">([^]*?)<\/template>/,
  )?.[1];
  assert.ok(encoded);
  const bootstrap = JSON.parse(encoded) as {
    session: { authenticated: boolean; csrfToken: string };
    dashboard: typeof snapshot;
    config: typeof config;
    configRevisions: { id: string }[];
  };
  assert.equal(bootstrap.session.authenticated, true);
  assert.equal(bootstrap.dashboard.marker, snapshot.marker);
  assert.deepEqual(bootstrap.config, config);
  assert.deepEqual(bootstrap.configRevisions, [{ id: "revision-1" }]);
  await app.close();
});

test("el documento público no incluye información operativa", async () => {
  const app = buildDashboard(
    {
      localSnapshot: () => {
        throw new Error("Un visitante anónimo no debe leer el snapshot.");
      },
    } as never,
    { password, trustedOrigin: origin },
  );
  const page = await app.inject({ method: "GET", url: "/" });
  assert.doesNotMatch(page.body, /qvaapply-bootstrap|csrfToken|dashboard\/app\.js/);
  assert.match(page.body, /id="login-form"/);
  const loginScript = await app.inject({ method: "GET", url: "/auth/login.js" });
  assert.equal(loginScript.statusCode, 200);
  assert.ok(loginScript.body.length < 2_000);
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

test("la API cooperativa publica y retira aportaciones sin exponer ejecución conjunta", async () => {
  const published: unknown[] = [];
  const withdrawn: string[] = [];
  let reconciliations = 0;
  const app = buildDashboard(
    {
      publishCooperativeContribution: async (input: unknown) => void published.push(input),
      withdrawCooperativeContribution: async (coin: string) => void withdrawn.push(coin),
      reconcileCooperativeNetwork: async () => void (reconciliations += 1),
    } as never,
    { password, trustedOrigin: origin },
  );
  const login = await app.inject({
    method: "POST",
    url: "/api/session",
    headers: { origin, "content-type": "application/json" },
    payload: { password },
  });
  const cookie = String(login.headers["set-cookie"]).split(";", 1)[0]!;
  const csrf = login.json<{ data: { csrfToken: string } }>().data.csrfToken;
  const headers = {
    origin,
    cookie,
    "content-type": "application/json",
    "x-csrf-token": csrf,
  };

  const invalid = await app.inject({
    method: "PUT",
    url: "/api/cooperative-network/contributions",
    headers,
    payload: { coin: "BANK_CUP", fiat: 0, minimal: 100, price: 390 },
  });
  assert.equal(invalid.statusCode, 400);

  const accepted = await app.inject({
    method: "PUT",
    url: "/api/cooperative-network/contributions",
    headers,
    payload: { coin: "BANK_CUP", fiat: 12_500, minimal: 1_000, price: 390 },
  });
  assert.equal(accepted.statusCode, 204);
  assert.deepEqual(published, [
    { coin: "BANK_CUP", fiat: 12_500, minimal: 1_000, price: 390 },
  ]);

  const removed = await app.inject({
    method: "DELETE",
    url: "/api/cooperative-network/contributions/BANK_CUP",
    headers,
    payload: {},
  });
  assert.equal(removed.statusCode, 204);
  assert.deepEqual(withdrawn, ["BANK_CUP"]);

  const reconciled = await app.inject({
    method: "POST",
    url: "/api/cooperative-network/reconcile",
    headers,
    payload: {},
  });
  assert.equal(reconciled.statusCode, 204);
  assert.equal(reconciliations, 1);

  const perform = await app.inject({
    method: "POST",
    url: "/api/cooperative-network/perform",
    headers,
    payload: { externalId: "unsafe" },
  });
  assert.equal(perform.statusCode, 404);
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

test("Fastify no expone fallos internos como errores de cliente", async () => {
  const readModel = {
    setPaused: async () => {
      throw new TypeError("No se pudo leer /srv/qvaapply/secreto interno");
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

  assert.equal(response.statusCode, 500);
  assert.deepEqual(response.json(), {
    error: "No se pudo completar la solicitud.",
  });
  assert.doesNotMatch(response.body, /srv|secreto|TypeError/);
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

test("API móvil de operador separa credenciales SMS, limita alcance y permite acciones auditables", async () => {
  const actions: string[] = [];
  const readModel = {
    pairMobileOperator: (label: string) => ({ operator: { id: "op-1", label, scopes: ["read", "actions"], createdAt: 1 }, token: "b".repeat(48) }),
    checkMobileOperator: (token: string) => token === "b".repeat(48) ? { ok: true, operatorId: "op-1", scopes: ["read", "actions"] } : { ok: false },
    mobileOperations: () => [{ uuid: "u1", side: "buy", market: "BAND", marketLabel: "Bandec", currency: "CUP", amount: 2, receive: 100, rate: 50, status: "applied", createdAt: 1, actions: ["paid", "cancel"] }],
    mobileAlerts: () => [{ id: "alert-1", type: "operation-applied", message: "Nueva operación", createdAt: 1 }],
    mobileMarkets: () => [{ code: "BAND", label: "Bandec", currency: "CUP" }],
    mobileReceiptOutcomes: () => [{ id: "receipt-1", status: "matched", receivedAt: 1, operationUuid: "u1" }],
    markPaid: async (uuid: string, reference: string) => void actions.push(`paid:${uuid}:${reference}`),
    confirmReceived: async (uuid: string) => void actions.push(`received:${uuid}`),
    cancelOperation: async (uuid: string) => void actions.push(`cancel:${uuid}`),
    mobileOperationAction: async (_operatorId: string, uuid: string, action: string, reference?: string) => {
      if (action === "paid") await (readModel.markPaid as (uuid: string, reference: string) => Promise<void>)(uuid, reference!);
      else if (action === "received") await (readModel.confirmReceived as (uuid: string) => Promise<void>)(uuid);
      else await (readModel.cancelOperation as (uuid: string) => Promise<void>)(uuid);
    },
  };
  const app = buildDashboard(readModel as never, { password, trustedOrigin: origin });
  const login = await app.inject({ method: "POST", url: "/api/session", headers: { origin, "content-type": "application/json" }, payload: { password } });
  const cookie = String(login.headers["set-cookie"]).split(";", 1)[0]!;
  const csrf = login.json<{ data: { csrfToken: string } }>().data.csrfToken;
  const paired = await app.inject({ method: "POST", url: "/api/mobile/operators", headers: { origin, cookie, "x-csrf-token": csrf, "content-type": "application/json" }, payload: { label: "Android" } });
  assert.equal(paired.statusCode, 201);
  const bearer = { authorization: `Bearer ${"b".repeat(48)}`, "content-type": "application/json" };
  assert.equal((await app.inject({ method: "GET", url: "/api/mobile/operations", headers: bearer })).statusCode, 200);
  assert.equal((await app.inject({ method: "GET", url: "/api/mobile/alerts", headers: bearer })).statusCode, 200);
  assert.equal((await app.inject({ method: "GET", url: "/api/mobile/markets", headers: bearer })).statusCode, 200);
  assert.equal((await app.inject({ method: "GET", url: "/api/mobile/receipt-outcomes", headers: bearer })).statusCode, 200);
  assert.equal((await app.inject({ method: "POST", url: "/api/mobile/operations/u1/cancel", headers: { ...bearer, cookie, origin }, payload: {} })).statusCode, 403);
  assert.equal((await app.inject({ method: "POST", url: "/api/mobile/operations/u1/paid", headers: bearer, payload: { reference: "REF-1" } })).statusCode, 204);
  assert.equal((await app.inject({ method: "POST", url: "/api/mobile/operations/u1/cancel", headers: bearer, payload: {} })).statusCode, 204);
  assert.deepEqual(actions, ["paid:u1:REF-1", "cancel:u1"]);
  assert.equal((await app.inject({ method: "GET", url: "/api/mobile/operations" })).statusCode, 401);
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
