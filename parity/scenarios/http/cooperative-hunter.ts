/**
 * Escenarios HTTP: `test/cooperative-hunter-http.test.ts`.
 */
import assert from "node:assert/strict";
import { buildDashboard } from "../../../src/http-dashboard.js";
import type { HttpScenario } from "../../../lib/http/scenario.js";

const origin = "http://127.0.0.1:3000";

const scenarios: HttpScenario[] = [
  {
    id: "cooperative-hunter/01-session-csrf-confirmation",
    file: "test/cooperative-hunter-http.test.ts",
    source: "test/cooperative-hunter-http.test.ts:5",
    build() {
      const calls: string[] = [];
      const app = buildDashboard(
        {
          setCooperativeHunting: (enabled: boolean) => {
            calls.push(`enabled:${enabled}`);
          },
          markCooperativeDistributed: (uuid: string) => {
            calls.push(`distributed:${uuid}`);
          },
          checkCooperativeHunting: async () => {
            calls.push("check");
          },
        } as never,
        { password: "cooperative-test-password-2026", trustedOrigin: origin },
      );
      (app as unknown as { __calls: string[] }).__calls = calls;
      return app;
    },
    async run(app, ctx) {
      const calls = (app as unknown as { __calls: string[] }).__calls;
      const url = "/api/cooperative-network/executions/group/distributed";
      assert.equal((await ctx.call(app, { method: "POST", url, payload: { confirmed: true } })).statusCode, 401);

      const login = await ctx.call(app, {
        method: "POST",
        url: "/api/session",
        headers: { origin },
        payload: { password: "cooperative-test-password-2026" },
      });
      const cookie = String(login.headers["set-cookie"]).split(";", 1)[0]!;
      assert.equal(
        (await ctx.call(app, { method: "POST", url, headers: { origin, cookie }, payload: { confirmed: true } })).statusCode,
        403,
      );

      const headers = { origin, cookie, "x-csrf-token": login.json().data.csrfToken };
      assert.equal((await ctx.call(app, { method: "POST", url, headers, payload: { confirmed: false } })).statusCode, 400);
      assert.equal((await ctx.call(app, { method: "POST", url, headers, payload: { confirmed: true } })).statusCode, 204);
      assert.equal(
        (await ctx.call(app, { method: "PUT", url: "/api/cooperative-network/hunting", headers, payload: { enabled: false } }))
          .statusCode,
        204,
      );
      assert.deepEqual(calls, ["distributed:group", "enabled:false"]);
      ctx.effect("cooperative.calls", calls);
    },
  },
];

export { scenarios };
