/**
 * Escenarios HTTP: `test/mobile-tools.test.ts`.
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import { DashboardReadModel } from "../../../src/dashboard.js";
import { buildDashboard } from "../../../src/http-dashboard.js";
import { Store } from "../../../src/store.js";
import type { HttpScenario } from "../../../lib/http/scenario.js";

const origin = "http://127.0.0.1:3000";
const NOW = 1_788_744_000_000;

const scenarios: HttpScenario[] = [
  {
    id: "mobile-tools/01-overview-no-remote",
    file: "test/mobile-tools.test.ts",
    source: "test/mobile-tools.test.ts:7",
    build() {
      return Fastify();
    },
    async run(_app, ctx) {
      let remote = 0;
      const readModel = Object.assign(Object.create(DashboardReadModel.prototype), {
        trading: {
          operationalState: () => ({ paused: false, fiat: { CLASICA: 12 }, active: 2 }),
          strategy: () => ({ buyMax: { CLASICA: 1.05 }, sellMin: { CLASICA: 1.1 } }),
        },
        marketConfig: {
          current: () => ({
            hunting: { buyRunning: true, sellRunning: true },
            markets: [
              {
                code: "CLASICA",
                label: "Clásica",
                currency: "USD",
                active: true,
                buyMaxRate: 1,
                sellMinRate: 1.2,
                huntBuyEnabled: true,
                huntSellEnabled: false,
                outgoingTransferFee: 0.08,
                secret: "never-expose",
              },
            ],
          }),
        },
        store: {
          loadRemoteResource: (key: string) => {
            assert.equal(key, "balance");
            return { data: 4, updatedAt: 123 };
          },
        },
        qva: new Proxy(
          {},
          {
            get() {
              remote++;
              throw new Error("remote call forbidden");
            },
          },
        ),
      });
      const value = readModel.mobileOverview();
      assert.equal(remote, 0);
      assert.equal(value.balance, 4);
      assert.equal(value.balanceUpdatedAt, 123);
      assert.equal(value.markets[0]?.fiat, 12);
      assert.equal(value.markets[0]?.buyMaxRate, 1.05);
      assert.equal(value.markets[0]?.sellMinRate, 1.1);
      assert.equal(JSON.stringify(value).includes("secret"), false);
      ctx.value("remote", remote);
      ctx.value("overview", value);
    },
  },
  {
    id: "mobile-tools/02-scoped-bearer-bounds",
    file: "test/mobile-tools.test.ts",
    source: "test/mobile-tools.test.ts:27",
    build() {
      const token = "x".repeat(48);
      const calls: string[] = [];
      const model = {
        checkMobileOperator: (value: string, write: boolean) =>
          value === token ? { ok: true, operatorId: "phone", scopes: write ? [] : ["read"] } : { ok: false },
        mobileOverview: () => {
          calls.push("overview");
          return { balance: null };
        },
        mobileMarkets: () => [{ code: "CLASICA" }],
        operationalHealth: () => {
          calls.push("health");
          return { checks: [] };
        },
        mobileProfitability: (days: number) => {
          calls.push(`profit:${days}`);
          return { days, currencies: [], coverage: {}, limited: false };
        },
        fiatHistory: (coin: string, page: number) => {
          calls.push(`history:${coin}:${page}`);
          return { items: [] };
        },
        opportunityDiagnostics: async () => {
          calls.push("diagnostics");
          return {};
        },
        simulatePrices: async () => {
          calls.push("simulation");
          return { note: "local" };
        },
      };
      const app = buildDashboard(model as never, { password: "android-tools-tests-password", trustedOrigin: origin });
      (app as unknown as { __calls: string[] }).__calls = calls;
      (app as unknown as { __token: string }).__token = token;
      return app;
    },
    async run(app, ctx) {
      const calls = (app as unknown as { __calls: string[] }).__calls;
      const token = (app as unknown as { __token: string }).__token;
      const bearer = { authorization: `Bearer ${token}` };
      for (const url of ["/api/mobile/overview", "/api/mobile/insights?kind=health"]) {
        assert.equal((await ctx.call(app, { url })).statusCode, 401);
        assert.equal(
          (await ctx.call(app, { url, headers: { authorization: `Bearer ${"y".repeat(48)}` } })).statusCode,
          401,
        );
        assert.equal((await ctx.call(app, { url, headers: bearer })).statusCode, 200);
      }
      const profit = await ctx.call(app, { url: "/api/mobile/insights?kind=profitability&days=7", headers: bearer });
      assert.equal(profit.statusCode, 200);
      assert.equal(profit.json().data.portfolioHistory, undefined);
      assert.equal(profit.json().data.transactions, undefined);
      for (const url of [
        "/api/mobile/insights?kind=history&coin=CLASICA&page=2",
        "/api/mobile/insights?kind=diagnostics&coin=CLASICA",
      ]) {
        assert.equal((await ctx.call(app, { url, headers: bearer })).statusCode, 200);
      }
      for (const url of [
        "/api/mobile/insights?kind=history&coin=UNKNOWN",
        "/api/mobile/insights?kind=history",
        "/api/mobile/insights?kind=profitability&days=365",
        "/api/mobile/insights?kind=history&coin=CLASICA&page=1001",
        "/api/mobile/insights?kind=other",
      ]) {
        assert.equal((await ctx.call(app, { url, headers: bearer })).statusCode, 400);
      }
      assert.equal((await ctx.call(app, { url: "/api/config", headers: bearer })).statusCode, 401);
      assert.equal((await ctx.call(app, { url: "/api/mobile/overview/extra", headers: bearer })).statusCode, 401);
      const payload = { coin: "CLASICA", hours: 24, buyMaxRate: 1, sellMinRate: 1.1, maxQusd: 25 };
      assert.equal((await ctx.call(app, { method: "POST", url: "/api/mobile/simulate", payload })).statusCode, 401);
      assert.equal(
        (await ctx.call(app, { method: "POST", url: "/api/mobile/simulate", headers: bearer, payload: { ...payload, maxQusd: -1 } }))
          .statusCode,
        400,
      );
      assert.equal((await ctx.call(app, { method: "POST", url: "/api/mobile/simulate", headers: bearer, payload })).statusCode, 200);
      const login = await ctx.call(app, {
        method: "POST",
        url: "/api/session",
        headers: { origin },
        payload: { password: "android-tools-tests-password" },
      });
      const cookie = String(login.headers["set-cookie"]).split(";")[0]!;
      assert.equal(
        (await ctx.call(app, { method: "POST", url: "/api/mobile/simulate", headers: { ...bearer, cookie, origin }, payload }))
          .statusCode,
        403,
      );
      assert.deepEqual(calls, ["overview", "health", "profit:7", "history:CLASICA:2", "diagnostics", "simulation"]);
      ctx.effect("mobile.calls", calls);
    },
  },
  {
    id: "mobile-tools/03-archived-input-bounds",
    file: "test/mobile-tools.test.ts",
    source: "test/mobile-tools.test.ts:73",
    build() {
      const store = new Store(mkdtempSync(join(tmpdir(), "qva-mobile-tools-")));
      const offers = Array.from({ length: 1002 }, (_, index) => ({
        uuid: `offer-${index}`,
        coin: "CLASICA",
        amount: 1,
        receive: 1,
        side: "incoming" as const,
        completedAt: NOW - index * 1000,
      }));
      store.saveAnalyticsOffers("me", offers);
      store.saveAnalyticsOffers("other", [{ ...offers[0]!, uuid: "private-other" }]);
      store.saveAnalyticsTransactions(
        "me",
        Array.from({ length: 1002 }, (_, index) => ({
          uuid: `tx-${index}`,
          amount: 1,
          createdAt: NOW - index * 1000,
          updatedAt: NOW - index * 1000,
        })),
      );
      const app = Fastify();
      app.addHook("onClose", async () => store.close());
      (app as unknown as { __store: Store }).__store = store;
      return app;
    },
    async run(app, ctx) {
      const store = (app as unknown as { __store: Store }).__store;
      const input = store.mobileAnalyticsInputs("me", 0);
      assert.equal(input.offers.length, 1000);
      assert.equal(input.transactions.length, 1000);
      assert.equal(input.limited, true);
      assert.ok(input.offers.every((row) => row.uuid !== "private-other"));
      assert.ok(!input.offers.some((row) => row.uuid === "offer-1001"));
      assert.equal(store.analyticsOffers("me", 0).length, 1002);
      assert.equal(store.mobileAnalyticsInputs("empty", 0).limited, false);
      ctx.value("offers", input.offers.length);
      ctx.value("transactions", input.transactions.length);
      ctx.value("limited", input.limited);
      ctx.value("fullArchive", store.analyticsOffers("me", 0).length);
      ctx.value("emptyLimited", store.mobileAnalyticsInputs("empty", 0).limited);
    },
  },
];

export { scenarios };
