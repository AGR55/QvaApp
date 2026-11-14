/**
 * Driver de escenarios HTTP in-process para la suite L2 (`--suite http`).
 *
 * Un escenario construye la aplicación real (`buildDashboard`) con dobles
 * deterministas, ejecuta una secuencia de peticiones con `app.inject` y
 * devuelve la observación canónica: petición, status, headers estables, body y
 * efectos sobre el modelo. No hay sockets, red, reloj real ni sleeps.
 *
 * Las peticiones y los efectos se congelan en goldens; el adaptador del SUT
 * recibe solo `{scenario: "<id>"}` y debe reproducir la misma observación.
 */
import { createHash } from "node:crypto";
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from "fastify";
import { normalizeValue } from "../scenario/normalize.js";

export interface HttpStepObservation {
  request: {
    method: string;
    url: string;
    headers: Record<string, string>;
    payload: unknown;
  };
  status: number;
  headers: Record<string, string | string[]>;
  body: unknown;
}

export interface HttpScenario {
  /** Identificador estable, p. ej. `http-dashboard/01-auth-csrf`. */
  id: string;
  /** Archivo de origen, p. ej. `test/http-dashboard.test.ts`. */
  file: string;
  /** Línea/origen del test que congela el escenario. */
  source: string;
  /** Construye la app Fastify con los dobles del escenario. */
  build(): FastifyInstance | Promise<FastifyInstance>;
  /** Ejecuta las peticiones y registra efectos. */
  run(app: FastifyInstance, ctx: HttpScenarioContext): Promise<void> | void;
}

const STABLE_RESPONSE_HEADERS = new Set([
  "cache-control",
  "content-encoding",
  "content-type",
  "location",
  "vary",
  "www-authenticate",
  "x-content-type-options",
  "x-frame-options",
]);

const STABLE_REQUEST_HEADERS = new Set([
  "accept-encoding",
  "content-type",
  "origin",
]);

function stableRequestHeaders(headers: InjectOptions["headers"]): Record<string, string> {
  const output: Record<string, string> = {};
  if (!headers) return output;
  for (const [rawName, rawValue] of Object.entries(headers)) {
    if (rawValue === undefined) continue;
    const name = rawName.toLowerCase();
    const value = /^multipart\//i.test(String(rawValue))
      ? String(rawValue).replace(/boundary=.*$/i, "boundary=<boundary>")
      : String(rawValue);
    if (STABLE_REQUEST_HEADERS.has(name)) output[name] = value;
    else if (name === "authorization") output[name] = /^Bearer\s+\S+$/i.test(value) ? "Bearer <redacted>" : "<redacted>";
    else if (name === "cookie") output[name] = cookieNames(value);
    else if (name === "x-csrf-token") output[name] = value ? "<csrf>" : "";
  }
  return output;
}

function cookieNames(value: string): string {
  return value
    .split(";")
    .map((part) => part.split("=", 1)[0]!.trim())
    .filter(Boolean)
    .sort()
    .map((name) => `${name}=<redacted>`)
    .join("; ");
}

function stableResponseHeaders(headers: LightMyRequestResponse["headers"]): Record<string, string | string[]> {
  const output: Record<string, string | string[]> = {};
  for (const [rawName, rawValue] of Object.entries(headers)) {
    const name = rawName.toLowerCase();
    if (rawValue === undefined) continue;
    if (name === "set-cookie") {
      const values = Array.isArray(rawValue) ? rawValue : [String(rawValue)];
      output[name] = values
        .map((cookie) => cookie.split(";", 1)[0]!.split("=", 1)[0]!.trim())
        .sort()
        .map((cookieName) => `${cookieName}=<redacted>`);
      continue;
    }
    if (!STABLE_RESPONSE_HEADERS.has(name)) continue;
    output[name] = Array.isArray(rawValue) ? rawValue.map(String) : String(rawValue);
  }
  return output;
}

function isTextual(contentType: string | undefined): boolean {
  if (!contentType) return false;
  return /^text\//i.test(contentType) || /javascript|json|xml|css|svg/i.test(contentType);
}

function normalizePayload(payload: InjectOptions["payload"], contentType: string): unknown {
  if (payload === undefined || payload === null) return null;
  if (typeof payload === "string") return payload.length <= 4_096 ? payload : { sha256: sha256(payload), bytes: Buffer.byteLength(payload) };
  if (payload instanceof Uint8Array || Buffer.isBuffer(payload)) {
    const bytes = Buffer.from(payload);
    // El boundary de multipart es aleatorio: se congela el tamaño, no el hash.
    if (/^multipart\//i.test(contentType)) return { multipart: true, bytes: bytes.length };
    return { sha256: sha256(bytes), bytes: bytes.length };
  }
  return normalizeJsonBody(payload);
}

/**
 * Campos volátiles de sesión: el token CSRF es aleatorio y `expiresAt` depende
 * del reloj. Se sustituyen por marcadores estables; el flujo (401/403/201) y
 * el resto del body siguen congelados.
 */
const VOLATILE_BODY_FIELDS = new Set(["csrftoken", "expiresat", "sessionid", "sessiontoken", "cookie", "receivedat"]);
const UUID_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/** Los UUID generados por el oráculo no son comportamiento: se congelan como `<uuid>`. */
function normalizeVolatileText(value: string): string {
  return value
    .replace(UUID_PATTERN, "<uuid>")
    .replace(/("csrfToken"\s*:\s*)"[^"]*"/g, '$1"<csrftoken>"')
    .replace(/("expiresAt"\s*:\s*)\d+/g, '$1"<expiresat>"');
}

function normalizeJsonBody(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeJsonBody);
  if (typeof value === "string") return normalizeVolatileText(value);
  if (value && typeof value === "object" && !(value instanceof Date)) {
    const output: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const field = (value as Record<string, unknown>)[key];
      const lower = key.toLowerCase();
      output[key] = VOLATILE_BODY_FIELDS.has(lower)
        ? `<${lower}>`
        : /at$/.test(lower) && typeof field === "number" && field > 1e12
          ? "<timestamp>"
          : normalizeJsonBody(field);
    }
    return output;
  }
  return normalizeValue(value);
}

function normalizeHttpBody(response: LightMyRequestResponse): unknown {
  const contentType = String(response.headers["content-type"] ?? "");
  const bytes = response.rawPayload;
  if (/application\/json/i.test(contentType)) {
    try {
      return normalizeJsonBody(JSON.parse(response.body));
    } catch {
      return { sha256: sha256(bytes), bytes: bytes.length, invalidJson: true };
    }
  }
  if (isTextual(contentType)) {
    const text = normalizeVolatileText(response.body);
    return text.length <= 4_096
      ? text
      : { sha256: sha256(text), bytes: Buffer.byteLength(text) };
  }
  return { sha256: sha256(bytes), bytes: bytes.length };
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * Contexto de un escenario: `call` reemplaza a `app.inject` y registra la
 * observación; `effect` registra llamadas al modelo o cualquier efecto
 * determinista que el contrato quiera congelar.
 */
export class HttpScenarioContext {
  readonly steps: HttpStepObservation[] = [];
  readonly effects: Array<{ effect: string; value: unknown }> = [];

  async call(app: FastifyInstance, options: InjectOptions): Promise<LightMyRequestResponse> {
    const response = await app.inject(options);
    const requestContentType = String(
      (options.headers as Record<string, unknown> | undefined)?.["content-type"] ??
        (options.headers as Record<string, unknown> | undefined)?.["Content-Type"] ??
        "",
    );
    this.steps.push({
      request: {
        method: (options.method ?? "GET").toUpperCase(),
        url: normalizeVolatileText(options.url),
        headers: stableRequestHeaders(options.headers),
        payload: normalizePayload(options.payload, requestContentType),
      },
      status: response.statusCode,
      headers: stableResponseHeaders(response.headers),
      body: normalizeHttpBody(response),
    });
    return response;
  }

  effect(name: string, value: unknown): void {
    this.effects.push({ effect: name, value: normalizeEffectValue(value) });
  }

  /** Registra un valor derivado (contadores, flags) como efecto observado. */
  value(name: string, value: unknown): void {
    this.effects.push({ effect: `value:${name}`, value: normalizeEffectValue(value) });
  }
}

/** Los valores derivados pueden contener marcas de tiempo de reloj real. */
function normalizeEffectValue(value: unknown): unknown {
  if (typeof value === "string") return normalizeVolatileText(value);
  if (Array.isArray(value)) return value.map(normalizeEffectValue);
  if (value && typeof value === "object" && !(value instanceof Date) && !(value instanceof Uint8Array)) {
    const output: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const field = (value as Record<string, unknown>)[key];
      const lower = key.toLowerCase();
      output[key] = VOLATILE_BODY_FIELDS.has(lower)
        ? `<${lower}>`
        : /at$/.test(lower) && typeof field === "number" && field > 1e12
          ? "<timestamp>"
          : normalizeEffectValue(field);
    }
    return output;
  }
  return normalizeValue(value);
}

export interface HttpScenarioObservation {
  steps: HttpStepObservation[];
  effects: Array<{ effect: string; value: unknown }>;
}

export async function runHttpScenario(scenario: HttpScenario): Promise<HttpScenarioObservation> {
  const app = await scenario.build();
  const ctx = new HttpScenarioContext();
  try {
    await scenario.run(app, ctx);
  } finally {
    await app.close();
  }
  return { steps: ctx.steps, effects: ctx.effects };
}
