#!/usr/bin/env node
/**
 * build-manifest.ts — generador de la matriz de paridad F0.
 *
 * Regenera, desde una única tabla de datos versionada (`FILES`) y la suite real
 * (`test/*.test.ts`), los dos artefactos del gate L0 de docs/migration/verification.md:
 *
 *   - parity/manifest.json            (índice machine-readable, qvaapply.parity/v1)
 *   - docs/migration/parity-matrix.md (matriz legible en español)
 *
 * Uso (sin argumentos, desde la raíz del repo; también funciona desde cualquier cwd):
 *
 *   node --import tsx parity/tools/build-manifest.ts
 *   node --import tsx parity/tools/build-manifest.ts --check   # no escribe; falla si hay deriva
 *
 * El script NO ejecuta la suite de tests: fija el baseline verificado del oráculo
 * (2026-11-12, 718 casos / 95 archivos, documentado en 04-tests.md §0.1) y valida que
 * el inventario declarado cuadre exactamente con él. Si la suite cambia, el baseline
 * debe actualizarse de forma revisada (es un acto consciente, no una regeneración
 * automática para que pase el gate).
 *
 * Sale con código 1 si:
 *   - existe un archivo test/*.test.ts sin clasificar (o una clasificación sin archivo real),
 *   - hay archivos o casos duplicados,
 *   - la suma de casos no es 718 o los totales por categoría no son 107/74/39/470/22/6,
 *   - falta categoría, destino, reutilización, lote, estado o motivo obligatorio,
 *   - `--check` detecta que los artefactos generados no coinciden con los del repo.
 *
 * Fuente de verdad de la clasificación: docs/migration/analysis/04-tests.md §2 y §5.2.
 * Mapeo a servicios E1: docs/migration/verification.md §2 y docs/migration/target-architecture.md §3.1.
 */
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");
const TEST_DIR = join(REPO_ROOT, "test");
const MANIFEST_PATH = join(REPO_ROOT, "parity", "manifest.json");
const MATRIX_PATH = join(REPO_ROOT, "docs", "migration", "parity-matrix.md");

// ---------------------------------------------------------------------------
// Tipos y constantes normativas
// ---------------------------------------------------------------------------

type Category = "P" | "C" | "H" | "I" | "U" | "O";
type Status = "portable" | "golden" | "contract" | "property" | "ui" | "descartado";
type Lote = "L1" | "L2" | "L3" | "L4" | "L5";
type Reuse = "A" | "B" | "C" | "D";
type TargetService =
  | "money-core"
  | "qvapay-adapter"
  | "config-registry"
  | "decisions"
  | "market-ingest"
  | "audit"
  | "gateway"
  | "dashboard-bff"
  | "notifier"
  | "chat"
  | "analytics"
  | "sync-coop-adapter"
  | "no-aplica";

interface FileRow {
  /** Ruta repo-relativa, siempre `test/<nombre>.test.ts`. */
  readonly file: string;
  readonly category: Category;
  /** Casos reales medidos con el reporter JUnit (atributo `file`). */
  readonly cases: number;
  /** Módulo/área bajo test, según 04-tests.md §2. */
  readonly module: string;
  /** Destino lógico del arnés; `no-aplica` solo para L5. */
  readonly targetService: TargetService;
  /** Destinos secundarios cuando 04-tests.md asigna más de uno. */
  readonly secondaryServices?: readonly TargetService[];
  readonly reuse: Reuse;
  readonly lote: Lote;
  /** Contrato K de 03-boundaries.md §7 (obligatorio en C y H). */
  readonly contract?: string;
  /** Justificación obligatoria en estado `ui` o `descartado`. */
  readonly motivo?: string;
}

const CATEGORY_ORDER: readonly Category[] = ["P", "C", "H", "I", "U", "O"];
const STATUS_ORDER: readonly Status[] = ["portable", "golden", "contract", "property", "ui", "descartado"];
const LOTE_ORDER: readonly Lote[] = ["L1", "L2", "L3", "L4", "L5"];
const TARGET_ORDER: readonly TargetService[] = [
  "money-core",
  "qvapay-adapter",
  "config-registry",
  "decisions",
  "market-ingest",
  "audit",
  "gateway",
  "dashboard-bff",
  "notifier",
  "chat",
  "analytics",
  "sync-coop-adapter",
  "no-aplica",
];
const E1_ORDER = ["trading-core", "edge", "notifier", "analytics", "no-aplica"] as const;
type E1Service = (typeof E1_ORDER)[number];

/** Mapeo destino lógico → servicio del estado E1 (verification.md §2, target-architecture.md §3.1). */
const TARGET_TO_E1: Record<TargetService, E1Service> = {
  "money-core": "trading-core",
  "qvapay-adapter": "trading-core",
  "config-registry": "trading-core",
  decisions: "trading-core",
  "market-ingest": "trading-core",
  audit: "trading-core",
  "sync-coop-adapter": "trading-core",
  gateway: "edge",
  "dashboard-bff": "edge",
  notifier: "notifier",
  chat: "notifier",
  analytics: "analytics",
  "no-aplica": "no-aplica",
};

const CATEGORY_META: Record<Category, { title: string; description: string }> = {
  P: {
    title: "P — Puros portables",
    description:
      "Lógica determinista sin fuente de verdad externa: vectores `input → output` directos (reutilización A). " +
      "Estado `portable`: se reescribe como test Go del paquete y se acompaña de golden directo.",
  },
  C: {
    title: "C — Contratos de adaptador",
    description:
      "Fronteras con fetch/runtime inyectado; la intención es el contrato, no la implementación (reutilización B). " +
      "Estado `contract`: se reescriben una vez como cassette o fixture de runtime.",
  },
  H: {
    title: "H — Superficie HTTP",
    description:
      "Handlers Fastify ejercitados con `app.inject()` (reutilización B). Estado `contract`: pares " +
      "request → response canónicos contra el adaptador HTTP y la matriz de auth de K10.",
  },
  I: {
    title: "I — Integración durable (SQLite + dominio)",
    description:
      "Secuencias con estado persistido; se instrumentan como replay stateful o golden extraído (reutilización B). " +
      "Estado `golden`; los casos dependientes de interleaving/tiempo pasan a `property`, y `repository` se " +
      "descarta como código porque su garantía pasa a la verificación de migración de datos.",
  },
  U: {
    title: "U — UI / React / estructura de fuente",
    description:
      "Afirman sobre texto de `.tsx`, `.css` o estructura de fuentes del frontend. No son evidencia de paridad " +
      "del backend. Estado `ui`: se conservan en el frontend y quedan fuera del score.",
  },
  O: {
    title: "O — Despliegue, scripts y reportes",
    description:
      "Prueban shell scripts, configuración de despliegue o reportes operativos, no el backend Go. " +
      "Estado `descartado`, con motivo escrito (verification.md §L0).",
  },
};

const EXPECTED = {
  files: 95,
  cases: 718,
  byCategory: {
    P: { files: 21, cases: 107 },
    C: { files: 11, cases: 74 },
    H: { files: 9, cases: 39 },
    I: { files: 42, cases: 470 },
    U: { files: 9, cases: 22 },
    O: { files: 3, cases: 6 },
  } satisfies Record<Category, { files: number; cases: number }>,
} as const;

/** Baseline verificado del oráculo el 2026-11-12 (04-tests.md §0.1). */
const BASELINE = {
  command: "node --import tsx --test test/*.test.ts",
  measuredAt: "2026-11-12",
  cases: 718,
  files: 95,
  pass: 718,
  fail: 0,
  skipped: 0,
  todo: 0,
  staticTestCalls: 643,
  locTests: 15769,
} as const;

// ---------------------------------------------------------------------------
// Tabla de datos: los 95 archivos de test, clasificados y asignados.
// Fuente: docs/migration/analysis/04-tests.md §2.1–§2.5 y §5.2 (lotes).
// ---------------------------------------------------------------------------

const FILES: readonly FileRow[] = [
  // --- P — Puros portables (21 archivos / 107 casos) -----------------------
  { file: "test/budget.test.ts", category: "P", cases: 6, module: "src/budget.ts (plan proporcional, mínimo CUP)", targetService: "money-core", reuse: "A", lote: "L1" },
  { file: "test/chat-stream.test.ts", category: "P", cases: 2, module: "src/chat-stream.ts (parser SSE)", targetService: "chat", reuse: "A", lote: "L1" },
  { file: "test/cooperative-menu.test.ts", category: "P", cases: 3, module: "src/cooperative-menu.ts (teclado/acciones)", targetService: "notifier", reuse: "A", lote: "L1" },
  { file: "test/dashboard-controls.test.ts", category: "P", cases: 3, module: "src/dashboard.ts (DashboardReadModel con fakes)", targetService: "dashboard-bff", reuse: "A", lote: "L1" },
  { file: "test/dashboard-auth.test.ts", category: "P", cases: 4, module: "src/dashboard-auth.ts (Origin, sesión, CSRF)", targetService: "gateway", reuse: "A", lote: "L1" },
  { file: "test/dashboard.test.ts", category: "P", cases: 3, module: "src/dashboard.ts (marginCalculation, allocateBudget)", targetService: "money-core", reuse: "A", lote: "L1" },
  { file: "test/hunting-balance-loops.test.ts", category: "P", cases: 1, module: "src/application/hunting-balance-loops.ts + Scheduler", targetService: "money-core", reuse: "A", lote: "L1" },
  { file: "test/hunting-requirements.test.ts", category: "P", cases: 1, module: "src/hunting-requirements.ts", targetService: "money-core", reuse: "A", lote: "L1" },
  { file: "test/liquidity-plan.test.ts", category: "P", cases: 9, module: "src/core/liquidity-plan.ts", targetService: "money-core", reuse: "A", lote: "L1" },
  { file: "test/market-hunting-loops.test.ts", category: "P", cases: 13, module: "src/application/market-hunting-loops.ts + Scheduler", targetService: "money-core", reuse: "A", lote: "L1" },
  { file: "test/market-history-compact.test.ts", category: "P", cases: 1, module: "src/dashboard.ts (compactMarketHistory)", targetService: "dashboard-bff", reuse: "A", lote: "L1" },
  { file: "test/market-list-budget.test.ts", category: "P", cases: 9, module: "src/market-list-budget.ts (cuota de listados)", targetService: "qvapay-adapter", reuse: "A", lote: "L1" },
  { file: "test/market-math.test.ts", category: "P", cases: 7, module: "src/market-math.ts (median, outgoingFiatCost, ownOfferFiatTotal)", targetService: "money-core", reuse: "A", lote: "L1" },
  { file: "test/mobile-operator.test.ts", category: "P", cases: 5, module: "src/mobile-operator.ts (repo + reloj inyectados)", targetService: "gateway", reuse: "A", lote: "L1" },
  { file: "test/monetary-intents.test.ts", category: "P", cases: 5, module: "src/application/monetary-intents.ts (MemoryIntentRepository)", targetService: "money-core", reuse: "A", lote: "L1" },
  { file: "test/qusd-balance-cache.test.ts", category: "P", cases: 13, module: "src/qusd-balance-cache.ts", targetService: "qvapay-adapter", reuse: "A", lote: "L1" },
  { file: "test/rate-rounding.test.ts", category: "P", cases: 2, module: "src/market-math.ts (roundRateForIndex)", targetService: "money-core", reuse: "A", lote: "L1" },
  { file: "test/risk-policy.test.ts", category: "P", cases: 8, module: "src/core/risk-policy.ts (evaluateRisk)", targetService: "money-core", reuse: "A", lote: "L1" },
  { file: "test/scheduler.test.ts", category: "P", cases: 2, module: "src/scheduler.ts", targetService: "money-core", reuse: "A", lote: "L1" },
  { file: "test/telegram-menu.test.ts", category: "P", cases: 5, module: "src/telegram-menu.ts", targetService: "notifier", reuse: "A", lote: "L1" },
  { file: "test/telegram-runtime.test.ts", category: "P", cases: 5, module: "src/telegram-runtime.ts", targetService: "notifier", reuse: "A", lote: "L1" },

  // --- C — Contratos de adaptador (11 archivos / 74 casos) -----------------
  { file: "test/chat-images.test.ts", category: "C", cases: 7, module: "src/chat-images.ts + QvaPayClient.downloadChatImage", targetService: "chat", reuse: "B", lote: "L2", contract: "K7" },
  { file: "test/login.test.ts", category: "C", cases: 11, module: "src/application/qvapay-login.ts + QvaPayClient.login", targetService: "qvapay-adapter", reuse: "B", lote: "L2", contract: "K1" },
  { file: "test/qusd-read-timing.test.ts", category: "C", cases: 2, module: "QvaPayClient.qusdBalance + telemetría de lectura", targetService: "qvapay-adapter", reuse: "B", lote: "L2", contract: "K2/K12" },
  { file: "test/qvapay-feed-stream.test.ts", category: "C", cases: 5, module: "src/qvapay-feed-stream.ts (SSE)", targetService: "qvapay-adapter", reuse: "B", lote: "L2", contract: "K6" },
  { file: "test/qvapay-gateway.test.ts", category: "C", cases: 27, module: "src/qvapay.ts (colas, cuotas, errores)", targetService: "qvapay-adapter", reuse: "B", lote: "L2", contract: "K2/K3/K4/K7" },
  { file: "test/qvapay-list-budget.test.ts", category: "C", cases: 6, module: "QvaPayClient.profile/listOffersPage + ListingReadBudget", targetService: "qvapay-adapter", reuse: "B", lote: "L2", contract: "K2" },
  { file: "test/qvapay-list-isolation.test.ts", category: "C", cases: 2, module: "QvaPayClient (identidad de listado)", targetService: "qvapay-adapter", reuse: "B", lote: "L2", contract: "K2" },
  { file: "test/qvapay-list-timing.test.ts", category: "C", cases: 3, module: "QvaPayClient (timing de lista)", targetService: "qvapay-adapter", reuse: "B", lote: "L2", contract: "K2" },
  { file: "test/qvapay-operation-timing.test.ts", category: "C", cases: 5, module: "src/operation-trace.ts + QvaPayClient", targetService: "qvapay-adapter", reuse: "B", lote: "L2", contract: "K3/K4" },
  { file: "test/telegram-recovery.test.ts", category: "C", cases: 1, module: "src/telegram-recovery.ts (grammy fake API)", targetService: "notifier", reuse: "B", lote: "L2", contract: "K14" },
  { file: "test/web-push.test.ts", category: "C", cases: 5, module: "src/web-push.ts (VAPID runtime inyectado)", targetService: "notifier", reuse: "B", lote: "L2", contract: "K14" },

  // --- H — Superficie HTTP (9 archivos / 39 casos) -------------------------
  { file: "test/bulk-dismiss-http.test.ts", category: "H", cases: 1, module: "POST /api/audit/dismiss-all", targetService: "gateway", secondaryServices: ["audit"], reuse: "B", lote: "L2", contract: "K10" },
  { file: "test/cooperative-hunter-http.test.ts", category: "H", cases: 1, module: "/api/cooperative-network/executions/check", targetService: "gateway", secondaryServices: ["sync-coop-adapter"], reuse: "B", lote: "L2", contract: "K10" },
  { file: "test/http-dashboard.test.ts", category: "H", cases: 26, module: "sesión, CSRF, control, push, recovery, estáticos, webhook", targetService: "gateway", secondaryServices: ["dashboard-bff", "notifier"], reuse: "B", lote: "L2", contract: "K10" },
  { file: "test/mobile-action-http-budget.test.ts", category: "H", cases: 1, module: "acciones móviles (rate limit)", targetService: "gateway", reuse: "B", lote: "L2", contract: "K10" },
  { file: "test/mobile-tools.test.ts", category: "H", cases: 3, module: "/api/mobile/* (overview, tools)", targetService: "gateway", reuse: "B", lote: "L2", contract: "K10" },
  { file: "test/operation-chat-http.test.ts", category: "H", cases: 3, module: "/api/operations/:uuid/chat", targetService: "gateway", secondaryServices: ["chat"], reuse: "B", lote: "L2", contract: "K10" },
  { file: "test/self-service-recovery-http.test.ts", category: "H", cases: 2, module: "/api/recovery*", targetService: "gateway", secondaryServices: ["money-core"], reuse: "B", lote: "L2", contract: "K10" },
  { file: "test/static-assets.test.ts", category: "H", cases: 1, module: "servido comprimido/ETag/HEAD", targetService: "gateway", reuse: "B", lote: "L2", contract: "K10" },
  { file: "test/trading-analytics-http.test.ts", category: "H", cases: 1, module: "/api/analytics", targetService: "gateway", secondaryServices: ["analytics"], reuse: "B", lote: "L2", contract: "K10" },

  // --- I — Integración durable (42 archivos / 470 casos) -------------------
  { file: "test/application-reservations.test.ts", category: "I", cases: 2, module: "reservas de aplicación (store.ts)", targetService: "money-core", reuse: "B", lote: "L3" },
  { file: "test/architecture-regression.test.ts", category: "I", cases: 4, module: "trading.ts, dashboard.ts, market-config.ts", targetService: "money-core", secondaryServices: ["dashboard-bff"], reuse: "B", lote: "L3" },
  { file: "test/assisted-payment.test.ts", category: "I", cases: 13, module: "assisted-payment.ts + HTTP", targetService: "money-core", secondaryServices: ["gateway"], reuse: "B", lote: "L3" },
  { file: "test/chat-orders-push.test.ts", category: "I", cases: 6, module: "chat-push.ts, operation-chat.ts", targetService: "notifier", reuse: "B", lote: "L4" },
  { file: "test/config-integrity-performance.test.ts", category: "I", cases: 2, module: "market-config.ts, store.ts", targetService: "config-registry", reuse: "B", lote: "L3" },
  { file: "test/cooperative-capital.test.ts", category: "I", cases: 16, module: "trading.ts, store.ts, market-config.ts", targetService: "money-core", reuse: "B", lote: "L3" },
  { file: "test/cooperative-hunter.test.ts", category: "I", cases: 6, module: "cooperative-hunter.ts", targetService: "sync-coop-adapter", reuse: "B", lote: "L4" },
  { file: "test/core.test.ts", category: "I", cases: 26, module: "trading.ts, store.ts, vault.ts, qvapay.ts", targetService: "money-core", reuse: "B", lote: "L3" },
  { file: "test/dashboard-market-observation.test.ts", category: "I", cases: 3, module: "dashboard.ts, market-config.ts", targetService: "market-ingest", reuse: "B", lote: "L4" },
  { file: "test/dashboard-rebalance.test.ts", category: "I", cases: 5, module: "dashboard.ts, market-config.ts, qvapay.ts", targetService: "market-ingest", secondaryServices: ["money-core"], reuse: "B", lote: "L4" },
  { file: "test/flexible-fiat.test.ts", category: "I", cases: 7, module: "trading.ts, store.ts", targetService: "money-core", reuse: "B", lote: "L3" },
  { file: "test/flexible-order.test.ts", category: "I", cases: 5, module: "flexible-order.ts, qvapay.ts, store.ts", targetService: "money-core", reuse: "B", lote: "L3" },
  { file: "test/hunting-pause.test.ts", category: "I", cases: 7, module: "market-config.ts, store.ts, trading.ts", targetService: "money-core", secondaryServices: ["market-ingest"], reuse: "B", lote: "L3" },
  { file: "test/hunting-query-performance.test.ts", category: "I", cases: 3, module: "store.ts (índices y consultas)", targetService: "money-core", secondaryServices: ["audit"], reuse: "C", lote: "L4" },
  { file: "test/hunting-sync.test.ts", category: "I", cases: 17, module: "hunting-sync.ts, store.ts, vault.ts", targetService: "sync-coop-adapter", reuse: "B", lote: "L4" },
  { file: "test/manual-cancel-exclusion.test.ts", category: "I", cases: 9, module: "trading.ts, market-config.ts", targetService: "money-core", reuse: "B", lote: "L3" },
  { file: "test/manual-cancel-race.test.ts", category: "I", cases: 31, module: "trading.ts, qvapay.ts, store.ts (carreras de cancelación)", targetService: "money-core", reuse: "B", lote: "L3" },
  { file: "test/market-accounts.test.ts", category: "I", cases: 3, module: "market-accounts.ts, vault.ts", targetService: "market-ingest", reuse: "B", lote: "L4" },
  { file: "test/market-feed-shutdown.test.ts", category: "I", cases: 1, module: "market-feed.ts, market-source.ts", targetService: "market-ingest", reuse: "B", lote: "L4" },
  { file: "test/market-feed.test.ts", category: "I", cases: 20, module: "market-feed.ts, market-source.ts, HTTP", targetService: "market-ingest", reuse: "B", lote: "L4" },
  { file: "test/market-ingest-serialization.test.ts", category: "I", cases: 9, module: "market-source.ts, trading.ts", targetService: "market-ingest", reuse: "B", lote: "L4" },
  { file: "test/market-poll-timing.test.ts", category: "I", cases: 2, module: "market-source.ts, market-accounts.ts", targetService: "market-ingest", reuse: "C", lote: "L4" },
  { file: "test/market-reader-identity.test.ts", category: "I", cases: 7, module: "market-accounts.ts, qvapay.ts", targetService: "market-ingest", reuse: "B", lote: "L4" },
  { file: "test/market-source.test.ts", category: "I", cases: 18, module: "market-source.ts, market-accounts.ts", targetService: "market-ingest", reuse: "B", lote: "L4" },
  { file: "test/mobile-operation-status.test.ts", category: "I", cases: 8, module: "mobile-operator.ts, chat-catalog.ts", targetService: "gateway", secondaryServices: ["chat"], reuse: "B", lote: "L4" },
  { file: "test/notification-dispatcher.test.ts", category: "I", cases: 7, module: "notification-dispatcher.ts", targetService: "notifier", reuse: "B", lote: "L4" },
  { file: "test/offer-latency.test.ts", category: "I", cases: 1, module: "trading.ts, qvapay.ts (latencia recepción→POST)", targetService: "money-core", reuse: "C", lote: "L3" },
  { file: "test/operation-actions.test.ts", category: "I", cases: 9, module: "trading.ts, qvapay.ts, store.ts", targetService: "money-core", reuse: "B", lote: "L4" },
  { file: "test/operation-chat.test.ts", category: "I", cases: 11, module: "operation-chat.ts, qvapay.ts", targetService: "chat", reuse: "B", lote: "L4" },
  { file: "test/operational-insights.test.ts", category: "I", cases: 8, module: "operational-insights.ts, notification-dispatcher.ts, HTTP", targetService: "decisions", secondaryServices: ["dashboard-bff"], reuse: "B", lote: "L4" },
  { file: "test/opportunity-orchestrator.test.ts", category: "I", cases: 19, module: "application/opportunity-orchestrator.ts", targetService: "money-core", reuse: "B", lote: "L3" },
  { file: "test/payment-sms.test.ts", category: "I", cases: 24, module: "payment-sms.ts, qvapay.ts, store.ts", targetService: "money-core", reuse: "B", lote: "L3" },
  { file: "test/practical-tools.test.ts", category: "I", cases: 7, module: "trading-analytics.ts, price-simulation.ts, HTTP", targetService: "analytics", reuse: "B", lote: "L4" },
  { file: "test/qusd-readiness-integration.test.ts", category: "I", cases: 12, module: "trading.ts, market-config.ts", targetService: "money-core", reuse: "B", lote: "L3" },
  { file: "test/reconciliation-feed.test.ts", category: "I", cases: 13, module: "self-service-recovery.ts, qvapay.ts, trading.ts", targetService: "money-core", reuse: "B", lote: "L3" },
  { file: "test/reconciliation-scheduler.test.ts", category: "I", cases: 5, module: "reconciliation-scheduler.ts, store.ts", targetService: "money-core", reuse: "B", lote: "L3" },
  {
    file: "test/repository.test.ts",
    category: "I",
    cases: 20,
    module: "store.ts (esquema v31, migraciones, índices)",
    targetService: "money-core",
    secondaryServices: ["audit"],
    reuse: "D",
    lote: "L3",
    motivo:
      "No se porta como código: su garantía se redefine como verificación de migración de datos (02-persistence.md §6.5) " +
      "+ tests de esquema Postgres. Es la excepción D de 04-tests.md §2.4 y §6.4; queda fuera del score de paridad ejecutable.",
  },
  { file: "test/self-service-recovery.test.ts", category: "I", cases: 13, module: "self-service-recovery.ts, store.ts", targetService: "money-core", reuse: "B", lote: "L3" },
  { file: "test/self-service-store.test.ts", category: "I", cases: 10, module: "store.ts (dismiss masivo/versionado)", targetService: "money-core", secondaryServices: ["decisions"], reuse: "B", lote: "L3" },
  { file: "test/telegram-operation.test.ts", category: "I", cases: 4, module: "telegram-operation.ts, store.ts", targetService: "notifier", reuse: "B", lote: "L4" },
  { file: "test/trading-analytics.test.ts", category: "I", cases: 18, module: "trading-analytics.ts, dashboard.ts", targetService: "analytics", reuse: "B", lote: "L4" },
  { file: "test/trading-automation.test.ts", category: "I", cases: 59, module: "trading.ts, qvapay.ts, market-config.ts", targetService: "money-core", reuse: "B", lote: "L3" },

  // --- U — UI / React / estructura de fuente (9 archivos / 22 casos) --------
  {
    file: "test/chart-domain.test.ts",
    category: "U",
    cases: 2,
    module: "web/lib (lógica de presentación de gráfica)",
    targetService: "no-aplica",
    reuse: "D",
    lote: "L5",
    motivo: "Lógica de presentación del navegador; no es comportamiento de un servicio de backend.",
  },
  {
    file: "test/dashboard-bootstrap.test.ts",
    category: "U",
    cases: 2,
    module: "web/lib (consumo del bootstrap del navegador)",
    targetService: "no-aplica",
    reuse: "D",
    lote: "L5",
    motivo: "Consumo del bootstrap del navegador; no se ejecuta en el backend Go.",
  },
  {
    file: "test/dashboard-bootstrap-regression.test.ts",
    category: "U",
    cases: 3,
    module: "web/main.jsx y hooks (lectura de fuente)",
    targetService: "no-aplica",
    reuse: "D",
    lote: "L5",
    motivo: "Assert.match sobre la estructura de fuentes del frontend; nula señal de paridad del backend.",
  },
  {
    file: "test/dashboard-local-snapshot-regression.test.ts",
    category: "U",
    cases: 1,
    module: "src/dashboard.ts (estructura interna, lectura de fuente)",
    targetService: "no-aplica",
    reuse: "D",
    lote: "L5",
    motivo: "Verifica estructura interna del código, no comportamiento financiero observable.",
  },
  {
    file: "test/server-dashboard-cache-regression.test.ts",
    category: "U",
    cases: 3,
    module: "web/hooks y src/index.ts (lectura de fuente)",
    targetService: "no-aplica",
    reuse: "D",
    lote: "L5",
    motivo: "Regresión estructural sobre fuentes del panel; sustituible por smoke visual/E2E.",
  },
  {
    file: "test/telegram-menu-regression.test.ts",
    category: "U",
    cases: 2,
    module: "src/telegram-menu.ts (regex sobre fuente)",
    targetService: "no-aplica",
    reuse: "D",
    lote: "L5",
    motivo: "Regex sobre el texto de la fuente; el contrato real se cubre con K14/notifier.",
  },
  {
    file: "test/ui-recovery-regression.test.ts",
    category: "U",
    cases: 4,
    module: ".jsx/.css del panel (lectura de fuente)",
    targetService: "no-aplica",
    reuse: "D",
    lote: "L5",
    motivo: "Regex sobre JSX/CSS; no es evidencia de paridad del backend.",
  },
  {
    file: "test/web-layout-regression.test.ts",
    category: "U",
    cases: 4,
    module: ".jsx/.css del panel (lectura de fuente)",
    targetService: "no-aplica",
    reuse: "D",
    lote: "L5",
    motivo: "Regex sobre JSX/CSS de layout; se sustituye por visual-smoke.",
  },
  {
    file: "test/web-operation-actions.test.ts",
    category: "U",
    cases: 1,
    module: "web/lib (mapeo de body de acciones del navegador)",
    targetService: "no-aplica",
    reuse: "D",
    lote: "L5",
    motivo: "Mapeo de payload del navegador; no pertenece al backend.",
  },

  // --- O — Despliegue, scripts y reportes (3 archivos / 6 casos) -----------
  {
    file: "test/deployment-cleanup.test.ts",
    category: "O",
    cases: 3,
    module: "scripts/cleanup-vps.sh con Docker simulado",
    targetService: "no-aplica",
    reuse: "D",
    lote: "L5",
    motivo: "Prueba un shell script de operaciones; no es un servicio del backend. Se sustituye por verificación operativa/CI.",
  },
  {
    file: "test/deployment-domain.test.ts",
    category: "O",
    cases: 1,
    module: "nginx/TLS/provision (regex sobre configuración)",
    targetService: "no-aplica",
    reuse: "D",
    lote: "L5",
    motivo: "Configuración de despliegue (nginx/TLS); no es lógica de negocio. Se sustituye por tests de contrato de infraestructura.",
  },
  {
    file: "test/hunting-latency-report.test.ts",
    category: "O",
    cases: 2,
    module: "scripts/report-hunting-latency.mjs",
    targetService: "no-aplica",
    reuse: "D",
    lote: "L5",
    motivo: "Reporte operativo sobre SQLite; se sustituye por métricas y proyecciones de analytics.",
  },
];

// ---------------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------------

function escapeCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

function mdTable(headers: readonly string[], rows: readonly (readonly string[])[]): string {
  const head = `| ${headers.map(escapeCell).join(" | ")} |`;
  const sep = `| ${headers.map(() => "---").join(" | ")} |`;
  const body = rows.map((r) => `| ${r.map((c) => escapeCell(String(c))).join(" | ")} |`);
  return [head, sep, ...body].join("\n");
}

function walkFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkFiles(full));
    else if (entry.isFile()) out.push(full);
  }
  return out.sort();
}

function sha256(input: string | Buffer): string {
  return createHash("sha256").update(input).digest("hex");
}

/** huella determinista del oráculo: contenido de src/ ordenado por ruta repo-relativa POSIX. */
function computeSrcHash(): string {
  const hash = createHash("sha256");
  for (const absolute of walkFiles(join(REPO_ROOT, "src"))) {
    const rel = relative(REPO_ROOT, absolute).split(sep).join("/");
    hash.update(rel);
    hash.update("\0");
    hash.update(readFileSync(absolute));
    hash.update("\0");
  }
  return `sha256:${hash.digest("hex")}`;
}

function gitCommit(): string {
  const result = spawnSync("git", ["rev-parse", "HEAD"], { cwd: REPO_ROOT, encoding: "utf8" });
  if (result.status === 0 && typeof result.stdout === "string" && result.stdout.trim()) {
    return result.stdout.trim();
  }
  return "unknown";
}

/** Estado derivado de categoría + reutilización (verification.md §L0). */
function deriveStatus(row: FileRow): Status {
  switch (row.category) {
    case "P":
      return "portable";
    case "C":
    case "H":
      return "contract";
    case "U":
      return "ui";
    case "O":
      return "descartado";
    case "I":
      if (row.reuse === "C") return "property";
      if (row.reuse === "D") return "descartado";
      return "golden";
  }
}

function e1Of(row: FileRow): E1Service {
  return TARGET_TO_E1[row.targetService];
}

interface Totals {
  files: number;
  cases: number;
  byCategory: Record<Category, { files: number; cases: number }>;
  byStatus: Record<Status, number>;
  byLote: Record<Lote, { files: number; cases: number }>;
  byTarget: Record<TargetService, { files: number; cases: number }>;
  byE1: Record<E1Service, { files: number; cases: number }>;
  parityCases: number;
  nonApplicableCases: number;
}

function emptyCategory(): Record<Category, { files: number; cases: number }> {
  const out = {} as Record<Category, { files: number; cases: number }>;
  for (const c of CATEGORY_ORDER) out[c] = { files: 0, cases: 0 };
  return out;
}

function computeTotals(rows: readonly FileRow[]): Totals {
  const byCategory = emptyCategory();
  const byStatus = {} as Record<Status, number>;
  for (const s of STATUS_ORDER) byStatus[s] = 0;
  const byLote = {} as Record<Lote, { files: number; cases: number }>;
  for (const l of LOTE_ORDER) byLote[l] = { files: 0, cases: 0 };
  const byTarget = {} as Record<TargetService, { files: number; cases: number }>;
  for (const t of TARGET_ORDER) byTarget[t] = { files: 0, cases: 0 };
  const byE1 = {} as Record<E1Service, { files: number; cases: number }>;
  for (const e of E1_ORDER) byE1[e] = { files: 0, cases: 0 };

  let cases = 0;
  let parityCases = 0;
  let nonApplicableCases = 0;
  for (const row of rows) {
    const status = deriveStatus(row);
    cases += row.cases;
    byCategory[row.category].files += 1;
    byCategory[row.category].cases += row.cases;
    byStatus[status] += row.cases;
    byLote[row.lote].files += 1;
    byLote[row.lote].cases += row.cases;
    byTarget[row.targetService].files += 1;
    byTarget[row.targetService].cases += row.cases;
    const e1 = e1Of(row);
    byE1[e1].files += 1;
    byE1[e1].cases += row.cases;
    if (status === "portable" || status === "contract" || status === "golden" || status === "property") {
      parityCases += row.cases;
    } else {
      nonApplicableCases += row.cases;
    }
  }
  return {
    files: rows.length,
    cases,
    byCategory,
    byStatus,
    byLote,
    byTarget,
    byE1,
    parityCases,
    nonApplicableCases,
  };
}

// ---------------------------------------------------------------------------
// Validación (todas las reglas del gate; exit 1 con la lista completa)
// ---------------------------------------------------------------------------

function validate(): { errors: string[]; totals: Totals } {
  const errors: string[] = [];
  const totals = computeTotals(FILES);

  // Inventario real de test/*.test.ts
  let actual: string[] = [];
  try {
    actual = readdirSync(TEST_DIR)
      .filter((name) => name.endsWith(".test.ts"))
      .map((name) => `test/${name}`)
      .sort();
  } catch {
    errors.push(`no se pudo leer el directorio de tests: ${TEST_DIR}`);
  }

  const declared = FILES.map((row) => row.file);
  const declaredSet = new Set(declared);

  if (declaredSet.size !== declared.length) {
    const seen = new Set<string>();
    for (const file of declared) {
      if (seen.has(file)) errors.push(`archivo duplicado en la clasificación: ${file}`);
      seen.add(file);
    }
  }

  const actualSet = new Set(actual);
  for (const file of actual) if (!declaredSet.has(file)) errors.push(`falta clasificar el archivo de test: ${file}`);
  for (const file of declared) if (!actualSet.has(file)) errors.push(`clasificación sin archivo real en test/: ${file}`);

  // Reglas por fila
  for (const row of FILES) {
    const where = row.file || "<fila sin file>";
    if (!row.file.startsWith("test/") || !row.file.endsWith(".test.ts")) {
      errors.push(`${where}: 'file' debe ser repo-relativo y terminar en .test.ts`);
    }
    if (!CATEGORY_ORDER.includes(row.category)) errors.push(`${where}: categoría inválida '${row.category}'`);
    if (!Number.isInteger(row.cases) || row.cases <= 0) errors.push(`${where}: 'cases' debe ser entero positivo`);
    if (!row.module || !row.module.trim()) errors.push(`${where}: falta 'module'`);
    if (!row.lote || !LOTE_ORDER.includes(row.lote)) errors.push(`${where}: lote inválido '${row.lote}'`);
    if (!row.reuse || !["A", "B", "C", "D"].includes(row.reuse)) errors.push(`${where}: reuse inválido '${row.reuse}'`);
    if (!TARGET_ORDER.includes(row.targetService)) errors.push(`${where}: targetService inválido '${row.targetService}'`);
    for (const secondary of row.secondaryServices ?? []) {
      if (!TARGET_ORDER.includes(secondary) || secondary === "no-aplica") {
        errors.push(`${where}: secondaryService inválido '${secondary}'`);
      }
    }

    // Coherencia categoría ↔ reutilización ↔ lote ↔ destino
    if (row.category === "P" && row.reuse !== "A") errors.push(`${where}: P exige reutilización A`);
    if ((row.category === "C" || row.category === "H") && row.reuse !== "B") {
      errors.push(`${where}: ${row.category} exige reutilización B`);
    }
    if ((row.category === "U" || row.category === "O") && row.reuse !== "D") {
      errors.push(`${where}: ${row.category} exige reutilización D`);
    }
    if (row.category === "I" && !["B", "C", "D"].includes(row.reuse)) {
      errors.push(`${where}: I exige reutilización B, C o D`);
    }
    if (row.category === "P" && row.lote !== "L1") errors.push(`${where}: P exige lote L1`);
    if ((row.category === "C" || row.category === "H") && row.lote !== "L2") {
      errors.push(`${where}: ${row.category} exige lote L2`);
    }
    if (row.category === "I" && row.lote !== "L3" && row.lote !== "L4") {
      errors.push(`${where}: I exige lote L3 o L4`);
    }
    if ((row.category === "U" || row.category === "O") && row.lote !== "L5") {
      errors.push(`${where}: ${row.category} exige lote L5`);
    }
    if (row.lote === "L5" && row.targetService !== "no-aplica") {
      errors.push(`${where}: L5 exige targetService 'no-aplica'`);
    }
    if (row.lote !== "L5" && row.targetService === "no-aplica") {
      errors.push(`${where}: ${row.lote} no admite targetService 'no-aplica'`);
    }

    // Contrato en fronteras (C: K; H: K10)
    if (row.category === "C" && !row.contract) errors.push(`${where}: C exige 'contract' (K de 03-boundaries §7)`);
    if (row.category === "H" && !row.contract) errors.push(`${where}: H exige 'contract' (K10)`);

    // Motivo en estados no migrables
    const status = deriveStatus(row);
    if ((status === "ui" || status === "descartado") && !row.motivo?.trim()) {
      errors.push(`${where}: estado '${status}' exige motivo escrito`);
    }
  }

  // Totales: cuadre exacto con el baseline 718/95 y 107/74/39/470/22/6
  if (totals.files !== EXPECTED.files) {
    errors.push(`total de archivos ${totals.files} ≠ ${EXPECTED.files}`);
  }
  if (totals.cases !== EXPECTED.cases) {
    errors.push(`suma de casos ${totals.cases} ≠ ${EXPECTED.cases}`);
  }
  for (const category of CATEGORY_ORDER) {
    const expected = EXPECTED.byCategory[category];
    const got = totals.byCategory[category];
    if (got.files !== expected.files) {
      errors.push(`categoría ${category}: ${got.files} archivos ≠ ${expected.files}`);
    }
    if (got.cases !== expected.cases) {
      errors.push(`categoría ${category}: ${got.cases} casos ≠ ${expected.cases}`);
    }
  }
  if (BASELINE.cases !== EXPECTED.cases || BASELINE.files !== EXPECTED.files) {
    errors.push("el baseline declarado no coincide con EXPECTED");
  }

  return { errors, totals };
}

// ---------------------------------------------------------------------------
// Modelo del manifest (qvaapply.parity/v1)
// ---------------------------------------------------------------------------

interface ManifestFile {
  file: string;
  category: Category;
  cases: number;
  module: string;
  targetService: TargetService;
  secondaryServices?: TargetService[];
  e1Service: E1Service;
  contract?: string;
  reuse: Reuse;
  lote: Lote;
  status: Status;
  motivo?: string;
}

interface Manifest {
  schema: "qvaapply.parity/v1";
  canonicalVersion: 1;
  oracle: { impl: "typescript"; commit: string; srcHash: string; source: string };
  baseline: typeof BASELINE;
  totals: {
    files: number;
    cases: number;
    byCategory: Record<Category, number>;
    byCategoryFiles: Record<Category, number>;
    byStatus: Record<Status, number>;
    byLote: Record<Lote, { files: number; cases: number }>;
    byTargetService: Record<TargetService, { files: number; cases: number }>;
    byE1Service: Record<E1Service, { files: number; cases: number }>;
    parityCases: number;
    nonApplicableBackendCases: number;
    repositoryCases: number;
    nonApplicableCases: number;
    unclassifiedCases: number;
  };
  generator: {
    name: "parity/tools/build-manifest.ts";
    version: 1;
    regenerate: string;
    check: string;
    profile: string;
    sourceOfTruth: string[];
  };
  files: ManifestFile[];
}

function buildManifest(totals: Totals, commit: string, srcHash: string): Manifest {
  const byCategory = {} as Record<Category, number>;
  const byCategoryFiles = {} as Record<Category, number>;
  for (const category of CATEGORY_ORDER) {
    byCategory[category] = totals.byCategory[category].cases;
    byCategoryFiles[category] = totals.byCategory[category].files;
  }

  const files: ManifestFile[] = [...FILES]
    .sort((a, b) => {
      const byCat = CATEGORY_ORDER.indexOf(a.category) - CATEGORY_ORDER.indexOf(b.category);
      return byCat !== 0 ? byCat : a.file.localeCompare(b.file, "en");
    })
    .map((row) => {
      const entry: ManifestFile = {
        file: row.file,
        category: row.category,
        cases: row.cases,
        module: row.module,
        targetService: row.targetService,
        e1Service: e1Of(row),
        reuse: row.reuse,
        lote: row.lote,
        status: deriveStatus(row),
      };
      if (row.secondaryServices?.length) entry.secondaryServices = [...row.secondaryServices];
      if (row.contract) entry.contract = row.contract;
      if (row.motivo) entry.motivo = row.motivo;
      return entry;
    });

  return {
    schema: "qvaapply.parity/v1",
    canonicalVersion: 1,
    oracle: { impl: "typescript", commit, srcHash, source: "src/" },
    baseline: BASELINE,
    totals: {
      files: totals.files,
      cases: totals.cases,
      byCategory,
      byCategoryFiles,
      byStatus: totals.byStatus,
      byLote: totals.byLote,
      byTargetService: totals.byTarget,
      byE1Service: totals.byE1,
      parityCases: totals.parityCases,
      nonApplicableBackendCases: totals.byStatus.ui + EXPECTED.byCategory.O.cases,
      repositoryCases: FILES.find((row) => row.file === "test/repository.test.ts")?.cases ?? 0,
      nonApplicableCases: totals.nonApplicableCases,
      unclassifiedCases: 0,
    },
    generator: {
      name: "parity/tools/build-manifest.ts",
      version: 1,
      regenerate: "node --import tsx parity/tools/build-manifest.ts",
      check: "node --import tsx parity/tools/build-manifest.ts --check",
      profile: "docs/migration/parity-matrix.md",
      sourceOfTruth: [
        "docs/migration/analysis/04-tests.md §2 y §5.2",
        "docs/migration/verification.md §2 (estado L0)",
        "docs/migration/target-architecture.md §3.1 (estado E1)",
      ],
    },
    files,
  };
}

// ---------------------------------------------------------------------------
// Render del documento docs/migration/parity-matrix.md
// ---------------------------------------------------------------------------

function pct(part: number, total: number): string {
  return `${((part / total) * 100).toFixed(1).replace(".", ",")} %`;
}

function renderMatrix(manifest: Manifest): string {
  const { totals } = manifest;
  const lines: string[] = [];

  // Derivados para que el documento no repita cifras a mano.
  const statusFileCounts = {} as Record<Status, number>;
  for (const status of STATUS_ORDER) statusFileCounts[status] = 0;
  for (const file of manifest.files) statusFileCounts[file.status] += 1;
  const repositoryEntry = manifest.files.find((file) => file.file === "test/repository.test.ts");
  const repositoryCases = repositoryEntry?.cases ?? 0;
  const nonApplicableBackend = totals.byStatus.ui + EXPECTED.byCategory.O.cases;
  const iFiles = manifest.files.filter((file) => file.category === "I");
  const iStatusBreakdown = (["golden", "property", "descartado"] as const)
    .map((status) => {
      const selection = iFiles.filter((file) => file.status === status);
      const cases = selection.reduce((sum, file) => sum + file.cases, 0);
      return `\`${status}\` ${selection.length}/${cases}`;
    })
    .join(" · ");

  lines.push("# Matriz de paridad de los 718 tests");
  lines.push("");
  lines.push("> **Artefacto generado; no editar a mano.** Se regenera con");
  lines.push("> `node --import tsx parity/tools/build-manifest.ts` a partir de la tabla `FILES` del generador.");
  lines.push("> El equivalente machine-readable es [parity/manifest.json](../../parity/manifest.json).");
  lines.push(">");
  lines.push(`> - **Esquema:** \`qvaapply.parity/v1\` (canonicalVersion 1, generator v1)`);
  lines.push(`> - **Oráculo:** TypeScript @ \`${manifest.oracle.commit}\`, \`srcHash\` \`${manifest.oracle.srcHash}\``);
  lines.push(
    `> - **Baseline verificado:** ${BASELINE.pass} pass / ${BASELINE.fail} fail / ${BASELINE.skipped} skipped / ${BASELINE.todo} todo, ${BASELINE.files} archivos (\`${BASELINE.command}\`, ${BASELINE.measuredAt})`,
  );
  lines.push("> - **Fuentes normativas:** [04-tests.md](analysis/04-tests.md) §2 y §5.2, [verification.md](verification.md) §L0, [target-architecture.md](target-architecture.md) §3.1");
  lines.push("");
  lines.push("## 0. Resumen ejecutivo");
  lines.push("");
  lines.push(`La suite TypeScript de \`test/*.test.ts\` es el oráculo de la migración a Go. Esta matriz demuestra que **los ${totals.cases} casos de los ${totals.files} archivos están clasificados exactamente una vez** y que cada archivo tiene lote de migración, destino lógico y servicio E1. El gate L0 de [verification.md](verification.md) exige **0 casos sin clasificar**: se cumple.`);
  lines.push("");
  lines.push(
    mdTable(
      ["Métrica", "Valor", "Lectura"],
      [
        ["Casos del oráculo inventariados", `**${totals.cases} / ${EXPECTED.cases}**`, "suma exacta de los 95 archivos"],
        ["Archivos de test inventariados", `**${totals.files} / ${EXPECTED.files}**`, "cada `test/*.test.ts` aparece una vez"],
        ["Casos sin clasificar", "**0**", "ningún archivo sin categoría, estado, lote o destino"],
        [
          "Casos con vía de paridad ejecutable",
          `**${totals.parityCases} (${pct(totals.parityCases, totals.cases)})**`,
          `portable ${totals.byStatus.portable} + contract ${totals.byStatus.contract} + golden ${totals.byStatus.golden} + property ${totals.byStatus.property}`,
        ],
        [
          "No aplicables al backend (U + O)",
          `**${nonApplicableBackend} (${pct(nonApplicableBackend, totals.cases)})**`,
          `ui ${totals.byStatus.ui} + descartado ${EXPECTED.byCategory.O.cases}`,
        ],
        [
          "`repository` reemplazado por verificación de datos",
          `**${repositoryCases} (${pct(repositoryCases, totals.cases)})**`,
          "estado `descartado`, justificación en §6",
        ],
        [
          "Totales por categoría",
          `**${CATEGORY_ORDER.map((category) => totals.byCategory[category]).join(" / ")}**`,
          `${CATEGORY_ORDER.map((category) => `${category} ${totals.byCategoryFiles[category]}`).join(" · ")} archivos`,
        ],
        [
          "Totales por lote",
          `**${LOTE_ORDER.map((lote) => `${lote} ${totals.byLote[lote].cases}`).join(" · ")}**`,
          `L1–L4 = ${totals.byLote.L1.cases + totals.byLote.L2.cases + totals.byLote.L3.cases + totals.byLote.L4.cases} casos; L5 = ${totals.byLote.L5.cases} no migran`,
        ],
      ],
    ),
  );
  lines.push("");
  lines.push(
    `**Lectura:** ${totals.parityCases} casos (${pct(totals.parityCases, totals.cases)}) tienen vía de paridad ejecutable contra Go; ${nonApplicableBackend} (${pct(nonApplicableBackend, totals.cases)}) son UI/operaciones no aplicables; ${repositoryCases} (${pct(repositoryCases, totals.cases)}) son el caso especial \`repository\`, cuya garantía pasa a la verificación de migración de datos. La suma ${totals.parityCases} + ${nonApplicableBackend} + ${repositoryCases} = ${totals.cases}.`,
  );
  lines.push("");

  lines.push("## 1. Cómo se genera y se valida");
  lines.push("");
  lines.push("Este documento y `parity/manifest.json` se regeneran juntos, de forma determinista, con:");
  lines.push("");
  lines.push("```bash");
  lines.push("# desde la raíz del repo");
  lines.push("node --import tsx parity/tools/build-manifest.ts");
  lines.push("");
  lines.push("# solo verificación (CI): no escribe y sale con 1 si hay deriva");
  lines.push("node --import tsx parity/tools/build-manifest.ts --check");
  lines.push("```");
  lines.push("");
  lines.push("El generador **no ejecuta la suite** (tarda ~15 s y no aporta al inventario): fija el baseline verificado de 2026-11-12 y comprueba que la tabla de datos cuadre con él. Sale con **exit code 1** si:");
  lines.push("");
  lines.push(
    mdTable(
      ["Condición de fallo", "Motivo"],
      [
        ["Un `test/*.test.ts` existe y no está en `FILES`", "archivo de test sin clasificar"],
        ["Una fila de `FILES` no tiene archivo real en `test/`", "clasificación obsoleta (archivo borrado o renombrado)"],
        ["Duplicados de archivo en `FILES`", "un caso aparecería dos veces"],
        ["La suma de casos no es 718", "pérdida o doble conteo de casos"],
        ["Los totales por categoría no son 107/74/39/470/22/6 (archivos 21/11/9/42/9/3)", "desvío del inventario de 04-tests.md"],
        ["Falta categoría, reutilización, lote, destino, estado o contrato", "caso sin clasificación completa"],
        ["Un estado `ui`/`descartado` no tiene motivo", "exclusión sin justificación escrita"],
        ["Incoherencia categoría ↔ reutilización ↔ lote ↔ destino", "clasificación contradictoria"],
        ["`--check` y los artefactos del repo difieren", "deriva entre generador y artefactos"],
      ],
    ),
  );
  lines.push("");
  lines.push("Regla de oro: **los artefactos no se editan a mano**. Cualquier cambio de clasificación se hace en `FILES` (o en la suite, con revisión del baseline) y se regeneran ambos ficheros en el mismo commit.");
  lines.push("");

  lines.push("## 2. Taxonomía, estados y lotes");
  lines.push("");
  lines.push("Estados de [verification.md](verification.md) §L0 aplicados a la taxonomía de [04-tests.md](analysis/04-tests.md) §0.2 y §3:");
  lines.push("");
  lines.push(
    mdTable(
      ["Categoría", "Archivos", "Casos", "Estado asignado", "Reutilización", "Lote"],
      [
        [
          "P — puro/inyectable determinista",
          String(totals.byCategoryFiles.P),
          String(totals.byCategory.P),
          "`portable` (reutilización A, golden directo)",
          "A",
          "L1",
        ],
        ["C — contrato de adaptador", String(totals.byCategoryFiles.C), String(totals.byCategory.C), "`contract` (cassette/fixture)", "B", "L2"],
        ["H — superficie HTTP", String(totals.byCategoryFiles.H), String(totals.byCategory.H), "`contract` (HTTP scripted, K10)", "B", "L2"],
        ["I — integración durable", String(totals.byCategoryFiles.I), String(totals.byCategory.I), iStatusBreakdown, "B / C / D", "L3–L4"],
        ["U — UI/React/estructura de fuente", String(totals.byCategoryFiles.U), String(totals.byCategory.U), "`ui`", "D", "L5"],
        ["O — despliegue/scripts/reportes", String(totals.byCategoryFiles.O), String(totals.byCategory.O), "`descartado`", "D", "L5"],
        [
          "**Total**",
          `**${totals.files}**`,
          `**${totals.cases}**`,
          "6 estados, 0 sin clasificar",
          "—",
          "L1–L5",
        ],
      ],
    ),
  );
  lines.push("");
  lines.push(
    mdTable(
      ["Estado", "Significado operativo (verification.md §L0)", "Archivos", "Casos"],
      [
        ["`portable`", "se reescribe como test Go del paquete; vector input→output directo", String(statusFileCounts.portable), String(totals.byStatus.portable)],
        ["`golden`", "se cubre con fixture dorado ejecutado contra Go (replay/golden extraído)", String(statusFileCounts.golden), String(totals.byStatus.golden)],
        ["`contract`", "se cubre con la suite de contratos (QvaPay/HTTP/webhook/SSE)", String(statusFileCounts.contract), String(totals.byStatus.contract)],
        ["`property`", "se cubre con property-based testing (tiempo/interleaving no determinista)", String(statusFileCounts.property), String(totals.byStatus.property)],
        ["`ui`", "se conserva en el frontend / smoke visual; fuera del score de backend", String(statusFileCounts.ui), String(totals.byStatus.ui)],
        ["`descartado`", "excluido del score con justificación escrita (O + `repository`)", String(statusFileCounts.descartado), String(totals.byStatus.descartado)],
      ],
    ),
  );
  lines.push("");
  lines.push(
    `\`descartado\` agrupa ${totals.byStatus.descartado} casos = ${EXPECTED.byCategory.O.cases} de O (despliegue/scripts) + ${repositoryCases} de \`repository\` (ver §6). Los ${nonApplicableBackend} casos “no aplicables al backend” de 04-tests.md §0.2 son solo U+O; \`repository\` es una exclusión adicional de código ejecutable, no una pérdida de cobertura: se sustituye por la verificación de migración de datos.`,
  );
  lines.push("");

  lines.push("### Lotes de migración");
  lines.push("");
  lines.push(
    mdTable(
      ["Lote", "Fase", "Archivos", "Casos", "Contenido"],
      [
        ["L1", "F1 — puros", String(totals.byLote.L1.files), String(totals.byLote.L1.cases), "riesgo, matemática/redondeo, liquidez, presupuesto, intents, schedulers, auth, telegram"],
        ["L2", "F2 — contratos y HTTP", String(totals.byLote.L2.files), String(totals.byLote.L2.cases), "QvaPay (K1–K7), SSE, push/Telegram (K14) y superficie HTTP (K10)"],
        ["L3", "F3 — núcleo monetario", String(totals.byLote.L3.files), String(totals.byLote.L3.cases), "reservas, intenciones, mutaciones, compensación, conciliación, ledger"],
        ["L4", "F4 — mercado y lecturas", String(totals.byLote.L4.files), String(totals.byLote.L4.cases), "ingesta, dedupe, notificaciones, chat, analítica, insights"],
        ["L5", "F5 — UI y operaciones", String(totals.byLote.L5.files), String(totals.byLote.L5.cases), "no migran; quedan como deuda del frontend/scripts"],
      ],
    ),
  );
  lines.push("");
  lines.push(
    `Cuadre: L1 ${totals.byLote.L1.cases} + L2 ${totals.byLote.L2.cases} = ${totals.byLote.L1.cases + totals.byLote.L2.cases} (220, objetivo de la semana 1 de 04-tests.md §0.4); L3+L4 = ${totals.byLote.L3.cases + totals.byLote.L4.cases}; total con L5 = ${totals.cases}.`,
  );
  lines.push("");

  lines.push("### Destinos lógicos y servicios E1");
  lines.push("");
  lines.push("Un destino lógico puede persistir como servicio propio o resolverse dentro de `trading-core`/`edge`/`notifier` en E1. El manifest guarda `targetService` (lógico) y `e1Service` (estado E1), para que la matriz no dependa de la topología final.");
  lines.push("");
  const e1Rows = E1_ORDER.map((e1) => {
    const t = totals.byE1Service[e1];
    const eligible = manifest.files
      .filter((f) => f.e1Service === e1 && ["portable", "contract", "golden", "property"].includes(f.status))
      .reduce((sum, f) => sum + f.cases, 0);
    return [e1, String(t.files), String(t.cases), String(eligible), String(t.cases - eligible)];
  });
  lines.push(mdTable(["Servicio E1", "Archivos", "Casos", "Con vía de paridad", "No aplicables/reemplazados"], e1Rows));
  lines.push("");
  const targetRows = TARGET_ORDER.filter((t) => totals.byTargetService[t].files > 0).map((t) => [
    t,
    TARGET_TO_E1[t],
    String(totals.byTargetService[t].files),
    String(totals.byTargetService[t].cases),
  ]);
  lines.push(mdTable(["Destino lógico", "Servicio E1", "Archivos", "Casos"], targetRows));
  lines.push("");
  lines.push(
    "Solo se listan destinos con al menos un archivo primario. `audit` aparece como destino secundario (p. ej. `repository`, `hunting-query-performance`, `bulk-dismiss-http`) y sus casos se contabilizan en el servicio primario para no duplicar cobertura; `secondaryServices` del manifest conserva el detalle.",
  );
  lines.push("");

  lines.push("## 3. Matriz archivo por archivo");
  lines.push("");
  for (const category of CATEGORY_ORDER) {
    const rows = manifest.files.filter((f) => f.category === category);
    const cases = rows.reduce((sum, f) => sum + f.cases, 0);
    const meta = CATEGORY_META[category];
    lines.push(`### ${meta.title} — ${rows.length} archivos / ${cases} casos`);
    lines.push("");
    lines.push(meta.description);
    lines.push("");
    lines.push(
      mdTable(
        ["Archivo", "Casos", "Módulo / área", "Destino lógico", "E1", "Reutil.", "Lote", "Estado"],
        rows.map((f) => [
          `\`${f.file}\``,
          String(f.cases),
          f.module,
          f.targetService,
          f.e1Service,
          f.reuse,
          f.lote,
          `\`${f.status}\``,
        ]),
      ),
    );
    lines.push("");
  }

  lines.push("## 4. Cuadre de totales");
  lines.push("");
  const sumCategoryCases = CATEGORY_ORDER.reduce((sum, c) => sum + totals.byCategory[c], 0);
  const sumCategoryFiles = CATEGORY_ORDER.reduce((sum, c) => sum + totals.byCategoryFiles[c], 0);
  const sumStatus = STATUS_ORDER.reduce((sum, s) => sum + totals.byStatus[s], 0);
  const sumLote = LOTE_ORDER.reduce((sum, l) => sum + totals.byLote[l].cases, 0);
  const sumE1 = E1_ORDER.reduce((sum, e) => sum + totals.byE1Service[e].cases, 0);
  const sumStatusFiles = STATUS_ORDER.reduce((sum, s) => sum + statusFileCounts[s], 0);
  lines.push(
    mdTable(
      ["Comprobación", "Fórmula", "Resultado"],
      [
        ["Suma de casos por archivo", "Σ `cases` de las 95 filas", `${totals.cases} = ${EXPECTED.cases} ✅`],
        [
          "Suma de casos por categoría",
          CATEGORY_ORDER.map((c) => totals.byCategory[c]).join(" + "),
          `${sumCategoryCases} = ${EXPECTED.cases} ✅`,
        ],
        [
          "Suma de archivos por categoría",
          CATEGORY_ORDER.map((c) => totals.byCategoryFiles[c]).join(" + "),
          `${sumCategoryFiles} = ${EXPECTED.files} ✅`,
        ],
        ["Suma por estado", STATUS_ORDER.map((s) => totals.byStatus[s]).join(" + "), `${sumStatus} = ${EXPECTED.cases} ✅`],
        ["Suma por lote", LOTE_ORDER.map((l) => totals.byLote[l].cases).join(" + "), `${sumLote} = ${EXPECTED.cases} ✅`],
        ["Suma por servicio E1", E1_ORDER.map((e) => totals.byE1Service[e].cases).join(" + "), `${sumE1} = ${EXPECTED.cases} ✅`],
        [
          "Casos sin clasificar",
          `${totals.cases} casos − ${sumStatus} casos con estado`,
          `${totals.cases - sumStatus} ✅ (${sumStatusFiles} archivos con estado de ${totals.files})`,
        ],
      ],
    ),
  );
  lines.push("");

  lines.push(`## 5. Casos no aplicables al backend (${nonApplicableBackend})`);
  lines.push("");
  lines.push(`Los ${totals.byCategoryFiles.U} archivos U (${totals.byCategory.U} casos) y ${totals.byCategoryFiles.O} archivos O (${totals.byCategory.O} casos) de 04-tests.md §2.5 **no suman al score de paridad**. Regla dura: si un caso afirma sobre texto de \`.tsx\`, \`.css\`, sobre la forma de una función fuente o sobre un script de despliegue, no es evidencia de paridad del backend Go. Se conservan mientras exista el frontend/scripts TypeScript; su cobertura futura pasa a \`visual-smoke\`/E2E y verificación operativa.`);
  lines.push("");
  const nonApplicable = manifest.files.filter((f) => f.status === "ui" || (f.status === "descartado" && f.category !== "I"));
  lines.push(
    mdTable(
      ["Archivo", "Cat.", "Casos", "Estado", "Motivo"],
      nonApplicable.map((f) => [`\`${f.file}\``, f.category, String(f.cases), `\`${f.status}\``, f.motivo ?? "—"]),
    ),
  );
  lines.push("");
  lines.push("**Sustitución futura:** `scripts/visual-smoke.mjs` (Chromium + axe-core) para el panel; tests de contrato de nginx/deploy y métricas/analytics para los scripts operativos. No se sustituyen por tests Go equivalentes porque no verifican comportamiento de backend.");
  lines.push("");

  lines.push(`## 6. Caso especial: \`repository\` (${repositoryCases} casos)`);
  lines.push("");
  lines.push(
    `\`test/repository.test.ts\` (${repositoryCases} casos, lote ${repositoryEntry?.lote ?? "L3"}, destino ${repositoryEntry?.targetService ?? "money-core"}) prueba el esquema SQLite v31, migraciones e índices. 04-tests.md §2.4 lo marca con reutilización **D** y §6.4 lo excluye de la portabilidad como código: no se reescribe en Go, sino que su garantía se redefine como **verificación de migración de datos** (02-persistence.md §6.5: conteos por tabla, sumas de saldos, hashes de configuración/epoch, snapshots) **+ tests de esquema Postgres**.`,
  );
  lines.push("");
  lines.push(
    `Por eso su estado es \`descartado\` con motivo, pero **no forma parte de los ${nonApplicableBackend} casos “no aplicables al backend”**: es una exclusión adicional que el propio 04-tests.md §6.4 autoriza. En el score de paridad ejecutable se contabiliza como ${pct(repositoryCases, totals.cases)} excluido con justificación, no como cobertura perdida.`,
  );
  lines.push("");

  lines.push("## 7. Verificación contra la suite real (2026-11-12)");
  lines.push("");
  lines.push("Esta matriz se contrastó con la ejecución real de la suite, no solo con el documento de inventario:");
  lines.push("");
  lines.push(
    mdTable(
      ["Comprobación", "Método", "Resultado"],
      [
        [
          "Casos totales",
          "`node --import tsx --test --test-reporter=junit test/*.test.ts`",
          "718 `<testcase>`, exit 0",
        ],
        ["Archivos", "atributo `file` de cada `<testcase>`", "95 archivos distintos"],
        [
          "Conteo por archivo",
          "95 conteos JUnit vs 04-tests.md §2.1–§2.5",
          "95/95 coinciden; 0 discrepancias",
        ],
        ["Llamadas `test()` estáticas", "`grep -c '^test(' test/*.test.ts`", `${BASELINE.staticTestCalls} (expandidas a 718 por tablas/bucles)`],
        ["LOC de tests", "`wc -l test/*.test.ts`", `${BASELINE.locTests.toLocaleString("es-ES")}`],
        ["Dependencias declaradas en §0.1", "grep -l", "`new Store` 43, `.inject` 13, `readFileSync` 9, `spawnSync` 1"],
      ],
    ),
  );
  lines.push("");
  lines.push("**Metodología:** el reporter `tap` de Node no atribuye el archivo a cada subtest; por eso el conteo por archivo se obtuvo con el reporter `junit` y su atributo `file`. El baseline de referencia se mantiene en 718/95 (04-tests.md §0.1).");
  lines.push("");

  lines.push("## 8. Discrepancias y observaciones");
  lines.push("");
  lines.push("**Entre 04-tests.md y la suite real: no se detectó ninguna discrepancia de conteo.** Los 95 conteos por archivo coinciden exactamente y las métricas de §0.1 se reprodujeron (718 casos, 95 archivos, 643 llamadas estáticas, 15 769 LOC, 43 archivos con `Store`, 13 con `inject`, 9 con lectura de fuentes y 1 con subproceso).");
  lines.push("");
  lines.push("Observaciones que no alteran el inventario:");
  lines.push("");
  lines.push("- **Errata menor en 04-tests.md §2.4:** la fila `market-reader-identity` declara la dependencia `fetcn` (por `fetch`). Sin efecto en casos ni clasificación.");
  lines.push("- **`descartado` vs “no aplicables”:** 04-tests.md §0.2 cuenta 28 no aplicables (U+O) y §6.4 excluye además `repository` (20) como código; este documento mantiene ambos hechos separados y explicados (§5 y §6) para que el cuadre 718 sea transparente.");
  lines.push("- **Entorno medido:** Node v25.9.0 en este workspace, aunque `package.json` declara `>=24.22.1 <25`. No afecta al inventario, pero conviene fijar la versión exacta de Node en el job de CI que regenere la matriz.");
  lines.push("- **Documentos públicos desactualizados:** `docs/VERIFICATION.md` y el README declaraban 118 tests; la evidencia de release de 2026-11-02 hablaba de 89 archivos. El baseline correcto es 718/95 (04-tests.md §0.1). La corrección de esos documentos es parte de L0 y queda fuera del alcance de esta matriz.");
  lines.push("");

  lines.push("## 9. Cómo cambiar la clasificación (guardrail)");
  lines.push("");
  lines.push("1. Edita la tabla `FILES` de `parity/tools/build-manifest.ts` (o el baseline `EXPECTED` si cambia la suite). No edites este documento ni `parity/manifest.json` a mano.");
  lines.push("2. Ejecuta `node --import tsx parity/tools/build-manifest.ts` desde la raíz del repo.");
  lines.push("3. Revisa el diff de ambos artefactos y commitea los tres ficheros juntos (generador, manifest, matriz).");
  lines.push("4. En CI, `--check` falla si alguien cambia un artefacto sin regenerar. Prohibido mover un archivo de lote o cambiar un estado sin actualizar el manifest y re-ejecutar el gate (04-tests.md §5.2).");
  lines.push("");
  lines.push("---");
  lines.push("");
  lines.push(
    `*Generado por \`parity/tools/build-manifest.ts\` v1 · esquema \`qvaapply.parity/v1\` · oráculo TypeScript @ ${manifest.oracle.commit} · \`${manifest.oracle.srcHash}\` · baseline ${BASELINE.measuredAt}.*`,
  );

  return `${lines.join("\n")}\n`;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main(): void {
  const args = process.argv.slice(2);
  const check = args.includes("--check");
  if (args.includes("--help")) {
    console.log("Uso: node --import tsx parity/tools/build-manifest.ts [--check]");
    console.log("Genera parity/manifest.json y docs/migration/parity-matrix.md.");
    console.log("--check: no escribe; sale con 1 si los artefactos del repo están desactualizados.");
    return;
  }
  const unknown = args.filter((a) => a !== "--check");
  if (unknown.length > 0) {
    console.error(`build-manifest: argumento no reconocido: ${unknown.join(" ")}`);
    process.exit(1);
  }

  const { errors, totals } = validate();
  if (errors.length > 0) {
    console.error(`build-manifest: ${errors.length} error(es) de validación; no se genera nada.`);
    for (const error of errors) console.error(`  - ${error}`);
    process.exit(1);
  }

  const commit = gitCommit();
  const srcHash = computeSrcHash();
  const manifest = buildManifest(totals, commit, srcHash);
  const manifestJson = `${JSON.stringify(manifest, null, 2)}\n`;
  const matrixMarkdown = renderMatrix(manifest);

  if (check) {
    let stale = false;
    for (const [path, expected] of [
      [MANIFEST_PATH, manifestJson],
      [MATRIX_PATH, matrixMarkdown],
    ] as const) {
      if (!readFileExists(path)) {
        console.error(`build-manifest: falta el artefacto ${relative(REPO_ROOT, path)}; regenera con --check sin flag.`);
        stale = true;
        continue;
      }
      const current = readFileSync(path, "utf8");
      if (current !== expected) {
        console.error(`build-manifest: artefacto desactualizado: ${relative(REPO_ROOT, path)}`);
        stale = true;
      }
    }
    if (stale) {
      console.error("build-manifest: ejecuta `node --import tsx parity/tools/build-manifest.ts` y commitea los artefactos.");
      process.exit(1);
    }
    console.log("build-manifest: OK — manifest y matriz coinciden con el generador.");
    return;
  }

  writeFileSync(MANIFEST_PATH, manifestJson, "utf8");
  writeFileSync(MATRIX_PATH, matrixMarkdown, "utf8");
  console.log(
    `build-manifest: OK — ${manifest.totals.files} archivos / ${manifest.totals.cases} casos ` +
      `(P ${manifest.totals.byCategory.P}, C ${manifest.totals.byCategory.C}, H ${manifest.totals.byCategory.H}, ` +
      `I ${manifest.totals.byCategory.I}, U ${manifest.totals.byCategory.U}, O ${manifest.totals.byCategory.O}).`,
  );
  console.log(`  - ${relative(REPO_ROOT, MANIFEST_PATH)}`);
  console.log(`  - ${relative(REPO_ROOT, MATRIX_PATH)}`);
}

function readFileExists(path: string): boolean {
  try {
    readFileSync(path);
    return true;
  } catch {
    return false;
  }
}

main();
