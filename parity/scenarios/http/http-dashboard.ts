/**
 * Escenarios HTTP: `test/http-dashboard.test.ts` (26 casos).
 *
 * Se conservan las aserciones originales; `ctx.call` sustituye a `app.inject`
 * y registra la observación canónica. Los UUID, CSRF, `expiresAt` y ETag se
 * normalizan para que el golden sea reproducible.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { buildDashboard } from "../../../src/http-dashboard.js";
import { MarketAccountService } from "../../../src/market-accounts.js";
import { PaymentSmsService } from "../../../src/payment-sms.js";
import { Store } from "../../../src/store.js";
import { Vault } from "../../../src/vault.js";
import type { HttpScenario, HttpScenarioContext } from "../../../lib/http/scenario.js";

const password = "contraseña-local-segura-2026";
const origin = "http://127.0.0.1:3000";
const NOW = 1_788_744_000_000;

interface Login {
  cookie: string;
  csrf: string;
  headers: { origin: string; cookie: string; "content-type": string; "x-csrf-token": string };
}

async function login(app: FastifyInstance, ctx: HttpScenarioContext, headerOrigin = origin): Promise<Login> {
  const response = await ctx.call(app, {
    method: "POST",
    url: "/api/session",
    headers: { origin: headerOrigin, "content-type": "application/json" },
    payload: { password },
  });
  const cookie = String(response.headers["set-cookie"]).split(";", 1)[0]!;
  const csrf = response.json<{ data: { csrfToken: string } }>().data.csrfToken;
  return {
    cookie,
    csrf,
    headers: { origin: headerOrigin, cookie, "content-type": "application/json", "x-csrf-token": csrf },
  };
}

function state<T>(app: FastifyInstance, value: T): FastifyInstance {
  (app as unknown as { __state: T }).__state = value;
  return app;
}

function getState<T>(app: FastifyInstance): T {
  return (app as unknown as { __state: T }).__state;
}

const scenarios: HttpScenario[] = [
  {
    id: "http-dashboard/01-session-origin-csrf",
    file: "test/http-dashboard.test.ts",
    source: "test/http-dashboard.test.ts:16",
    build() {
      const controls: boolean[] = [];
      const app = buildDashboard({ setPaused: async (value: boolean) => void controls.push(value) } as never, {
        password,
        trustedOrigin: origin,
      });
      return state(app, controls);
    },
    async run(app, ctx) {
      const controls = getState<boolean[]>(app);
      const anonymous = await ctx.call(app, { method: "GET", url: "/api/config" });
      assert.equal(anonymous.statusCode, 401);
      assert.equal(anonymous.headers["x-frame-options"], "DENY");
      const wrongOrigin = await ctx.call(app, {
        method: "POST",
        url: "/api/session",
        headers: { origin: "http://malicioso.example", "content-type": "application/json" },
        payload: { password },
      });
      assert.equal(wrongOrigin.statusCode, 403);
      const session = await login(app, ctx);
      assert.equal(
        (await ctx.call(app, {
          method: "PUT",
          url: "/api/control",
          headers: { origin, cookie: session.cookie, "content-type": "application/json" },
          payload: { paused: true },
        })).statusCode,
        403,
      );
      assert.equal(
        (await ctx.call(app, {
          method: "PUT",
          url: "/api/control",
          headers: session.headers,
          payload: { paused: true },
        })).statusCode,
        204,
      );
      assert.deepEqual(controls, [true]);
      assert.equal(
        (await ctx.call(app, {
          method: "PUT",
          url: "/api/control",
          headers: session.headers,
          payload: { mode: "simulation" },
        })).statusCode,
        400,
      );
      ctx.effect("controls", controls);
    },
  },
  {
    id: "http-dashboard/02-mobile-receipts-structured",
    file: "test/http-dashboard.test.ts",
    source: "test/http-dashboard.test.ts:75",
    build() {
      const stored: unknown[] = [];
      const app = buildDashboard(
        {
          pairSmsDevice: (label: string) => ({ device: { id: "device-1", label }, token: "a".repeat(43) }),
          receivePaymentReceipt: async (token: string, input: unknown) => {
            assert.equal(token, "a".repeat(43));
            stored.push(input);
            return { duplicate: false, receipt: { id: "receipt-1", state: "review" } };
          },
        } as never,
        { password, trustedOrigin: origin },
      );
      return state(app, stored);
    },
    async run(app, ctx) {
      const stored = getState<unknown[]>(app);
      assert.equal(
        (await ctx.call(app, {
          method: "POST",
          url: "/api/mobile/payment-receipts",
          headers: { "content-type": "application/json" },
          payload: {},
        })).statusCode,
        401,
      );
      assert.equal(
        (await ctx.call(app, {
          method: "POST",
          url: "/api/mobile/payment-receipts",
          headers: { authorization: `Bearer ${"a".repeat(43)}`, "content-type": "application/json" },
          payload: { sms: "texto íntegro del SMS" },
        })).statusCode,
        400,
      );
      const accepted = await ctx.call(app, {
        method: "POST",
        url: "/api/mobile/payment-receipts",
        headers: { authorization: `Bearer ${"a".repeat(43)}`, "content-type": "application/json" },
        payload: {
          bank: "BPA",
          sender: "BPA",
          currency: "CUP",
          amount: 100,
          beneficiaryMasked: "1234****5678",
          transactionId: "TX-1",
          receivedAt: Date.now(),
        },
      });
      assert.equal(accepted.statusCode, 202);
      assert.equal(accepted.json<{ status: string }>().status, "review");
      assert.equal(stored.length, 1);
      assert.equal((await ctx.call(app, { method: "GET", url: "/api/mobile/payment-receipts" })).statusCode, 401);
      ctx.effect("stored", stored);
    },
  },
  {
    id: "http-dashboard/03-device-check-revocation",
    file: "test/http-dashboard.test.ts",
    source: "test/http-dashboard.test.ts:108",
    build() {
      const store = new Store(mkdtempSync(join(tmpdir(), "qvaapply-http-device-check-")));
      const service = new PaymentSmsService(store, {} as never, { markPaid: async () => undefined }, () => "CUP");
      const paired = service.pairDevice("Android de prueba");
      const app = buildDashboard(
        { checkSmsDevice: (token: string) => service.checkDevice(token) } as never,
        { password, trustedOrigin: origin },
      );
      app.addHook("onClose", async () => store.close());
      return state(app, { paired, service });
    },
    async run(app, ctx) {
      const { paired, service } = getState<{
        paired: { token: string; device: { id: string } };
        service: PaymentSmsService;
      }>(app);
      const valid = await ctx.call(app, {
        method: "GET",
        url: "/api/mobile/device-check",
        headers: { authorization: `Bearer ${paired.token}` },
      });
      assert.equal(valid.statusCode, 200);
      assert.deepEqual(valid.json(), { ok: true });
      assert.equal(
        (await ctx.call(app, {
          method: "GET",
          url: "/api/mobile/device-check",
          headers: { authorization: `Bearer ${"b".repeat(43)}` },
        })).statusCode,
        401,
      );
      service.revokeDevice(paired.device.id);
      assert.equal(
        (await ctx.call(app, {
          method: "GET",
          url: "/api/mobile/device-check",
          headers: { authorization: `Bearer ${paired.token}` },
        })).statusCode,
        401,
      );
      assert.equal((await ctx.call(app, { method: "GET", url: "/api/mobile/devices" })).statusCode, 401);
      assert.equal((await ctx.call(app, { method: "GET", url: "/api/mobile/device-check/extra" })).statusCode, 401);
    },
  },
  {
    id: "http-dashboard/04-operational-logs",
    file: "test/http-dashboard.test.ts",
    source: "test/http-dashboard.test.ts:144",
    build() {
      const calls: unknown[] = [];
      const app = buildDashboard(
        {
          operationalLogs: (options: unknown) => {
            calls.push(options);
            return { items: [], hasMore: false, newestId: 0 };
          },
        } as never,
        { password, trustedOrigin: origin },
      );
      return state(app, calls);
    },
    async run(app, ctx) {
      const calls = getState<unknown[]>(app);
      assert.equal((await ctx.call(app, { method: "GET", url: "/api/logs" })).statusCode, 401);
      const session = await login(app, ctx);
      const listed = await ctx.call(app, {
        method: "GET",
        url: "/api/logs?after=7&limit=80&level=error&component=qvapay&query=fiat&since=3600000",
        headers: { cookie: session.cookie },
      });
      assert.equal(listed.statusCode, 200);
      assert.deepEqual(calls, [
        { after: 7, limit: 80, level: "error", component: "qvapay", query: "fiat", since: 3_600_000 },
      ]);
      assert.equal(
        (await ctx.call(app, {
          method: "GET",
          url: "/api/logs?level=critical&limit=9999",
          headers: { cookie: session.cookie },
        })).statusCode,
        400,
      );
      ctx.effect("operationalLogs.calls", calls);
    },
  },
  {
    id: "http-dashboard/05-market-readers-no-token",
    file: "test/http-dashboard.test.ts",
    source: "test/http-dashboard.test.ts:191",
    build() {
      const store = new Store(mkdtempSync(join(tmpdir(), "qvaapply-http-readers-")));
      const accounts = new MarketAccountService(store, new Vault("a".repeat(64)), () => ({
        listOffersPage: async () => ({ offers: [], total: 0, currentPage: 1, perPage: 1 }),
      }));
      const source = {
        status: () => ({
          mode: "polling" as const,
          accounts: [],
          healthyAccounts: 1,
          effectiveCadenceSeconds: 3,
          estimatedRequestsPerMinute: 20,
        }),
      };
      const app = buildDashboard({} as never, { password, trustedOrigin: origin }, undefined, accounts, source);
      app.addHook("onClose", async () => store.close());
      return app;
    },
    async run(app, ctx) {
      const session = await login(app, ctx);
      const created = await ctx.call(app, {
        method: "POST",
        url: "/api/market-readers",
        headers: session.headers,
        payload: { label: "Observadora web", token: "reader-token-from-browser", intervalSeconds: 3 },
      });
      assert.equal(created.statusCode, 201);
      assert.doesNotMatch(created.body, /reader-token|encryptedToken|fingerprint/);
      const id = created.json<{ data: { id: string } }>().data.id;
      const listed = await ctx.call(app, { method: "GET", url: "/api/market-source", headers: { cookie: session.cookie } });
      assert.equal(listed.statusCode, 200);
      assert.equal(listed.json<{ data: { readers: unknown[] } }>().data.readers.length, 1);
      assert.doesNotMatch(listed.body, /reader-token|encryptedToken|fingerprint/);
      const disabled = await ctx.call(app, {
        method: "PUT",
        url: `/api/market-readers/${id}`,
        headers: session.headers,
        payload: { enabled: false },
      });
      assert.equal(disabled.statusCode, 200);
      assert.equal(disabled.json<{ data: { enabled: boolean } }>().data.enabled, false);
      const rotated = await ctx.call(app, {
        method: "PUT",
        url: `/api/market-readers/${id}/token`,
        headers: session.headers,
        payload: { token: "reader-token-rotated-safely" },
      });
      assert.equal(rotated.statusCode, 200);
      assert.doesNotMatch(rotated.body, /rotated-safely/);
      assert.equal(
        (await ctx.call(app, {
          method: "DELETE",
          url: `/api/market-readers/${id}`,
          headers: session.headers,
          payload: {},
        })).statusCode,
        204,
      );
    },
  },
  {
    id: "http-dashboard/06-visual-identity-public-only",
    file: "test/http-dashboard.test.ts",
    source: "test/http-dashboard.test.ts:285",
    build() {
      const assetName = "cachetestfixture.js";
      const assetDirectory = join(process.cwd(), "public", "dashboard");
      const assetPath = join(assetDirectory, assetName);
      mkdirSync(assetDirectory, { recursive: true });
      writeFileSync(assetPath, "export const cacheFixture = true;\n");
      const app = buildDashboard({} as never, { password, trustedOrigin: origin });
      app.addHook("onClose", async () => {
        try {
          unlinkSync(assetPath);
        } catch {
          // el archivo puede haberse eliminado en una ejecución previa
        }
      });
      return state(app, assetName);
    },
    async run(app, ctx) {
      const assetName = getState<string>(app);
      const page = await ctx.call(app, { method: "GET", url: "/" });
      assert.match(page.body, /href="\/logo\/encuentro-preciso-favicon\.svg"/);
      assert.match(page.body, /src="\/logo\/encuentro-preciso-horizontal\.svg"/);
      assert.match(page.body, /src="\/auth\/login\.js"/);
      assert.doesNotMatch(page.body, /src="\/dashboard\/app\.js"/);
      assert.doesNotMatch(page.body, /fonts\.(?:googleapis|gstatic)\.com/);
      const icon = await ctx.call(app, { method: "GET", url: "/icons/qusd.png" });
      assert.equal(icon.statusCode, 200);
      assert.match(String(icon.headers["content-type"]), /image\/png/);
      assert.match(String(icon.headers["cache-control"]), /public, max-age=86400/);
      const logo = await ctx.call(app, { method: "GET", url: "/logo/logotipo.webp" });
      assert.equal(logo.statusCode, 200);
      assert.match(String(logo.headers["content-type"]), /image\/webp/);
      assert.match(String(logo.headers["cache-control"]), /public, max-age=86400/);
      for (const [asset, mime] of [
        ["encuentro-preciso-horizontal.svg", "image/svg+xml"],
        ["encuentro-preciso-horizontal-inverse.svg", "image/svg+xml"],
        ["encuentro-preciso-icon-180.png", "image/png"],
        ["brand.css", "text/css"],
      ]) {
        const response = await ctx.call(app, { method: "GET", url: `/logo/${asset}` });
        assert.equal(response.statusCode, 200);
        assert.ok(String(response.headers["content-type"]).startsWith(mime!));
      }
      assert.equal((await ctx.call(app, { method: "GET", url: "/logo/%2e%2e%2fpackage.json" })).statusCode, 404);
      assert.equal((await ctx.call(app, { method: "GET", url: "/images/signin-picture.webp" })).statusCode, 404);
      const appScript = await ctx.call(app, { method: "GET", url: `/dashboard/${assetName}` });
      assert.equal(appScript.headers["cache-control"], "public, no-cache, must-revalidate");
      assert.equal(
        (await ctx.call(app, {
          method: "GET",
          url: `/dashboard/${assetName}`,
          headers: { "if-none-match": String(appScript.headers.etag) },
        })).statusCode,
        304,
      );
      assert.equal((await ctx.call(app, { method: "GET", url: "/icons/%2e%2e%2fpackage.json" })).statusCode, 404);
      assert.equal((await ctx.call(app, { method: "GET", url: "/images/%2e%2e%2fpackage.json" })).statusCode, 404);
    },
  },
  {
    id: "http-dashboard/07-authenticated-document-bootstrap",
    file: "test/http-dashboard.test.ts",
    source: "test/http-dashboard.test.ts:335",
    build() {
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
      return state(app, { get localReads() { return localReads; }, config, snapshot });
    },
    async run(app, ctx) {
      const data = getState<{ localReads: number; config: unknown; snapshot: unknown }>(app);
      const session = await login(app, ctx);
      const page = await ctx.call(app, { method: "GET", url: "/", headers: { cookie: session.cookie } });
      assert.equal(page.statusCode, 200);
      assert.equal(page.headers["cache-control"], "no-store");
      assert.equal(page.headers.vary, "Cookie");
      assert.equal(data.localReads, 1);
      assert.doesNotMatch(page.body, /<script>alert\('no'\)<\/script>/);
      const encoded = page.body.match(/<template id="qvaapply-bootstrap">([^]*?)<\/template>/)?.[1];
      assert.ok(encoded);
      const bootstrap = JSON.parse(encoded) as {
        session: { authenticated: boolean; csrfToken: string };
        dashboard: typeof data.snapshot;
        config: typeof data.config;
        configRevisions: { id: string }[];
      };
      assert.equal(bootstrap.session.authenticated, true);
      assert.deepEqual(bootstrap.dashboard, data.snapshot);
      assert.deepEqual(bootstrap.config, data.config);
      assert.deepEqual(bootstrap.configRevisions, [{ id: "revision-1" }]);
      ctx.value("localReads", data.localReads);
    },
  },
  {
    id: "http-dashboard/08-public-document-no-ops",
    file: "test/http-dashboard.test.ts",
    source: "test/http-dashboard.test.ts:389",
    build() {
      return buildDashboard(
        {
          localSnapshot: () => {
            throw new Error("Un visitante anónimo no debe leer el snapshot.");
          },
        } as never,
        { password, trustedOrigin: origin },
      );
    },
    async run(app, ctx) {
      const page = await ctx.call(app, { method: "GET", url: "/" });
      assert.doesNotMatch(page.body, /qvaapply-bootstrap|csrfToken|dashboard\/app\.js/);
      assert.match(page.body, /id="login-form"/);
      const loginScript = await ctx.call(app, { method: "GET", url: "/auth/login.js" });
      assert.equal(loginScript.statusCode, 200);
      assert.ok(loginScript.body.length < 2_000);
    },
  },
  {
    id: "http-dashboard/09-market-icon-upload",
    file: "test/http-dashboard.test.ts",
    source: "test/http-dashboard.test.ts:407",
    build() {
      const uploads: unknown[] = [];
      const app = buildDashboard(
        {
          saveMarketIcon: (input: unknown) => {
            uploads.push(input);
            return { url: "/market-icons/hash.png" };
          },
        } as never,
        { password, trustedOrigin: origin },
      );
      return state(app, uploads);
    },
    async run(app, ctx) {
      const uploads = getState<unknown[]>(app);
      const session = await login(app, ctx);
      const response = await ctx.call(app, {
        method: "POST",
        url: "/api/market-icons",
        headers: session.headers,
        payload: { name: "etecsa.png", mimeType: "image/png", base64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB" },
      });
      assert.equal(response.statusCode, 201);
      assert.equal(response.json<{ data: { url: string } }>().data.url, "/market-icons/hash.png");
      assert.equal(uploads.length, 1);
      ctx.effect("uploads", uploads);
    },
  },
  {
    id: "http-dashboard/10-invalid-body-before-domain",
    file: "test/http-dashboard.test.ts",
    source: "test/http-dashboard.test.ts:440",
    build() {
      return buildDashboard({} as never, { password, trustedOrigin: origin });
    },
    async run(app, ctx) {
      const session = await login(app, ctx);
      assert.equal(
        (await ctx.call(app, {
          method: "POST",
          url: "/api/offers",
          headers: session.headers,
          payload: { coin: "BANK_CUP", type: "sell", amount: -1, rate: 900 },
        })).statusCode,
        400,
      );
    },
  },
  {
    id: "http-dashboard/11-cooperative-contributions",
    file: "test/http-dashboard.test.ts",
    source: "test/http-dashboard.test.ts:460",
    build() {
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
      return state(app, {
        published,
        withdrawn,
        get reconciliations() {
          return reconciliations;
        },
      });
    },
    async run(app, ctx) {
      const data = getState<{
        published: unknown[];
        withdrawn: string[];
        reconciliations: number;
      }>(app);
      const session = await login(app, ctx);
      assert.equal(
        (await ctx.call(app, {
          method: "PUT",
          url: "/api/cooperative-network/contributions",
          headers: session.headers,
          payload: { coin: "BANK_CUP", minimal: 100, price: 0 },
        })).statusCode,
        400,
      );
      assert.equal(
        (await ctx.call(app, {
          method: "PUT",
          url: "/api/cooperative-network/contributions",
          headers: session.headers,
          payload: { coin: "BANK_CUP", fiat: 999_999, minimal: 1_000, price: 390 },
        })).statusCode,
        204,
      );
      assert.deepEqual(data.published, [{ coin: "BANK_CUP", minimal: 1_000, price: 390 }]);
      assert.equal(
        (await ctx.call(app, {
          method: "DELETE",
          url: "/api/cooperative-network/contributions/BANK_CUP",
          headers: session.headers,
          payload: {},
        })).statusCode,
        204,
      );
      assert.deepEqual(data.withdrawn, ["BANK_CUP"]);
      assert.equal(
        (await ctx.call(app, {
          method: "POST",
          url: "/api/cooperative-network/reconcile",
          headers: session.headers,
          payload: {},
        })).statusCode,
        204,
      );
      assert.equal(data.reconciliations, 1);
      assert.equal(
        (await ctx.call(app, {
          method: "POST",
          url: "/api/cooperative-network/perform",
          headers: session.headers,
          payload: { externalId: "unsafe" },
        })).statusCode,
        404,
      );
      ctx.effect("published", data.published);
      ctx.effect("withdrawn", data.withdrawn);
      ctx.value("reconciliations", data.reconciliations);
    },
  },
  {
    id: "http-dashboard/12-budget-rebalance-preview",
    file: "test/http-dashboard.test.ts",
    source: "test/http-dashboard.test.ts:534",
    build() {
      const calls: unknown[] = [];
      const job = { id: "rebalance-1", state: "pending", adjustments: [], createdAt: 1, updatedAt: 1 };
      const preview = { plans: [{ coin: "CLASICA", deficit: 2.5, adjustments: [] }], updatedAt: 123 };
      const app = buildDashboard(
        {
          budgetRebalancePreview: () => preview,
          refreshBudgetRebalancePreview: async () => ({ ...preview, updatedAt: 456 }),
          startBudgetRebalance: (adjustments: unknown) => {
            calls.push(adjustments);
            return job;
          },
          rebalanceJob: (id: string) => (id === job.id ? job : undefined),
        } as never,
        { password, trustedOrigin: origin },
      );
      return state(app, calls);
    },
    async run(app, ctx) {
      const calls = getState<unknown[]>(app);
      const session = await login(app, ctx);
      const cachedPreview = await ctx.call(app, {
        method: "POST",
        url: "/api/offers/rebalance/preview",
        headers: session.headers,
        payload: {},
      });
      assert.equal(cachedPreview.statusCode, 200);
      assert.equal(
        cachedPreview.json<{ data: { plans: { coin: string }[]; updatedAt: number } }>().data.plans[0]!.coin,
        "CLASICA",
      );
      assert.equal(cachedPreview.json<{ data: { updatedAt: number } }>().data.updatedAt, 123);
      const refreshedPreview = await ctx.call(app, {
        method: "POST",
        url: "/api/offers/rebalance/preview",
        headers: session.headers,
        payload: { refresh: true },
      });
      assert.equal(refreshedPreview.statusCode, 200);
      assert.equal(refreshedPreview.json<{ data: { updatedAt: number } }>().data.updatedAt, 456);
      assert.equal(
        (await ctx.call(app, {
          method: "POST",
          url: "/api/offers/rebalance/apply",
          headers: session.headers,
          payload: { adjustments: [{ uuid: "offer-1", amount: 8.25 }] },
        })).statusCode,
        202,
      );
      assert.deepEqual(calls, [[{ uuid: "offer-1", amount: 8.25 }]]);
      const progress = await ctx.call(app, {
        method: "GET",
        url: "/api/offers/rebalance/rebalance-1",
        headers: { cookie: session.cookie },
      });
      assert.equal(progress.statusCode, 200);
      assert.equal(progress.json<{ data: { id: string } }>().data.id, "rebalance-1");
      ctx.effect("rebalance.calls", calls);
    },
  },
  {
    id: "http-dashboard/13-hunting-controls",
    file: "test/http-dashboard.test.ts",
    source: "test/http-dashboard.test.ts:576",
    build() {
      const updates: unknown[] = [];
      const app = buildDashboard({ updateHunting: (value: unknown) => updates.push(value) } as never, {
        password,
        trustedOrigin: origin,
      });
      return state(app, updates);
    },
    async run(app, ctx) {
      const updates = getState<unknown[]>(app);
      const session = await login(app, ctx);
      const response = await ctx.call(app, {
        method: "PUT",
        url: "/api/hunting",
        headers: session.headers,
        payload: { market: { code: "BANDECPREPAGO", huntSellEnabled: false, sellMinRate: 1.13 } },
      });
      assert.equal(response.statusCode, 204);
      assert.deepEqual(updates, [{ market: { code: "BANDECPREPAGO", huntSellEnabled: false, sellMinRate: 1.13 } }]);
      ctx.effect("hunting.updates", updates);
    },
  },
  {
    id: "http-dashboard/14-blocked-offers-confirmation",
    file: "test/http-dashboard.test.ts",
    source: "test/http-dashboard.test.ts:599",
    build() {
      const calls: string[] = [];
      const app = buildDashboard(
        {
          previewBlockedOffer: async (uuid: string) => ({ uuid, rate: 1_010 }),
          applyBlockedOffer: async (uuid: string) => {
            calls.push(`apply:${uuid}`);
            return "confirmada";
          },
          dismissBlockedOffer: (uuid: string) => void calls.push(`dismiss:${uuid}`),
        } as never,
        { password, trustedOrigin: origin },
      );
      return state(app, calls);
    },
    async run(app, ctx) {
      const calls = getState<string[]>(app);
      const session = await login(app, ctx);
      const preview = await ctx.call(app, {
        method: "POST",
        url: "/api/blocked-offers/blocked-1/preview",
        headers: session.headers,
        payload: {},
      });
      assert.equal(preview.statusCode, 200);
      assert.equal(preview.json<{ data: { uuid: string } }>().data.uuid, "blocked-1");
      assert.equal(
        (await ctx.call(app, {
          method: "POST",
          url: "/api/blocked-offers/blocked-1/apply",
          headers: session.headers,
          payload: { overridePriceGuard: false },
        })).statusCode,
        400,
      );
      assert.equal(
        (await ctx.call(app, {
          method: "POST",
          url: "/api/blocked-offers/blocked-1/apply",
          headers: session.headers,
          payload: { overridePriceGuard: true },
        })).statusCode,
        200,
      );
      assert.equal(
        (await ctx.call(app, {
          method: "POST",
          url: "/api/blocked-offers/blocked-2/dismiss",
          headers: session.headers,
          payload: {},
        })).statusCode,
        204,
      );
      assert.deepEqual(calls, ["apply:blocked-1", "dismiss:blocked-2"]);
      ctx.effect("blocked.calls", calls);
    },
  },
  {
    id: "http-dashboard/15-localhost-login",
    file: "test/http-dashboard.test.ts",
    source: "test/http-dashboard.test.ts:625",
    build() {
      return buildDashboard({} as never, { password, trustedOrigin: origin });
    },
    async run(app, ctx) {
      const response = await ctx.call(app, {
        method: "POST",
        url: "/api/session",
        headers: { origin: "http://localhost:3000", "content-type": "application/json" },
        payload: { password },
      });
      assert.equal(response.statusCode, 201);
      assert.match(String(response.headers["set-cookie"]), /HttpOnly; SameSite=Strict/);
    },
  },
  {
    id: "http-dashboard/16-domain-rejection-safe",
    file: "test/http-dashboard.test.ts",
    source: "test/http-dashboard.test.ts:639",
    build() {
      return buildDashboard(
        {
          setPaused: async () => {
            throw new Error("QvaPay no tiene una sesión válida.");
          },
        } as never,
        { password, trustedOrigin: origin },
      );
    },
    async run(app, ctx) {
      const session = await login(app, ctx);
      const response = await ctx.call(app, {
        method: "PUT",
        url: "/api/control",
        headers: session.headers,
        payload: { paused: false },
      });
      assert.equal(response.statusCode, 400);
      assert.equal(response.json<{ error: string }>().error, "QvaPay no tiene una sesión válida.");
    },
  },
  {
    id: "http-dashboard/17-internal-failure-not-exposed",
    file: "test/http-dashboard.test.ts",
    source: "test/http-dashboard.test.ts:666",
    build() {
      return buildDashboard(
        {
          setPaused: async () => {
            throw new TypeError("No se pudo leer /srv/qvaapply/secreto interno");
          },
        } as never,
        { password, trustedOrigin: origin },
      );
    },
    async run(app, ctx) {
      const session = await login(app, ctx);
      const response = await ctx.call(app, {
        method: "PUT",
        url: "/api/control",
        headers: session.headers,
        payload: { paused: false },
      });
      assert.equal(response.statusCode, 500);
      assert.deepEqual(response.json(), { error: "No se pudo completar la solicitud." });
      assert.doesNotMatch(response.body, /srv|secreto|TypeError/);
    },
  },
  {
    id: "http-dashboard/18-emergency-stop-atomic",
    file: "test/http-dashboard.test.ts",
    source: "test/http-dashboard.test.ts:696",
    build() {
      const mutations = { value: 0 };
      const app = buildDashboard(
        {
          setEmergencyStop: () => void (mutations.value += 1),
          setPaused: async () => void (mutations.value += 1),
        } as never,
        { password, trustedOrigin: origin },
      );
      return state(app, mutations);
    },
    async run(app, ctx) {
      const mutations = getState<{ value: number }>(app);
      const session = await login(app, ctx);
      const response = await ctx.call(app, {
        method: "PUT",
        url: "/api/control",
        headers: session.headers,
        payload: { emergencyStop: true, paused: false },
      });
      assert.equal(response.statusCode, 400);
      assert.equal(mutations.value, 0);
      ctx.value("mutations", mutations.value);
    },
  },
  {
    id: "http-dashboard/19-dashboard-startup-sqlite-only",
    file: "test/http-dashboard.test.ts",
    source: "test/http-dashboard.test.ts:723",
    build() {
      let remoteCalls = 0;
      const app = buildDashboard(
        {
          localSnapshot: () => ({ generatedAt: 123, markets: [], freshness: {} }),
          snapshot: async () => {
            remoteCalls += 1;
            throw new Error("no debe ejecutarse");
          },
        } as never,
        { password, trustedOrigin: origin },
      );
      return state(app, { get remoteCalls() { return remoteCalls; } });
    },
    async run(app, ctx) {
      const data = getState<{ remoteCalls: number }>(app);
      const session = await login(app, ctx);
      const response = await ctx.call(app, {
        method: "GET",
        url: "/api/dashboard",
        headers: { cookie: session.cookie },
      });
      assert.equal(response.statusCode, 200);
      assert.equal(response.json<{ source: string }>().source, "sqlite");
      assert.equal(data.remoteCalls, 0);
      ctx.value("remoteCalls", data.remoteCalls);
    },
  },
  {
    id: "http-dashboard/20-remote-failure-keeps-sqlite",
    file: "test/http-dashboard.test.ts",
    source: "test/http-dashboard.test.ts:753",
    build() {
      const cachedAt = NOW - 60_000;
      const app = buildDashboard(
        {
          refreshBalance: async () => {
            throw new Error("conexión inestable");
          },
          localSnapshot: () => ({
            balance: 18.5,
            freshness: { balance: cachedAt, ownOffers: null, transactions: null, markets: {} },
          }),
        } as never,
        { password, trustedOrigin: origin },
      );
      return state(app, cachedAt);
    },
    async run(app, ctx) {
      const cachedAt = getState<number>(app);
      const session = await login(app, ctx);
      const response = await ctx.call(app, {
        method: "GET",
        url: "/api/live/balance",
        headers: { cookie: session.cookie },
      });
      const payload = response.json<{ data: number; updatedAt: number; stale: boolean; error: string }>();
      assert.equal(response.statusCode, 200);
      assert.equal(payload.data, 18.5);
      assert.equal(payload.updatedAt, cachedAt);
      assert.equal(payload.stale, true);
      assert.match(payload.error, /inestable/);
    },
  },
  {
    id: "http-dashboard/21-decision-events-csrf",
    file: "test/http-dashboard.test.ts",
    source: "test/http-dashboard.test.ts:798",
    build() {
      const dismissed: number[] = [];
      const app = buildDashboard(
        {
          decisionEvents: (options: unknown) => ({
            items: [],
            total: 0,
            pending: 0,
            page: 2,
            pageSize: 5,
            options,
          }),
          dismissDecisionEvent: (id: number) => void dismissed.push(id),
        } as never,
        { password, trustedOrigin: origin },
      );
      return state(app, dismissed);
    },
    async run(app, ctx) {
      const dismissed = getState<number[]>(app);
      const session = await login(app, ctx);
      const listed = await ctx.call(app, {
        method: "GET",
        url: "/api/decision-events?decision=blocked&status=pending&page=2&pageSize=5",
        headers: { cookie: session.cookie },
      });
      assert.equal(listed.statusCode, 200);
      assert.equal(listed.json<{ data: { page: number } }>().data.page, 2);
      assert.equal(
        (await ctx.call(app, {
          method: "POST",
          url: "/api/decision-events/7/dismiss",
          headers: { origin, cookie: session.cookie, "content-type": "application/json" },
          payload: {},
        })).statusCode,
        403,
      );
      assert.equal(
        (await ctx.call(app, {
          method: "POST",
          url: "/api/decision-events/7/dismiss",
          headers: session.headers,
          payload: {},
        })).statusCode,
        204,
      );
      assert.deepEqual(dismissed, [7]);
      ctx.effect("dismissed", dismissed);
    },
  },
  {
    id: "http-dashboard/22-notifications-ack",
    file: "test/http-dashboard.test.ts",
    source: "test/http-dashboard.test.ts:819",
    build() {
      const acknowledged: string[] = [];
      const app = buildDashboard(
        {
          notifications: () => [{ id: "operation-applied:one", type: "operation-applied" }],
          acknowledgeNotification: (id: string) => void acknowledged.push(id),
        } as never,
        { password, trustedOrigin: origin },
      );
      return state(app, acknowledged);
    },
    async run(app, ctx) {
      const acknowledged = getState<string[]>(app);
      const session = await login(app, ctx);
      const listed = await ctx.call(app, {
        method: "GET",
        url: "/api/notifications",
        headers: { cookie: session.cookie },
      });
      assert.equal(listed.statusCode, 200);
      assert.equal(listed.json<{ data: { id: string }[] }>().data[0]?.id, "operation-applied:one");
      assert.equal(
        (await ctx.call(app, {
          method: "POST",
          url: "/api/notifications/operation-applied%3Aone/ack",
          headers: session.headers,
          payload: {},
        })).statusCode,
        204,
      );
      assert.deepEqual(acknowledged, ["operation-applied:one"]);
      ctx.effect("acknowledged", acknowledged);
    },
  },
  {
    id: "http-dashboard/23-service-worker-identity",
    file: "test/http-dashboard.test.ts",
    source: "test/http-dashboard.test.ts:845",
    build() {
      return buildDashboard({} as never, { password, trustedOrigin: origin });
    },
    async run(app, ctx) {
      const worker = await ctx.call(app, { method: "GET", url: "/service-worker.js" });
      assert.equal(worker.statusCode, 200);
      assert.match(worker.body, /icon:\s*"\/logo\/encuentro-preciso-icon-192\.png"/);
      assert.match(worker.body, /requireInteraction:\s*payload\.type === "operation-applied"/);
    },
  },
  {
    id: "http-dashboard/24-cancel-empty-paid-reference",
    file: "test/http-dashboard.test.ts",
    source: "test/http-dashboard.test.ts:854",
    build() {
      const calls: string[] = [];
      const app = buildDashboard(
        {
          cancelOperation: async (uuid: string) => void calls.push(`cancel:${uuid}`),
          markPaid: async (uuid: string, reference: string) => void calls.push(`paid:${uuid}:${reference}`),
        } as never,
        { password, trustedOrigin: origin },
      );
      return state(app, calls);
    },
    async run(app, ctx) {
      const calls = getState<string[]>(app);
      const session = await login(app, ctx);
      const cancelled = await ctx.call(app, {
        method: "POST",
        url: "/api/operations/operation-1/cancel",
        headers: session.headers,
        payload: {},
      });
      const invalidPaid = await ctx.call(app, {
        method: "POST",
        url: "/api/operations/operation-2/paid",
        headers: session.headers,
        payload: {},
      });
      assert.equal(cancelled.statusCode, 204);
      assert.equal(invalidPaid.statusCode, 400);
      assert.deepEqual(calls, ["cancel:operation-1"]);
      ctx.effect("operations.calls", calls);
    },
  },
  {
    id: "http-dashboard/25-mobile-operator-scopes",
    file: "test/http-dashboard.test.ts",
    source: "test/http-dashboard.test.ts:875",
    build() {
      const actions: string[] = [];
      const readModel = {
        pairMobileOperator: (label: string) => ({
          operator: { id: "op-1", label, scopes: ["read", "actions"], createdAt: 1 },
          token: "b".repeat(48),
        }),
        checkMobileOperator: (token: string) =>
          token === "b".repeat(48) ? { ok: true, operatorId: "op-1", scopes: ["read", "actions"] } : { ok: false },
        mobileOperations: () => [
          {
            uuid: "u1",
            side: "buy",
            market: "BAND",
            marketLabel: "Bandec",
            currency: "CUP",
            amount: 2,
            receive: 100,
            rate: 50,
            status: "applied",
            createdAt: 1,
            actions: ["paid", "cancel"],
          },
        ],
        mobileAlerts: () => [{ id: "alert-1", type: "operation-applied", message: "Nueva operación", createdAt: 1 }],
        mobileMarkets: () => [{ code: "BAND", label: "Bandec", currency: "CUP" }],
        mobileReceiptOutcomes: () => [{ id: "receipt-1", status: "matched", receivedAt: 1, operationUuid: "u1" }],
        markPaid: async (uuid: string, reference: string) => void actions.push(`paid:${uuid}:${reference}`),
        confirmReceived: async (uuid: string) => void actions.push(`received:${uuid}`),
        cancelOperation: async (uuid: string) => void actions.push(`cancel:${uuid}`),
        mobileOperationAction: async (_operatorId: string, uuid: string, action: string, reference?: string) => {
          if (action === "paid") await readModel.markPaid(uuid, reference!);
          else if (action === "received") await readModel.confirmReceived(uuid);
          else await readModel.cancelOperation(uuid);
        },
      };
      const app = buildDashboard(readModel as never, { password, trustedOrigin: origin });
      return state(app, actions);
    },
    async run(app, ctx) {
      const actions = getState<string[]>(app);
      const session = await login(app, ctx);
      assert.equal(
        (await ctx.call(app, {
          method: "POST",
          url: "/api/mobile/operators",
          headers: session.headers,
          payload: { label: "Android" },
        })).statusCode,
        201,
      );
      const bearer = { authorization: `Bearer ${"b".repeat(48)}`, "content-type": "application/json" };
      for (const url of ["/api/mobile/operations", "/api/mobile/alerts", "/api/mobile/markets", "/api/mobile/receipt-outcomes"]) {
        assert.equal((await ctx.call(app, { method: "GET", url, headers: bearer })).statusCode, 200);
      }
      assert.equal(
        (await ctx.call(app, {
          method: "POST",
          url: "/api/mobile/operations/u1/cancel",
          headers: { ...bearer, cookie: session.cookie, origin },
          payload: {},
        })).statusCode,
        403,
      );
      assert.equal(
        (await ctx.call(app, {
          method: "POST",
          url: "/api/mobile/operations/u1/paid",
          headers: bearer,
          payload: { reference: "REF-1" },
        })).statusCode,
        204,
      );
      assert.equal(
        (await ctx.call(app, { method: "POST", url: "/api/mobile/operations/u1/cancel", headers: bearer, payload: {} }))
          .statusCode,
        204,
      );
      assert.deepEqual(actions, ["paid:u1:REF-1", "cancel:u1"]);
      assert.equal((await ctx.call(app, { method: "GET", url: "/api/mobile/operations" })).statusCode, 401);
      ctx.effect("mobile.actions", actions);
    },
  },
  {
    id: "http-dashboard/26-web-push-session-csrf",
    file: "test/http-dashboard.test.ts",
    source: "test/http-dashboard.test.ts:912",
    build() {
      const subscriptions: string[] = [];
      const push = {
        publicKey: () => "public-key",
        subscribe: (value: { endpoint: string }) => {
          subscriptions.push(value.endpoint);
          return value;
        },
        unsubscribe: (endpoint: string) => {
          subscriptions.splice(subscriptions.indexOf(endpoint), 1);
          return true;
        },
      };
      const app = buildDashboard({} as never, { password, trustedOrigin: origin }, push as never);
      return state(app, subscriptions);
    },
    async run(app, ctx) {
      const subscriptions = getState<string[]>(app);
      const session = await login(app, ctx);
      assert.equal(
        (await ctx.call(app, { method: "GET", url: "/api/push/public-key", headers: { cookie: session.cookie } }))
          .statusCode,
        200,
      );
      const body = {
        endpoint: "https://push.example/device",
        expirationTime: null,
        keys: { p256dh: "key", auth: "auth" },
      };
      assert.equal(
        (await ctx.call(app, {
          method: "POST",
          url: "/api/push/subscriptions",
          headers: session.headers,
          payload: body,
        })).statusCode,
        201,
      );
      assert.equal(
        (await ctx.call(app, {
          method: "DELETE",
          url: "/api/push/subscriptions",
          headers: session.headers,
          payload: { endpoint: body.endpoint },
        })).statusCode,
        204,
      );
      assert.deepEqual(subscriptions, []);
      ctx.effect("push.subscriptions", subscriptions);
    },
  },
];

export { scenarios };
