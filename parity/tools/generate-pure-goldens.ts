/**
 * Generador repetible de goldens de dominio puro — lote 3 (F0).
 *
 * Cierra los 8 archivos P que faltaban para cubrir los 21 archivos / 107 casos
 * portables de L1: auth y controles del panel, operador móvil, intenciones
 * monetarias, presupuesto de listados, caché de saldo QUSD y los dos bucles de
 * cacería.
 *
 * Igual que los lotes anteriores, `expect` se deriva ejecutando el oráculo
 * TypeScript congelado a través de `parity/adapters/ops/*`; las aserciones
 * literales de los tests de origen se declaran en `check` para detectar deriva.
 *
 * Uso:
 *   node --import tsx parity/tools/generate-pure-goldens.ts          # regenera
 *   node --import tsx parity/tools/generate-pure-goldens.ts --check  # solo verifica
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalHash } from "../lib/canonical.js";
import { ops as dashboardAuthOps } from "../adapters/ops/dashboard-auth.js";
import { ops as dashboardControlsOps } from "../adapters/ops/dashboard-controls.js";
import { ops as mobileOperatorOps } from "../adapters/ops/mobile-operator.js";
import { ops as monetaryIntentsOps } from "../adapters/ops/monetary-intents.js";
import { ops as marketListBudgetOps } from "../adapters/ops/market-list-budget.js";
import { ops as qusdBalanceCacheOps } from "../adapters/ops/qusd-balance-cache.js";
import { ops as huntingBalanceLoopsOps } from "../adapters/ops/hunting-balance-loops.js";
import { ops as marketHuntingLoopsOps } from "../adapters/ops/market-hunting-loops.js";

type Input = Record<string, unknown>;
type Handler = (input: Input) => unknown | Promise<unknown>;

const COMMIT = "02bb5afc04b5eb95f5ac3996ef7634dedf073d02";
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");
const goldenDir = join(repoRoot, "parity", "golden", "v1", "pure");

const registry: Record<string, Handler> = {
  ...dashboardAuthOps,
  ...dashboardControlsOps,
  ...mobileOperatorOps,
  ...monetaryIntentsOps,
  ...marketListBudgetOps,
  ...qusdBalanceCacheOps,
  ...huntingBalanceLoopsOps,
  ...marketHuntingLoopsOps,
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

function resultsOf(result: unknown): unknown[] {
  return (result as { results: unknown[] }).results;
}

function at<T>(items: unknown[], index: number): T {
  return items[index] as T;
}

const modules: ModuleSpec[] = [
  {
    file: "dashboard-auth.json",
    module: "src/dashboard-auth.ts",
    targetService: "gateway",
    sourceTests: ["test/dashboard-auth.test.ts"],
    notes:
      "Autenticación local del panel: cookie HttpOnly/SameSite=Strict, CSRF exacto, alias loopback del mismo puerto, límite de 5 intentos y expiración de sesión. No se exponen cookies ni tokens reales.",
    cases: [
      {
        caseId: "pure/dashboard-auth/login-csrf/0001",
        op: "auth.login",
        source: "test/dashboard-auth.test.ts:5",
        input: {
          password: "correcta-muy-larga-2026",
          trustedOrigin: "http://127.0.0.1:3000",
          now: 1_000,
          loginPassword: "correcta-muy-larga-2026",
          clientId: "local",
        },
        check: (result) => {
          const value = result as Record<string, unknown>;
          assert.equal(value.httpOnly, true);
          assert.equal(value.sameSiteStrict, true);
          assert.equal(value.csrfAccepted, true);
          assert.equal(value.wrongCsrfStatus, 403);
        },
      },
      {
        caseId: "pure/dashboard-auth/origins-rate-limit/0001",
        op: "auth.origins-rate-limit",
        source: "test/dashboard-auth.test.ts:20",
        input: {
          password: "correcta-muy-larga-2026",
          trustedOrigin: "http://127.0.0.1:3000",
          now: 0,
          clientId: "local",
          failed: 5,
          origins: [
            "http://127.0.0.1:3000",
            "http://localhost:3000",
            "http://[::1]:3000",
            "http://localhost:3001",
            "https://localhost:3000",
            "http://127.0.0.1.example:3000",
            "http://192.168.1.5:3000",
            null,
          ],
        },
        check: (result) => {
          const value = result as {
            origins: { ok: boolean; status?: number }[];
            failedStatuses: number[];
            finalStatus?: number;
          };
          assert.deepEqual(value.origins.slice(0, 3), [{ ok: true }, { ok: true }, { ok: true }]);
          for (const item of value.origins.slice(3)) {
            assert.deepEqual(item, { ok: false, status: 403 });
          }
          assert.deepEqual(value.failedStatuses, [401, 401, 401, 401, 401]);
          assert.equal(value.finalStatus, 429);
        },
      },
      {
        caseId: "pure/dashboard-auth/origins-public/0001",
        op: "auth.origins",
        source: "test/dashboard-auth.test.ts:41",
        input: {
          password: "correcta-muy-larga-2026",
          trustedOrigin: "https://panel.example.com",
          origins: [
            "https://panel.example.com",
            "https://localhost",
            "http://panel.example.com",
          ],
        },
        check: (result) => {
          const value = result as { results: { ok: boolean; status?: number }[] };
          assert.deepEqual(value.results, [
            { ok: true },
            { ok: false, status: 403 },
            { ok: false, status: 403 },
          ]);
        },
      },
      {
        caseId: "pure/dashboard-auth/session-expiry/0001",
        op: "auth.session",
        source: "test/dashboard-auth.test.ts:51",
        input: {
          password: "correcta-muy-larga-2026",
          trustedOrigin: "http://127.0.0.1:3000",
          now: 0,
          sessionDurationMs: 100,
          advance: 101,
        },
        check: (result) => {
          const value = result as { before: boolean; after: boolean };
          assert.equal(value.before, true);
          assert.equal(value.after, false);
        },
      },
    ],
  },
  {
    file: "dashboard-controls.json",
    module: "src/dashboard.ts",
    targetService: "dashboard-bff",
    sourceTests: ["test/dashboard-controls.test.ts"],
    notes:
      "Controles del panel sobre DashboardReadModel con dependencias falsas: pausa local vs reanudación validada, delegación de cacería y refresco periódico que reutiliza mercados.",
    cases: [
      {
        caseId: "pure/dashboard-controls/pause/0001",
        op: "dashboard.controls.pause",
        source: "test/dashboard-controls.test.ts:5",
        check: (result) => {
          assert.deepEqual((result as { calls: string[] }).calls, [
            "pause:true:panel web",
            "activate",
          ]);
        },
      },
      {
        caseId: "pure/dashboard-controls/hunting/0001",
        op: "dashboard.controls.hunting",
        source: "test/dashboard-controls.test.ts:25",
        input: {
          value: {
            sellRunning: false,
            market: { code: "CLASICA", huntBuyEnabled: true, buyMaxRate: 1.04 },
          },
        },
        check: (result) => {
          assert.deepEqual((result as { calls: unknown[] }).calls, [{
            sellRunning: false,
            market: { code: "CLASICA", huntBuyEnabled: true, buyMaxRate: 1.04 },
          }]);
        },
      },
      {
        caseId: "pure/dashboard-controls/refresh/0001",
        op: "dashboard.controls.refresh",
        source: "test/dashboard-controls.test.ts:45",
        check: (result) => {
          const value = result as { first: string[]; second: string[] };
          assert.deepEqual(value.first, ["balance", "own", "transactions"]);
          assert.deepEqual(value.second, ["balance", "own", "transactions", "CUP", "CLASICA"]);
        },
      },
    ],
  },
  {
    file: "mobile-operator.json",
    module: "src/mobile-operator.ts",
    targetService: "gateway",
    sourceTests: ["test/mobile-operator.test.ts"],
    notes:
      "Contrato móvil: token solo hasheado, cupos de lectura y mutación separados, revocación, auditoría de acciones inciertas sin filtrar el secreto y composición de operaciones con órdenes hermanas.",
    cases: [
      {
        caseId: "pure/mobile-operator/credentials/0001",
        op: "mobile.operator.credentials",
        source: "test/mobile-operator.test.ts:5",
        check: (result) => {
          const value = result as Record<string, unknown>;
          assert.equal(value.tokenLength, 48);
          assert.equal(value.tokenStored, false);
          assert.equal(value.first, true);
          assert.equal(value.rateLimitedAfter60, true);
          assert.equal(value.readOkAfterWriteLimit, true);
          assert.equal(value.readRateLimitedAfter20, true);
          assert.equal(value.writeStillLimited, true);
          assert.equal(value.okAfterWindow, true);
          assert.equal(value.revoked, true);
          assert.equal(value.checkAfterRevoke, false);
          assert.deepEqual(value.audit, ["mobile_operator_created", "mobile_operator_revoked"]);
        },
      },
      {
        caseId: "pure/mobile-operator/action-uncertain/0001",
        op: "mobile.operator.action-uncertain",
        source: "test/mobile-operator.test.ts:34",
        check: (result) => {
          const value = result as { error: string; audit: string[] };
          assert.match(value.error, /timeout/);
          assert.deepEqual(value.audit, [
            "mobile_paid_requested",
            "mobile_paid_uncertain",
            "mobile_action_timing",
          ]);
        },
      },
      {
        caseId: "pure/mobile-operator/action-audit-failure/0001",
        op: "mobile.operator.action-audit-failure",
        source: "test/mobile-operator.test.ts:47",
        check: (result) => {
          const value = result as Record<string, unknown>;
          assert.equal(value.mutations, 1);
          assert.equal(value.outcome, "confirmed");
          assert.equal(value.totalMsAtLeastZero, true);
          assert.equal(value.secretLeaked, false);
        },
      },
      {
        caseId: "pure/mobile-operator/operations/0001",
        op: "mobile.operator.operations",
        source: "test/mobile-operator.test.ts:67",
        input: {
          limit: 10,
          operations: [
            { uuid: "sell-1", offerType: "sell", coin: "BPA", amount: 10, receive: 100, rate: 10, state: "applied", createdAt: 1 },
            { uuid: "buy-1", offerType: "buy", coin: "BAND", amount: 10, receive: 100, rate: 10, state: "acknowledged", createdAt: 2 },
            { uuid: "buy-paid", offerType: "buy", coin: "BAND", amount: 10, receive: 100, rate: 10, state: "paid", createdAt: 3 },
            { uuid: "buy-revision", offerType: "buy", coin: "BAND", amount: 10, receive: 100, rate: 10, state: "revision", createdAt: 4 },
          ],
          alerts: [
            { id: "a1", type: "operation-applied", message: "Aviso", createdAt: 3, operationUuid: "sell-1", url: "/?view=ops" },
          ],
          markets: [
            { code: "BPA", label: "BPA", currency: "CUP" },
            { code: "BAND", label: "Bandec", currency: "CUP" },
          ],
        },
        check: (result) => {
          const value = result as {
            operations: { actions: string[] }[];
            alerts: unknown[];
          };
          assert.deepEqual(value.operations[0]?.actions, ["paid", "cancel"]);
          assert.deepEqual(value.operations[1]?.actions, ["received", "cancel"]);
          assert.deepEqual(value.operations[2]?.actions, ["received"]);
          assert.deepEqual(value.operations[3]?.actions, []);
          assert.deepEqual(value.alerts, [{
            id: "a1",
            type: "operation-applied",
            message: "Aviso",
            createdAt: 3,
            operationUuid: "sell-1",
          }]);
        },
      },
      {
        caseId: "pure/mobile-operator/threads/0001",
        op: "mobile.operator.threads",
        source: "test/mobile-operator.test.ts:87",
        input: {
          limit: 100,
          operations: [
            { uuid: "parent", orderUuid: "one", offerType: "sell", coin: "CLASICA", amount: 10, receive: 11, rate: 1.1, state: "applied", createdAt: 1 },
          ],
          threads: [
            { id: "parent:one", uuid: "parent", orderUuid: "one", offerType: "sell", role: "taker", coin: "CLASICA", amount: 10, receive: 11, state: "applied", createdAt: 1, discoveredAt: 1, updatedAt: 1 },
            { id: "parent:two", uuid: "parent", orderUuid: "two", offerType: "sell", role: "taker", coin: "CLASICA", amount: 20, receive: 22, state: "processing", createdAt: 2, discoveredAt: 2, updatedAt: 2 },
            { id: "own:fixed", uuid: "own", offerType: "buy", role: "creator", coin: "CLASICA", amount: 30, receive: 33, state: "paid", createdAt: 3, discoveredAt: 3, updatedAt: 3 },
          ],
          markets: [{ code: "CLASICA", label: "Clásica", currency: "USD" }],
        },
        check: (result) => {
          const operations = (result as {
            operations: {
              id: string;
              uuid: string;
              orderUuid?: string;
              side: string;
              role: string;
              chatAvailable: boolean;
              actions: string[];
            }[];
          }).operations;
          assert.equal(operations.length, 3);
          assert.equal(new Set(operations.map((operation) => operation.id)).size, 3);
          assert.deepEqual(operations.find((operation) => operation.orderUuid === "one")?.actions, ["paid", "cancel"]);
          assert.deepEqual(operations.find((operation) => operation.orderUuid === "two")?.actions, []);
          const own = operations.find((operation) => operation.uuid === "own");
          assert.equal(own?.side, "sell");
          assert.equal(own?.role, "creator");
          assert.equal(own?.chatAvailable, true);
          assert.deepEqual(own?.actions, []);
        },
      },
    ],
  },
  {
    file: "monetary-intents.json",
    module: "src/application/monetary-intents.ts",
    targetService: "money-core",
    sourceTests: ["test/monetary-intents.test.ts"],
    notes:
      "Intención durable antes de despachar: el repositorio en memoria registra `created`, el resultado remoto y la auditoría; el observador de tiempos no puede alterar el resultado y la clasificación de fallos es conservadora.",
    cases: [
      {
        caseId: "pure/monetary-intents/timing/0001",
        op: "monetary.timing",
        source: "test/monetary-intents.test.ts:53",
        check: (result) => {
          const value = result as {
            phases: string[];
            durationsFinite: boolean;
            state?: string;
          };
          assert.deepEqual(value.phases, ["intentPersistMs", "mutationMs", "resultPersistMs"]);
          assert.equal(value.durationsFinite, true);
          assert.equal(value.state, "confirmed");
        },
      },
      {
        caseId: "pure/monetary-intents/persist-before-dispatch/0001",
        op: "monetary.persist-before-dispatch",
        source: "test/monetary-intents.test.ts:71",
        check: (result) => {
          const value = result as { result: unknown; state?: string; events: string[] };
          assert.deepEqual(value.result, { ok: true });
          assert.equal(value.state, "confirmed");
          assert.deepEqual(value.events, [
            "created:intent-1",
            "remote:apply",
            "confirmed:intent-1",
          ]);
        },
      },
      {
        caseId: "pure/monetary-intents/persist-failure/0001",
        op: "monetary.persist-failure",
        source: "test/monetary-intents.test.ts:95",
        check: (result) => {
          const value = result as { dispatched: boolean; message: string };
          assert.equal(value.dispatched, false);
          assert.match(value.message, /sqlite unavailable/);
        },
      },
      {
        caseId: "pure/monetary-intents/failure-classification/0001",
        op: "monetary.failure-classification-all",
        source: "test/monetary-intents.test.ts:116",
        input: { kinds: ["4xx", "5xx", "timeout", "unknown"] },
        check: (result) => {
          const items = resultsOf(result) as {
            kind: string;
            sameError: boolean;
            state?: string;
            events: string[];
          }[];
          const expected = ["rejected", "uncertain", "uncertain", "uncertain"];
          items.forEach((item, index) => {
            assert.equal(item.sameError, true);
            assert.equal(item.state, expected[index]);
            assert.ok(item.events.includes(`audit:mutation_${expected[index]}`));
          });
        },
      },
      {
        caseId: "pure/monetary-intents/outcome/0001",
        op: "monetary.outcome-all",
        source: "test/monetary-intents.test.ts:168",
        input: { kinds: ["4xx", "5xx", "timeout", "unknown"] },
        check: (result) => {
          const items = resultsOf(result) as { kind: string; outcome: string }[];
          assert.deepEqual(
            items.map((item) => item.outcome),
            ["rejected", "uncertain", "uncertain", "uncertain"],
          );
        },
      },
    ],
  },
  {
    file: "market-list-budget.json",
    module: "src/market-list-budget.ts",
    targetService: "qvapay-adapter",
    sourceTests: ["test/market-list-budget.test.ts"],
    notes:
      "Cuota de listados por titular con reloj y almacén virtuales: intervalo por titular tras reinicio, esperas concurrentes, 429 por titular/global, revalidación de identidad y bloqueo tras fallo de persistencia.",
    cases: [
      {
        caseId: "pure/market-list-budget/owners/0001",
        op: "market-list-budget.sequence",
        source: "test/market-list-budget.test.ts:14",
        input: {
          steps: [
            { op: "setOwner", owner: " Owner-A " },
            { op: "wait" },
            { op: "setOwner", owner: "owner-b" },
            { op: "wait" },
            { op: "now" },
            { op: "recreate" },
            { op: "setOwner", owner: "OWNER-A" },
            { op: "wait" },
            { op: "sleeps" },
          ],
        },
        check: (result) => {
          const items = resultsOf(result);
          assert.deepEqual(at(items, 1), { owner: "owner-a" });
          assert.deepEqual(at(items, 3), { owner: "owner-b" });
          assert.equal(at(items, 4), 10_000);
          assert.deepEqual(at(items, 7), { owner: "owner-a" });
          assert.deepEqual(at(items, 8), [2_401]);
        },
      },
      {
        caseId: "pure/market-list-budget/independent-waits/0001",
        op: "market-list-budget.sequence",
        source: "test/market-list-budget.test.ts:23",
        input: {
          steps: [
            { op: "setOwner", owner: "a" },
            { op: "wait" },
            { op: "holdNextSleep" },
            { op: "setOwner", owner: "a" },
            { op: "beginWait", label: "waiting", owner: "a" },
            { op: "setOwner", owner: "b" },
            { op: "wait" },
            { op: "releaseSleep" },
            { op: "joinWait", label: "waiting" },
            { op: "sleeps" },
          ],
        },
        check: (result) => {
          const items = resultsOf(result);
          assert.deepEqual(at(items, 1), { owner: "a" });
          assert.deepEqual(at(items, 6), { owner: "b" });
          assert.deepEqual(at(items, 8), { owner: "a" });
          assert.deepEqual(at(items, 9), [2_401]);
        },
      },
      {
        caseId: "pure/market-list-budget/unknown-owner/0001",
        op: "market-list-budget.sequence",
        source: "test/market-list-budget.test.ts:36",
        input: {
          steps: [
            { op: "setOwner", owner: "a" },
            { op: "wait" },
            { op: "advance", ms: 1_000 },
            { op: "setOwner", owner: "b" },
            { op: "wait" },
            { op: "setOwner", owner: null },
            { op: "wait" },
            { op: "now" },
            { op: "setOwner", owner: "c" },
            { op: "wait" },
            { op: "now" },
            { op: "sleeps" },
          ],
        },
        check: (result) => {
          const items = resultsOf(result);
          assert.deepEqual(at(items, 1), { owner: "a" });
          assert.deepEqual(at(items, 4), { owner: "b" });
          assert.equal((at(items, 6) as { owner?: unknown }).owner, undefined);
          assert.equal(at(items, 7), 13_401);
          assert.deepEqual(at(items, 9), { owner: "c" });
          assert.equal(at(items, 10), 15_802);
        },
      },
      {
        caseId: "pure/market-list-budget/rate-limit/0001",
        op: "market-list-budget.sequence",
        source: "test/market-list-budget.test.ts:47",
        input: {
          steps: [
            { op: "note", owner: "Owner-A", retryAfterMs: 10_000 },
            { op: "setOwner", owner: "b" },
            { op: "wait" },
            { op: "now" },
            { op: "recreate" },
            { op: "setOwner", owner: "owner-a" },
            { op: "wait" },
            { op: "now" },
            { op: "note", owner: null, retryAfterMs: 8_000 },
            { op: "setOwner", owner: "c" },
            { op: "wait" },
            { op: "now" },
            { op: "sleeps" },
          ],
        },
        check: (result) => {
          const items = resultsOf(result);
          assert.deepEqual(at(items, 2), { owner: "b" });
          assert.equal(at(items, 3), 10_000);
          assert.deepEqual(at(items, 6), { owner: "owner-a" });
          assert.equal(at(items, 7), 20_000);
          assert.deepEqual(at(items, 10), { owner: "c" });
          assert.equal(at(items, 11), 28_000);
        },
      },
      {
        caseId: "pure/market-list-budget/known-429-no-identity/0001",
        op: "market-list-budget.sequence",
        source: "test/market-list-budget.test.ts:59",
        input: {
          steps: [
            { op: "note", owner: "a", retryAfterMs: 10_000 },
            { op: "setOwner", owner: null },
            { op: "wait" },
            { op: "now" },
            { op: "sleeps" },
          ],
        },
        check: (result) => {
          const items = resultsOf(result);
          assert.equal((at(items, 2) as { owner?: unknown }).owner, undefined);
          assert.equal(at(items, 3), 20_000);
          assert.deepEqual(at(items, 4), [10_000]);
        },
      },
      {
        caseId: "pure/market-list-budget/revalidate-identity/0001",
        op: "market-list-budget.sequence",
        source: "test/market-list-budget.test.ts:66",
        input: {
          sleepSetsOwner: "b",
          steps: [
            { op: "setOwner", owner: "a" },
            { op: "wait" },
            { op: "wait", dynamicOwner: true },
            { op: "now" },
            { op: "sleeps" },
          ],
        },
        check: (result) => {
          const items = resultsOf(result);
          assert.deepEqual(at(items, 1), { owner: "a" });
          assert.deepEqual(at(items, 2), { owner: "b" });
          assert.equal(at(items, 3), 12_401);
        },
      },
      {
        caseId: "pure/market-list-budget/persist-failure/0001",
        op: "market-list-budget.sequence",
        source: "test/market-list-budget.test.ts:76",
        input: {
          failFirstWrite: true,
          steps: [
            { op: "setOwner", owner: "a" },
            { op: "wait" },
            { op: "wait" },
          ],
        },
        check: (result) => {
          const items = resultsOf(result);
          assert.match((at(items, 1) as { error: string }).error, /disco/);
          assert.deepEqual(at(items, 2), { owner: "a" });
        },
      },
      {
        caseId: "pure/market-list-budget/rate-limit-persist-failure/0001",
        op: "market-list-budget.sequence",
        source: "test/market-list-budget.test.ts:87",
        input: {
          failFirstWrite: true,
          steps: [
            { op: "note", owner: "a", retryAfterMs: 5_000 },
            { op: "setOwner", owner: "a" },
            { op: "wait" },
            { op: "setOwner", owner: "b" },
            { op: "wait" },
          ],
        },
        check: (result) => {
          const items = resultsOf(result);
          assert.match((at(items, 0) as { error: string }).error, /disco/);
          assert.match((at(items, 2) as { error: string }).error, /bloqueados/);
          assert.match((at(items, 4) as { error: string }).error, /bloqueados/);
        },
      },
      {
        caseId: "pure/market-list-budget/prune/0001",
        op: "market-list-budget.sequence",
        source: "test/market-list-budget.test.ts:99",
        input: {
          steps: [
            { op: "setOwner", owner: "a" },
            { op: "wait" },
            { op: "writes" },
            { op: "advance", ms: 3_000 },
            { op: "setOwner", owner: "b" },
            { op: "wait" },
            { op: "writes" },
            { op: "stored" },
          ],
        },
        check: (result) => {
          const items = resultsOf(result);
          assert.equal(at(items, 2), 1);
          assert.equal(at(items, 6), 2);
          assert.equal((at(items, 7) as { ownerCount: number }).ownerCount, 1);
        },
      },
    ],
  },
  {
    file: "qusd-balance-cache.json",
    module: "src/qusd-balance-cache.ts",
    targetService: "qvapay-adapter",
    sourceTests: ["test/qusd-balance-cache.test.ts"],
    notes:
      "Caché de saldo QUSD bruto: TTL de 15 s por época, lecturas normales/urgentes independientes, respuesta remota más reciente, force con reintento, límite de 4 lecturas, cierre y descarte por control. Sin red ni reloj real.",
    cases: [
      {
        caseId: "pure/qusd-balance-cache/ttl-epoch/0001",
        op: "qusd.sequence",
        source: "test/qusd-balance-cache.test.ts:12",
        input: {
          now: 100_000,
          epoch: "1",
          reads: [{ value: 10 }, { value: 20 }, { value: 30 }],
          steps: [
            { op: "get", priority: true, context: "fast_lane" },
            { op: "advance", ms: 15_000 },
            { op: "get", priority: true, context: "fast_lane" },
            { op: "advance", ms: 1 },
            { op: "get", priority: true, context: "fast_lane" },
            { op: "setEpoch", value: "2" },
            { op: "get", priority: true, context: "fast_lane" },
            { op: "events" },
          ],
        },
        check: (result) => {
          const items = resultsOf(result);
          assert.equal((at(items, 0) as { value: string }).value, "10.00000000");
          assert.equal((at(items, 2) as { value: string }).value, "10.00000000");
          assert.equal((at(items, 4) as { value: string }).value, "20.00000000");
          assert.equal((at(items, 6) as { value: string }).value, "30.00000000");
          const misses = (at(items, 7) as string[]).filter((outcome) => outcome.startsWith("miss"));
          assert.deepEqual(misses, ["miss_absent", "miss_expired", "miss_epoch"]);
        },
      },
      {
        caseId: "pure/qusd-balance-cache/priority-independent/0001",
        op: "qusd.sequence",
        source: "test/qusd-balance-cache.test.ts:26",
        input: {
          reads: [{ hang: true }, { hang: true }],
          steps: [
            { op: "beginGet", label: "normal", priority: false, context: "warmup" },
            { op: "beginGet", label: "first", priority: true, context: "fast_lane" },
            { op: "beginGet", label: "second", priority: true, context: "fast_lane" },
            { op: "priorities" },
            { op: "calls" },
            { op: "resolveRead", index: 1, value: 25 },
            { op: "settle" },
            { op: "join", label: "first" },
            { op: "join", label: "second" },
            { op: "resolveRead", index: 0, value: 40 },
            { op: "join", label: "normal" },
            { op: "priorities" },
            { op: "calls" },
          ],
        },
        check: (result) => {
          const items = resultsOf(result);
          assert.deepEqual(at(items, 3), [false, true]);
          assert.equal(at(items, 4), 2);
          assert.equal((at(items, 7) as { value: string }).value, "25.00000000");
          assert.equal((at(items, 8) as { value: string }).value, "25.00000000");
          assert.equal((at(items, 10) as { value: string }).value, "25.00000000");
          assert.equal(at(items, 12), 2);
        },
      },
      {
        caseId: "pure/qusd-balance-cache/urgent-prevails/0001",
        op: "qusd.sequence",
        source: "test/qusd-balance-cache.test.ts:39",
        input: {
          reads: [{ hang: true }, { hang: true }],
          steps: [
            { op: "beginGet", label: "background", priority: false, context: "warmup" },
            { op: "beginGet", label: "priority", priority: true, context: "fast_lane" },
            { op: "resolveRead", index: 0, value: 100 },
            { op: "join", label: "background" },
            { op: "resolveRead", index: 1, value: 0 },
            { op: "join", label: "priority" },
            { op: "peek" },
          ],
        },
        check: (result) => {
          const items = resultsOf(result);
          assert.equal((at(items, 3) as { value: string }).value, "100.00000000");
          assert.equal((at(items, 5) as { value: string }).value, "0.00000000");
          assert.equal(at(items, 6), "0.00000000");
        },
      },
      {
        caseId: "pure/qusd-balance-cache/late-normal/0001",
        op: "qusd.sequence",
        source: "test/qusd-balance-cache.test.ts:51",
        input: {
          reads: [{ hang: true }, { hang: true }],
          steps: [
            { op: "beginGet", label: "background", priority: false, context: "warmup" },
            { op: "beginGet", label: "priority", priority: true, context: "fast_lane" },
            { op: "resolveRead", index: 1, value: 0 },
            { op: "join", label: "priority" },
            { op: "resolveRead", index: 0, value: 100 },
            { op: "join", label: "background" },
            { op: "peek" },
          ],
        },
        check: (result) => {
          const items = resultsOf(result);
          assert.equal((at(items, 3) as { value: string }).value, "0.00000000");
          assert.equal((at(items, 5) as { value: string }).value, "0.00000000");
          assert.equal(at(items, 6), "0.00000000");
        },
      },
      {
        caseId: "pure/qusd-balance-cache/forced-refresh/0001",
        op: "qusd.sequence",
        source: "test/qusd-balance-cache.test.ts:63",
        input: {
          reads: [{ hang: true }, { hang: true }],
          steps: [
            { op: "beginGet", label: "background", priority: false, context: "warmup", force: true },
            { op: "beginGet", label: "priority", priority: true, context: "fast_lane" },
            { op: "resolveRead", index: 1, value: 0 },
            { op: "join", label: "priority" },
            { op: "resolveRead", index: 0, value: 100 },
            { op: "join", label: "background" },
            { op: "peek" },
            { op: "calls" },
          ],
        },
        check: (result) => {
          const items = resultsOf(result);
          assert.equal((at(items, 3) as { value: string }).value, "0.00000000");
          assert.equal((at(items, 5) as { value: string }).value, "0.00000000");
          assert.equal(at(items, 6), "0.00000000");
          assert.equal(at(items, 7), 2);
        },
      },
      {
        caseId: "pure/qusd-balance-cache/epoch-revision/0001",
        op: "qusd.sequence",
        source: "test/qusd-balance-cache.test.ts:77",
        input: {
          epoch: "old",
          reads: [{ hang: true }],
          steps: [
            { op: "beginGet", label: "result", priority: true, context: "fast_lane" },
            { op: "setEpoch", value: "new" },
            { op: "replace", value: 20 },
            { op: "resolveRead", index: 0, value: 999 },
            { op: "join", label: "result" },
            { op: "peek" },
            { op: "calls" },
          ],
        },
        check: (result) => {
          const items = resultsOf(result);
          assert.equal((at(items, 4) as { value: string }).value, "20.00000000");
          assert.equal(at(items, 5), "20.00000000");
          assert.equal(at(items, 6), 1);
        },
      },
      {
        caseId: "pure/qusd-balance-cache/force-retry/0001",
        op: "qusd.sequence",
        source: "test/qusd-balance-cache.test.ts:90",
        input: {
          reads: [{ hang: true }, { value: 9 }],
          steps: [
            { op: "replace", value: 5 },
            { op: "beginGet", label: "pending", priority: true, context: "fast_lane", force: true },
            { op: "replace", value: 6 },
            { op: "resolveRead", index: 0, value: 500 },
            { op: "join", label: "pending" },
            { op: "calls" },
          ],
        },
        check: (result) => {
          const items = resultsOf(result);
          assert.equal((at(items, 4) as { value: string }).value, "9.00000000");
          assert.equal(at(items, 5), 2);
        },
      },
      {
        caseId: "pure/qusd-balance-cache/active-limit/0001",
        op: "qusd.sequence",
        source: "test/qusd-balance-cache.test.ts:101",
        input: {
          reads: [{ hang: true }, { hang: true }, { hang: true }, { hang: true }],
          steps: [
            { op: "setEpoch", value: "0" },
            { op: "beginGet", label: "r0", priority: true, context: "fast_lane" },
            { op: "setEpoch", value: "1" },
            { op: "beginGet", label: "r1", priority: true, context: "fast_lane" },
            { op: "setEpoch", value: "2" },
            { op: "beginGet", label: "r2", priority: true, context: "fast_lane" },
            { op: "setEpoch", value: "3" },
            { op: "beginGet", label: "r3", priority: true, context: "fast_lane" },
            { op: "setEpoch", value: "4" },
            { op: "get", priority: true, context: "fast_lane" },
            { op: "beginStop", label: "closing" },
            { op: "resolveRead", index: 0, value: 10 },
            { op: "resolveRead", index: 1, value: 10 },
            { op: "resolveRead", index: 2, value: 10 },
            { op: "resolveRead", index: 3, value: 10 },
            { op: "settle" },
            { op: "join", label: "r0" },
            { op: "join", label: "r1" },
            { op: "join", label: "r2" },
            { op: "join", label: "r3" },
            { op: "joinStop", label: "closing" },
            { op: "stopResolved" },
          ],
        },
        check: (result) => {
          const items = resultsOf(result);
          assert.match((at(items, 9) as { message: string }).message, /Demasiadas/);
          for (let index = 16; index <= 19; index += 1) {
            assert.equal((at(items, index) as { status: string }).status, "error");
            assert.match((at(items, index) as { message: string }).message, /cerrada/);
          }
          assert.equal(at(items, 21), true);
        },
      },
      {
        caseId: "pure/qusd-balance-cache/three-invalidations/0001",
        op: "qusd.sequence",
        source: "test/qusd-balance-cache.test.ts:115",
        input: {
          epoch: "1",
          reads: [
            { value: 10, advanceEpoch: true },
            { value: 10, advanceEpoch: true },
            { value: 10, advanceEpoch: true },
          ],
          steps: [
            { op: "get", priority: true, context: "fast_lane", force: true },
            { op: "calls" },
            { op: "peek" },
          ],
        },
        check: (result) => {
          const items = resultsOf(result);
          assert.match((at(items, 0) as { message: string }).message, /cambió/);
          assert.equal(at(items, 1), 3);
          assert.equal(at(items, 2), null);
        },
      },
      {
        caseId: "pure/qusd-balance-cache/invalid-balance/0001",
        op: "qusd.sequence",
        source: "test/qusd-balance-cache.test.ts:123",
        input: {
          observeThrows: true,
          reads: [{ value: "NaN" }, { value: 8 }],
          steps: [
            { op: "get", priority: true, context: "fast_lane" },
            { op: "peek" },
            { op: "get", priority: true, context: "fast_lane" },
            { op: "replace", value: -1 },
          ],
        },
        check: (result) => {
          const items = resultsOf(result);
          assert.match((at(items, 0) as { message: string }).message, /Saldo QUSD/);
          assert.equal(at(items, 1), null);
          assert.equal((at(items, 2) as { value: string }).value, "8.00000000");
          assert.match((at(items, 3) as { message: string }).message, /inválido/);
        },
      },
      {
        caseId: "pure/qusd-balance-cache/preserve-error/0001",
        op: "qusd.sequence",
        source: "test/qusd-balance-cache.test.ts:133",
        input: {
          reads: [{ error: "límite remoto", status: 429 }],
          steps: [{ op: "get", priority: true, context: "fast_lane" }],
        },
        check: (result) => {
          const item = at<{ status: string; message: string; httpStatus?: number }>(resultsOf(result), 0);
          assert.equal(item.status, "error");
          assert.equal(item.message, "límite remoto");
          assert.equal(item.httpStatus, 429);
        },
      },
      {
        caseId: "pure/qusd-balance-cache/stop-waits/0001",
        op: "qusd.sequence",
        source: "test/qusd-balance-cache.test.ts:139",
        input: {
          reads: [{ hang: true }],
          steps: [
            { op: "beginGet", label: "request", priority: true, context: "fast_lane" },
            { op: "beginStop", label: "closing" },
            { op: "get", priority: true, context: "fast_lane" },
            { op: "stopResolved" },
            { op: "resolveRead", index: 0, value: 10 },
            { op: "settle" },
            { op: "join", label: "request" },
            { op: "joinStop", label: "closing" },
            { op: "stopResolved" },
            { op: "calls" },
            { op: "peek" },
          ],
        },
        check: (result) => {
          const items = resultsOf(result);
          assert.match((at(items, 2) as { message: string }).message, /cerrada/);
          assert.equal(at(items, 3), false);
          assert.match((at(items, 6) as { message: string }).message, /cerrada/);
          assert.equal(at(items, 8), true);
          assert.equal(at(items, 9), 1);
          assert.equal(at(items, 10), null);
        },
      },
      {
        caseId: "pure/qusd-balance-cache/control-change/0001",
        op: "qusd.sequence",
        source: "test/qusd-balance-cache.test.ts:153",
        input: {
          epoch: "old",
          reads: [{ hang: true }],
          steps: [
            { op: "beginGet", label: "request", priority: false, context: "warmup", force: true, isCurrent: true },
            { op: "setCurrent", value: false },
            { op: "setEpoch", value: "new" },
            { op: "resolveRead", index: 0, value: 10 },
            { op: "join", label: "request" },
            { op: "peek" },
            { op: "calls" },
            { op: "lastEvent" },
          ],
        },
        check: (result) => {
          const items = resultsOf(result);
          assert.match((at(items, 4) as { message: string }).message, /detenida/);
          assert.equal(at(items, 5), null);
          assert.equal(at(items, 6), 1);
          assert.equal(at(items, 7), "discarded_control");
        },
      },
    ],
  },
  {
    file: "hunting-balance-loops.json",
    module: "src/application/hunting-balance-loops.ts",
    targetService: "money-core",
    sourceTests: ["test/hunting-balance-loops.test.ts"],
    notes:
      "Cierre ordenado de los bucles de saldo de cacería: `stop()` espera los trabajos completos (incluidas sus guardas), no inicia trabajo nuevo y cierra la caché al final.",
    cases: [
      {
        caseId: "pure/hunting-balance-loops/stop/0001",
        op: "hunting-balance.stop",
        source: "test/hunting-balance-loops.test.ts:6",
        check: (result) => {
          const value = result as {
            events: string[];
            cacheStoppedAfterWarm: boolean;
            warmCount: number;
          };
          assert.equal(value.cacheStoppedAfterWarm, false);
          assert.equal(value.warmCount, 1);
          assert.deepEqual(value.events, [
            "warm",
            "prepare",
            "warm-completed",
            "prepare-completed",
            "cache-stopped",
          ]);
        },
      },
    ],
  },
  {
    file: "market-hunting-loops.json",
    module: "src/application/market-hunting-loops.ts",
    targetService: "money-core",
    sourceTests: ["test/market-hunting-loops.test.ts"],
    notes:
      "Bucles de cacería con Scheduler determinista: polling y feed progresan por separado, solo la página más reciente por mercado/lado, generaciones invalidan trabajo en curso, stop espera todo y los descartes se registran.",
    cases: [
      {
        caseId: "pure/market-hunting-loops/polling-progress/0001",
        op: "market-hunting.polling-progress",
        source: "test/market-hunting-loops.test.ts:9",
        check: (result) => {
          const value = result as { scan: boolean; polls: number; ingested: number; secondFeed: boolean };
          assert.equal(value.scan, true);
          assert.equal(value.polls, 1);
          assert.equal(value.ingested, 1);
          assert.equal(value.secondFeed, false);
        },
      },
      {
        caseId: "pure/market-hunting-loops/feed-progress/0001",
        op: "market-hunting.feed-progress",
        source: "test/market-hunting-loops.test.ts:28",
        check: (result) => {
          const value = result as { feedRun: boolean; feedAfter: number; polls: number; feedTotal: number };
          assert.equal(value.feedRun, true);
          assert.equal(value.feedAfter, 1);
          assert.equal(value.polls, 1);
          assert.equal(value.feedTotal, 1);
        },
      },
      {
        caseId: "pure/market-hunting-loops/latest-page/0001",
        op: "market-hunting.latest-page",
        source: "test/market-hunting-loops.test.ts:43",
        check: (result) => {
          const value = result as {
            remaining: number;
            before: number[];
            after: { scannedAt: number; realtimeRecovery?: boolean }[];
          };
          assert.equal(value.remaining, 0);
          assert.deepEqual(value.before, [1_000]);
          assert.deepEqual(value.after, [
            { scannedAt: 1_000, realtimeRecovery: true },
            { scannedAt: 3_000, realtimeRecovery: true },
            { scannedAt: 4_000, realtimeRecovery: true },
          ]);
        },
      },
      {
        caseId: "pure/market-hunting-loops/ingest-error/0001",
        op: "market-hunting.ingest-error",
        source: "test/market-hunting-loops.test.ts:79",
        check: (result) => {
          const value = result as { errors: string[]; ingested: number[] };
          assert.deepEqual(value.errors, ["fallo"]);
          assert.deepEqual(value.ingested, [1_000, 2_000]);
        },
      },
      {
        caseId: "pure/market-hunting-loops/pause-stop/0001",
        op: "market-hunting.pause-stop",
        source: "test/market-hunting-loops.test.ts:99",
        check: (result) => {
          const value = result as { outcomes: { stop: boolean; ingested: number }[] };
          assert.deepEqual(value.outcomes, [
            { stop: false, ingested: 1 },
            { stop: true, ingested: 1 },
          ]);
        },
      },
      {
        caseId: "pure/market-hunting-loops/generation-invalidate/0001",
        op: "market-hunting.generation-invalidate",
        source: "test/market-hunting-loops.test.ts:121",
        check: (result) => {
          assert.deepEqual((result as { ingested: number[] }).ingested, [1_000]);
        },
      },
      {
        caseId: "pure/market-hunting-loops/stop-waits/0001",
        op: "market-hunting.stop-waits",
        source: "test/market-hunting-loops.test.ts:145",
        check: (result) => {
          const value = result as { beforeIngestion: boolean; afterIngestion: boolean };
          assert.equal(value.beforeIngestion, false);
          assert.equal(value.afterIngestion, true);
        },
      },
      {
        caseId: "pure/market-hunting-loops/timing/0001",
        op: "market-hunting.timing",
        source: "test/market-hunting-loops.test.ts:167",
        check: (result) => {
          const value = result as { timings: { queueMs: number; evaluationMs: number; outcome: string }[] };
          assert.deepEqual(value.timings, [
            { queueMs: 0, evaluationMs: 20, outcome: "success" },
            { queueMs: 15, evaluationMs: 10, outcome: "success" },
          ]);
        },
      },
      {
        caseId: "pure/market-hunting-loops/generation-replaces/0001",
        op: "market-hunting.generation-replaces",
        source: "test/market-hunting-loops.test.ts:189",
        check: (result) => {
          assert.deepEqual((result as { ingested: number[] }).ingested, [1_000, 2_000]);
        },
      },
      {
        caseId: "pure/market-hunting-loops/dispatch-sequence/0001",
        op: "market-hunting.dispatch-sequence",
        source: "test/market-hunting-loops.test.ts:206",
        check: (result) => {
          assert.deepEqual((result as { ingested: number[] }).ingested, [1, 3]);
        },
      },
      {
        caseId: "pure/market-hunting-loops/slow-read/0001",
        op: "market-hunting.slow-read",
        source: "test/market-hunting-loops.test.ts:225",
        check: (result) => {
          const value = result as {
            first: number[];
            calls: number;
            stoppedBeforeRelease: boolean;
            after: number[];
          };
          assert.deepEqual(value.first, [2_000]);
          assert.equal(value.calls, 5);
          assert.equal(value.stoppedBeforeRelease, false);
          assert.deepEqual(value.after, [2_000]);
        },
      },
      {
        caseId: "pure/market-hunting-loops/discard-reasons/0001",
        op: "market-hunting.discard-reasons",
        source: "test/market-hunting-loops.test.ts:254",
        check: (result) => {
          const value = result as { outcomes: { finalReason: string; reasons: string[] }[] };
          assert.deepEqual(value.outcomes.map((item) => item.finalReason), ["control", "shutdown"]);
          for (const outcome of value.outcomes) {
            assert.ok(outcome.reasons.includes("superseded"));
            assert.ok(outcome.reasons.includes("capacity"));
            assert.ok(outcome.reasons.includes(outcome.finalReason));
          }
        },
      },
      {
        caseId: "pure/market-hunting-loops/queue-limit/0001",
        op: "market-hunting.queue-limit",
        source: "test/market-hunting-loops.test.ts:277",
        check: (result) => {
          const value = result as { count: number; firstAfterHead: string; last: string };
          assert.equal(value.count, 65);
          assert.equal(value.firstAfterHead, "TEST_1");
          assert.equal(value.last, "TEST_64");
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
