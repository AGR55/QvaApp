/**
 * Operaciones de conformidad para `src/core/apply-budget.ts`.
 *
 * Contrato `apply.budget`:
 *   input  = { now, attempts?, legacyApplyAt?, retryAt? }
 *            Reproduce el estado persistido que consume el presupuesto de
 *            aplicaciones:
 *              attempts      → `qva_throttle:apply_window` (JSON [ms, ms])
 *              legacyApplyAt → `qva_throttle:apply` (epoch ms del esquema viejo)
 *              retryAt       → `qva_throttle:apply_retry_at` (Retry-After)
 *   output = { attempts: number[], readyAt: number }
 *            `attempts` son epoch ms ordenados; `readyAt` es epoch ms. No hay
 *            importes monetarios en esta op.
 *
 * Cada petición parte de un almacén vacío: el estado se inyecta solo por input,
 * así que el caso es determinista y no depende del reloj de sistema.
 */
import { applyAttempts, applyReadyAt } from "../../../src/core/apply-budget.js";

type Input = Record<string, unknown>;

const WINDOW_KEY = "qva_throttle:apply_window";
const LEGACY_KEY = "qva_throttle:apply";
const RETRY_KEY = "qva_throttle:apply_retry_at";

function num(input: Input, key: string): number {
  const value = input[key];
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new Error(`El campo ${key} debe ser un entero.`);
  }
  return value;
}

export const ops = {
  "apply.budget": (input: Input) => {
    const values = new Map<string, string>();
    if (input.attempts !== undefined) {
      if (!Array.isArray(input.attempts)) throw new Error("El campo attempts debe ser un array.");
      values.set(WINDOW_KEY, JSON.stringify(input.attempts));
    }
    if (input.legacyApplyAt !== undefined) values.set(LEGACY_KEY, String(num(input, "legacyApplyAt")));
    if (input.retryAt !== undefined) values.set(RETRY_KEY, String(num(input, "retryAt")));
    const state = { get: (key: string) => values.get(key) };
    const now = num(input, "now");
    return { attempts: applyAttempts(state), readyAt: applyReadyAt(state, now) };
  },
};
