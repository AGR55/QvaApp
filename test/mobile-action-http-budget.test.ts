import assert from "node:assert/strict";
import test from "node:test";
import { buildDashboard } from "../src/http-dashboard.js";

test("only an authorized valid monetary action extends the response socket budget", async context => {
  const token = "b".repeat(48);
  const budgets: number[] = [];
  const actions: string[] = [];
  const model = {
    checkMobileOperator: (value: string) => value === token ? { ok: true, operatorId: "phone", scopes: ["read", "actions"] } : { ok: false },
    mobileOperationAction: async (_operator: string, _uuid: string, action: string) => { actions.push(action); },
  };
  const app = buildDashboard(model as never, { password: "long-test-password-only", trustedOrigin: "http://127.0.0.1:3000" });
  context.after(() => app.close());
  app.addHook("onRequest", async request => {
    const socket = request.raw.socket;
    const original = socket.setTimeout;
    socket.setTimeout = (timeout, callback) => {
      budgets.push(timeout);
      return original ? original.call(socket, timeout, callback) : socket;
    };
  });
  const headers = { authorization: `Bearer ${token}` };
  const path = "/api/mobile/operations/offer/paid";
  assert.equal((await app.inject({ method: "POST", url: path, payload: { reference: "reference" } })).statusCode, 401);
  assert.equal((await app.inject({ method: "POST", url: path, headers, payload: {} })).statusCode, 400);
  assert.deepEqual(budgets, []);
  assert.equal((await app.inject({ method: "POST", url: path, headers, payload: { reference: "reference" } })).statusCode, 204);
  assert.deepEqual(budgets, [60_000]);
  assert.deepEqual(actions, ["paid"]);
  assert.equal(app.server.requestTimeout, 60_000);
  assert.equal(app.initialConfig.connectionTimeout, 10_000);
});
