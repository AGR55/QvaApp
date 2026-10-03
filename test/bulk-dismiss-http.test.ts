import assert from "node:assert/strict";
import test from "node:test";
import { buildDashboard } from "../src/http-dashboard.js";

test("descarte masivo exige sesión, CSRF y cursor válido; una sola llamada", async (t) => {
  const calls: number[] = [];
  const app = buildDashboard({ dismissAllDecisionEvents: (throughId: number) => { calls.push(throughId); return { dismissed: 45 }; } } as never,
    { password: "test-password-strong-2026", trustedOrigin: "http://127.0.0.1:3000" });
  t.after(() => app.close());
  const origin = "http://127.0.0.1:3000";
  const url = "/api/decision-events/dismiss-all";
  const anonymous = await app.inject({ method: "POST", url, payload: { throughId: 45 } });
  assert.equal(anonymous.statusCode, 401);
  const login = await app.inject({ method: "POST", url: "/api/session", headers: { origin }, payload: { password: "test-password-strong-2026" } });
  const cookie = String(login.headers["set-cookie"]).split(";", 1)[0]!;
  const csrf = login.json().data.csrfToken;
  assert.equal((await app.inject({ method: "POST", url, headers: { origin, cookie }, payload: { throughId: 45 } })).statusCode, 403);
  const headers = { origin, cookie, "x-csrf-token": csrf };
  // Fastify strips additional properties by design; required/range checks remain strict.
  for (const payload of [{}, { throughId: 0 }, { throughId: 1.5 }])
    assert.equal((await app.inject({ method: "POST", url, headers, payload })).statusCode, 400);
  const okay = await app.inject({ method: "POST", url, headers, payload: { throughId: 45 } });
  assert.equal(okay.statusCode, 200);
  assert.deepEqual(okay.json().data, { dismissed: 45 });
  assert.deepEqual(calls, [45]);
});
