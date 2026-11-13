/**
 * Operaciones de conformidad para `src/reconciliation-scheduler.ts`.
 *
 * Contrato `reconciliation.sequence`:
 *   input  = { steps[] } con operaciones sobre el shim de estado persistido:
 *              {op:"canAttempt",    intentId, at}
 *              {op:"recordFailure", intentId, at}
 *              {op:"clear",         intentId}
 *   output = { results[] } en el mismo orden: `canAttempt` → {can},
 *            `recordFailure` → {attempts, nextAttemptAt}, `clear` → null.
 *
 * Cada petición arranca con un almacén vacío: el estado del backoff se construye
 * dentro de la secuencia, nunca se comparte entre casos. Los epoch ms viajan
 * como number (permitido); no hay importes monetarios en esta op.
 */
import { ReconciliationScheduler } from "../../../src/reconciliation-scheduler.js";

type Input = Record<string, unknown>;

function text(input: Input, key: string): string {
  const value = input[key];
  if (typeof value !== "string") throw new Error(`El campo ${key} debe ser texto.`);
  return value;
}

function num(input: Input, key: string): number {
  const value = input[key];
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new Error(`El campo ${key} debe ser un entero.`);
  }
  return value;
}

export const ops = {
  "reconciliation.sequence": (input: Input) => {
    const steps = input.steps;
    if (!Array.isArray(steps)) throw new Error("El campo steps debe ser un array.");
    const values = new Map<string, string>();
    const scheduler = new ReconciliationScheduler({
      get: (key) => values.get(key),
      set: (key, value) => void values.set(key, value),
    });
    const results: unknown[] = [];
    for (const step of steps as Input[]) {
      const op = text(step, "op");
      const intentId = text(step, "intentId");
      if (op === "canAttempt") {
        results.push({ can: scheduler.canAttempt(intentId, num(step, "at")) });
      } else if (op === "recordFailure") {
        const record = scheduler.recordFailure(intentId, num(step, "at"));
        results.push({ attempts: record.attempts, nextAttemptAt: record.nextAttemptAt });
      } else if (op === "clear") {
        scheduler.clear(intentId);
        results.push(null);
      } else {
        throw new Error(`Operación de conciliación desconocida: ${op}.`);
      }
    }
    return { results };
  },
};
