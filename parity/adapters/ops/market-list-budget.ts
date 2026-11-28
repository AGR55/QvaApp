/**
 * Operaciones de conformidad para `src/market-list-budget.ts`.
 *
 * El escenario usa un almacén y un reloj virtuales. La secuencia declara las
 * esperas, los 429, el avance del reloj y la recreación del presupuesto (para
 * demostrar que el estado sobrevive al reinicio).
 */
import { ListingReadBudget } from "../../../src/market-list-budget.js";

type Input = Record<string, unknown>;

function text(input: Input, key: string): string {
  const value = input[key];
  if (typeof value !== "string") throw new Error(`El campo ${key} debe ser texto.`);
  return value;
}

function num(input: Input, key: string, fallback?: number): number {
  const value = input[key];
  if (value === undefined && fallback !== undefined) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`El campo ${key} debe ser un número finito.`);
  }
  return value;
}

function ownerOf(step: Input): string | undefined {
  const value = step.owner;
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new Error("El campo owner debe ser texto o null.");
  return value;
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

export const ops = {
  "market-list-budget.sequence": async (input: Input) => {
    const steps = input.steps;
    if (!Array.isArray(steps)) throw new Error("El campo steps debe ser un array.");
    let now = num(input, "now", 10_000);
    const values = new Map<string, string>();
    const sleeps: number[] = [];
    let writes = 0;
    let failWrite = input.failFirstWrite === true;
    let holdNextSleep = false;
    let gate: { promise: Promise<void>; resolve: () => void } | undefined;
    const sleepSetsOwner = typeof input.sleepSetsOwner === "string" ? input.sleepSetsOwner : undefined;
    let owner: string | undefined;

    const store = {
      get: (key: string) => values.get(key),
      set: (key: string, value: string) => {
        if (failWrite) {
          failWrite = false;
          throw new Error("disco");
        }
        writes += 1;
        values.set(key, value);
      },
    };
    const makeBudget = () => new ListingReadBudget(store, {
      now: () => now,
      sleep: async (milliseconds: number) => {
        sleeps.push(milliseconds);
        if (holdNextSleep) {
          holdNextSleep = false;
          gate = deferred();
          await gate.promise;
        }
        if (sleepSetsOwner !== undefined) owner = sleepSetsOwner;
        now += milliseconds;
      },
    });
    let budget = makeBudget();
    const pending = new Map<string, Promise<string | undefined>>();
    const results: unknown[] = [];

    const capture = async (work: Promise<string | undefined>) => {
      try {
        return { owner: await work };
      } catch (error) {
        return { error: error instanceof Error ? error.message : String(error) };
      }
    };

    const callbackFor = (step: Input): (() => string | undefined) => {
      if (step.dynamicOwner === true) return () => owner;
      const fixed = step.owner === undefined ? owner : ownerOf(step);
      return () => fixed;
    };

    for (const raw of steps) {
      const step = raw as Input;
      const op = text(step, "op");
      switch (op) {
        case "wait":
          results.push(await capture(budget.waitForDispatch(callbackFor(step))));
          break;
        case "beginWait": {
          const label = text(step, "label");
          const work = budget.waitForDispatch(callbackFor(step));
          void work.catch(() => undefined);
          pending.set(label, work);
          results.push(null);
          break;
        }
        case "joinWait": {
          const label = text(step, "label");
          const work = pending.get(label);
          results.push(work ? await capture(work) : null);
          break;
        }
        case "holdNextSleep":
          holdNextSleep = true;
          results.push(null);
          break;
        case "releaseSleep":
          gate?.resolve();
          gate = undefined;
          results.push(null);
          break;
        case "setOwner":
          owner = ownerOf(step);
          results.push(null);
          break;
        case "advance":
          now += num(step, "ms");
          results.push(null);
          break;
        case "note":
          try {
            budget.noteRateLimit(ownerOf(step), num(step, "retryAfterMs", 60_000));
            results.push(null);
          } catch (error) {
            results.push({ error: error instanceof Error ? error.message : String(error) });
          }
          break;
        case "recreate":
          budget = makeBudget();
          results.push(null);
          break;
        case "now":
          results.push(now);
          break;
        case "sleeps":
          results.push([...sleeps]);
          break;
        case "writes":
          results.push(writes);
          break;
        case "stored": {
          const rawState = values.get("market_list_budget:v1");
          if (rawState === undefined) {
            results.push(null);
            break;
          }
          const state = JSON.parse(rawState) as Record<string, unknown>;
          results.push({
            universal: state.universal,
            lastAny: state.lastAny,
            ownerCount: Object.keys(state.owners as Record<string, unknown>).length,
          });
          break;
        }
        default:
          throw new Error(`Operación de presupuesto de listados desconocida: ${op}.`);
      }
    }
    return { results };
  },
};
