/**
 * Escenarios HTTP: `test/mobile-action-http-budget.test.ts`.
 */
import assert from "node:assert/strict";
import { buildDashboard } from "../../../src/http-dashboard.js";
import type { HttpScenario } from "../../../lib/http/scenario.js";

const token = "b".repeat(48);

const scenarios: HttpScenario[] = [
  {
    id: "mobile-action-budget/01-authorized-action-extends-budget",
    file: "test/mobile-action-http-budget.test.ts",
    source: "test/mobile-action-http-budget.test.ts:5",
    build() {
      const budgets: number[] = [];
      const actions: string[] = [];
      const model = {
        checkMobileOperator: (value: string) =>
          value === token ? { ok: true, operatorId: "phone", scopes: ["read", "actions"] } : { ok: false },
        mobileOperationAction: async (_operator: string, _uuid: string, action: string) => {
          actions.push(action);
        },
      };
      const app = buildDashboard(model as never, {
        password: "long-test-password-only",
        trustedOrigin: "http://127.0.0.1:3000",
      });
      app.addHook("onRequest", async (request) => {
        const socket = request.raw.socket;
        const original = socket.setTimeout;
        socket.setTimeout = (timeout, callback) => {
          budgets.push(timeout);
          return original ? original.call(socket, timeout, callback) : socket;
        };
      });
      Object.assign(app as unknown as Record<string, unknown>, { __budgets: budgets, __actions: actions });
      return app;
    },
    async run(app, ctx) {
      const { __budgets: budgets, __actions: actions } = app as unknown as {
        __budgets: number[];
        __actions: string[];
      };
      const headers = { authorization: `Bearer ${token}` };
      const path = "/api/mobile/operations/offer/paid";
      assert.equal((await ctx.call(app, { method: "POST", url: path, payload: { reference: "reference" } })).statusCode, 401);
      assert.equal((await ctx.call(app, { method: "POST", url: path, headers, payload: {} })).statusCode, 400);
      assert.deepEqual(budgets, []);
      assert.equal((await ctx.call(app, { method: "POST", url: path, headers, payload: { reference: "reference" } })).statusCode, 204);
      assert.deepEqual(budgets, [60_000]);
      assert.deepEqual(actions, ["paid"]);
      assert.equal(app.server.requestTimeout, 60_000);
      assert.equal(app.initialConfig.connectionTimeout, 10_000);
      ctx.value("budgets", budgets);
      ctx.value("actions", actions);
      ctx.value("requestTimeout", app.server.requestTimeout);
      ctx.value("connectionTimeout", app.initialConfig.connectionTimeout);
    },
  },
];

export { scenarios };
