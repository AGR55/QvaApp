/**
 * Smoke reproducible del fake QvaPay (F0).
 *
 * Arranca el servidor local (helper in-process y una vez por CLI con puerto 0),
 * ejecuta los escenarios obligatorios de K1–K14 priorizados y valida respuestas
 * + log de requests (método, path, query, headers relevantes, body hash,
 * latencia virtual, strictness). Sin red externa, sin `pnpm`, sin `sleep` real
 * en la simulación: los timeouts se provocan con abort/hang.
 *
 * Ejecutar desde la raíz del repo:
 *   node --import tsx parity/scripts/fake-qvapay-smoke.ts
 */
import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  sha256Hex,
  signWebhookBody,
  startFakeQvaPay,
  type FakeQvaPayHandle,
} from "../lib/fake-qvapay/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, "../..");
const FIXTURES = join(ROOT, "parity/fixtures/contracts/qvapay");
const fixture = (name: string): string => join(FIXTURES, name);

let checks = 0;
let failures = 0;
const startedAt = Date.now();

function check(name: string, condition: boolean, detail = ""): void {
  checks += 1;
  if (condition) {
    process.stdout.write(`  ok   ${name}\n`);
    return;
  }
  failures += 1;
  process.stdout.write(`  FAIL ${name}${detail ? ` — ${detail}` : ""}\n`);
}

function equal<T>(name: string, actual: T, expected: T): void {
  check(name, Object.is(actual, expected), `esperado ${JSON.stringify(expected)}, recibido ${JSON.stringify(actual)}`);
}

async function expectRejects(name: string, promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
    check(name, false, "la promesa resolvió pero debía rechazar");
    return undefined;
  } catch (error) {
    check(name, true);
    return error;
  }
}

async function startScenario(cassette: string): Promise<FakeQvaPayHandle> {
  return startFakeQvaPay({ cassette: fixture(cassette), port: 0, quiet: true });
}

async function scenario(title: string, body: (fake: FakeQvaPayHandle) => Promise<void>, cassette: string): Promise<void> {
  process.stdout.write(`\n[${title}] cassette=${cassette}\n`);
  let fake: FakeQvaPayHandle;
  try {
    fake = await startScenario(cassette);
  } catch (error) {
    check(`${title}: arranque del servidor`, false, String(error));
    return;
  }
  try {
    await body(fake);
  } catch (error) {
    check(`${title}: excepción inesperada`, false, error instanceof Error ? `${error.name}: ${error.message}` : String(error));
  } finally {
    await fake.close().catch(() => undefined);
  }
}

const AUTH_READER = { authorization: "Bearer test-reader-token" };
const AUTH_OWNER = { authorization: "Bearer test-owner-token", "content-type": "application/json" };

/* ------------------------------------------------------------------ */
/* Escenarios                                                          */
/* ------------------------------------------------------------------ */

async function cliBoot(): Promise<void> {
  process.stdout.write("\n[S0 CLI: arranque con puerto efímero]\n");
  const child = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      join(ROOT, "parity/lib/fake-qvapay/start.ts"),
      "--cassette",
      fixture("apply-409-contention.json"),
      "--port",
      "0",
    ],
    { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] },
  );
  const stderr: string[] = [];
  child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk.toString("utf8")));
  try {
    const line = await firstLine(child.stdout, 8_000);
    const ready = JSON.parse(line) as { ready?: boolean; url?: string; port?: number; cassette?: string };
    check("CLI imprime línea ready", ready.ready === true, line);
    check("CLI usa URL loopback", typeof ready.url === "string" && /^http:\/\/127\.0\.0\.1:\d+$/.test(ready.url), String(ready.url));
    check("CLI asigna puerto efímero > 0", typeof ready.port === "number" && ready.port > 0, String(ready.port));
    equal("CLI carga el cassette", ready.cassette, "apply-409-contention");
    const health = await (await fetch(`${ready.url}/__fake/health`)).json() as { ok?: boolean };
    check("CLI responde /__fake/health", health.ok === true, JSON.stringify(health));
  } finally {
    child.kill("SIGTERM");
    await waitExit(child, 3_000);
    if (stderr.length) process.stdout.write(`  (stderr CLI: ${stderr.join("").trim().split("\n")[0]})\n`);
  }
}

async function listXcache429(): Promise<void> {
  await scenario("S1 K2 listado: x-cache HIT/MISS y 429", async (fake) => {
    const base = fake.url;
    const r1 = await fetch(`${base}/v2/p2p?take=100&page=1&type=sell&coin=QUSD`, { headers: AUTH_READER });
    const b1 = await r1.json() as { data?: Array<{ uuid?: string }>; total?: number };
    equal("listado: status 200", r1.status, 200);
    equal("listado: x-cache HIT", r1.headers.get("x-cache"), "HIT");
    equal("listado: envelope data[0].uuid", b1.data?.[0]?.uuid, "offer-open-1");
    equal("listado: total", b1.total, 2);

    const r2 = await fetch(`${base}/v2/p2p?take=100&page=2&type=sell&coin=QUSD`, { headers: AUTH_READER });
    const b2 = await r2.json() as { offers?: unknown[] };
    equal("listado: x-cache MISS", r2.headers.get("x-cache"), "MISS");
    equal("listado: envelope offers (compat)", b2.offers?.length, 1);

    const r3 = await fetch(`${base}/v2/p2p?page=3`, { headers: AUTH_READER });
    const b3 = await r3.json() as { code?: string };
    equal("listado: 429 con Retry-After", r3.status, 429);
    equal("listado: Retry-After segundos", r3.headers.get("retry-after"), "2");
    equal("listado: código RATE_LIMITED", b3.code, "RATE_LIMITED");

    const r4 = await fetch(`${base}/v2/p2p?page=4`, { headers: AUTH_READER });
    equal("listado: 429 sin Retry-After", r4.status, 429);
    equal("listado: sin cabecera Retry-After", r4.headers.get("retry-after"), null);

    const r5 = await fetch(`${base}/v2/p2p?page=5`, { headers: AUTH_READER });
    equal("listado: 2xx con JSON malformado", r5.status, 200);
    await expectRejects("listado: parseo del body malformado falla", r5.json());

    const log = fake.log();
    equal("listado: requests registradas", log.requestCount, 5);
    equal("listado: sin requests no declaradas", log.unexpectedRequests, 0);
    equal("listado: exchange HIT consumida", log.exchanges[0]?.consumed, 1);
    equal("listado: body vacío hasheado", log.requests[0]?.bodyBytes, 0);
    equal(
      "listado: hash de authorization registrado",
      log.requests[0]?.headerHashes.authorization,
      sha256Hex("Bearer test-reader-token"),
    );
    equal("listado: authorization redactada", log.requests[0]?.headers.authorization, "Bearer <redacted>");
    equal("listado: query normalizada en log", log.requests[0]?.querySorted.includes("page=1"), true);
    equal("listado: latencia virtual del MISS", log.requests[1]?.latencyMs, 2_401);
    equal("listado: reloj virtual avanzado", log.virtualNow, 1767225600000 + 2_401);
    equal("listado: estado 429 en log", log.requests[2]?.status, 429);
    equal("listado: logAssertions sin fallos", log.assertionFailures.length, 0);
  }, "list-xcache-429.json");
}

async function apply409(): Promise<void> {
  await scenario("S2 K3 apply: 409 de contención y éxito", async (fake) => {
    const base = fake.url;
    const apply = (uuid: string) => fetch(`${base}/v2/p2p/${uuid}/apply`, { method: "POST", headers: AUTH_OWNER });

    const contended = await apply("offer-contended-1");
    const contendedBody = await contended.json() as { code?: string };
    equal("apply: 409 OFFER_CONTENDED", contended.status, 409);
    equal("apply: code OFFER_CONTENDED", contendedBody.code, "OFFER_CONTENDED");

    const paused = await apply("offer-paused-1");
    const pausedBody = await paused.json() as { code?: string };
    equal("apply: 409 OFFER_PAUSED", pausedBody.code, "OFFER_PAUSED");

    const requirements = await apply("offer-requirements-1");
    const requirementsBody = await requirements.json() as { code?: string; missing?: string[] };
    equal("apply: 409 PEER_REQUIREMENTS_NOT_MET", requirementsBody.code, "PEER_REQUIREMENTS_NOT_MET");
    equal("apply: missing conservado", requirementsBody.missing?.includes("kyc_verified"), true);

    const taken = await apply("offer-taken-1");
    const takenBody = await taken.json() as { error?: string };
    equal("apply: 409 oferta ya tomada (genérico)", takenBody.error?.includes("ya fue tomada"), true);

    const success = await apply("offer-success-1");
    equal("apply: 200 éxito", success.status, 200);
    const readBack = await fetch(`${base}/v2/p2p/offer-success-1`, { headers: AUTH_OWNER });
    const readBackBody = await readBack.json() as { p2p?: { status?: string; Orders?: Array<{ uuid?: string }> } };
    equal("apply: mundo refleja applied", readBackBody.p2p?.status, "applied");
    equal("apply: orden determinista en Orders", readBackBody.p2p?.Orders?.[0]?.uuid, "order-apply-0001");

    const log = fake.log();
    equal("apply: requests registradas", log.requestCount, 6);
    equal("apply: sin requests no declaradas", log.unexpectedRequests, 0);
    equal("apply: latencia virtual 1218 ms", log.requests[0]?.latencyMs, 1_218);
    equal("apply: latencia virtual 1032 ms", log.requests[4]?.latencyMs, 1_032);
    equal("apply: body vacío hasheado igual", log.requests[0]?.bodySha256, sha256Hex(""));
    equal("apply: exchange sin consumir (ninguna)", log.unconsumed.length, 0);
    equal("apply: logAssertions sin fallos", log.assertionFailures.length, 0);
  }, "apply-409-contention.json");
}

async function apply429(): Promise<void> {
  await scenario("S3 K3 apply: 429 con/sin Retry-After", async (fake) => {
    const base = fake.url;
    const apply = (uuid: string) => fetch(`${base}/v2/p2p/${uuid}/apply`, { method: "POST", headers: AUTH_OWNER });

    const withRetry = await apply("offer-429-retry");
    equal("apply 429: status", withRetry.status, 429);
    equal("apply 429: Retry-After 7 s", withRetry.headers.get("retry-after"), "7");

    const withoutRetry = await apply("offer-429-noretry");
    equal("apply 429: sin Retry-After", withoutRetry.headers.get("retry-after"), null);

    const dateRetry = await apply("offer-429-date");
    equal("apply 429: Retry-After fecha HTTP", dateRetry.headers.get("retry-after"), "Thu, 01 Jan 2026 00:00:07 GMT");

    const ok1 = await apply("offer-window-a");
    const ok2 = await apply("offer-window-b");
    equal("apply ventana: primera 200", ok1.status, 200);
    equal("apply ventana: segunda 200", ok2.status, 200);
    const log = fake.log();
    equal("apply ventana: el fake solo ve 2 despachos", log.requests.filter((entry) => entry.method === "POST").length, 5);
    equal("apply 429: sin requests no declaradas", log.unexpectedRequests, 0);
  }, "apply-429.json");
}

async function timeoutAndAmbiguous(): Promise<void> {
  await scenario("S4 K3/K4 timeout y respuesta ambigua tras apply", async (fake) => {
    const base = fake.url;
    const apply = (uuid: string, signal?: AbortSignal) =>
      fetch(`${base}/v2/p2p/${uuid}/apply`, { method: "POST", headers: AUTH_OWNER, ...(signal ? { signal } : {}) });

    await expectRejects(
      "timeout: el SUT aborta la mutación colgada (hang)",
      apply("offer-hang-1", AbortSignal.timeout(80)),
    );

    const ambiguous = await apply("offer-ambiguous-1");
    equal("ambiguo: status 200 recibido", ambiguous.status, 200);
    await expectRejects("ambiguo: la respuesta cortada no se puede leer", ambiguous.text());

    // La mutación sí se aplicó en el mundo: la conciliación posterior lo demuestra.
    const state = fake.state() as {
      offers: Array<{ uuid: string; status: string }>;
      appliedOrders: Array<{ uuid: string; order: string }>;
    };
    equal(
      "ambiguo: el efecto se aplicó en el mundo",
      state.offers.find((offer) => offer.uuid === "offer-ambiguous-1")?.status,
      "applied",
    );
    equal("ambiguo: orden determinista registrada", state.appliedOrders[0]?.order, "order-amb-0001");

    const reconcile = await fetch(`${base}/v2/p2p/offer-ambiguous-1`, { headers: AUTH_OWNER });
    const reconcileBody = await reconcile.json() as { p2p?: { status?: string } };
    equal("ambiguo: reconciliación lee applied", reconcileBody.p2p?.status, "applied");

    await expectRejects("timeout: reset de conexión antes de responder", apply("offer-destroy-1"));

    const log = fake.log();
    equal("timeout/ambiguo: requests de API", log.requestCount, 4);
    equal("timeout/ambiguo: sin requests no declaradas", log.unexpectedRequests, 0);
    equal("timeout: hang registrado", log.requests[0]?.aborted, "hang");
    equal("timeout: hang sin status de respuesta", log.requests[0]?.status, null);
    equal("ambiguo: corte tras headers registrado", log.requests[1]?.aborted, "after-headers");
    equal("timeout: destroy registrado", log.requests[3]?.aborted, "destroy");
    equal("timeout: reloj virtual intacto (sin sleep real)", log.virtualNow, 1767225600000);
  }, "apply-timeout-ambiguous.json");
}

async function webhookSigned(): Promise<void> {
  await scenario("S5 K5/K13 webhook HMAC, timestamp y dedupe", async (fake) => {
    const base = fake.url;
    const secret = "whsec_fake_test_0123456789abcdef";
    const virtualNow = (fake.state() as { virtualNow: number }).virtualNow;
    const payload = {
      event: "p2p.created",
      sent_at: "2026-01-01T00:00:00.000Z",
      data: { uuid: "offer-webhook-0001", type: "sell", coin: "QUSD", amount: 10, receive: 10, status: "open" },
    };
    const raw = JSON.stringify(payload);
    const post = (body: string, headers: Record<string, string>) =>
      fetch(`${base}/webhooks/qvapay/p2p-feed`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body });

    const first = await post(raw, {
      "x-qvapay-signature": signWebhookBody(raw, secret),
      "x-qvapay-timestamp": String(virtualNow),
    });
    const firstBody = await first.json() as { ok?: boolean; duplicate?: boolean; queued?: boolean };
    equal("webhook: 202 tras persistir", first.status, 202);
    equal("webhook: evento nuevo", firstBody.duplicate, false);
    equal("webhook: encolado", firstBody.queued, true);

    const duplicate = await post(raw, {
      "x-qvapay-signature": signWebhookBody(raw, secret),
      "x-qvapay-timestamp": String(virtualNow),
    });
    const duplicateBody = await duplicate.json() as { duplicate?: boolean; queued?: boolean };
    equal("webhook: duplicado 202", duplicate.status, 202);
    equal("webhook: duplicate:true", duplicateBody.duplicate, true);
    equal("webhook: duplicado no se encola", duplicateBody.queued, false);

    const tampered = `${raw.slice(0, -1)} `;
    const badSignature = await post(tampered, {
      "x-qvapay-signature": signWebhookBody(raw, secret),
      "x-qvapay-timestamp": String(virtualNow),
    });
    equal("webhook: firma inválida 401", badSignature.status, 401);

    const missingTimestamp = await post(raw, { "x-qvapay-signature": signWebhookBody(raw, secret) });
    equal("webhook: timestamp ausente 401", missingTimestamp.status, 401);

    const expiredTimestamp = await post(raw, {
      "x-qvapay-signature": signWebhookBody(raw, secret),
      "x-qvapay-timestamp": String(virtualNow - 6 * 60_000),
    });
    equal("webhook: timestamp vencido 401", expiredTimestamp.status, 401);

    const oversized = JSON.stringify({ ...payload, big: "x".repeat(10_000) });
    const tooLarge = await post(oversized, {
      "x-qvapay-signature": signWebhookBody(oversized, secret),
      "x-qvapay-timestamp": String(virtualNow),
    });
    equal("webhook: cuerpo >10 KB 400", tooLarge.status, 400);

    const malformed = "{esto no es json";
    const invalidJson = await post(malformed, {
      "x-qvapay-signature": signWebhookBody(malformed, secret),
      "x-qvapay-timestamp": String(virtualNow),
    });
    equal("webhook: JSON inválido 400", invalidJson.status, 400);

    // Emisor firmado del fake hacia el receptor (sin red externa).
    const emitter = await fetch(`${base}/__fake/webhook/send`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        targetUrl: `${base}/webhooks/qvapay/p2p-feed`,
        secret,
        payload: {
          event: "p2p.created",
          sent_at: "2026-01-01T00:00:01.000Z",
          data: { uuid: "offer-webhook-0002", type: "buy", coin: "QUSD", amount: 5, receive: 5, status: "open" },
        },
      }),
    });
    const emitterBody = await emitter.json() as { ok?: boolean; request?: { signature?: string }; response?: { status?: number; body?: string } };
    equal("webhook emisor: ok", emitterBody.ok, true);
    equal("webhook emisor: firma sha256=", emitterBody.request?.signature?.startsWith("sha256="), true);
    equal("webhook emisor: receptor 202", emitterBody.response?.status, 202);

    const state = fake.state() as {
      webhook: { duplicates: number; events: Array<{ key: string; uuid: string }> };
    };
    equal("webhook: eventos persistidos", state.webhook.events.length, 2);
    equal("webhook: contador de duplicados", state.webhook.duplicates, 1);
    equal("webhook: dedupe key incluye uuid", state.webhook.events[0]?.key.includes("offer-webhook-0001"), true);
  }, "webhook-signed.json");
}

async function errors4xx5xx(): Promise<void> {
  await scenario("S6 4xx/5xx, 5xx incierta y 2xx no-JSON", async (fake) => {
    const base = fake.url;
    const get = (path: string) => fetch(`${base}${path}`, { headers: AUTH_OWNER });

    equal("errores: 401", (await get("/v2/user?case=401")).status, 401);
    equal("errores: 403", (await get("/v2/user?case=403")).status, 403);
    equal("errores: 404", (await get("/v2/p2p/offer-missing-1")).status, 404);
    const badRequest = await fetch(`${base}/v2/p2p/create`, {
      method: "POST",
      headers: AUTH_OWNER,
      body: JSON.stringify({ type: "buy", coin: "QUSD", amount: 1, receive: 1, details: [] }),
    });
    equal("errores: 400 definitivo", badRequest.status, 400);
    equal("errores: 500", (await get("/v2/transaction?case=500")).status, 500);
    equal("errores: 502", (await get("/v2/transaction?case=502")).status, 502);
    const unavailable = await get("/v2/transaction?case=503");
    equal("errores: 503", unavailable.status, 503);
    equal("errores: 503 Retry-After", unavailable.headers.get("retry-after"), "30");

    const garbage = await get("/v2/user?case=garbage");
    equal("errores: 2xx no-JSON status", garbage.status, 200);
    await expectRejects("errores: 2xx no-JSON no parsea", garbage.json());

    const user = await (await get("/v2/user?case=success")).json() as { uuid?: string };
    equal("errores: /user éxito", user.uuid, "user-owner-0001");
    const transactions = await (await get("/v2/transaction?case=success")).json() as {
      transactions?: Array<{ P2P?: { coin?: string } }>;
    };
    equal("errores: /transaction éxito (K12)", transactions.transactions?.[0]?.P2P?.coin, "QUSD");

    const log = fake.log();
    equal("errores: sin requests no declaradas", log.unexpectedRequests, 0);
    equal("errores: 10 requests de API", log.requestCount, 10);
  }, "errors-4xx-5xx.json");
}

async function strictnessAndControl(): Promise<void> {
  await scenario("S7 cassette estricto, reloj virtual y reset", async (fake) => {
    const base = fake.url;
    const undeclared = await fetch(`${base}/v2/p2p/oferta-no-declarada`, { headers: AUTH_OWNER });
    const undeclaredBody = await undeclared.json() as { code?: string };
    equal("estricto: request no declarada 500", undeclared.status, 500);
    equal("estricto: código FAKE_UNEXPECTED_REQUEST", undeclaredBody.code, "FAKE_UNEXPECTED_REQUEST");
    equal("estricto: contador unexpected", fake.log().unexpectedRequests, 1);

    // logAssertions se evalúan contra el request real: token distinto ⇒ fallo 500.
    const wrongAuth = await fetch(`${base}/v2/p2p/offer-contended-1/apply`, {
      method: "POST",
      headers: { authorization: "Bearer token-equivocado", "content-type": "application/json" },
    });
    const wrongAuthBody = await wrongAuth.json() as { code?: string };
    equal("estricto: logAssertions fallan 500", wrongAuth.status, 500);
    equal("estricto: código FAKE_LOG_ASSERTION_FAILED", wrongAuthBody.code, "FAKE_LOG_ASSERTION_FAILED");
    equal("estricto: assertionFailures registradas", fake.log().assertionFailures.length, 1);

    const before = (fake.log().virtualNow);
    const advanced = await fetch(`${base}/__fake/advance`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ms: 5_000 }),
    });
    const advancedBody = await advanced.json() as { virtualNow?: number };
    equal("reloj: advance sin dormir", advancedBody.virtualNow, before + 5_000);
    equal("reloj: log refleja avance", fake.log().virtualNow, before + 5_000);

    const reset = await fetch(`${base}/__fake/reset`, { method: "POST" });
    const resetBody = await reset.json() as { ok?: boolean; requests?: number };
    equal("reset: ok", resetBody.ok, true);
    equal("reset: log vacío", resetBody.requests, 0);
    equal("reset: reloj vuelve al epoch fijo", fake.log().virtualNow, 1767225600000);
    equal("reset: exchanges recargadas", fake.log().exchanges.every((exchange) => exchange.consumed === 0), true);
    equal("reset: sin fallos de logAssertions", fake.log().assertionFailures.length, 0);

    // Recarga de cassette vía HTTP: el runner puede cambiar de escenario sin reiniciar.
    const replacement = {
      cassetteVersion: 1,
      name: "inline-reload",
      clockMs: 1767225600000,
      exchanges: [
        {
          id: "inline-user",
          match: { method: "GET", path: "/v2/user" },
          response: { status: 200, body: { uuid: "user-inline-0001" } },
        },
      ],
    };
    const reload = await fetch(`${base}/__fake/reset`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cassette: replacement }),
    });
    equal("reset: recarga de cassette ok", reload.status, 200);
    equal("reset: cassette activo", fake.log().cassette, "inline-reload");
    const inlineUser = await (await fetch(`${base}/v2/user`, { headers: AUTH_OWNER })).json() as { uuid?: string };
    equal("reset: cassette inline responde", inlineUser.uuid, "user-inline-0001");
  }, "apply-409-contention.json");
}

async function sseFeed(): Promise<void> {
  await scenario("S8 K6 SSE: 401/402, retry, init, subscription_expired, >64 KB", async (fake) => {
    const base = fake.url;
    const get = (headers: Record<string, string> = {}) =>
      fetch(`${base}/v2/p2p/stream`, { headers: { accept: "text/event-stream", ...headers } });

    equal("SSE: 401 sin credenciales", (await get()).status, 401);
    equal("SSE: 402 suscripción requerida", (await get()).status, 402);

    const open = await get({ "app-id": "fake-app", "app-secret": "fake-secret" });
    equal("SSE: 200 stream", open.status, 200);
    equal("SSE: content-type text/event-stream", open.headers.get("content-type")?.startsWith("text/event-stream"), true);
    const streamText = await open.text();
    equal("SSE: retry respetado", streamText.includes("retry: 2500"), true);
    equal("SSE: evento init con expires_at", streamText.includes("event: init") && streamText.includes("expires_at"), true);
    equal("SSE: evento de feed", streamText.includes("event: p2p.created"), true);

    const expired = await get({ "app-id": "fake-app", "app-secret": "fake-secret" });
    equal("SSE: subscription_expired", (await expired.text()).includes("event: subscription_expired"), true);

    const huge = await get({ "app-id": "fake-app", "app-secret": "fake-secret" });
    const hugeText = await huge.text();
    check("SSE: evento >64 KB emitido", Buffer.byteLength(hugeText) > 64_000, `${Buffer.byteLength(hugeText)} bytes`);

    const keepalive = await get({ "app-id": "fake-app", "app-secret": "fake-secret" });
    equal("SSE: keepalive", (await keepalive.text()).includes(": keepalive"), true);
    equal("SSE: sin requests no declaradas", fake.log().unexpectedRequests, 0);
  }, "k6-sse.json");
}

async function chatK7(): Promise<void> {
  await scenario("S9 K7 chat: envelopes, send y stream", async (fake) => {
    const base = fake.url;
    const get = (format: string) => fetch(`${base}/v2/p2p/offer-chat-1/chat?format=${format}`, { headers: AUTH_OWNER });

    const array = await (await get("array")).json() as unknown[];
    check("chat: envelope array", Array.isArray(array), JSON.stringify(array).slice(0, 80));
    const data = await (await get("data")).json() as { data?: { messages?: unknown[] } };
    equal("chat: envelope data.messages", data.data?.messages?.length, 1);

    const sent = await fetch(`${base}/v2/p2p/offer-chat-1/chat`, {
      method: "POST",
      headers: AUTH_OWNER,
      body: JSON.stringify({ message: "Hola, sigo interesado" }),
    });
    const sentBody = await sent.json() as { message?: { id?: string } };
    equal("chat: id en message", sentBody.message?.id, "msg-0002");
    equal("chat: efecto persistido en el mundo", (fake.state() as { chats: Record<string, unknown[]> }).chats["offer-chat-1"]?.length, 2);

    const messages = await (await get("messages")).json() as { messages?: unknown[] };
    equal("chat: envelope messages", messages.messages?.length, 1);

    const ambiguous = await fetch(`${base}/v2/p2p/offer-chat-1/chat`, {
      method: "POST",
      headers: AUTH_OWNER,
      body: JSON.stringify({ message: "mensaje incierto" }),
    });
    equal("chat: envío ambiguo responde 200", ambiguous.status, 200);
    await expectRejects("chat: envío ambiguo se corta", ambiguous.text());
    equal("chat: sin requests no declaradas", fake.log().unexpectedRequests, 0);
  }, "k7-chat.json");
}

async function loginK1(): Promise<void> {
  await scenario("S10 K1 login TOTP/PIN, 423 y 429", async (fake) => {
    const base = fake.url;
    const login = (body: Record<string, unknown>) =>
      fetch(`${base}/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    const credentials = { email: "owner@fake.qvapay", password: "correct-horse-1", remember: true };

    const otp = await login(credentials);
    const otpBody = await otp.json() as { has_otp?: boolean };
    equal("login: 202 has_otp", otp.status, 202);
    equal("login: has_otp true", otpBody.has_otp, true);

    const ok = await login({ ...credentials, two_factor_code: "123456" });
    const okBody = await ok.json() as { accessToken?: string };
    equal("login: 200 accessToken", okBody.accessToken, "fake-access-token-0001");

    const rejected = await login({ ...credentials, two_factor_code: "000000" });
    equal("login: TOTP rechazado 401", rejected.status, 401);

    const locked = await login({ ...credentials, two_factor_code: "999999" });
    equal("login: cuenta bloqueada 423", locked.status, 423);

    const rateLimited = await login({ email: "ratelimited@fake.qvapay", password: "correct-horse-2", remember: true });
    equal("login: 429 rate limit", rateLimited.status, 429);
    equal("login: 429 Retry-After", rateLimited.headers.get("retry-after"), "60");
    equal("login: sin requests no declaradas", fake.log().unexpectedRequests, 0);
  }, "k1-login.json");
}

/* ------------------------------------------------------------------ */
/* Helpers de proceso                                                  */
/* ------------------------------------------------------------------ */

function firstLine(stream: NodeJS.ReadableStream, timeoutMs: number): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    let buffer = "";
    const timer = setTimeout(() => reject(new Error(`timeout esperando línea ready (${timeoutMs} ms)`)), timeoutMs);
    stream.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      const newline = buffer.indexOf("\n");
      if (newline >= 0) {
        clearTimeout(timer);
        resolvePromise(buffer.slice(0, newline));
      }
    });
    stream.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

function waitExit(child: ReturnType<typeof spawn>, timeoutMs: number): Promise<void> {
  return new Promise((resolvePromise) => {
    if (child.exitCode !== null) {
      resolvePromise();
      return;
    }
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolvePromise();
    }, timeoutMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolvePromise();
    });
  });
}

/* ------------------------------------------------------------------ */
/* Runner                                                              */
/* ------------------------------------------------------------------ */

const scenarios: Array<[string, () => Promise<void>]> = [
  ["cli-boot", cliBoot],
  ["list-xcache-429", listXcache429],
  ["apply-409-contention", apply409],
  ["apply-429", apply429],
  ["timeout-ambiguous", timeoutAndAmbiguous],
  ["webhook-signed", webhookSigned],
  ["errors-4xx-5xx", errors4xx5xx],
  ["strictness-control", strictnessAndControl],
  ["sse-k6", sseFeed],
  ["chat-k7", chatK7],
  ["login-k1", loginK1],
];

for (const [, run] of scenarios) {
  await run();
}

const elapsed = Date.now() - startedAt;
process.stdout.write(
  `\nfake-qvapay smoke: ${checks - failures}/${checks} checks OK, ${failures} fallos, ${elapsed} ms\n`,
);
if (failures > 0) {
  process.stdout.write(`smoke FALLIDO (${failures} fallos)\n`);
  process.exitCode = 1;
} else if (elapsed >= 10_000) {
  process.stdout.write(`smoke FALLIDO: excede 10 s (${elapsed} ms)\n`);
  process.exitCode = 1;
} else {
  process.stdout.write("smoke OK\n");
}
