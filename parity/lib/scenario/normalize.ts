/**
 * Normalización canónica de observaciones para las suites L2 (`contract` y
 * `http`).
 *
 * El objetivo es congelar comportamiento, no detalles de transporte ni
 * secretos efímeros: cookies, tokens CSRF, fechas de reloj real, `ETag` y
 * `Last-Modified` no forman parte de la observación. Los errores se reducen a
 * `{name, message, code?, …campos propios}` para que un SUT nuevo pueda
 * reproducirlos sin compartir la jerarquía de clases de TypeScript.
 */

import { createHash } from "node:crypto";

export interface NormalizedError {
  name: string;
  message: string;
  code?: string | number | null;
  [field: string]: unknown;
}

export function normalizeError(error: unknown): NormalizedError {
  if (error instanceof Error) {
    const normalized: NormalizedError = {
      name: error.name,
      message: error.message,
    };
    for (const key of Object.getOwnPropertyNames(error).sort()) {
      if (key === "name" || key === "message" || key === "stack") continue;
      const value = (error as unknown as Record<string, unknown>)[key];
      if (typeof value === "function") continue;
      normalized[key] = normalizeValue(value);
    }
    return normalized;
  }
  return { name: "Unknown", message: String(error) };
}

/**
 * Convierte cualquier valor en JSON estable:
 * - claves de objeto ordenadas;
 * - `undefined` → `null`;
 * - `Date` → `{date: ISO}`;
 * - `Error` → {@link NormalizedError};
 * - números no finitos → `{number: "NaN"|"Infinity"|"-Infinity"}`;
 * - `bigint` → `{bigint: "…"}`.
 *
 * Un `number` normal se conserva: las reglas de dinero usan strings de escala
 * fija y esa diferencia sigue siendo un fallo de paridad.
 */
export function normalizeValue(value: unknown): unknown {
  if (value === undefined || value === null) return null;
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : { number: String(value) };
  }
  if (typeof value === "bigint") return { bigint: value.toString() };
  if (typeof value === "symbol") return { symbol: value.toString() };
  if (typeof value === "function") return { function: value.name || "<anonymous>" };
  if (value instanceof Date) return { date: value.toISOString() };
  if (value instanceof Error) return normalizeError(value);
  if (value instanceof Uint8Array) {
    const bytes = Buffer.from(value);
    return { sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length };
  }
  if (Array.isArray(value)) return value.map(normalizeValue);
  if (typeof value === "object") {
    const source = value as Record<string, unknown>;
    const output: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) output[key] = normalizeValue(source[key]);
    return output;
  }
  return String(value);
}

export type Settled<T> =
  | { ok: true; value: T }
  | { ok: false; error: NormalizedError };

/** Ejecuta una promesa y captura el resultado o el error normalizado. */
export async function settle<T>(promise: Promise<T> | T): Promise<Settled<T>> {
  try {
    return { ok: true, value: await promise };
  } catch (error) {
    return { ok: false, error: normalizeError(error) };
  }
}
