/**
 * Operaciones de conformidad para `src/qusd-balance-cache.ts`.
 *
 * El escenario controla lecturas colgadas, época, revisión, reloj y cierre.
 * Las lecturas se declaran en `reads[]` y se resuelven con `resolveRead` /
 * `rejectRead`, de modo que no hay red ni temporizadores reales.
 *
 * Marcadores: `value:"NaN"` representa un saldo no finito; `hang:true` deja la
 * lectura pendiente hasta que el escenario la resuelva.
 */
import { QusdBalanceCache, type QusdBalanceTiming } from "../../../src/qusd-balance-cache.js";

type Input = Record<string, unknown>;
type ReadSpec = { value?: number | "NaN"; error?: string; status?: number; hang?: boolean; advanceEpoch?: boolean };

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

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: Error) => void } {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function resultOf(error: unknown): Record<string, unknown> {
  const status = (error as { status?: unknown })?.status;
  return {
    status: "error",
    message: error instanceof Error ? error.message : String(error),
    ...(typeof status === "number" ? { httpStatus: status } : {}),
  };
}

/** Saldo QUSD a escala fija 8: nunca un `number` monetario en el transporte. */
function dec(value: number): string {
  if (!Number.isFinite(value)) return String(value);
  return Number(value.toFixed(8)).toFixed(8);
}

export const ops = {
  "qusd.sequence": async (input: Input) => {
    const steps = input.steps;
    if (!Array.isArray(steps)) throw new Error("El campo steps debe ser un array.");
    const reads = Array.isArray(input.reads) ? (input.reads as ReadSpec[]) : [];
    let now = num(input, "now", 100_000);
    let epoch = typeof input.epoch === "string" ? input.epoch : "1";
    let current = true;
    let calls = 0;
    const priorities: boolean[] = [];
    const events: QusdBalanceTiming[] = [];
    const deferredReads = new Map<number, ReturnType<typeof deferred<number>>>();
    const pending = new Map<string, Promise<number>>();
    const stops = new Map<string, Promise<void>>();
    let stopResolved = false;

    const read = (priority: boolean): Promise<number> => {
      const index = calls;
      calls += 1;
      priorities.push(priority);
      const spec = reads[index];
      if (!spec) throw new Error(`Lectura de saldo no declarada (${index}).`);
      if (spec.advanceEpoch) {
        epoch = String(Number(epoch) + 1);
        return Promise.resolve(typeof spec.value === "number" ? spec.value : 10);
      }
      if (spec.hang) {
        const item = deferred<number>();
        deferredReads.set(index, item);
        return item.promise;
      }
      if (spec.error) {
        const error = Object.assign(new Error(spec.error), spec.status === undefined ? {} : { status: spec.status });
        return Promise.reject(error);
      }
      if (spec.value === "NaN") return Promise.resolve(Number.NaN);
      return Promise.resolve(typeof spec.value === "number" ? spec.value : 0);
    };

    const observe = input.observeThrows === true
      ? (() => {
          throw new Error("telemetría");
        })
      : (event: QusdBalanceTiming) => {
          events.push(event);
        };

    const cache = new QusdBalanceCache({
      read,
      epoch: () => epoch,
      now: () => now,
      monotonicNow: () => now,
      observe,
    });

    const optionsOf = (step: Input) => ({
      priority: step.priority === true,
      ...(step.force === true ? { force: true } : {}),
      context: (typeof step.context === "string" ? step.context : "fast_lane") as never,
      ...(step.isCurrent === true ? { isCurrent: () => current } : {}),
    });

    const results: unknown[] = [];
    for (const raw of steps) {
      const step = raw as Input;
      const op = text(step, "op");
      switch (op) {
        case "get": {
          try {
            results.push({ status: "ok", value: dec(await cache.get(optionsOf(step))) });
          } catch (error) {
            results.push(resultOf(error));
          }
          break;
        }
        case "beginGet": {
          const label = text(step, "label");
          const work = cache.get(optionsOf(step));
          void work.catch(() => undefined);
          pending.set(label, work);
          results.push(null);
          break;
        }
        case "join": {
          const label = text(step, "label");
          const work = pending.get(label);
          if (!work) {
            results.push(null);
            break;
          }
          try {
            results.push({ status: "ok", value: dec(await work) });
          } catch (error) {
            results.push(resultOf(error));
          }
          break;
        }
        case "settle":
          await new Promise<void>((resolve) => setImmediate(resolve));
          results.push(null);
          break;
        case "resolveRead": {
          const index = num(step, "index");
          const value = step.value === "NaN" ? Number.NaN : num(step, "value");
          deferredReads.get(index)?.resolve(value);
          results.push(null);
          break;
        }
        case "rejectRead": {
          const index = num(step, "index");
          deferredReads.get(index)?.reject(new Error(text(step, "message")));
          results.push(null);
          break;
        }
        case "advance":
          now += num(step, "ms");
          results.push(null);
          break;
        case "setEpoch":
          epoch = text(step, "value");
          results.push(null);
          break;
        case "setCurrent":
          current = step.value !== false;
          results.push(null);
          break;
        case "replace":
          try {
            cache.replace(num(step, "value"));
            results.push(null);
          } catch (error) {
            results.push(resultOf(error));
          }
          break;
        case "peek": {
          const snapshot = cache.peek();
          results.push(snapshot ? dec(snapshot.value) : null);
          break;
        }
        case "beginStop": {
          const label = text(step, "label");
          stops.set(label, cache.stop().then(() => {
            stopResolved = true;
          }));
          results.push(null);
          break;
        }
        case "joinStop": {
          const label = text(step, "label");
          await stops.get(label);
          results.push(null);
          break;
        }
        case "stopResolved":
          results.push(stopResolved);
          break;
        case "calls":
          results.push(calls);
          break;
        case "priorities":
          results.push([...priorities]);
          break;
        case "events":
          results.push(events.map((event) => event.outcome));
          break;
        case "lastEvent":
          results.push(events.at(-1)?.outcome ?? null);
          break;
        default:
          throw new Error(`Operación de caché QUSD desconocida: ${op}.`);
      }
    }
    return { results };
  },
};
