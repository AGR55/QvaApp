import assert from "node:assert/strict";
import test from "node:test";
import { DashboardAuth, DashboardAuthError } from "../src/dashboard-auth.js";

test("crea sesión HttpOnly y exige el mismo token CSRF", () => {
  const auth = new DashboardAuth({
    password: "correcta-muy-larga-2026",
    trustedOrigin: "http://127.0.0.1:3000",
    now: () => 1_000,
  });
  const login = auth.login("correcta-muy-larga-2026", "local");
  assert.match(login.cookie, /HttpOnly; SameSite=Strict/);
  auth.assertCsrf(login.cookie, login.csrfToken);
  assert.throws(
    () => auth.assertCsrf(login.cookie, "otro"),
    (error) => error instanceof DashboardAuthError && error.status === 403,
  );
});

test("limita intentos fallidos y acepta alias loopback del mismo puerto", () => {
  const auth = new DashboardAuth({
    password: "correcta-muy-larga-2026",
    trustedOrigin: "http://127.0.0.1:3000",
  });
  auth.assertOrigin("http://127.0.0.1:3000");
  auth.assertOrigin("http://localhost:3000");
  auth.assertOrigin("http://[::1]:3000");
  assert.throws(() => auth.assertOrigin("http://localhost:3001"));
  assert.throws(() => auth.assertOrigin("https://localhost:3000"));
  assert.throws(() => auth.assertOrigin("http://127.0.0.1.example:3000"));
  assert.throws(() => auth.assertOrigin("http://192.168.1.5:3000"));
  assert.throws(() => auth.assertOrigin(undefined));
  for (let attempt = 0; attempt < 5; attempt += 1)
    assert.throws(() => auth.login("incorrecta", "local"));
  assert.throws(
    () => auth.login("correcta-muy-larga-2026", "local"),
    (error) => error instanceof DashboardAuthError && error.status === 429,
  );
});

test("un origen público configurado conserva igualdad exacta", () => {
  const auth = new DashboardAuth({
    password: "correcta-muy-larga-2026",
    trustedOrigin: "https://panel.example.com",
  });
  auth.assertOrigin("https://panel.example.com");
  assert.throws(() => auth.assertOrigin("https://localhost"));
  assert.throws(() => auth.assertOrigin("http://panel.example.com"));
});

test("expira e invalida sesiones sin persistir secretos", () => {
  let now = 0;
  const auth = new DashboardAuth({
    password: "correcta-muy-larga-2026",
    trustedOrigin: "http://127.0.0.1:3000",
    now: () => now,
    sessionDurationMs: 100,
  });
  const login = auth.login("correcta-muy-larga-2026", "local");
  assert.ok(auth.session(login.cookie));
  now = 101;
  assert.equal(auth.session(login.cookie), undefined);
});
