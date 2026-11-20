/**
 * CLI de conformidad v1 (oráculo TypeScript).
 *
 * Protocolo: NDJSON por stdin/stdout, una petición y una respuesta por línea.
 *
 *   -> {"id":"case-1","op":"market.roundQusd","input":{"value":1.234567891}}
 *   <- {"id":"case-1","result":{"value":"1.23456789"}}
 *   <- {"id":"case-1","error":{"class":"validation","message":"..."}}
 *
 * No hay estado entre peticiones: cada línea es independiente y determinista.
 * Las operaciones viven en `parity/adapters/ops/*.ts` y exportan `ops`.
 */
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createInterface } from "node:readline";

type Op = (input: Record<string, unknown>) => unknown | Promise<unknown>;

const here = dirname(fileURLToPath(import.meta.url));
const opsDir = join(here, "ops");
const registry = new Map<string, Op>();

for (const file of readdirSync(opsDir).filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts")).sort()) {
  const module = (await import(pathToFileURL(join(opsDir, file)).href)) as {
    ops?: Record<string, Op>;
  };
  if (!module.ops || typeof module.ops !== "object") {
    throw new Error(`El módulo de operaciones ${file} no exporta { ops }.`);
  }
  for (const [name, handler] of Object.entries(module.ops)) {
    if (typeof handler !== "function") throw new Error(`La operación ${name} (${file}) no es una función.`);
    if (registry.has(name)) throw new Error(`Operación duplicada: ${name}.`);
    registry.set(name, handler);
  }
}

interface Request {
  id: string;
  op: string;
  input?: Record<string, unknown>;
}

interface OpError {
  class: string;
  code?: string;
  message: string;
}

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
let queue: Promise<void> = Promise.resolve();

async function handleLine(line: string): Promise<void> {
  const text = line.trim();
  if (!text) return;
  let request: Request;
  try {
    request = JSON.parse(text) as Request;
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ id: "<unparsed>", error: { class: "protocol", message: String(error) } })}\n`);
    return;
  }
  try {
    const handler = registry.get(request.op);
    if (!handler) {
      const error: OpError = { class: "protocol", code: "unknown-op", message: `Operación desconocida: ${request.op}` };
      process.stdout.write(`${JSON.stringify({ id: request.id, error })}\n`);
      return;
    }
    const result = await handler(request.input ?? {});
    process.stdout.write(`${JSON.stringify({ id: request.id, result })}\n`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const code = (error as { code?: string })?.code;
    const errorClass = /positiv|rango|válid|invalid|debe|requiere|rechaza/i.test(message) ? "validation" : "error";
    const payload: { id: string; error: OpError } = { id: request.id, error: { class: errorClass, message } };
    if (code) payload.error.code = code;
    process.stdout.write(`${JSON.stringify(payload)}\n`);
  }
}

input.on("line", (line) => {
  queue = queue.then(() => handleLine(line));
});
input.on("close", () => {
  void queue.finally(() => process.exit(0));
});
