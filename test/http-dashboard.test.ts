import assert from "node:assert/strict";
import test from "node:test";
import { buildDashboard } from "../src/http-dashboard.js";

const password = "contraseña-local-segura-2026";
const origin = "http://127.0.0.1:3000";

test("Fastify protege datos, origen y mutaciones con sesión y CSRF", async () => {
  const controls: boolean[] = [];
  const readModel = {
    setPaused: async (value: boolean) => void controls.push(value),
  };
  const app = buildDashboard(readModel as never, {
    password,
    trustedOrigin: origin,
  });

  const anonymous = await app.inject({ method: "GET", url: "/api/config" });
  assert.equal(anonymous.statusCode, 401);
  assert.equal(anonymous.headers["x-frame-options"], "DENY");

  const wrongOrigin = await app.inject({
    method: "POST",
    url: "/api/session",
    headers: { origin: "http://malicioso.example", "content-type": "application/json" },
    payload: { password },
  });
  assert.equal(wrongOrigin.statusCode, 403);

  const login = await app.inject({
    method: "POST",
    url: "/api/session",
    headers: { origin, "content-type": "application/json" },
    payload: { password },
  });
  assert.equal(login.statusCode, 201);
  const cookie = String(login.headers["set-cookie"]).split(";", 1)[0]!;
  const csrf = login.json<{ data: { csrfToken: string } }>().data.csrfToken;

  const withoutCsrf = await app.inject({
    method: "PUT",
    url: "/api/control",
    headers: { origin, cookie, "content-type": "application/json" },
    payload: { paused: true },
  });
  assert.equal(withoutCsrf.statusCode, 403);

  const accepted = await app.inject({
    method: "PUT",
    url: "/api/control",
    headers: { origin, cookie, "content-type": "application/json", "x-csrf-token": csrf },
    payload: { paused: true },
  });
  assert.equal(accepted.statusCode, 204);
  assert.deepEqual(controls, [true]);
  await app.close();
});

test("Fastify rechaza cuerpos inválidos antes de llegar al dominio", async () => {
  const app = buildDashboard({} as never, { password, trustedOrigin: origin });
  const login = await app.inject({
    method: "POST",
    url: "/api/session",
    headers: { origin, "content-type": "application/json" },
    payload: { password },
  });
  const cookie = String(login.headers["set-cookie"]).split(";", 1)[0]!;
  const csrf = login.json<{ data: { csrfToken: string } }>().data.csrfToken;
  const invalid = await app.inject({
    method: "POST",
    url: "/api/offers",
    headers: { origin, cookie, "content-type": "application/json", "x-csrf-token": csrf },
    payload: { coin: "BANK_CUP", type: "sell", amount: -1, rate: 900 },
  });
  assert.equal(invalid.statusCode, 400);
  await app.close();
});

test("Fastify devuelve un rechazo de dominio como error de cliente seguro", async () => {
  const readModel = {
    setPaused: async () => {
      throw new Error("QvaPay no tiene una sesión válida.");
    },
  };
  const app = buildDashboard(readModel as never, { password, trustedOrigin: origin });
  const login = await app.inject({
    method: "POST",
    url: "/api/session",
    headers: { origin, "content-type": "application/json" },
    payload: { password },
  });
  const cookie = String(login.headers["set-cookie"]).split(";", 1)[0]!;
  const csrf = login.json<{ data: { csrfToken: string } }>().data.csrfToken;
  const response = await app.inject({
    method: "PUT",
    url: "/api/control",
    headers: { origin, cookie, "content-type": "application/json", "x-csrf-token": csrf },
    payload: { paused: false },
  });

  assert.equal(response.statusCode, 400);
  assert.equal(response.json<{ error: string }>().error, "QvaPay no tiene una sesión válida.");
  await app.close();
});

test("Fastify exige que la parada de emergencia sea atómica", async () => {
  let mutations = 0;
  const readModel = {
    setEmergencyStop: () => void (mutations += 1),
    setPaused: async () => void (mutations += 1),
  };
  const app = buildDashboard(readModel as never, { password, trustedOrigin: origin });
  const login = await app.inject({
    method: "POST",
    url: "/api/session",
    headers: { origin, "content-type": "application/json" },
    payload: { password },
  });
  const cookie = String(login.headers["set-cookie"]).split(";", 1)[0]!;
  const csrf = login.json<{ data: { csrfToken: string } }>().data.csrfToken;
  const response = await app.inject({
    method: "PUT",
    url: "/api/control",
    headers: { origin, cookie, "content-type": "application/json", "x-csrf-token": csrf },
    payload: { emergencyStop: true, paused: false },
  });

  assert.equal(response.statusCode, 400);
  assert.equal(mutations, 0);
  await app.close();
});
