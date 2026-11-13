/**
 * Carga, validación y match estricto de cassettes (K1–K14).
 *
 * Un cassette es un autómata finito ordenado: cada request entrante consume la
 * primera exchange no agotada cuyo `match` cumple. Si ninguna cumple, el fake
 * responde 500 `FAKE_UNEXPECTED_REQUEST` y lo cuenta en el log: un request no
 * declarado es un fallo explícito, nunca un comodín.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { canonicalHash, equalCanonical } from "../canonical.js";
import type {
  Cassette,
  CassetteExchange,
  CassetteMatch,
  CassetteResponse,
  LogAssertions,
  WorldEffect,
} from "./types.js";

export class CassetteError extends Error {
  constructor(message: string, readonly path: string) {
    super(`${message} (${path})`);
    this.name = "CassetteError";
  }
}

const HTTP_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);
const ABORT_MODES = new Set(["destroy", "after-headers", "hang"]);

export interface LoadedCassette {
  cassette: Cassette;
  file: string | null;
}

export function loadCassette(file: string): LoadedCassette {
  const raw = readFileSync(file, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new CassetteError(`JSON inválido: ${String(error)}`, file);
  }
  return { cassette: validateCassette(parsed, file), file };
}

export function validateCassette(value: unknown, path = "<inline>"): Cassette {
  if (!isRecord(value)) throw new CassetteError("El cassette debe ser un objeto JSON", path);
  if (typeof value.name !== "string" || !value.name.trim()) {
    throw new CassetteError("Falta `name` del cassette", path);
  }
  if (!Array.isArray(value.exchanges)) {
    throw new CassetteError("Falta el array `exchanges`", path);
  }
  if (value.cassetteVersion !== undefined && value.cassetteVersion !== 1) {
    throw new CassetteError(`cassetteVersion no soportada: ${String(value.cassetteVersion)}`, path);
  }
  if (value.clockMs !== undefined && (!Number.isFinite(value.clockMs) || (value.clockMs as number) < 0)) {
    throw new CassetteError("`clockMs` debe ser un epoch ms no negativo", path);
  }
  if (value.world !== undefined) validateWorldSeed(value.world, `${path}.world`);
  if (value.webhookSecret !== undefined && typeof value.webhookSecret !== "string") {
    throw new CassetteError("`webhookSecret` debe ser string", path);
  }

  const exchanges = value.exchanges.map((exchange, index) =>
    validateExchange(exchange, `${path}.exchanges[${index}]`),
  );

  const ids = new Set<string>();
  for (const exchange of exchanges) {
    if (ids.has(exchange.id!)) throw new CassetteError(`Id de exchange duplicado: ${exchange.id}`, path);
    ids.add(exchange.id!);
  }

  const cassette: Cassette = {
    cassetteVersion: 1,
    name: value.name,
    exchanges,
  };
  if (typeof value.description === "string") cassette.description = value.description;
  if (typeof value.contract === "string") cassette.contract = value.contract;
  if (typeof value.clockMs === "number") cassette.clockMs = value.clockMs;
  if (typeof value.webhookSecret === "string") cassette.webhookSecret = value.webhookSecret;
  if (value.world !== undefined) cassette.world = value.world as Cassette["world"];
  return cassette;
}

function validateExchange(value: unknown, path: string): CassetteExchange {
  if (!isRecord(value)) throw new CassetteError("Cada exchange debe ser un objeto", path);
  const match = value.match;
  if (!isRecord(match)) throw new CassetteError("Falta `match`", path);
  if (typeof match.method !== "string" || !HTTP_METHODS.has(match.method.toUpperCase())) {
    throw new CassetteError(`Método inválido: ${String(match.method)}`, path);
  }
  if (typeof match.path !== "string" || !match.path.startsWith("/")) {
    throw new CassetteError("`match.path` debe empezar por `/`", path);
  }
  validateMatchConditions(match, path);

  if (value.response !== undefined) validateResponse(value.response, `${path}.response`);
  if (value.abort !== undefined) {
    if (typeof value.abort !== "string" || !ABORT_MODES.has(value.abort)) {
      throw new CassetteError(`Modo abort inválido: ${String(value.abort)}`, path);
    }
  }
  const delayMs = value.delayMs;
  if (delayMs !== undefined && (typeof delayMs !== "number" || !Number.isFinite(delayMs) || delayMs < 0)) {
    throw new CassetteError("`delayMs` debe ser un número >= 0", path);
  }
  const atMost = value.atMost;
  if (atMost !== undefined && (typeof atMost !== "number" || !Number.isInteger(atMost) || atMost < 1)) {
    throw new CassetteError("`atMost` debe ser un entero >= 1", path);
  }
  if (value.effects !== undefined && !Array.isArray(value.effects)) {
    throw new CassetteError("`effects` debe ser un array", path);
  }
  if (value.logAssertions !== undefined) validateLogAssertions(value.logAssertions, `${path}.logAssertions`);

  const exchange: CassetteExchange = {
    id: typeof value.id === "string" && value.id ? value.id : undefined,
    name: typeof value.name === "string" ? value.name : undefined,
    contract: typeof value.contract === "string" ? value.contract : undefined,
    match: {
      method: match.method.toUpperCase() as CassetteExchange["match"]["method"],
      path: match.path,
      ...(isRecord(match.query) ? { query: match.query as Record<string, string> } : {}),
      ...(isRecord(match.headers) ? { headers: match.headers as Record<string, string> } : {}),
      ...(match.body !== undefined ? { body: match.body } : {}),
      ...(typeof match.bodyContains === "string" ? { bodyContains: match.bodyContains } : {}),
      ...(typeof match.bodySha256 === "string" ? { bodySha256: match.bodySha256 } : {}),
    },
    ...(value.response !== undefined ? { response: value.response as CassetteResponse } : {}),
    ...(typeof value.delayMs === "number" ? { delayMs: value.delayMs } : {}),
    ...(typeof value.abort === "string" ? { abort: value.abort as CassetteExchange["abort"] } : {}),
    ...(typeof value.atMost === "number" ? { atMost: value.atMost } : {}),
    ...(value.optional === true ? { optional: true } : {}),
    ...(Array.isArray(value.effects) ? { effects: value.effects as WorldEffect[] } : {}),
    ...(value.logAssertions !== undefined
      ? { logAssertions: value.logAssertions as LogAssertions }
      : {}),
  };
  exchange.id ??= exchange.name ?? path.split(".").pop() ?? "exchange";
  return exchange;
}

function validateWorldSeed(value: unknown, path: string): void {
  if (!isRecord(value)) throw new CassetteError("`world` debe ser un objeto", path);
  if (value.user !== undefined && !isRecord(value.user)) {
    throw new CassetteError("`world.user` debe ser un objeto", `${path}.user`);
  }
  if (value.offers !== undefined && (!Array.isArray(value.offers) || !value.offers.every(isRecord))) {
    throw new CassetteError("`world.offers` debe ser un array de objetos", `${path}.offers`);
  }
  if (value.transactions !== undefined && !Array.isArray(value.transactions)) {
    throw new CassetteError("`world.transactions` debe ser un array", `${path}.transactions`);
  }
  if (value.chats !== undefined && !isRecord(value.chats)) {
    throw new CassetteError("`world.chats` debe ser un objeto", `${path}.chats`);
  }
}

function validateMatchConditions(match: Record<string, unknown>, path: string): void {
  for (const key of ["query", "headers"]) {
    if (match[key] !== undefined && !isRecord(match[key])) {
      throw new CassetteError(`\`match.${key}\` debe ser un objeto`, path);
    }
  }
  if (match.body !== undefined && typeof match.bodyContains === "string") {
    throw new CassetteError("`match.body` y `match.bodyContains` son excluyentes", path);
  }
  if (match.bodySha256 !== undefined && (typeof match.bodySha256 !== "string" || !/^[a-f0-9]{64}$/.test(match.bodySha256))) {
    throw new CassetteError("`match.bodySha256` debe ser un sha256 hex de 64 caracteres", path);
  }
}

function validateResponse(value: unknown, path: string): void {
  if (!isRecord(value)) throw new CassetteError("`response` debe ser un objeto", path);
  const status = value.status;
  if (status !== undefined && (typeof status !== "number" || !Number.isInteger(status) || status < 100 || status > 599)) {
    throw new CassetteError("`response.status` inválido", path);
  }
  if (value.headers !== undefined && !isRecord(value.headers)) {
    throw new CassetteError("`response.headers` debe ser un objeto", path);
  }
  if (value.bodyRaw !== undefined && typeof value.bodyRaw !== "string") {
    throw new CassetteError("`response.bodyRaw` debe ser string", path);
  }
  if (value.partialBody !== undefined && typeof value.partialBody !== "string") {
    throw new CassetteError("`response.partialBody` debe ser string", path);
  }
  if (value.sse !== undefined) {
    if (!isRecord(value.sse) || !Array.isArray(value.sse.events)) {
      throw new CassetteError("`response.sse.events` debe ser un array", path);
    }
    if (value.sse.retryMs !== undefined && (!Number.isFinite(value.sse.retryMs) || (value.sse.retryMs as number) < 0)) {
      throw new CassetteError("`response.sse.retryMs` inválido", path);
    }
  }
}

function validateLogAssertions(value: unknown, path: string): void {
  if (!isRecord(value)) throw new CassetteError("`logAssertions` debe ser un objeto", path);
  if (value.body !== undefined && typeof value.body === "object" && value.body !== null) {
    // ok: comparación canónica
  }
  if (value.bodySha256 !== undefined && (typeof value.bodySha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.bodySha256))) {
    throw new CassetteError("`logAssertions.bodySha256` debe ser sha256 hex", path);
  }
  for (const key of ["query", "headers"]) {
    if (value[key] !== undefined && !isRecord(value[key])) {
      throw new CassetteError(`\`logAssertions.${key}\` debe ser un objeto`, path);
    }
  }
}

/* ------------------------------------------------------------------ */
/* Match                                                               */
/* ------------------------------------------------------------------ */

export interface FakeRequest {
  method: string;
  path: string;
  normalizedPath: string;
  query: Record<string, string[]>;
  headers: Record<string, string>;
  bodyText: string;
  bodyJson: unknown;
  bodySha256: string;
}

/** `/v2/p2p` y `/p2p` se consideran la misma ruta; el `:param` es un segmento. */
export function normalizePath(path: string): string {
  let normalized = path;
  if (normalized.startsWith("/v2/")) normalized = normalized.slice(3);
  else if (normalized === "/v2") normalized = "/";
  if (normalized.length > 1) normalized = normalized.replace(/\/+$/, "");
  return normalized || "/";
}

/** Convierte `/v2/p2p/:uuid/apply` en regex anclada. */
function pathMatches(template: string, actual: string): boolean {
  const normalizedTemplate = normalizePath(template);
  const normalizedActual = normalizePath(actual);
  if (normalizedTemplate === normalizedActual) return true;
  if (!normalizedTemplate.includes(":")) return false;
  const pattern = normalizedTemplate
    .split("/")
    .map((segment) => {
      if (!segment) return "";
      if (segment.startsWith(":")) return "[^/]+?";
      return segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    })
    .join("/");
  return new RegExp(`^${pattern}$`).test(normalizedActual);
}

function queryMatches(expected: Record<string, string | number | boolean>, actual: Record<string, string[]>): boolean {
  for (const [key, value] of Object.entries(expected)) {
    const values = actual[key];
    if (!values || values.length === 0) return false;
    if (!values.includes(String(value))) return false;
  }
  return true;
}

function headerMatches(expected: Record<string, string>, actual: Record<string, string>): boolean {
  for (const [key, value] of Object.entries(expected)) {
    if (actual[key.toLowerCase()] !== value) return false;
  }
  return true;
}

export function matchesRequest(exchange: CassetteExchange, request: FakeRequest): boolean {
  if (exchange.match.method !== request.method.toUpperCase()) return false;
  if (!pathMatches(exchange.match.path, request.normalizedPath)) return false;
  if (exchange.match.query && !queryMatches(exchange.match.query, request.query)) return false;
  if (exchange.match.headers && !headerMatches(exchange.match.headers, request.headers)) return false;
  if (exchange.match.bodySha256 && exchange.match.bodySha256 !== request.bodySha256) return false;
  if (exchange.match.bodyContains !== undefined && !request.bodyText.includes(exchange.match.bodyContains)) {
    return false;
  }
  if (exchange.match.body !== undefined) {
    if (request.bodyJson === undefined) return false;
    if (!equalCanonical(exchange.match.body, request.bodyJson)) return false;
  }
  return true;
}

/**
 * Evalúa `logAssertions` contra el request recibido. Devuelve la lista de
 * errores (vacía si pasa). Un fallo se señaliza como 500 con
 * `FAKE_LOG_ASSERTION_FAILED` y se acumula en el log.
 */
export function evaluateLogAssertions(assertions: LogAssertions, request: FakeRequest): string[] {
  const errors: string[] = [];
  if (assertions.method !== undefined && assertions.method.toUpperCase() !== request.method.toUpperCase()) {
    errors.push(`method esperado ${assertions.method}, recibido ${request.method}`);
  }
  if (assertions.path !== undefined && normalizePath(assertions.path) !== request.normalizedPath) {
    errors.push(`path esperado ${assertions.path}, recibido ${request.path}`);
  }
  if (assertions.query && !queryMatches(assertions.query, request.query)) {
    errors.push(`query no coincide: esperado ${canonicalHash(assertions.query)} recibido ${canonicalHash(request.query)}`);
  }
  if (assertions.headers && !headerMatches(assertions.headers, request.headers)) {
    errors.push("headers relevantes no coinciden");
  }
  if (assertions.bodySha256 !== undefined && assertions.bodySha256 !== request.bodySha256) {
    errors.push(`bodySha256 esperado ${assertions.bodySha256}, recibido ${request.bodySha256}`);
  }
  if (assertions.bodyContains !== undefined && !request.bodyText.includes(assertions.bodyContains)) {
    errors.push("bodyContains no encontrado");
  }
  if (assertions.body !== undefined) {
    if (request.bodyJson === undefined) errors.push("body JSON esperado, recibido no-JSON");
    else if (!equalCanonical(assertions.body, request.bodyJson)) errors.push("body JSON no coincide");
  }
  return errors;
}

/**
 * sha256 canónico del body: JSON canónico si parsea; bytes crudos si no.
 * Un body vacío usa el sha256 de la cadena vacía (e3b0c442…), no el del JSON
 * `""`, para que `mutationParity` distinga "sin body" de "string vacío".
 */
export function canonicalBodySha256(bodyText: string, bodyJson: unknown): string {
  if (bodyText.length === 0) return createHash("sha256").update("").digest("hex");
  if (bodyJson !== null && bodyJson !== undefined) return canonicalHash(bodyJson);
  return createHash("sha256").update(bodyText).digest("hex");
}

export { canonicalHash, equalCanonical };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
