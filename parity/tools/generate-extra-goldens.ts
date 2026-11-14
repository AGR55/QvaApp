/**
 * Generador repetible de goldens de dominio puro — lote 2 (F0).
 *
 * Cubre los módulos puros que faltaban tras el primer lote: scheduler,
 * dashboard (margen/presupuesto/histórico), chat-stream, menús cooperativo y de
 * Telegram, y el runtime de Telegram.
 *
 * Igual que `generate-domain-goldens.ts`, el `expect` se deriva ejecutando el
 * oráculo TypeScript congelado a través de los adaptadores de
 * `parity/adapters/ops/*`; las aserciones literales de los tests de origen se
 * declaran en `check` para detectar cualquier deriva del oráculo.
 *
 * Uso:
 *   node --import tsx parity/tools/generate-extra-goldens.ts          # regenera
 *   node --import tsx parity/tools/generate-extra-goldens.ts --check  # solo verifica
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalHash } from "../lib/canonical.js";
import { ops as schedulerOps } from "../adapters/ops/scheduler.js";
import { ops as dashboardOps } from "../adapters/ops/dashboard.js";
import { ops as chatOps } from "../adapters/ops/chat-stream.js";
import { ops as cooperativeOps } from "../adapters/ops/cooperative-menu.js";
import { ops as telegramMenuOps } from "../adapters/ops/telegram-menu.js";
import { ops as telegramRuntimeOps } from "../adapters/ops/telegram-runtime.js";

type Input = Record<string, unknown>;
type Handler = (input: Input) => unknown | Promise<unknown>;

const COMMIT = "02bb5afc04b5eb95f5ac3996ef7634dedf073d02";
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");
const goldenDir = join(repoRoot, "parity", "golden", "v1", "pure");

const registry: Record<string, Handler> = {
  ...schedulerOps,
  ...dashboardOps,
  ...chatOps,
  ...cooperativeOps,
  ...telegramMenuOps,
  ...telegramRuntimeOps,
};

interface CaseDef {
  caseId: string;
  op: string;
  source: string;
  input?: Input;
  /** Aserciones tomadas literalmente del test de origen. */
  check?: (result: unknown) => void;
  /** Si el test espera un throw, aquí se declara el contrato de error. */
  expectError?: { class: string; messageIncludes: string };
}

interface ModuleSpec {
  file: string;
  module: string;
  targetService: string;
  sourceTests: string[];
  notes: string;
  cases: CaseDef[];
}

function classify(message: string): string {
  return /positiv|rango|válid|invalid|debe|requiere|rechaza/i.test(message)
    ? "validation"
    : "error";
}

async function compileCase(def: CaseDef): Promise<Record<string, unknown>> {
  const handler = registry[def.op];
  if (!handler) throw new Error(`${def.caseId}: operación desconocida ${def.op}.`);
  const base: Record<string, unknown> = {
    caseId: def.caseId,
    op: def.op,
    source: def.source,
    ...(def.input === undefined ? {} : { input: def.input }),
  };
  let result: unknown;
  try {
    result = await handler(def.input ?? {});
  } catch (error) {
    if (!def.expectError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    const errorClass = classify(message);
    if (errorClass !== def.expectError.class) {
      throw new Error(
        `${def.caseId}: clase de error ${errorClass}, esperada ${def.expectError.class} (${message})`,
      );
    }
    if (!message.includes(def.expectError.messageIncludes)) {
      throw new Error(
        `${def.caseId}: el mensaje no incluye "${def.expectError.messageIncludes}" (${message})`,
      );
    }
    return { ...base, expectError: { class: errorClass, messageIncludes: def.expectError.messageIncludes } };
  }
  if (def.expectError) {
    throw new Error(`${def.caseId}: se esperaba error y el oráculo devolvió ${JSON.stringify(result)}`);
  }
  def.check?.(result);
  return { ...base, expect: result };
}

function buildFile(spec: ModuleSpec, cases: Record<string, unknown>[]): { payload: Record<string, unknown>; hash: string } {
  const hash = canonicalHash(cases);
  return {
    hash,
    payload: {
      schema: "qvaapply.parity/v1",
      suite: "pure",
      targetService: spec.targetService,
      module: spec.module,
      sourceTests: spec.sourceTests,
      generatedFrom: { impl: "typescript", commit: COMMIT, approvedBy: "f0-bootstrap" },
      notes: `${spec.notes} · goldenHash=${hash}`,
      cases,
    },
  };
}

const HISTORY = Array.from({ length: 300 }, (_, index) => ({
  coin: index % 2 ? "BANK_CUP" : "CLASICA",
  createdAt: index,
  medianBuy: index,
}));

const modules: ModuleSpec[] = [
  {
    file: "scheduler.json",
    module: "src/scheduler.ts",
    targetService: "money-core",
    sourceTests: ["test/scheduler.test.ts"],
    notes:
      "Planificador inyectable: exclusión de ejecuciones solapadas y rechazo tras stop. La secuencia se declara por `steps`; no hay temporizadores reales en el escenario.",
    cases: [
      {
        caseId: "pure/scheduler/overlap/0001",
        op: "scheduler.sequence",
        source: "test/scheduler.test.ts:5",
        input: {
          steps: [
            { op: "register", name: "scan", interval: 1_000, task: "hold" },
            { op: "begin", name: "scan" },
            { op: "settle" },
            { op: "run", name: "scan" },
            { op: "calls", name: "scan" },
            { op: "release", name: "scan" },
            { op: "join", name: "scan" },
          ],
        },
        check: (result) => {
          const value = result as { results: unknown[] };
          assert.equal(value.results[3], false);
          assert.equal(value.results[4], 1);
          assert.equal(value.results[6], true);
        },
      },
      {
        caseId: "pure/scheduler/closed/0001",
        op: "scheduler.sequence",
        source: "test/scheduler.test.ts:20",
        input: {
          steps: [
            { op: "register", name: "job", interval: 1_000, task: "noop" },
            { op: "start" },
            { op: "stop" },
            { op: "run", name: "job" },
          ],
        },
        check: (result) => {
          const value = result as { results: unknown[] };
          assert.equal(value.results[3], false);
        },
      },
    ],
  },
  {
    file: "dashboard.json",
    module: "src/dashboard.ts",
    targetService: "money-core",
    sourceTests: ["test/dashboard.test.ts", "test/market-history-compact.test.ts"],
    notes:
      "Funciones puras del panel: margen neto con comisión fija, reparto de presupuesto por mejores tasas y compactación determinista del histórico. Importes y tasas a 8 dp.",
    cases: [
      {
        caseId: "pure/dashboard/margin/0001",
        op: "dashboard.margin",
        source: "test/dashboard.test.ts:5",
        input: { buyRate: 970, sellRate: 1_010, amount: 35, sellFeePercent: 0.25 },
        check: (result) => {
          const value = result as Record<string, string>;
          assert.equal(value.cost, "33950.00000000");
          assert.equal(value.netRevenue, "35261.62500000");
          assert.equal(value.netProfit, "1311.62500000");
          assert.ok(Number(value.breakEvenRate) > 970);
        },
      },
      {
        caseId: "pure/dashboard/margin/fixed-fee/0001",
        op: "dashboard.margin",
        source: "test/dashboard.test.ts:13",
        input: { buyRate: 1.04, sellRate: 1.12, amount: 10, sellFeePercent: 0, outgoingTransferFee: 0.08 },
        check: (result) => {
          const value = result as Record<string, string>;
          assert.ok(Math.abs(Number(value.cost) - 10.48) < 0.000001);
          assert.ok(Math.abs(Number(value.breakEvenRate) - 1.048) < 0.000001);
        },
      },
      {
        caseId: "pure/dashboard/allocate/0001",
        op: "dashboard.allocate",
        source: "test/dashboard.test.ts:19",
        input: {
          budget: 35_000,
          reserve: 1_000,
          maximumPerOffer: 35,
          opportunities: [
            { rate: 980, amount: 20 },
            { rate: 970, amount: 20 },
          ],
        },
        check: (result) => {
          assert.deepEqual(result, [
            { rate: "970.00000000", fiat: "19400.00000000", qusd: "20.00000000" },
            { rate: "980.00000000", fiat: "14600.00000000", qusd: "14.89795918" },
          ]);
        },
      },
      {
        caseId: "pure/dashboard/compact-history/0001",
        op: "dashboard.compact-history",
        source: "test/market-history-compact.test.ts:5",
        input: { history: HISTORY, maxPerMarket: 12 },
        check: (result) => {
          const points = result as { coin: string; createdAt: number }[];
          assert.equal(points.length, 24);
          assert.deepEqual(
            points.map((point) => point.createdAt),
            [...points.map((point) => point.createdAt)].sort((a, b) => a - b),
          );
          for (const coin of ["BANK_CUP", "CLASICA"]) {
            const original = HISTORY.filter((point) => point.coin === coin);
            const compacted = points.filter((point) => point.coin === coin);
            assert.deepEqual(compacted[0], original[0]);
            assert.deepEqual(compacted.at(-1), original.at(-1));
            assert.equal(compacted.length, 12);
          }
        },
      },
    ],
  },
  {
    file: "chat-stream.json",
    module: "src/chat-stream.ts",
    targetService: "notifier",
    sourceTests: ["test/chat-stream.test.ts"],
    notes:
      "Framing SSE acotado: separa fragmentos, ignora heartbeats y rechaza eventos > 64 KiB. El chat de una orden usa su query y no bloquea una aplicación.",
    cases: [
      {
        caseId: "pure/chat-stream/sse/0001",
        op: "chat.consume",
        source: "test/chat-stream.test.ts:7",
        input: {
          chunks: [
            ": ping\n\nevent: heartbeat\ndata: {}\n\ndata: {\"message\":",
            "\"Hola\"}\r\n\r\ndata: {\"type\":\"ping\"}\n\ndata: changed\n\n",
          ],
        },
        check: (result) => {
          assert.equal((result as { changes: number }).changes, 2);
        },
      },
      {
        caseId: "pure/chat-stream/oversized/0001",
        op: "chat.consume",
        source: "test/chat-stream.test.ts:9",
        input: { chunks: ["x".repeat(65_537)] },
        expectError: { class: "error", messageIncludes: "grande" },
      },
      {
        caseId: "pure/chat-stream/order-read/0001",
        op: "chat.order-read",
        source: "test/chat-stream.test.ts:13",
        check: (result) => {
          const paths = (result as { paths: string[] }).paths;
          assert.ok(paths.some((path) => path.endsWith("/p2p/other/apply")));
          assert.ok(paths.some((path) => path.endsWith("/p2p/parent/chat?order=child")));
        },
      },
    ],
  },
  {
    file: "cooperative-menu.json",
    module: "src/cooperative-menu.ts",
    targetService: "notifier",
    sourceTests: ["test/cooperative-menu.test.ts"],
    notes:
      "Menú cooperativo: codificación dentro de 64 bytes, flujo precio → mínimo → confirmación con token fijo y rechazo de importes ambiguos.",
    cases: [
      {
        caseId: "pure/cooperative-menu/roundtrip/0001",
        op: "coop.roundtrip",
        source: "test/cooperative-menu.test.ts:10",
        input: {
          actions: [
            { type: "home" },
            { type: "refresh" },
            { type: "edit", coin: "BANK_CUP" },
            { type: "withdraw", coin: "BANDECPREPAGO" },
            { type: "withdraw-confirm", coin: "CLASICA" },
            { type: "confirm", token: "token1" },
            { type: "cancel", token: "token1" },
          ],
        },
        check: (result) => {
          const results = (result as { results: { encoded: string; bytes: number; decoded: unknown }[] }).results;
          const actions = [
            { type: "home" },
            { type: "refresh" },
            { type: "edit", coin: "BANK_CUP" },
            { type: "withdraw", coin: "BANDECPREPAGO" },
            { type: "withdraw-confirm", coin: "CLASICA" },
            { type: "confirm", token: "token1" },
            { type: "cancel", token: "token1" },
          ];
          results.forEach((item, index) => {
            assert.ok(item.encoded.startsWith("coop:"));
            assert.ok(item.bytes <= 64);
            assert.deepEqual(item.decoded, actions[index]);
          });
        },
      },
      {
        caseId: "pure/cooperative-menu/sessions/0001",
        op: "coop.sessions",
        source: "test/cooperative-menu.test.ts:29",
        input: {
          steps: [
            { op: "begin", chatId: "admin", coin: "BANK_CUP" },
            { op: "accept", chatId: "admin", text: "390,5" },
            { op: "accept", chatId: "admin", text: "1000" },
            { op: "confirm", chatId: "admin", token: "otro-token" },
            { op: "confirm", chatId: "admin", token: "token1" },
            { op: "current", chatId: "admin" },
          ],
        },
        check: (result) => {
          const results = (result as { results: unknown[] }).results;
          assert.equal((results[0] as { stage: string }).stage, "price");
          assert.equal((results[1] as { stage: string }).stage, "minimal");
          assert.equal((results[2] as { stage: string }).stage, "confirm");
          assert.ok("error" in (results[3] as object));
          assert.deepEqual(results[4], { coin: "BANK_CUP", price: 390.5, minimal: 1_000 });
          assert.equal(results[5], undefined);
        },
      },
      {
        caseId: "pure/cooperative-menu/invalid-amounts/0001",
        op: "coop.sessions",
        source: "test/cooperative-menu.test.ts:45",
        input: {
          steps: [
            { op: "begin", chatId: "admin", coin: "CLASICA" },
            { op: "accept", chatId: "admin", text: "" },
            { op: "accept", chatId: "admin", text: "0" },
            { op: "accept", chatId: "admin", text: "-1" },
            { op: "accept", chatId: "admin", text: "1e3" },
            { op: "accept", chatId: "admin", text: "1,2,3" },
            { op: "accept", chatId: "admin", text: "Infinity" },
            { op: "cancel", chatId: "admin" },
            { op: "current", chatId: "admin" },
          ],
        },
        check: (result) => {
          const results = (result as { results: unknown[] }).results;
          for (const item of results.slice(1, 7)) {
            assert.match((item as { error: string }).error, /importe/i);
          }
          assert.equal((results[7] as { coin: string }).coin, "CLASICA");
          assert.equal(results[8], undefined);
        },
      },
      {
        caseId: "pure/cooperative-menu/decode-invalid/0001",
        op: "coop.decode",
        source: "test/cooperative-menu.test.ts:24",
        input: { data: "coop:e:moneda inválida" },
        expectError: { class: "validation", messageIncludes: "inválido" },
      },
    ],
  },
  {
    file: "telegram-menu.json",
    module: "src/telegram-menu.ts",
    targetService: "notifier",
    sourceTests: ["test/telegram-menu.test.ts"],
    notes:
      "Menú nativo de Telegram: comandos sin duplicados, acciones de cacería dentro de 64 bytes, tasas exactas y flujo de edición con token vigente.",
    cases: [
      {
        caseId: "pure/telegram-menu/commands/0001",
        op: "telegram.commands",
        source: "test/telegram-menu.test.ts:12",
        check: (result) => {
          const value = result as { commands: string[]; unique: boolean; allDescribed: boolean };
          assert.deepEqual(value.commands, [
            "panel", "balance", "hunting", "network", "coop", "markets", "offers",
            "recovery", "operations", "strategy", "automation", "scan", "logs",
            "diagnostico", "historial", "salud", "rentabilidad", "simular", "help",
          ]);
          assert.equal(value.unique, true);
          assert.equal(value.allDescribed, true);
        },
      },
      {
        caseId: "pure/telegram-menu/roundtrip/0001",
        op: "telegram.roundtrip",
        source: "test/telegram-menu.test.ts:38",
        input: {
          actions: [
            { type: "home" },
            { type: "global-toggle", side: "buy" },
            { type: "market", coin: "BANDECPREPAGO" },
            { type: "market-toggle", side: "sell", coin: "BANK_CUP" },
            { type: "rate-edit", side: "buy", coin: "CLASICA" },
            { type: "rate-confirm", token: "ab12cd34" },
            { type: "rate-cancel", token: "ab12cd34" },
          ],
        },
        check: (result) => {
          const results = (result as { results: { encoded: string; bytes: number; decoded: unknown }[] }).results;
          const actions = [
            { type: "home" },
            { type: "global-toggle", side: "buy" },
            { type: "market", coin: "BANDECPREPAGO" },
            { type: "market-toggle", side: "sell", coin: "BANK_CUP" },
            { type: "rate-edit", side: "buy", coin: "CLASICA" },
            { type: "rate-confirm", token: "ab12cd34" },
            { type: "rate-cancel", token: "ab12cd34" },
          ];
          results.forEach((item, index) => {
            assert.ok(item.encoded.startsWith("hunt:"));
            assert.ok(item.bytes <= 64);
            assert.deepEqual(item.decoded, actions[index]);
          });
        },
      },
      {
        caseId: "pure/telegram-menu/parse-rates/0001",
        op: "telegram.parse-rates",
        source: "test/telegram-menu.test.ts:58",
        input: { texts: ["930", " 1.125 ", "1,125", "", "0", "-1", "1,2,3", "1e3", "Infinity"] },
        check: (result) => {
          const results = (result as { results: unknown[] }).results;
          assert.deepEqual(results[0], { value: 930 });
          assert.deepEqual(results[1], { value: 1.125 });
          assert.deepEqual(results[2], { value: 1.125 });
          for (const item of results.slice(3)) {
            assert.match((item as { error: string }).error, /tasa/i);
          }
        },
      },
      {
        caseId: "pure/telegram-menu/rate-sessions/0001",
        op: "telegram.rate-sessions",
        source: "test/telegram-menu.test.ts:64",
        input: {
          steps: [
            { op: "begin", chatId: "admin", coin: "BANK_CUP", side: "buy", previousRate: 925 },
            { op: "propose", chatId: "admin", text: "930,5" },
            { op: "confirm", chatId: "admin", token: "token-equivocado" },
            { op: "current", chatId: "admin" },
            { op: "confirm", chatId: "admin", token: "token1" },
            { op: "current", chatId: "admin" },
          ],
        },
        check: (result) => {
          const results = (result as { results: unknown[] }).results;
          assert.equal((results[0] as { stage: string }).stage, "input");
          assert.equal((results[1] as { stage: string }).stage, "confirm");
          assert.equal((results[1] as { proposedRate: number }).proposedRate, 930.5);
          assert.ok("error" in (results[2] as object));
          assert.equal((results[3] as { stage: string }).stage, "confirm");
          assert.equal((results[4] as { proposedRate: number }).proposedRate, 930.5);
          assert.equal(results[5], undefined);
        },
      },
      {
        caseId: "pure/telegram-menu/cancel/0001",
        op: "telegram.rate-sessions",
        source: "test/telegram-menu.test.ts:83",
        input: {
          steps: [
            { op: "begin", chatId: "admin", coin: "CLASICA", side: "sell", previousRate: 1.12 },
            { op: "cancel", chatId: "admin" },
            { op: "current", chatId: "admin" },
            { op: "confirm", chatId: "admin", token: "token1" },
          ],
        },
        check: (result) => {
          const results = (result as { results: unknown[] }).results;
          assert.equal((results[1] as { previousRate: number }).previousRate, 1.12);
          assert.equal(results[2], undefined);
          assert.ok("error" in (results[3] as object));
        },
      },
      {
        caseId: "pure/telegram-menu/decode-invalid/0001",
        op: "telegram.decode",
        source: "test/telegram-menu.test.ts:53",
        input: { data: "hunt:market:codigo inválido" },
        expectError: { class: "validation", messageIncludes: "inválida" },
      },
    ],
  },
  {
    file: "telegram-runtime.json",
    module: "src/telegram-runtime.ts",
    targetService: "notifier",
    sourceTests: ["test/telegram-runtime.test.ts"],
    notes:
      "Runtime de Telegram: callbacks expirados no derriban el proceso, split conserva dos puntos, el guard invalida ediciones anteriores y se reconoce el texto sin cambios.",
    cases: [
      {
        caseId: "pure/telegram-runtime/answer-callback/expired/0001",
        op: "telegram.answer-callback",
        source: "test/telegram-runtime.test.ts:12",
        input: { scenario: "expired" },
        check: (result) => {
          assert.equal((result as { answered: boolean }).answered, false);
          assert.equal((result as { calls: number }).calls, 1);
        },
      },
      {
        caseId: "pure/telegram-runtime/answer-callback/valid/0001",
        op: "telegram.answer-callback",
        source: "test/telegram-runtime.test.ts:21",
        input: { scenario: "valid" },
        check: (result) => {
          assert.equal((result as { answered: boolean }).answered, true);
          assert.equal((result as { calls: number }).calls, 1);
        },
      },
      {
        caseId: "pure/telegram-runtime/split-callback/0001",
        op: "telegram.split-callback",
        source: "test/telegram-runtime.test.ts:29",
        input: { data: "panel:market:BANDECPREPAGO" },
        check: (result) => {
          assert.deepEqual((result as { parts: string[] }).parts, ["panel", "market:BANDECPREPAGO"]);
        },
      },
      {
        caseId: "pure/telegram-runtime/render-guard/0001",
        op: "telegram.render-guard",
        source: "test/telegram-runtime.test.ts:36",
        input: {
          steps: [
            { op: "begin", key: "admin-chat", label: "first" },
            { op: "isCurrent", key: "admin-chat", label: "first" },
            { op: "begin", key: "admin-chat", label: "second" },
            { op: "isCurrent", key: "admin-chat", label: "first" },
          ],
        },
        check: (result) => {
          const results = (result as { results: unknown[] }).results;
          assert.deepEqual(results[1], { current: true });
          assert.deepEqual(results[3], { current: false });
        },
      },
      {
        caseId: "pure/telegram-runtime/not-modified/0001",
        op: "telegram.not-modified",
        source: "test/telegram-runtime.test.ts:44",
        input: { message: "Bad Request: message is not modified" },
        check: (result) => {
          assert.equal((result as { notModified: boolean }).notModified, true);
        },
      },
      {
        caseId: "pure/telegram-runtime/not-modified/0002",
        op: "telegram.not-modified",
        source: "test/telegram-runtime.test.ts:45",
        input: { message: "network error" },
        check: (result) => {
          assert.equal((result as { notModified: boolean }).notModified, false);
        },
      },
    ],
  },
];

async function main(): Promise<void> {
  const checkOnly = process.argv.includes("--check");
  let drift = false;
  let totalCases = 0;
  for (const spec of modules) {
    const cases: Record<string, unknown>[] = [];
    for (const def of spec.cases) cases.push(await compileCase(def));
    const { payload, hash } = buildFile(spec, cases);
    totalCases += spec.cases.length;
    const path = join(goldenDir, spec.file);
    const serialized = `${JSON.stringify(payload, null, 2)}\n`;
    if (checkOnly) {
      const current = existsSync(path) ? readFileSync(path, "utf8") : "";
      if (current !== serialized) {
        drift = true;
        console.error(`✗ ${spec.file}: golden desactualizado (hash actual ${hash}).`);
      } else {
        console.log(`✓ ${spec.file} (${spec.cases.length} casos, goldenHash=${hash.slice(0, 12)}…)`);
      }
      continue;
    }
    writeFileSync(path, serialized);
    console.log(`→ ${spec.file}: ${spec.cases.length} casos, goldenHash=${hash}`);
  }
  console.log(`\n${modules.length} lotes, ${totalCases} casos${checkOnly ? " verificados" : " generados"}.`);
  if (checkOnly && drift) {
    console.error("Los goldens no coinciden con el oráculo; regenera con el script sin --check.");
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exit(2);
});
