import assert from "node:assert/strict";
import test from "node:test";
import { buildDashboard } from "../src/http-dashboard.js";

test("analítica local requiere sesión y valida el periodo sin consultar QvaPay", async () => {
  const calls: number[] = [];
  const app = buildDashboard({ tradingAnalytics: (days: number) => { calls.push(days); return { volume: 12, days }; } } as never,
    { password: "analytics-http-password-2026", trustedOrigin: "http://127.0.0.1:3000" });
  assert.equal((await app.inject({ url: "/api/trading-analytics" })).statusCode, 401);
  const login = await app.inject({ method: "POST", url: "/api/session", headers: { origin: "http://127.0.0.1:3000" }, payload: { password: "analytics-http-password-2026" } });
  const headers = { cookie: String(login.headers["set-cookie"]).split(";", 1)[0]! };
  assert.equal((await app.inject({ url: "/api/trading-analytics?days=365", headers })).statusCode, 400);
  assert.equal((await app.inject({ url: "/api/trading-analytics?days=7&account=other", headers })).statusCode, 200);
  const result = await app.inject({ url: "/api/trading-analytics?days=7", headers });
  assert.equal(result.statusCode, 200);
  assert.deepEqual(result.json(), { data: { volume: 12, days: 7 }, source: "sqlite" });
  assert.deepEqual(calls, [7, 7], "el filtro de cuenta externo se ignora y no llega al modelo");
  await app.close();
});
