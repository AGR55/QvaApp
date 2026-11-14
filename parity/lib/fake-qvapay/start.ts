/**
 * Punto de entrada del fake QvaPay determinista.
 *
 * Uso:
 *   node --import tsx parity/lib/fake-qvapay/start.ts \
 *     --cassette parity/fixtures/contracts/qvapay/apply-409-contention.json \
 *     --port 0
 *
 * Imprime UNA línea JSON en stdout cuando está listo:
 *   {"ready":true,"url":"http://127.0.0.1:PORT","cassette":"...","port":PORT}
 *
 * El resto de diagnósticos va por stderr. Sin red externa: escucha en 127.0.0.1.
 * Cierra ordenadamente con SIGINT/SIGTERM.
 */
import { resolve } from "node:path";
import { startFakeQvaPay } from "./server.js";

interface CliOptions {
  cassette: string;
  host: string;
  port: number;
}

function parseArgs(argv: string[]): CliOptions {
  let cassette: string | undefined;
  let host = "127.0.0.1";
  let port = 0;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === "--cassette" && next) {
      cassette = next;
      index += 1;
    } else if (arg === "--host" && next) {
      host = next;
      index += 1;
    } else if (arg === "--port" && next) {
      const parsed = Number(next);
      if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65_535) {
        throw new Error(`--port inválido: ${next}`);
      }
      port = parsed;
      index += 1;
    } else if (arg === "--help" || arg === "-h") {
      process.stdout.write(
        "uso: fake-qvapay --cassette <ruta.json> [--host 127.0.0.1] [--port 0]\n",
      );
      process.exit(0);
    } else if (!cassette) {
      cassette = arg;
    } else {
      throw new Error(`Argumento desconocido: ${arg}`);
    }
  }
  if (!cassette) throw new Error("Falta --cassette <ruta.json>");
  return { cassette: resolve(process.cwd(), cassette), host, port };
}

const options = parseArgs(process.argv.slice(2));
const handle = await startFakeQvaPay({
  cassette: options.cassette,
  host: options.host,
  port: options.port,
  quiet: true,
});

process.stdout.write(
  `${JSON.stringify({
    ready: true,
    url: handle.url,
    host: handle.host,
    port: handle.port,
    cassette: handle.cassette.name,
    contract: handle.cassette.contract ?? null,
    pid: process.pid,
  })}\n`,
);

let closing = false;
async function shutdown(signal: string): Promise<void> {
  if (closing) return;
  closing = true;
  process.stderr.write(`fake-qvapay: ${signal}, cerrando ${handle.url}\n`);
  try {
    await handle.close();
  } finally {
    process.exit(0);
  }
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("uncaughtException", (error) => {
  process.stderr.write(`fake-qvapay: excepción no capturada: ${String(error)}\n`);
  void shutdown("uncaughtException");
});
