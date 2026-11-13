/**
 * Operaciones de conformidad para `src/scheduler.ts`.
 *
 * Contrato `scheduler.sequence`:
 *   input  = { steps[] } con operaciones sobre un `Scheduler` vacío:
 *              {op:"register", name, interval, task:"noop"|"hold"|"throw"}
 *              {op:"start"} | {op:"stop"}
 *              {op:"begin",  name}   inicia `run` sin esperar (guarda la promesa)
 *              {op:"run",    name}   espera `run` y devuelve el boolean
 *              {op:"settle"}         cede el turno (setImmediate)
 *              {op:"release", name}  libera una tarea "hold"
 *              {op:"join",   name}   espera la promesa de `begin`
 *              {op:"calls",  name}   número de invocaciones de la tarea
 *   output = { results[] } en el mismo orden.
 *
 * Cada petición arranca con un planificador nuevo: no hay estado compartido.
 * No hay reloj real ni temporizadores duraderos: `start` solo se usa en el
 * escenario que llama a `stop` antes de que el intervalo dispare.
 */
import { Scheduler } from "../../../src/scheduler.js";

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
  "scheduler.sequence": async (input: Input) => {
    const steps = input.steps;
    if (!Array.isArray(steps)) throw new Error("El campo steps debe ser un array.");
    const scheduler = new Scheduler();
    const calls = new Map<string, number>();
    const releases = new Map<string, () => void>();
    const started = new Map<string, Promise<boolean>>();
    const results: unknown[] = [];
    const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

    for (const raw of steps) {
      const step = raw as Input;
      const op = text(step, "op");
      switch (op) {
        case "register": {
          const name = text(step, "name");
          const task = text(step, "task");
          calls.set(name, 0);
          scheduler.register(name, num(step, "interval"), async () => {
            calls.set(name, (calls.get(name) ?? 0) + 1);
            if (task === "throw") throw new Error("tarea fallida");
            if (task === "hold") {
              await new Promise<void>((resolve) => releases.set(name, resolve));
            }
          });
          results.push(null);
          break;
        }
        case "start":
          scheduler.start();
          results.push(null);
          break;
        case "stop":
          scheduler.stop();
          results.push(null);
          break;
        case "begin": {
          const name = text(step, "name");
          started.set(name, scheduler.run(name));
          results.push(null);
          break;
        }
        case "run":
          results.push(await scheduler.run(text(step, "name")));
          break;
        case "settle":
          await settle();
          results.push(null);
          break;
        case "release": {
          const name = text(step, "name");
          releases.get(name)?.();
          results.push(null);
          break;
        }
        case "join": {
          const name = text(step, "name");
          const pending = started.get(name);
          results.push(pending ? await pending : null);
          break;
        }
        case "calls":
          results.push(calls.get(text(step, "name")) ?? 0);
          break;
        default:
          throw new Error(`Operación de scheduler desconocida: ${op}.`);
      }
    }
    return { results };
  },
};
