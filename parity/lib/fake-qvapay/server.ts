/**
 * Servidor HTTP local determinista que simula la API QvaPay para los tests de
 * contrato y de saga (F0). Escucha solo en 127.0.0.1 (o el host indicado) y su
 * puerto es configurable (`0` = efímero).
 *
 * Contratos cubiertos (docs/migration/analysis/03-boundaries.md §7):
 *  - K1 login TOTP/PIN .............. `/auth/login`, `/auth/request-pin`
 *  - K2 listado ..................... `GET /v2/p2p` (envelope data/offers, x-cache, 429)
 *  - K3 aplicar ..................... `POST /v2/p2p/:uuid/apply`
 *  - K4 mutaciones ambiguas ......... create/edit/cancel/paid/received
 *  - K5 webhook ..................... `POST /webhooks/qvapay/p2p-feed` (receptor de
 *                                     referencia + emisor firmado para el SUT)
 *  - K6 SSE feed .................... `GET /v2/p2p/stream`
 *  - K7 chat ........................ `GET|POST /v2/p2p/:uuid/chat`, `.../chat/stream`
 *  - K12 decimales .................. las respuestas del cassette viajan como string
 *  - K13 dedupe feed ................ misma clave que `src/market-feed.ts`
 *
 * Reglas: sin red externa, sin `sleep` real, sin azar y sin reloj real. Un
 * request que el cassette no declare es un fallo explícito (500 +
 * `unexpectedRequests`). La latencia solo avanza el reloj virtual; los timeouts
 * se simulan con `abort` (`destroy`, `after-headers`, `hang`).
 */
import { createServer, type Server, type ServerResponse } from "node:http";
import type { IncomingMessage } from "node:http";

import { canonicalBodySha256, evaluateLogAssertions, loadCassette, matchesRequest, normalizePath, validateCassette } from "./cassette.js";
import { DEFAULT_CLOCK_MS, VirtualClock } from "./clock.js";
import {
  DEFAULT_WEBHOOK_SECRET,
  FakeWorld,
  WebhookValidationError,
  parseFeedPayload,
  parseWebhookTimestamp,
  sha256Hex,
  signWebhookBody,
  verifyWebhookSignature,
} from "./world.js";
import type {
  AbortMode,
  Cassette,
  CassetteExchange,
  CassetteResponse,
  FakeQvaPayLog,
  RequestKind,
  RequestLogEntry,
  WorldSeed,
} from "./types.js";

const MAX_BODY_BYTES = 1_000_000;
const WEBHOOK_MAX_BODY_BYTES = 10_000;
const WEBHOOK_TIMESTAMP_WINDOW_MS = 5 * 60_000;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

const RELEVANT_HEADERS = [
  "authorization",
  "content-type",
  "accept",
  "app-id",
  "app-secret",
  "x-qvapay-signature",
  "x-qvapay-timestamp",
  "user-agent",
  "idempotency-key",
  "x-request-id",
] as const;

export interface StartFakeQvaPayOptions {
  /** Ruta a un cassette JSON o el cassette ya validado/en memoria. */
  cassette: Cassette | string;
  host?: string;
  port?: number;
  /** Silencia avisos por stderr (el CLI siempre imprime la línea `ready`). */
  quiet?: boolean;
}

export interface FakeQvaPayHandle {
  url: string;
  host: string;
  port: number;
  cassette: Cassette;
  server: Server;
  close(): Promise<void>;
  /** Snapshot del log ordenado de requests (para comparar mutationParity). */
  log(): FakeQvaPayLog;
  /** Snapshot del mundo determinista (ofertas, usuario, webhook dedupe…). */
  state(): Record<string, unknown>;
  /** Avanza el reloj virtual sin dormir. */
  advance(milliseconds: number): number;
  /** Reinicia estado/log/reloj; opcionalmente sustituye el cassette. */
  reset(cassette?: Cassette): void;
}

interface State {
  cassette: Cassette;
  clock: VirtualClock;
  world: FakeWorld;
  requests: RequestLogEntry[];
  exchanges: { exchange: CassetteExchange; consumed: number }[];
  seq: number;
  unexpected: number;
  assertionFailures: string[];
  pending: Set<ServerResponse>;
}

/* ------------------------------------------------------------------ */
/* Arranque                                                            */
/* ------------------------------------------------------------------ */

export async function startFakeQvaPay(options: StartFakeQvaPayOptions): Promise<FakeQvaPayHandle> {
  const cassette = typeof options.cassette === "string"
    ? loadCassette(options.cassette).cassette
    : validateCassette(options.cassette);
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 0;
  const state = createState(cassette);
  const server = createServer((request, response) => {
    void dispatch(state, request, response).catch((error: unknown) => {
      if (state.listening) process.stderr.write(`fake-qvapay: error interno: ${String(error)}\n`);
      if (!response.headersSent) {
        response.writeHead(500, { "content-type": "application/json; charset=utf-8" });
        response.end(JSON.stringify({ error: "Error interno del fake", code: "FAKE_INTERNAL_ERROR" }));
      } else {
        response.destroy();
      }
    });
  });
  server.on("clientError", (_error, socket) => {
    socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });

  const address = server.address();
  const boundPort = typeof address === "object" && address ? address.port : port;
  state.listening = true;
  const url = `http://${host}:${boundPort}`;

  return {
    url,
    host,
    port: boundPort,
    cassette,
    server,
    async close() {
      state.listening = false;
      for (const pending of state.pending) pending.destroy();
      state.pending.clear();
      server.closeAllConnections?.();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
    log: () => snapshotLog(state),
    state: () => state.world.snapshot(),
    advance: (milliseconds: number) => state.clock.advance(milliseconds),
    reset: (next?: Cassette) => resetState(state, next ? validateCassette(next) : undefined),
  };
}

function createState(cassette: Cassette): State & { listening?: boolean } {
  const clock = new VirtualClock(cassette.clockMs ?? DEFAULT_CLOCK_MS);
  const world = new FakeWorld(cassette.world ?? {}, clock, cassette.webhookSecret ?? DEFAULT_WEBHOOK_SECRET);
  return {
    cassette,
    clock,
    world,
    requests: [],
    exchanges: cassette.exchanges.map((exchange) => ({
      exchange,
      consumed: 0,
    })),
    seq: 0,
    unexpected: 0,
    assertionFailures: [],
    pending: new Set(),
    listening: false,
  };
}

function resetState(state: State, next?: Cassette): void {
  for (const pending of state.pending) pending.destroy();
  state.pending.clear();
  if (next) {
    state.cassette = next;
    state.exchanges = next.exchanges.map((exchange) => ({ exchange, consumed: 0 }));
    state.clock = new VirtualClock(next.clockMs ?? DEFAULT_CLOCK_MS);
    state.world = new FakeWorld(next.world ?? {}, state.clock, next.webhookSecret ?? DEFAULT_WEBHOOK_SECRET);
  } else {
    state.clock.set(state.cassette.clockMs ?? DEFAULT_CLOCK_MS);
    state.world.reset();
    for (const entry of state.exchanges) entry.consumed = 0;
  }
  state.requests.length = 0;
  state.seq = 0;
  state.unexpected = 0;
  state.assertionFailures.length = 0;
}

/* ------------------------------------------------------------------ */
/* Dispatch                                                            */
/* ------------------------------------------------------------------ */

async function dispatch(state: State, request: IncomingMessage, response: ServerResponse): Promise<void> {
  const method = (request.method ?? "GET").toUpperCase();
  const url = new URL(request.url ?? "/", "http://127.0.0.1");

  if (method === "POST" && url.pathname === "/webhooks/qvapay/p2p-feed") {
    const { raw, tooLarge } = await readBody(request, WEBHOOK_MAX_BODY_BYTES + 1);
    await handleWebhook(state, request, response, raw, tooLarge);
    return;
  }

  if (url.pathname.startsWith("/__fake/")) {
    const { raw } = await readBody(request, MAX_BODY_BYTES);
    await handleControl(state, request, response, url, raw);
    return;
  }

  const { raw, tooLarge } = await readBody(request, MAX_BODY_BYTES);
  await handleApi(state, request, response, url, raw, tooLarge);
}

function readBody(request: IncomingMessage, limit: number): Promise<{ raw: Buffer; tooLarge: boolean }> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) tooLarge = true;
      else chunks.push(chunk);
    });
    request.on("end", () => resolve({ raw: Buffer.concat(chunks), tooLarge }));
    request.on("error", reject);
  });
}

/* ------------------------------------------------------------------ */
/* API simulada (cassette estricto)                                    */
/* ------------------------------------------------------------------ */

async function handleApi(
  state: State,
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  raw: Buffer,
  tooLarge: boolean,
): Promise<void> {
  const fakeRequest = buildFakeRequest(request, url, raw);
  const entry = createLogEntry(state, "api", fakeRequest);
  state.requests.push(entry);

  if (tooLarge) {
    entry.status = 413;
    entry.responseHeaders = { "content-type": "application/json; charset=utf-8" };
    entry.responseEnded = true;
    sendJson(response, 413, { error: "Body demasiado grande para el fake", code: "FAKE_BODY_TOO_LARGE" });
    return;
  }

  const match = findExchange(state, fakeRequest);
  if (!match) {
    state.unexpected += 1;
    entry.status = 500;
    entry.responseHeaders = { "content-type": "application/json; charset=utf-8" };
    entry.responseEnded = true;
    sendJson(response, 500, {
      error: "Request no declarada en el cassette",
      code: "FAKE_UNEXPECTED_REQUEST",
      request: {
        method: fakeRequest.method,
        path: fakeRequest.path,
        query: fakeRequest.query,
      },
    });
    return;
  }

  const { exchange, index } = match;
  state.exchanges[index]!.consumed += 1;
  entry.exchange = exchange.id!;
  entry.contract = exchange.contract ?? null;

  if (exchange.logAssertions) {
    const errors = evaluateLogAssertions(exchange.logAssertions, fakeRequest);
    if (errors.length) {
      entry.assertionErrors = errors;
      entry.status = 500;
      entry.responseHeaders = { "content-type": "application/json; charset=utf-8" };
      entry.responseEnded = true;
      state.assertionFailures.push(...errors.map((error) => `${exchange.id}: ${error}`));
      sendJson(response, 500, {
        error: "logAssertions fallaron",
        code: "FAKE_LOG_ASSERTION_FAILED",
        exchange: exchange.id,
        failures: errors,
      });
      return;
    }
  }

  // Latencia virtual: NO se duerme; se avanza el reloj y se anota en el log.
  const delayMs = exchange.delayMs ?? 0;
  if (delayMs > 0) {
    entry.latencyMs = delayMs;
    state.clock.advance(delayMs);
  }

  try {
    state.world.applyEffects(exchange.effects ?? [], state.clock.now());
  } catch (error) {
    entry.status = 500;
    entry.responseHeaders = { "content-type": "application/json; charset=utf-8" };
    entry.responseEnded = true;
    sendJson(response, 500, {
      error: `effects inválidos: ${error instanceof Error ? error.message : String(error)}`,
      code: "FAKE_EFFECT_FAILED",
      exchange: exchange.id,
    });
    return;
  }

  serveExchange(state, response, exchange, entry);
}

function findExchange(
  state: State,
  request: ReturnType<typeof buildFakeRequest>,
): { exchange: CassetteExchange; index: number } | undefined {
  for (let index = 0; index < state.exchanges.length; index += 1) {
    const record = state.exchanges[index]!;
    const atMost = record.exchange.atMost ?? 1;
    if (record.consumed >= atMost) continue;
    if (matchesRequest(record.exchange, request)) return { exchange: record.exchange, index };
  }
  return undefined;
}

function serveExchange(
  state: State,
  response: ServerResponse,
  exchange: CassetteExchange,
  entry: RequestLogEntry,
): void {
  const spec: CassetteResponse = exchange.response ?? {};
  const status = spec.status ?? 200;
  const headers = normalizeHeaders(spec.headers);
  headers["x-fake-cassette"] = state.cassette.name;
  headers["x-fake-exchange"] = exchange.id!;
  headers["x-fake-virtual-now"] = String(state.clock.now());
  if (exchange.delayMs !== undefined) headers["x-fake-latency-ms"] = String(exchange.delayMs);
  const abort = exchange.abort;

  // Timeout de transporte sin dormir: se cuelga la respuesta; el SUT aborta.
  if (abort === "hang") {
    entry.aborted = "hang";
    entry.status = null;
    entry.responseEnded = false;
    state.pending.add(response);
    response.on("close", () => {
      state.pending.delete(response);
      entry.responseEnded = false;
    });
    return;
  }

  // Reset de conexión antes de cualquier byte de respuesta.
  if (abort === "destroy") {
    entry.aborted = "destroy";
    entry.status = null;
    entry.responseEnded = false;
    response.destroy();
    return;
  }

  if (spec.sse) {
    serveSse(state, response, exchange, entry, headers, status);
    return;
  }

  const hasJsonBody = spec.body !== undefined;
  let materialized: unknown;
  try {
    materialized = materializeBody(state, spec.body);
  } catch (error) {
    entry.status = 500;
    entry.responseHeaders = { "content-type": "application/json; charset=utf-8" };
    entry.responseEnded = true;
    sendJson(response, 500, {
      error: `template de respuesta inválido: ${error instanceof Error ? error.message : String(error)}`,
      code: "FAKE_TEMPLATE_FAILED",
      exchange: exchange.id,
    });
    return;
  }
  const payload = hasJsonBody ? JSON.stringify(materialized) : spec.bodyRaw ?? "";
  if (!headers["content-type"]) {
    headers["content-type"] = hasJsonBody ? "application/json; charset=utf-8" : "text/plain; charset=utf-8";
  }

  // Respuesta ambigua tras mutación: status+headers+body parcial y corte (K4).
  if (abort === "after-headers") {
    const partial = spec.partialBody ?? payload.slice(0, Math.max(1, Math.floor(payload.length / 2)));
    entry.aborted = "after-headers";
    entry.status = status;
    entry.responseHeaders = { ...headers };
    entry.responseBodySha256 = sha256Hex(partial);
    entry.responseEnded = false;
    response.writeHead(status, headers);
    response.write(partial, () => {
      response.destroy();
    });
    response.on("close", () => {
      entry.responseEnded = false;
    });
    return;
  }

  entry.status = status;
  entry.responseHeaders = { ...headers };
  entry.responseBodySha256 = sha256Hex(payload);
  entry.responseEnded = true;
  response.writeHead(status, headers);
  response.end(payload);
}

function serveSse(
  state: State,
  response: ServerResponse,
  exchange: CassetteExchange,
  entry: RequestLogEntry,
  headers: Record<string, string>,
  status: number,
): void {
  const sse = exchange.response!.sse!;
  headers["content-type"] = "text/event-stream; charset=utf-8";
  headers["cache-control"] = "no-store";
  headers["connection"] = "keep-alive";
  let payload = "";
  if (sse.retryMs !== undefined) payload += `retry: ${sse.retryMs}\n\n`;
  for (const event of sse.events) {
    if (event.comment) payload += `: ${event.comment}\n`;
    if (event.event) payload += `event: ${event.event}\n`;
    const data = typeof event.data === "string" ? event.data : JSON.stringify(event.data ?? {});
    payload += `data: ${data}\n\n`;
  }
  entry.status = status;
  entry.responseHeaders = { ...headers };
  entry.responseBodySha256 = sha256Hex(payload);
  response.writeHead(status, headers);
  response.write(payload);
  if (sse.holdOpen) {
    entry.responseEnded = false;
    state.pending.add(response);
    response.on("close", () => {
      state.pending.delete(response);
      entry.responseEnded = false;
    });
    return;
  }
  entry.responseEnded = true;
  response.end();
}

/* ------------------------------------------------------------------ */
/* Control (`/__fake/*`)                                               */
/* ------------------------------------------------------------------ */

async function handleControl(
  state: State,
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  raw: Buffer,
): Promise<void> {
  const method = (request.method ?? "GET").toUpperCase();
  const path = url.pathname;
  const body = parseJson(raw);

  if (method === "GET" && path === "/__fake/health") {
    sendJson(response, 200, {
      ok: true,
      cassette: state.cassette.name,
      contract: state.cassette.contract ?? null,
      virtualNow: state.clock.now(),
      requests: state.requests.length,
      unexpectedRequests: state.unexpected,
    });
    return;
  }
  if (method === "GET" && path === "/__fake/log") {
    sendJson(response, 200, snapshotLog(state));
    return;
  }
  if (method === "GET" && path === "/__fake/state") {
    sendJson(response, 200, state.world.snapshot());
    return;
  }
  if (method === "POST" && path === "/__fake/advance") {
    const milliseconds = numberOr(body?.ms, 1_000);
    if (!Number.isFinite(milliseconds) || milliseconds < 0) {
      sendJson(response, 400, { error: "`ms` debe ser un número >= 0", code: "FAKE_BAD_ADVANCE" });
      return;
    }
    const virtualNow = state.clock.advance(milliseconds);
    sendJson(response, 200, { ok: true, advancedMs: milliseconds, virtualNow });
    return;
  }
  if (method === "POST" && path === "/__fake/reset") {
    const replacement = body?.cassette;
    if (replacement !== undefined) resetState(state, validateCassette(replacement));
    else resetState(state);
    sendJson(response, 200, {
      ok: true,
      cassette: state.cassette.name,
      virtualNow: state.clock.now(),
      requests: state.requests.length,
    });
    return;
  }
  if (method === "POST" && path === "/__fake/webhook/send") {
    await handleWebhookSend(state, response, body);
    return;
  }
  sendJson(response, 404, {
    error: `Endpoint de control desconocido: ${method} ${path}`,
    code: "FAKE_CONTROL_NOT_FOUND",
  });
}

/**
 * Emisor de webhooks firmados (K5): permite al runner/adaptador simular a
 * QvaPay enviando un evento al SUT. La firma la calcula el fake con el secreto
 * del cassette, nunca QvaPay real. Solo destinos loopback.
 */
async function handleWebhookSend(
  state: State,
  response: ServerResponse,
  body: Record<string, unknown> | undefined,
): Promise<void> {
  const target = typeof body?.targetUrl === "string"
    ? body.targetUrl
    : typeof body?.url === "string"
      ? body.url
      : undefined;
  if (!target) {
    sendJson(response, 400, { error: "Falta `targetUrl`", code: "FAKE_BAD_WEBHOOK_TARGET" });
    return;
  }
  let parsed: URL;
  try {
    parsed = new URL(target);
  } catch {
    sendJson(response, 400, { error: `URL inválida: ${target}`, code: "FAKE_BAD_WEBHOOK_TARGET" });
    return;
  }
  if (parsed.protocol !== "http:" || !LOOPBACK_HOSTS.has(parsed.hostname)) {
    sendJson(response, 400, {
      error: "El fake solo envía webhooks a destinos loopback (sin red externa)",
      code: "FAKE_TARGET_NOT_LOOPBACK",
    });
    return;
  }
  if (!body || body.payload === undefined) {
    sendJson(response, 400, { error: "Falta `payload`", code: "FAKE_BAD_WEBHOOK_PAYLOAD" });
    return;
  }
  const rawBody = JSON.stringify(body.payload);
  const secret = typeof body.secret === "string" ? body.secret : state.world.webhookSecret;
  const timestampMs = numberOr(body.timestampMs, state.clock.now());
  const signature = signWebhookBody(rawBody, secret);
  try {
    const sent = await fetch(parsed, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-qvapay-signature": signature,
        "x-qvapay-timestamp": String(timestampMs),
      },
      body: rawBody,
      redirect: "error",
      signal: AbortSignal.timeout(5_000),
    });
    const text = await sent.text();
    sendJson(response, 200, {
      ok: true,
      target: parsed.href,
      request: {
        bodyBytes: Buffer.byteLength(rawBody),
        bodySha256: sha256Hex(rawBody),
        signature,
        timestamp: String(timestampMs),
      },
      response: {
        status: sent.status,
        headers: {
          "content-type": sent.headers.get("content-type"),
        },
        body: text,
      },
    });
  } catch (error) {
    sendJson(response, 502, {
      error: `No se pudo entregar el webhook: ${error instanceof Error ? error.message : String(error)}`,
      code: "FAKE_WEBHOOK_DELIVERY_FAILED",
    });
  }
}

/* ------------------------------------------------------------------ */
/* Webhook entrante (receptor de referencia, K5/K13)                   */
/* ------------------------------------------------------------------ */

async function handleWebhook(
  state: State,
  request: IncomingMessage,
  response: ServerResponse,
  raw: Buffer,
  tooLarge: boolean,
): Promise<void> {
  const fakeRequest = buildFakeRequest(request, new URL(request.url ?? "/", "http://127.0.0.1"), raw);
  const entry = createLogEntry(state, "webhook", fakeRequest);
  state.requests.push(entry);
  const signature = headerValue(request, "x-qvapay-signature");
  const timestampHeader = headerValue(request, "x-qvapay-timestamp");

  try {
    if (tooLarge || raw.length > WEBHOOK_MAX_BODY_BYTES) {
      throw new WebhookValidationError(400, "Payload del feed inválido.");
    }
    if (raw.length === 0) throw new WebhookValidationError(400, "Payload del feed inválido.");
    const timestamp = parseWebhookTimestamp(timestampHeader);
    if (Math.abs(state.clock.now() - timestamp) > WEBHOOK_TIMESTAMP_WINDOW_MS) {
      throw new WebhookValidationError(401, "Timestamp del feed vencido.");
    }
    verifyWebhookSignature(raw, signature, state.world.webhookSecret);
    const payload = parseFeedPayload(raw);
    const { key, duplicate } = state.world.receiveWebhook(payload, state.clock.now());
    entry.exchange = "webhook";
    entry.contract = "K5";
    entry.status = 202;
    entry.responseHeaders = { "content-type": "application/json; charset=utf-8" };
    entry.responseBodySha256 = null;
    entry.responseEnded = true;
    entry.bodyJson = { ...(entry.bodyJson as Record<string, unknown> | undefined), __dedupeKey: key };
    sendJson(response, 202, { ok: true, duplicate, queued: !duplicate, key });
  } catch (error) {
    const status = error instanceof WebhookValidationError ? error.status : 500;
    entry.status = status;
    entry.responseHeaders = { "content-type": "application/json; charset=utf-8" };
    entry.responseEnded = true;
    sendJson(response, status, {
      ok: false,
      error: error instanceof Error ? error.message : "Webhook inválido",
      ...(status === 500 ? { code: "FAKE_WEBHOOK_INTERNAL_ERROR" } : {}),
    });
  }
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function buildFakeRequest(request: IncomingMessage, url: URL, raw: Buffer) {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(request.headers)) {
    if (typeof value === "string") headers[name.toLowerCase()] = value;
    else if (Array.isArray(value)) headers[name.toLowerCase()] = value.join(",");
  }
  const query: Record<string, string[]> = {};
  for (const [key, value] of url.searchParams.entries()) {
    (query[key] ??= []).push(value);
  }
  const querySorted = Object.entries(query)
    .flatMap(([key, values]) => values.map((value) => `${key}=${value}`))
    .sort()
    .join("&");
  const bodyText = raw.toString("utf8");
  let bodyJson: unknown;
  if (bodyText.trim()) {
    try {
      bodyJson = JSON.parse(bodyText);
    } catch {
      bodyJson = undefined;
    }
  }
  return {
    method: (request.method ?? "GET").toUpperCase(),
    path: url.pathname,
    normalizedPath: normalizePath(url.pathname),
    query,
    querySorted,
    headers,
    bodyText,
    bodyJson,
    bodySha256: canonicalBodySha256(bodyText, bodyJson),
  };
}

function createLogEntry(
  state: State,
  kind: RequestKind,
  request: ReturnType<typeof buildFakeRequest>,
): RequestLogEntry {
  state.seq += 1;
  const { headers, headerHashes } = logHeaders(request.headers);
  return {
    seq: state.seq,
    kind,
    virtualAt: state.clock.now(),
    method: request.method,
    path: request.path,
    normalizedPath: request.normalizedPath,
    query: request.query,
    querySorted: request.querySorted,
    headers,
    headerHashes,
    bodyBytes: Buffer.byteLength(request.bodyText),
    bodySha256: request.bodySha256,
    bodyJson: request.bodyText.length <= 2_048 ? request.bodyJson ?? null : null,
    exchange: null,
    contract: null,
    status: null,
    responseHeaders: {},
    responseBodySha256: null,
    latencyMs: null,
    aborted: null,
    responseEnded: false,
    assertionErrors: [],
  };
}

function logHeaders(input: Record<string, string>): {
  headers: Record<string, string | null>;
  headerHashes: Record<string, string>;
} {
  const headers: Record<string, string | null> = {};
  const headerHashes: Record<string, string> = {};
  for (const name of RELEVANT_HEADERS) {
    const value = input[name];
    if (value === undefined) {
      headers[name] = null;
      continue;
    }
    if (name === "authorization") {
      headers[name] = `${value.split(/\s+/)[0] ?? ""} <redacted>`;
      headerHashes[name] = sha256Hex(value);
    } else if (name === "app-secret") {
      headers[name] = "<redacted>";
      headerHashes[name] = sha256Hex(value);
    } else {
      headers[name] = value;
    }
  }
  return { headers, headerHashes };
}

function snapshotLog(state: State): FakeQvaPayLog {
  const unconsumed = state.exchanges
    .filter((record) => record.consumed === 0 && record.exchange.optional !== true)
    .map((record) => record.exchange.id!);
  return {
    cassette: state.cassette.name,
    contract: state.cassette.contract ?? null,
    virtualNow: state.clock.now(),
    startedAtVirtual: state.cassette.clockMs ?? DEFAULT_CLOCK_MS,
    requestCount: state.requests.length,
    unexpectedRequests: state.unexpected,
    assertionFailures: [...state.assertionFailures],
    requests: state.requests.map((entry) => structuredClone(entry)),
    exchanges: state.exchanges.map((record) => ({
      id: record.exchange.id!,
      contract: record.exchange.contract ?? null,
      method: record.exchange.match.method,
      path: record.exchange.match.path,
      query: record.exchange.match.query ? JSON.stringify(record.exchange.match.query) : null,
      consumed: record.consumed,
      atMost: record.exchange.atMost ?? 1,
      optional: record.exchange.optional === true,
    })),
    unconsumed,
  };
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  if (!response.headersSent) {
    response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  }
  response.end(payload);
}

function normalizeHeaders(input: Record<string, string> | undefined): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(input ?? {})) headers[name.toLowerCase()] = value;
  return headers;
}

function headerValue(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name];
  return typeof value === "string" ? value : Array.isArray(value) ? value[0] : undefined;
}

function parseJson(raw: Buffer): Record<string, unknown> | undefined {
  if (raw.length === 0) return undefined;
  try {
    const parsed = JSON.parse(raw.toString("utf8")) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/**
 * Resuelve plantillas reservadas en `response.body` para que un cassette pueda
 * devolver el estado del mundo sin duplicar datos:
 *   - `{"$offer": "<uuid>"}` → la oferta actual de `world.offers`
 *   - `{"$state": true}`     → snapshot completo del mundo (solo depuración)
 */
function materializeBody(state: State, value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => materializeBody(state, item));
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record);
    if (keys.length === 1 && typeof record.$offer === "string") {
      const offer = state.world.findOffer(record.$offer);
      if (!offer) throw new Error(`$offer: no existe la oferta ${record.$offer} en world.offers`);
      return structuredClone(offer);
    }
    if (keys.length === 1 && record.$state === true) return state.world.snapshot();
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(record)) out[key] = materializeBody(state, item);
    return out;
  }
  return value;
}

/** Reexport para pruebas in-process sin pasar por el CLI. */
export { DEFAULT_CLOCK_MS, DEFAULT_WEBHOOK_SECRET };
export type { Cassette, FakeQvaPayLog, WorldSeed, AbortMode };
