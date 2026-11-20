/**
 * Escenarios HTTP: `test/trading-analytics-http.test.ts`.
 *
 * Cada `test()` se convierte en un escenario que conserva sus aserciones y
 * registra las peticiones/efectos canónicos.
 */
import assert from "node:assert/strict";
import { buildDashboard } from "../../../src/http-dashboard.js";
import type { HttpScenario } from "../../../lib/http/scenario.js";

const scenarios: HttpScenario[] = [
  {
    id: "trading-analytics/01-auth-bounds",
    file: "test/trading-analytics-http.test.ts",
    source: "test/trading-analytics-http.test.ts:5",
    build() {
      const calls: number[] = [];
      const app = buildDashboard(
        {
          tradingAnalytics: (days: number) => {
            calls.push(days);
            return { volume: 12, days };
          },
        } as never,
        { password: "analytics-http-password-2026", trustedOrigin: "http://127.0.0.1:3000" },
      );
      (app as unknown as { __calls: number[] }).__calls = calls;
      return app;
    },
    async run(app, ctx) {
      const calls = (app as unknown as { __calls: number[] }).__calls;
      assert.equal((await ctx.call(app, { url: "/api/trading-analytics" })).statusCode, 401);
      const login = await ctx.call(app, {
        method: "POST",
        url: "/api/session",
        headers: { origin: "http://127.0.0.1:3000" },
        payload: { password: "analytics-http-password-2026" },
      });
      const headers = { cookie: String(login.headers["set-cookie"]).split(";", 1)[0]! };
      assert.equal((await ctx.call(app, { url: "/api/trading-analytics?days=365", headers })).statusCode, 400);
      assert.equal((await ctx.call(app, { url: "/api/trading-analytics?days=7&account=other", headers })).statusCode, 200);
      const result = await ctx.call(app, { url: "/api/trading-analytics?days=7", headers });
      assert.equal(result.statusCode, 200);
      assert.deepEqual(result.json(), { data: { volume: 12, days: 7 }, source: "sqlite" });
      assert.deepEqual(calls, [7, 7], "el filtro de cuenta externo se ignora y no llega al modelo");
      ctx.effect("tradingAnalytics.days", calls);
    },
  },
];

export { scenarios };
