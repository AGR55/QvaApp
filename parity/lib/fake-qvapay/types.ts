/**
 * Tipos del fake QvaPay determinista del arnés de paridad (F0).
 *
 * Contratos cubiertos: K1–K14 de docs/migration/analysis/03-boundaries.md §7.
 * El fake es un autómata finito dirigido por cassette: no usa reloj real, no
 * usa azar, no toca red externa y falla de forma explícita ante cualquier
 * request que el cassette no declare.
 */

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/** Condición de match de una exchange. Toda condición declarada debe cumplirse. */
export interface CassetteMatch {
  method: HttpMethod;
  /**
   * Ruta exacta o plantilla con `:param` (p. ej. `/v2/p2p/:uuid/apply`).
   * El prefijo de versión `/v2` es opcional: se normaliza en ambos lados.
   */
  path: string;
  /** Subconjunto de query params que debe estar presente (comparación textual). */
  query?: Record<string, string | number | boolean>;
  /** Subconjunto de headers (nombres case-insensitive, valores exactos). */
  headers?: Record<string, string>;
  /** Body JSON completo (igualdad canónica estricta). */
  body?: unknown;
  /** Subcadena del body crudo. */
  bodyContains?: string;
  /** sha256 canónico del body (ver `canonicalBodySha256`). */
  bodySha256?: string;
}

export interface SseEventSpec {
  /** Campo `event:`; ausente ⇒ evento `message` por defecto. */
  event?: string;
  /** Se serializa como JSON en una sola línea `data: <json>`. */
  data?: unknown;
  /** Línea de comentario (`: keepalive`) antes del evento. */
  comment?: string;
}

export interface SseResponseSpec {
  /** Campo `retry:` inicial, en milisegundos. */
  retryMs?: number;
  events: SseEventSpec[];
  /** Deja la conexión abierta después de emitir los eventos. */
  holdOpen?: boolean;
}

export interface CassetteResponse {
  /** HTTP status; por defecto 200. */
  status?: number;
  headers?: Record<string, string>;
  /** Body JSON serializado por el fake. */
  body?: unknown;
  /** Body crudo (para JSON malformado o cuerpos no-JSON). */
  bodyRaw?: string;
  /** Body parcial que se envía antes de cortar la conexión (abort after-headers). */
  partialBody?: string;
  /** Respuesta SSE (K6/K7); si está presente manda sobre `body`. */
  sse?: SseResponseSpec;
}

/**
 * Fallo de transporte. Nunca se usa `sleep` real para simular un timeout:
 *  - `destroy`:        corta el socket antes de enviar nada (reset de conexión).
 *  - `after-headers`:  envía status+headers+body parcial y corta (respuesta ambigua).
 *  - `hang`:           no responde nunca; el SUT aborta con su timeout inyectado.
 */
export type AbortMode = "destroy" | "after-headers" | "hang";

/** Efectos deterministas sobre el mundo del fake. Se aplican ANTES de responder. */
export type WorldEffect =
  | { op: "status"; uuid: string; status: string }
  | { op: "patch"; uuid: string; patch: Record<string, unknown> }
  | { op: "apply"; uuid: string; order?: string }
  | { op: "cancel"; uuid: string; status?: string }
  | { op: "create"; offer: Record<string, unknown> }
  | { op: "chat"; uuid: string; message: Record<string, unknown> }
  | { op: "transaction"; transaction: Record<string, unknown> };

/** Aserciones sobre el request que acaba de llegar; si fallan, el fake responde 500. */
export interface LogAssertions {
  method?: string;
  path?: string;
  query?: Record<string, string | number | boolean>;
  headers?: Record<string, string>;
  body?: unknown;
  bodyContains?: string;
  bodySha256?: string;
}

export interface CassetteExchange {
  /** Identificador estable para reportes. Por defecto `exchange-N`. */
  id?: string;
  /** Alias legible de `id` (formato simplificado de la tarea: `name`). */
  name?: string;
  /** Contrato K citado (K1..K14). */
  contract?: string;
  match: CassetteMatch;
  response?: CassetteResponse;
  /**
   * Latencia simulada en milisegundos. SOLO avanza el reloj virtual y queda en
   * el log (`latencyMs` + header `x-fake-latency-ms`); no hay `sleep` real.
   */
  delayMs?: number;
  abort?: AbortMode;
  /** Nº máximo de requests que pueden consumir esta exchange. Por defecto 1. */
  atMost?: number;
  /** Si es `true`, el runner no exige que se consuma (ver `/__fake/log`). */
  optional?: boolean;
  effects?: WorldEffect[];
  logAssertions?: LogAssertions;
}

/** Semilla del mundo determinista del fake. */
export interface WorldSeed {
  user?: Record<string, unknown>;
  offers?: Record<string, unknown>[];
  transactions?: unknown[];
  chats?: Record<string, unknown[]>;
}

export interface Cassette {
  cassetteVersion?: number;
  /** Nombre único del escenario (p. ej. `apply-409-contention`). */
  name: string;
  description?: string;
  /** Contrato principal citado (K1..K14). */
  contract?: string;
  /** Epoch ms del reloj virtual; fijo para determinismo. */
  clockMs?: number;
  /** Secreto HMAC del webhook entrante (K5); el cassette calcula la firma. */
  webhookSecret?: string;
  world?: WorldSeed;
  exchanges: CassetteExchange[];
}

/* ------------------------------------------------------------------ */
/* Log de requests                                                     */
/* ------------------------------------------------------------------ */

export type RequestKind = "api" | "control" | "webhook";

export interface RequestLogEntry {
  seq: number;
  kind: RequestKind;
  /** Reloj virtual (ms epoch) en el momento de recibir la request. */
  virtualAt: number;
  method: string;
  /** Path tal y como llegó (sin query). */
  path: string;
  /** Path normalizado (sin prefijo `/v2`) usado para el match. */
  normalizedPath: string;
  query: Record<string, string[]>;
  /** Query ordenada `k=v&k=v` para comparar `mutationParity`. */
  querySorted: string;
  /** Headers relevantes, con secretos redactados. */
  headers: Record<string, string | null>;
  /** sha256 de valores sensibles para comparación exacta sin filtrarlos. */
  headerHashes: Record<string, string>;
  bodyBytes: number;
  /** sha256 canónico del body JSON (o del body crudo si no es JSON). */
  bodySha256: string | null;
  /** Body JSON parseado, solo si es pequeño y parseable (ayuda de depuración). */
  bodyJson: unknown;
  /** Exchange consumida o `null` si el request no estaba declarado. */
  exchange: string | null;
  contract: string | null;
  status: number | null;
  responseHeaders: Record<string, string>;
  responseBodySha256: string | null;
  /** Latencia virtual simulada por la exchange (`delayMs`). */
  latencyMs: number | null;
  aborted: AbortMode | null;
  responseEnded: boolean;
  assertionErrors: string[];
}

export interface ExchangeReport {
  id: string;
  contract: string | null;
  method: string;
  path: string;
  query: string | null;
  consumed: number;
  atMost: number;
  optional: boolean;
}

export interface FakeQvaPayLog {
  cassette: string;
  contract: string | null;
  virtualNow: number;
  startedAtVirtual: number;
  requestCount: number;
  unexpectedRequests: number;
  assertionFailures: string[];
  requests: RequestLogEntry[];
  exchanges: ExchangeReport[];
  /** Exchanges obligatorias que no se consumieron (debe ser vacío al cerrar un caso). */
  unconsumed: string[];
}
