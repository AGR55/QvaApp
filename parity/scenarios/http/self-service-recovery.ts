/**
 * Escenarios HTTP: `test/self-service-recovery-http.test.ts`.
 */
import assert from "node:assert/strict";
import { buildDashboard } from "../../../src/http-dashboard.js";
import { RecoveryConflictError } from "../../../src/self-service-recovery.js";
import type { HttpScenario } from "../../../lib/http/scenario.js";

const password = "recovery-http-password-2026";
const origin = "http://127.0.0.1:3000";

const scenarios: HttpScenario[] = [
  {
    id: "self-service-recovery/01-session-csrf-contracts",
    file: "test/self-service-recovery-http.test.ts",
    source: "test/self-service-recovery-http.test.ts:11",
    build() {
      const calls: unknown[] = [];
      const readModel = {
        recoveryItems: () => ({ items: [], blocked: true }),
        recordRecoveryEvidence: (id: string, evidence: string) => {
          calls.push({ id, evidence });
          return { saved: true };
        },
        acknowledgeRecoveryIntent: (id: string) => {
          calls.push({ acknowledged: id });
          return { acknowledged: true };
        },
        checkRecoveryIntent: async (intentId: string) => {
          calls.push({ check: intentId });
          return { intentId, outcome: "pending", state: "uncertain", checkedAt: 1, updatedAt: 1 };
        },
        resolveRecoveryIntent: (input: unknown) => {
          calls.push(input);
          return { intentId: "i-1", outcome: "not_applied", state: "reconciled", updatedAt: 2, actor: "admin_web", verifiedAt: 2 };
        },
      };
      const app = buildDashboard(readModel as never, { password, trustedOrigin: origin });
      (app as unknown as { __calls: unknown[] }).__calls = calls;
      return app;
    },
    async run(app, ctx) {
      const calls = (app as unknown as { __calls: unknown[] }).__calls;
      assert.equal((await ctx.call(app, { method: "GET", url: "/api/recovery" })).statusCode, 401);
      const login = await ctx.call(app, {
        method: "POST",
        url: "/api/session",
        headers: { origin, "content-type": "application/json" },
        payload: { password },
      });
      const cookie = String(login.headers["set-cookie"]).split(";", 1)[0]!;
      const csrf = login.json<{ data: { csrfToken: string } }>().data.csrfToken;
      const headers = { origin, cookie, "content-type": "application/json", "x-csrf-token": csrf };

      const list = await ctx.call(app, { method: "GET", url: "/api/recovery", headers: { cookie } });
      assert.equal(list.statusCode, 200);
      assert.deepEqual(list.json<{ data: unknown }>().data, { items: [], blocked: true });
      assert.equal(
        (await ctx.call(app, {
          method: "POST",
          url: "/api/recovery/i-1/check",
          headers: { origin, cookie, "content-type": "application/json" },
          payload: {},
        })).statusCode,
        403,
      );
      const check = await ctx.call(app, { method: "POST", url: "/api/recovery/i-1/check", headers, payload: {} });
      assert.equal(check.statusCode, 200);
      assert.deepEqual(calls[0], { check: "i-1" });

      assert.equal(
        (await ctx.call(app, {
          method: "POST",
          url: "/api/recovery/i-1/resolve",
          headers,
          payload: { expectedUpdatedAt: 1, outcome: "paid", reason: "x", evidence: "x", confirmed: true },
        })).statusCode,
        400,
      );
      const resolved = await ctx.call(app, {
        method: "POST",
        url: "/api/recovery/i-1/resolve",
        headers,
        payload: {
          expectedUpdatedAt: 1,
          outcome: "not_applied",
          reason: "Revisé la actividad en QvaPay.",
          evidence: "No aparece aplicación ni operación para ese UUID.",
          confirmed: true,
        },
      });
      assert.equal(resolved.statusCode, 200);
      assert.deepEqual(calls[1], {
        intentId: "i-1",
        expectedUpdatedAt: 1,
        outcome: "not_applied",
        reason: "Revisé la actividad en QvaPay.",
        evidence: "No aparece aplicación ni operación para ese UUID.",
        confirmed: true,
      });
      for (const action of ["evidence", "acknowledge"]) {
        assert.equal(
          (await ctx.call(app, {
            method: "POST",
            url: `/api/recovery/i-1/${action}`,
            payload: { evidence: "Estado comprobado en QvaPay" },
          })).statusCode,
          401,
        );
        assert.equal(
          (await ctx.call(app, {
            method: "POST",
            url: `/api/recovery/i-1/${action}`,
            headers: { origin, cookie },
            payload: { evidence: "Estado comprobado en QvaPay" },
          })).statusCode,
          403,
        );
      }
      assert.equal(
        (await ctx.call(app, {
          method: "POST",
          url: "/api/recovery/i-1/evidence",
          headers,
          payload: { evidence: "short" },
        })).statusCode,
        400,
      );
      assert.equal(
        (await ctx.call(app, {
          method: "POST",
          url: "/api/recovery/i-1/evidence",
          headers,
          payload: { evidence: "Estado comprobado en QvaPay" },
        })).statusCode,
        200,
      );
      assert.equal(
        (await ctx.call(app, { method: "POST", url: "/api/recovery/i-1/acknowledge", headers, payload: {} })).statusCode,
        200,
      );
      assert.deepEqual(calls.slice(2), [
        { id: "i-1", evidence: "Estado comprobado en QvaPay" },
        { acknowledged: "i-1" },
      ]);
      ctx.effect("recovery.calls", calls);
    },
  },
  {
    id: "self-service-recovery/02-cas-conflict",
    file: "test/self-service-recovery-http.test.ts",
    source: "test/self-service-recovery-http.test.ts:88",
    build() {
      return buildDashboard(
        {
          recoveryItems: () => ({ items: [], blocked: false }),
          resolveRecoveryIntent: () => {
            throw new RecoveryConflictError("La intención cambió.");
          },
        } as never,
        { password, trustedOrigin: origin },
      );
    },
    async run(app, ctx) {
      const login = await ctx.call(app, {
        method: "POST",
        url: "/api/session",
        headers: { origin, "content-type": "application/json" },
        payload: { password },
      });
      const cookie = String(login.headers["set-cookie"]).split(";", 1)[0]!;
      const csrf = login.json<{ data: { csrfToken: string } }>().data.csrfToken;
      const response = await ctx.call(app, {
        method: "POST",
        url: "/api/recovery/i-1/resolve",
        headers: { origin, cookie, "content-type": "application/json", "x-csrf-token": csrf },
        payload: {
          expectedUpdatedAt: 1,
          outcome: "cancelled",
          reason: "Revisé la actividad en QvaPay.",
          evidence: "No aparece una operación activa.",
          confirmed: true,
        },
      });
      assert.equal(response.statusCode, 409);
    },
  },
];

export { scenarios };
