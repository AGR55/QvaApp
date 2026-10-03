import assert from "node:assert/strict";
import test from "node:test";
import { buildDashboard } from "../src/http-dashboard.js";
import { RecoveryConflictError } from "../src/self-service-recovery.js";

const password = "recovery-http-password-2026";
const origin = "http://127.0.0.1:3000";

test("API recovery exige sesión y CSRF, y valida los dos contratos de acción", async () => {
  const calls: unknown[] = [];
  const readModel = {
    recoveryItems: () => ({ items: [], blocked: true }),
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
  assert.equal((await app.inject({ method: "GET", url: "/api/recovery" })).statusCode, 401);

  const login = await app.inject({
    method: "POST", url: "/api/session",
    headers: { origin, "content-type": "application/json" }, payload: { password },
  });
  const cookie = String(login.headers["set-cookie"]).split(";", 1)[0]!;
  const csrf = login.json<{ data: { csrfToken: string } }>().data.csrfToken;
  const headers = { origin, cookie, "content-type": "application/json", "x-csrf-token": csrf };

  const list = await app.inject({ method: "GET", url: "/api/recovery", headers: { cookie } });
  assert.equal(list.statusCode, 200);
  assert.deepEqual(list.json<{ data: unknown }>().data, { items: [], blocked: true });
  const noCsrf = await app.inject({
    method: "POST", url: "/api/recovery/i-1/check",
    headers: { origin, cookie, "content-type": "application/json" }, payload: {},
  });
  assert.equal(noCsrf.statusCode, 403);
  const check = await app.inject({
    method: "POST", url: "/api/recovery/i-1/check", headers, payload: {},
  });
  assert.equal(check.statusCode, 200);
  assert.deepEqual(calls[0], { check: "i-1" });

  const invalid = await app.inject({
    method: "POST", url: "/api/recovery/i-1/resolve", headers,
    payload: { expectedUpdatedAt: 1, outcome: "paid", reason: "x", evidence: "x", confirmed: true },
  });
  assert.equal(invalid.statusCode, 400);
  const resolved = await app.inject({
    method: "POST", url: "/api/recovery/i-1/resolve", headers,
    payload: {
      expectedUpdatedAt: 1, outcome: "not_applied",
      reason: "Revisé la actividad en QvaPay.",
      evidence: "No aparece aplicación ni operación para ese UUID.", confirmed: true,
    },
  });
  assert.equal(resolved.statusCode, 200);
  assert.deepEqual(calls[1], {
    intentId: "i-1", expectedUpdatedAt: 1, outcome: "not_applied",
    reason: "Revisé la actividad en QvaPay.",
    evidence: "No aparece aplicación ni operación para ese UUID.", confirmed: true,
  });
  await app.close();
});

test("API recovery convierte revisión CAS obsoleta en HTTP 409", async () => {
  const app = buildDashboard({
    recoveryItems: () => ({ items: [], blocked: false }),
    resolveRecoveryIntent: () => { throw new RecoveryConflictError("La intención cambió."); },
  } as never, { password, trustedOrigin: origin });
  const login = await app.inject({
    method: "POST", url: "/api/session",
    headers: { origin, "content-type": "application/json" }, payload: { password },
  });
  const cookie = String(login.headers["set-cookie"]).split(";", 1)[0]!;
  const csrf = login.json<{ data: { csrfToken: string } }>().data.csrfToken;
  const response = await app.inject({
    method: "POST", url: "/api/recovery/i-1/resolve",
    headers: { origin, cookie, "content-type": "application/json", "x-csrf-token": csrf },
    payload: {
      expectedUpdatedAt: 1, outcome: "cancelled",
      reason: "Revisé la actividad en QvaPay.", evidence: "No aparece una operación activa.", confirmed: true,
    },
  });
  assert.equal(response.statusCode, 409);
  await app.close();
});
