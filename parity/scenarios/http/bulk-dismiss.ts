/**
 * Escenarios HTTP: `test/bulk-dismiss-http.test.ts`.
 */
import assert from "node:assert/strict";
import { buildDashboard } from "../../../src/http-dashboard.js";
import type { HttpScenario } from "../../../lib/http/scenario.js";

const origin = "http://127.0.0.1:3000";

const scenarios: HttpScenario[] = [
  {
    id: "bulk-dismiss/01-session-csrf-cursor",
    file: "test/bulk-dismiss-http.test.ts",
    source: "test/bulk-dismiss-http.test.ts:5",
    build() {
      const calls: number[] = [];
      const app = buildDashboard(
        {
          dismissAllDecisionEvents: (throughId: number) => {
            calls.push(throughId);
            return { dismissed: 45 };
          },
        } as never,
        { password: "test-password-strong-2026", trustedOrigin: origin },
      );
      (app as unknown as { __calls: number[] }).__calls = calls;
      return app;
    },
    async run(app, ctx) {
      const calls = (app as unknown as { __calls: number[] }).__calls;
      const url = "/api/decision-events/dismiss-all";
      assert.equal((await ctx.call(app, { method: "POST", url, payload: { throughId: 45 } })).statusCode, 401);

      const login = await ctx.call(app, {
        method: "POST",
        url: "/api/session",
        headers: { origin },
        payload: { password: "test-password-strong-2026" },
      });
      const cookie = String(login.headers["set-cookie"]).split(";", 1)[0]!;
      const csrf = login.json().data.csrfToken;

      assert.equal(
        (await ctx.call(app, { method: "POST", url, headers: { origin, cookie }, payload: { throughId: 45 } })).statusCode,
        403,
      );

      const headers = { origin, cookie, "x-csrf-token": csrf };
      for (const payload of [{}, { throughId: 0 }, { throughId: 1.5 }]) {
        assert.equal((await ctx.call(app, { method: "POST", url, headers, payload })).statusCode, 400);
      }

      const okay = await ctx.call(app, { method: "POST", url, headers, payload: { throughId: 45 } });
      assert.equal(okay.statusCode, 200);
      assert.deepEqual(okay.json().data, { dismissed: 45 });
      assert.deepEqual(calls, [45]);
      ctx.effect("dismissAllDecisionEvents.calls", calls);
    },
  },
];

export { scenarios };
