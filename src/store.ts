import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { conservativeRiskLimits } from "./core/risk-policy.js";
import type { RiskDecision } from "./core/risk-policy.js";
import type {
  PlannedOwnOffer,
  RestorableOwnOffer,
} from "./core/liquidity-plan.js";
import type { TradingConfig } from "./market-config.js";
import type {
  FiatMarket,
  OperationState,
  P2pOffer,
  P2pType,
} from "./types.js";

const LATEST_SCHEMA_VERSION = 12;

export interface CachedRemoteResource<T = unknown> {
  key: string;
  data: T;
  updatedAt: number;
}

export type WorkflowState =
  | "planned"
  | "capital_reserved"
  | "cancelling_own_offers"
  | "cancellation_uncertain"
  | "own_offers_cancelled"
  | "applying_external"
  | "applied"
  | "apply_rejected"
  | "apply_uncertain"
  | "reconciling"
  | "restoring_own_offers"
  | "restoring_surplus"
  | "restored"
  | "surplus_restore_failed"
  | "compensation_failed"
  | "blocked";

export interface TradeWorkflow {
  id: string;
  targetOffer: P2pOffer;
  riskDecision: RiskDecision;
  state: WorkflowState;
  error: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface WorkflowOwnOffer {
  workflowId: string;
  originalUuid: string;
  snapshot: PlannedOwnOffer;
  state:
    | "planned"
    | "cancel_requested"
    | "cancelled"
    | "restore_requested"
    | "restored"
    | "consumed"
    | "uncertain";
  restoreIdempotencyKey: string;
  restoredUuid: string | null;
  error: string | null;
}

export interface ConfigRevision {
  id: number;
  createdAt: number;
  source: string;
  reason: string | null;
  config: TradingConfig;
  previousHash: string | null;
  hash: string;
}

export interface Operation {
  uuid: string;
  offerType: P2pType;
  coin: FiatMarket;
  amount: number;
  receive: number;
  rate: number;
  state: OperationState;
  autoApplied: boolean;
  cancelAt: number | null;
  createdAt: number;
  counterpartyId?: string;
  referenceRate?: number;
}

export interface TradingAlert {
  uuid: string;
  coin: FiatMarket;
  offerType: P2pType;
  amount: number;
  receive: number;
  rate: number;
  decision: "auto_buy" | "manual_sell" | "blocked";
  reason: string;
  referenceRate?: number;
  resolution?: "dismissed" | "applied" | "expired" | "resolved";
  createdAt: number;
  updatedAt: number;
  resolvedAt: number | null;
}

export interface DecisionEvent {
  id: number;
  version: string;
  uuid: string;
  coin: FiatMarket;
  offerType: P2pType;
  amount: number;
  receive: number;
  rate: number;
  decision: "applied" | "blocked" | "manual_review";
  reason: string;
  checks: RiskDecision["checks"];
  referenceRate?: number;
  resolution?: "dismissed" | "applied" | "expired" | "resolved";
  createdAt: number;
  updatedAt: number;
  resolvedAt: number | null;
}

export interface DecisionEventPage {
  items: DecisionEvent[];
  total: number;
  pending: number;
  page: number;
  pageSize: number;
}

export type NotificationKind =
  | "blocked-offer"
  | "operation-applied"
  | "reconciliation-required"
  | "rebalance-completed"
  | "rebalance-attention";

export interface DurableNotification {
  id: string;
  kind: NotificationKind;
  message: string;
  operationUuid?: string;
  payload: Record<string, unknown>;
  telegramDeliveredAt: number | null;
  telegramAttempts: number;
  telegramNextAttemptAt: number;
  telegramLastError?: string;
  pushDeliveredAt: number | null;
  pushAttempts: number;
  pushNextAttemptAt: number;
  pushLastError?: string;
  acknowledgedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export type RebalanceJobState =
  | "pending"
  | "applying"
  | "completed"
  | "partial"
  | "reconciliation_required"
  | "failed";

export interface RebalanceJobAdjustment {
  uuid: string;
  coin: FiatMarket;
  currentAmount: number;
  targetAmount: number;
  rate: number;
  receive: number;
  action: "edit" | "cancel";
  state: "pending" | "applying" | "completed" | "reconciliation_required" | "failed";
  error?: string;
}

export interface RebalanceJob {
  id: string;
  state: RebalanceJobState;
  adjustments: RebalanceJobAdjustment[];
  error?: string;
  createdAt: number;
  updatedAt: number;
}

export interface MutationIntent {
  intentId: string;
  operationUuid?: string;
  kind: string;
  idempotencyKey?: string;
  state: "submitted" | "confirmed" | "rejected" | "uncertain" | "reconciled";
  request: unknown;
  response?: unknown;
  error?: string;
  createdAt: number;
  updatedAt: number;
}

export interface CapitalReservation {
  workflowId: string;
  market: FiatMarket;
  amount: number;
  state: "active" | "released";
  createdAt: number;
  releasedAt: number | null;
}

export class Store {
  private readonly db: DatabaseSync;
  private readonly dbPath: string;

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    this.dbPath = join(dataDir, "qvaapply.sqlite");
    const existed = existsSync(this.dbPath);
    this.db = new DatabaseSync(this.dbPath);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
    if (existed && this.currentSchemaVersion() < LATEST_SCHEMA_VERSION)
      this.backupBeforeMigration(dataDir);
    this.migrate();
  }

  private migrate(): void {
    this.transaction(() => {
      this.db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL
      )`);
      if (this.currentSchemaVersion() < 1) {
        this.db.exec(`
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS seen_offers (uuid TEXT PRIMARY KEY, seen_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS operations (
        uuid TEXT PRIMARY KEY, offer_type TEXT NOT NULL, amount REAL NOT NULL, receive REAL NOT NULL,
        rate REAL NOT NULL, state TEXT NOT NULL, auto_applied INTEGER NOT NULL, cancel_at INTEGER,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT, created_at INTEGER NOT NULL, action TEXT NOT NULL,
        offer_uuid TEXT, detail TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS fiat_ledger (
        id INTEGER PRIMARY KEY AUTOINCREMENT, operation_uuid TEXT NOT NULL, direction TEXT NOT NULL,
        amount REAL NOT NULL, source TEXT NOT NULL, created_at INTEGER NOT NULL,
        UNIQUE(operation_uuid, direction)
      );
      CREATE TABLE IF NOT EXISTS dashboard_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT, created_at INTEGER NOT NULL,
        qusd_balance REAL NOT NULL, cup_balance REAL NOT NULL, prepago_balance REAL NOT NULL,
        open_offers INTEGER NOT NULL, active_operations INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS market_observations (
        id INTEGER PRIMARY KEY AUTOINCREMENT, created_at INTEGER NOT NULL,
        coin TEXT NOT NULL, average_buy REAL, average_sell REAL,
        median_buy REAL, median_sell REAL, best_buy REAL, best_sell REAL, open_offers INTEGER NOT NULL,
        eligible INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS trading_alerts (
        offer_uuid TEXT PRIMARY KEY, coin TEXT NOT NULL, offer_type TEXT NOT NULL,
        amount REAL NOT NULL, receive REAL NOT NULL, rate REAL NOT NULL,
        decision TEXT NOT NULL, reason TEXT NOT NULL, created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL, resolved_at INTEGER
      );
    `);
        this.ensureColumn(
          "operations",
          "coin",
          "TEXT NOT NULL DEFAULT 'BANK_CUP'",
        );
        this.ensureColumn(
          "fiat_ledger",
          "coin",
          "TEXT NOT NULL DEFAULT 'BANK_CUP'",
        );
        this.ensureColumn("market_observations", "median_buy", "REAL");
        this.ensureColumn("market_observations", "median_sell", "REAL");
        this.db
          .prepare(
            "INSERT INTO schema_migrations(version, applied_at) VALUES (1, ?)",
          )
          .run(Date.now());
      }
      if (this.currentSchemaVersion() < 2) {
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS trading_config (
            id INTEGER PRIMARY KEY CHECK (id = 1), qusd_reserve REAL NOT NULL,
            max_open_offers INTEGER NOT NULL
          );
          CREATE TABLE IF NOT EXISTS market_config (
            code TEXT PRIMARY KEY, label TEXT NOT NULL, currency TEXT NOT NULL,
            active INTEGER NOT NULL, fiat_balance REAL NOT NULL,
            buy_max_rate REAL NOT NULL, sell_min_rate REAL NOT NULL,
            purchase_max_qusd REAL NOT NULL, sell_fee_percent REAL NOT NULL
          );
          CREATE TABLE IF NOT EXISTS payment_details (
            market_code TEXT NOT NULL REFERENCES market_config(code) ON DELETE CASCADE,
            position INTEGER NOT NULL, name TEXT NOT NULL, value TEXT NOT NULL,
            PRIMARY KEY (market_code, position)
          );
          CREATE TABLE IF NOT EXISTS fiat_accounts (
            market_code TEXT PRIMARY KEY REFERENCES market_config(code) ON DELETE CASCADE,
            declared_balance REAL NOT NULL, updated_at INTEGER NOT NULL
          );
          CREATE TABLE IF NOT EXISTS scheduled_actions (
            id INTEGER PRIMARY KEY AUTOINCREMENT, operation_uuid TEXT,
            kind TEXT NOT NULL, run_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
            state TEXT NOT NULL, last_error TEXT, created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
          );
          CREATE TABLE IF NOT EXISTS mutation_intents (
            intent_id TEXT PRIMARY KEY, operation_uuid TEXT, kind TEXT NOT NULL,
            idempotency_key TEXT, state TEXT NOT NULL, request_json TEXT NOT NULL,
            response_json TEXT, error TEXT, created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
          );
        `);
        this.db
          .prepare(
            "INSERT INTO schema_migrations(version, applied_at) VALUES (2, ?)",
          )
          .run(Date.now());
      }
      if (this.currentSchemaVersion() < 3) {
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS risk_config (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            max_qusd_per_operation REAL NOT NULL,
            max_concurrent_qusd_exposure REAL NOT NULL,
            max_daily_applied_qusd REAL NOT NULL,
            max_concurrent_operations INTEGER NOT NULL,
            min_qusd_reserve REAL NOT NULL,
            max_quote_age_seconds REAL NOT NULL,
            min_expected_margin_percent REAL NOT NULL,
            max_slippage_percent REAL NOT NULL,
            max_consecutive_errors INTEGER NOT NULL,
            market_cooldown_seconds REAL NOT NULL,
            counterparty_cooldown_seconds REAL NOT NULL,
            reviewed_at INTEGER
          );
          CREATE TABLE IF NOT EXISTS config_revisions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            created_at INTEGER NOT NULL,
            source TEXT NOT NULL,
            reason TEXT,
            config_json TEXT NOT NULL,
            previous_hash TEXT,
            hash TEXT NOT NULL UNIQUE
          );
        `);
        this.db
          .prepare(
            "INSERT INTO schema_migrations(version, applied_at) VALUES (3, ?)",
          )
          .run(Date.now());
      }
      if (this.currentSchemaVersion() < 4) {
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS trade_workflows (
            id TEXT PRIMARY KEY,
            target_offer_uuid TEXT NOT NULL UNIQUE,
            target_json TEXT NOT NULL,
            risk_decision_json TEXT NOT NULL,
            state TEXT NOT NULL,
            error TEXT,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
          );
          CREATE TABLE IF NOT EXISTS workflow_own_offers (
            workflow_id TEXT NOT NULL REFERENCES trade_workflows(id) ON DELETE CASCADE,
            original_uuid TEXT NOT NULL,
            snapshot_json TEXT NOT NULL,
            state TEXT NOT NULL,
            restore_idempotency_key TEXT NOT NULL,
            restored_uuid TEXT,
            error TEXT,
            PRIMARY KEY (workflow_id, original_uuid)
          );
          CREATE TABLE IF NOT EXISTS capital_reservations (
            workflow_id TEXT PRIMARY KEY REFERENCES trade_workflows(id) ON DELETE CASCADE,
            asset TEXT NOT NULL,
            market_code TEXT NOT NULL,
            amount REAL NOT NULL CHECK (amount > 0),
            state TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            released_at INTEGER
          );
          CREATE INDEX IF NOT EXISTS idx_trade_workflows_state
            ON trade_workflows(state, updated_at);
          CREATE INDEX IF NOT EXISTS idx_capital_reservations_active
            ON capital_reservations(state, asset, market_code);
        `);
        this.db
          .prepare(
            "INSERT INTO schema_migrations(version, applied_at) VALUES (4, ?)",
          )
          .run(Date.now());
      }
      if (this.currentSchemaVersion() < 5) {
        this.ensureColumn("operations", "counterparty_id", "TEXT");
        this.db.exec(
          "CREATE INDEX IF NOT EXISTS idx_operations_cooldown ON operations(coin, counterparty_id, created_at)",
        );
        this.db
          .prepare(
            "INSERT INTO schema_migrations(version, applied_at) VALUES (5, ?)",
          )
          .run(Date.now());
      }
      if (this.currentSchemaVersion() < 6) {
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS remote_resource_cache (
            resource_key TEXT PRIMARY KEY,
            payload_json TEXT NOT NULL,
            updated_at INTEGER NOT NULL
          );
          CREATE INDEX IF NOT EXISTS idx_remote_resource_cache_updated
            ON remote_resource_cache(updated_at);
          CREATE TABLE IF NOT EXISTS bot_config (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            scan_interval_seconds REAL NOT NULL,
            auto_cancel_minutes REAL NOT NULL,
            offer_refresh_interval_minutes REAL NOT NULL,
            price_guard_percent REAL NOT NULL,
            welcome_message TEXT NOT NULL
          );
        `);
        this.db
          .prepare(
            "INSERT INTO schema_migrations(version, applied_at) VALUES (6, ?)",
          )
          .run(Date.now());
      }
      if (this.currentSchemaVersion() < 7) {
        this.ensureColumn(
          "market_config",
          "outgoing_transfer_fee",
          "REAL NOT NULL DEFAULT 0",
        );
        this.db
          .prepare(
            "UPDATE market_config SET outgoing_transfer_fee = 0.08 WHERE code = 'CLASICA' AND outgoing_transfer_fee = 0",
          )
          .run();
        this.db
          .prepare(
            "INSERT INTO schema_migrations(version, applied_at) VALUES (7, ?)",
          )
          .run(Date.now());
      }
      if (this.currentSchemaVersion() < 8) {
        this.ensureColumn(
          "market_config",
          "hunt_buy_enabled",
          "INTEGER NOT NULL DEFAULT 1",
        );
        this.ensureColumn(
          "market_config",
          "hunt_sell_enabled",
          "INTEGER NOT NULL DEFAULT 1",
        );
        this.ensureColumn(
          "operations",
          "reference_rate",
          "REAL",
        );
        this.ensureColumn(
          "bot_config",
          "hunt_buy_running",
          "INTEGER NOT NULL DEFAULT 1",
        );
        this.ensureColumn(
          "bot_config",
          "hunt_sell_running",
          "INTEGER NOT NULL DEFAULT 1",
        );
        this.db.prepare(
          "UPDATE market_config SET hunt_buy_enabled = active, hunt_sell_enabled = active",
        ).run();
        this.db.prepare(
          "INSERT INTO schema_migrations(version, applied_at) VALUES (8, ?)",
        ).run(Date.now());
      }
      if (this.currentSchemaVersion() < 9) {
        this.ensureColumn("trading_alerts", "reference_rate", "REAL");
        this.ensureColumn("trading_alerts", "resolution", "TEXT");
        this.db.prepare(
          "INSERT INTO schema_migrations(version, applied_at) VALUES (9, ?)",
        ).run(Date.now());
      }
      if (this.currentSchemaVersion() < 10) {
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS decision_events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            version TEXT NOT NULL UNIQUE,
            offer_uuid TEXT NOT NULL,
            coin TEXT NOT NULL,
            offer_type TEXT NOT NULL,
            amount REAL NOT NULL,
            receive REAL NOT NULL,
            rate REAL NOT NULL,
            decision TEXT NOT NULL,
            reason TEXT NOT NULL,
            checks_json TEXT NOT NULL,
            reference_rate REAL,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            resolved_at INTEGER,
            resolution TEXT
          );
          CREATE INDEX IF NOT EXISTS idx_decision_events_queue
            ON decision_events(resolved_at, decision, updated_at DESC);
          CREATE INDEX IF NOT EXISTS idx_decision_events_offer
            ON decision_events(offer_uuid, updated_at DESC);
        `);
        this.db.prepare(
          "INSERT INTO schema_migrations(version, applied_at) VALUES (10, ?)",
        ).run(Date.now());
      }
      if (this.currentSchemaVersion() < 11) {
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS notification_events (
            id TEXT PRIMARY KEY,
            kind TEXT NOT NULL,
            message TEXT NOT NULL,
            operation_uuid TEXT,
            payload_json TEXT NOT NULL,
            telegram_delivered_at INTEGER,
            telegram_attempts INTEGER NOT NULL DEFAULT 0,
            telegram_next_attempt_at INTEGER NOT NULL DEFAULT 0,
            telegram_last_error TEXT,
            push_delivered_at INTEGER,
            push_attempts INTEGER NOT NULL DEFAULT 0,
            push_next_attempt_at INTEGER NOT NULL DEFAULT 0,
            push_last_error TEXT,
            acknowledged_at INTEGER,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
          );
          CREATE INDEX IF NOT EXISTS idx_notification_delivery
            ON notification_events(telegram_delivered_at, push_delivered_at,
              telegram_next_attempt_at, push_next_attempt_at);
          CREATE INDEX IF NOT EXISTS idx_notification_unacknowledged
            ON notification_events(acknowledged_at, created_at DESC);
        `);
        const now = Date.now();
        this.db.prepare(
          `UPDATE decision_events
           SET resolved_at = ?, resolution = 'resolved', updated_at = ?
           WHERE resolved_at IS NULL AND lower(reason) LIKE '%vip%'`,
        ).run(now, now);
        this.db.prepare(
          `UPDATE trading_alerts
           SET resolved_at = ?, resolution = 'resolved', updated_at = ?
           WHERE resolved_at IS NULL AND lower(reason) LIKE '%vip%'`,
        ).run(now, now);
        this.db.prepare(
          "INSERT INTO schema_migrations(version, applied_at) VALUES (11, ?)",
        ).run(now);
      }
      if (this.currentSchemaVersion() < 12) {
        this.ensureColumn("market_config", "icon_url", "TEXT");
        this.ensureColumn("market_config", "color", "TEXT");
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS capital_rebalance_jobs (
            id TEXT PRIMARY KEY,
            state TEXT NOT NULL,
            adjustments_json TEXT NOT NULL,
            error TEXT,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
          );
          CREATE INDEX IF NOT EXISTS idx_capital_rebalance_jobs_state
            ON capital_rebalance_jobs(state, updated_at);
        `);
        this.db.prepare(
          "INSERT INTO schema_migrations(version, applied_at) VALUES (12, ?)",
        ).run(Date.now());
      }
      // Conserva las claves usadas por versiones anteriores durante la sustitución incremental.
      if (
        this.get("fiat_balance:BANK_CUP") === undefined &&
        this.get("fiat_balance") !== undefined
      )
        this.set("fiat_balance:BANK_CUP", this.get("fiat_balance")!);
      if (
        this.get("fiat_ledger_started_at:BANK_CUP") === undefined &&
        this.get("fiat_ledger_started_at") !== undefined
      )
        this.set(
          "fiat_ledger_started_at:BANK_CUP",
          this.get("fiat_ledger_started_at")!,
        );
    });
  }

  private ensureColumn(
    table: "operations" | "fiat_ledger" | "market_observations" | "market_config" | "bot_config" | "trading_alerts",
    column: string,
    definition: string,
  ): void {
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as {
      name: string;
    }[];
    if (!columns.some((item) => item.name === column))
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }

  schemaVersion(): number {
    return this.currentSchemaVersion();
  }

  close(): void {
    this.db.close();
  }

  loadTradingConfig(): TradingConfig | undefined {
    const root = this.db
      .prepare(
        "SELECT qusd_reserve, max_open_offers FROM trading_config WHERE id = 1",
      )
      .get() as Record<string, unknown> | undefined;
    if (!root) return undefined;
    const risk = this.db
      .prepare("SELECT * FROM risk_config WHERE id = 1")
      .get() as Record<string, unknown> | undefined;
    const marketRows = this.db
      .prepare(
        "SELECT code, label, currency, icon_url, color, active, hunt_buy_enabled, hunt_sell_enabled, fiat_balance, buy_max_rate, sell_min_rate, purchase_max_qusd, sell_fee_percent, outgoing_transfer_fee FROM market_config ORDER BY rowid",
      )
      .all() as Record<string, unknown>[];
    const details = this.db
      .prepare(
        "SELECT market_code, name, value FROM payment_details ORDER BY market_code, position",
      )
      .all() as Record<string, unknown>[];
    const automation = this.db
      .prepare("SELECT * FROM bot_config WHERE id = 1")
      .get() as Record<string, unknown> | undefined;
    return {
      version: 3,
      qusdReserve: Number(root.qusd_reserve),
      maxOpenOffers: Number(root.max_open_offers),
      hunting: {
        buyRunning: automation ? Boolean(automation.hunt_buy_running) : true,
        sellRunning: automation ? Boolean(automation.hunt_sell_running) : true,
      },
      automation: automation
        ? {
            scanIntervalSeconds: Number(automation.scan_interval_seconds),
            autoCancelMinutes: Number(automation.auto_cancel_minutes),
            offerRefreshIntervalMinutes: Number(
              automation.offer_refresh_interval_minutes,
            ),
            priceGuardPercent: Number(automation.price_guard_percent),
            welcomeMessage: String(automation.welcome_message),
          }
        : {
            scanIntervalSeconds: 15,
            autoCancelMinutes: 10,
            offerRefreshIntervalMinutes: 5,
            priceGuardPercent: 15,
            welcomeMessage:
              "Oferta aplicada por bot. El usuario atenderá y realizará el pago manualmente.",
          },
      risk: risk
        ? {
            maxQusdPerOperation: Number(risk.max_qusd_per_operation),
            maxConcurrentQusdExposure: Number(
              risk.max_concurrent_qusd_exposure,
            ),
            maxDailyAppliedQusd: Number(risk.max_daily_applied_qusd),
            maxConcurrentOperations: Number(risk.max_concurrent_operations),
            minQusdReserve: Number(risk.min_qusd_reserve),
            maxQuoteAgeSeconds: Number(risk.max_quote_age_seconds),
            minExpectedMarginPercent: Number(
              risk.min_expected_margin_percent,
            ),
            maxSlippagePercent: Number(risk.max_slippage_percent),
            maxConsecutiveErrors: Number(risk.max_consecutive_errors),
            marketCooldownSeconds: Number(risk.market_cooldown_seconds),
            counterpartyCooldownSeconds: Number(
              risk.counterparty_cooldown_seconds,
            ),
            reviewedAt:
              risk.reviewed_at === null ? null : Number(risk.reviewed_at),
          }
        : { ...conservativeRiskLimits, reviewedAt: null },
      markets: marketRows.map((row) => ({
        code: String(row.code),
        label: String(row.label),
        currency: String(row.currency),
        ...(row.icon_url === null ? {} : { iconUrl: String(row.icon_url) }),
        ...(row.color === null ? {} : { color: String(row.color) }),
        active: Boolean(row.active),
        huntBuyEnabled: Boolean(row.hunt_buy_enabled),
        huntSellEnabled: Boolean(row.hunt_sell_enabled),
        fiatBalance: Number(row.fiat_balance),
        buyMaxRate: Number(row.buy_max_rate),
        sellMinRate: Number(row.sell_min_rate),
        purchaseMaxQusd: Number(row.purchase_max_qusd),
        sellFeePercent: Number(row.sell_fee_percent),
        outgoingTransferFee: Number(row.outgoing_transfer_fee),
        paymentDetails: details
          .filter((detail) => detail.market_code === row.code)
          .map((detail) => ({
            name: String(detail.name),
            value: String(detail.value),
          })),
      })),
    };
  }

  hasBotConfig(): boolean {
    return Boolean(
      this.db.prepare("SELECT 1 FROM bot_config WHERE id = 1").get(),
    );
  }

  saveTradingConfig(
    config: TradingConfig,
    source = "system",
    reason?: string,
  ): void {
    this.transaction(() => {
      this.db
        .prepare(
          "INSERT INTO trading_config(id, qusd_reserve, max_open_offers) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET qusd_reserve = excluded.qusd_reserve, max_open_offers = excluded.max_open_offers",
        )
        .run(config.qusdReserve, config.maxOpenOffers);
      this.db
        .prepare(
          `INSERT INTO bot_config(
            id, scan_interval_seconds, auto_cancel_minutes,
            offer_refresh_interval_minutes, price_guard_percent, welcome_message,
            hunt_buy_running, hunt_sell_running
          ) VALUES (1, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            scan_interval_seconds = excluded.scan_interval_seconds,
            auto_cancel_minutes = excluded.auto_cancel_minutes,
            offer_refresh_interval_minutes = excluded.offer_refresh_interval_minutes,
            price_guard_percent = excluded.price_guard_percent,
            welcome_message = excluded.welcome_message,
            hunt_buy_running = excluded.hunt_buy_running,
            hunt_sell_running = excluded.hunt_sell_running`,
        )
        .run(
          config.automation.scanIntervalSeconds,
          config.automation.autoCancelMinutes,
          config.automation.offerRefreshIntervalMinutes,
          config.automation.priceGuardPercent,
          config.automation.welcomeMessage,
          Number(config.hunting.buyRunning),
          Number(config.hunting.sellRunning),
        );
      this.db
        .prepare(
          `INSERT INTO risk_config(
            id, max_qusd_per_operation, max_concurrent_qusd_exposure,
            max_daily_applied_qusd, max_concurrent_operations, min_qusd_reserve,
            max_quote_age_seconds, min_expected_margin_percent,
            max_slippage_percent, max_consecutive_errors,
            market_cooldown_seconds, counterparty_cooldown_seconds, reviewed_at
          ) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            max_qusd_per_operation = excluded.max_qusd_per_operation,
            max_concurrent_qusd_exposure = excluded.max_concurrent_qusd_exposure,
            max_daily_applied_qusd = excluded.max_daily_applied_qusd,
            max_concurrent_operations = excluded.max_concurrent_operations,
            min_qusd_reserve = excluded.min_qusd_reserve,
            max_quote_age_seconds = excluded.max_quote_age_seconds,
            min_expected_margin_percent = excluded.min_expected_margin_percent,
            max_slippage_percent = excluded.max_slippage_percent,
            max_consecutive_errors = excluded.max_consecutive_errors,
            market_cooldown_seconds = excluded.market_cooldown_seconds,
            counterparty_cooldown_seconds = excluded.counterparty_cooldown_seconds,
            reviewed_at = excluded.reviewed_at`,
        )
        .run(
          config.risk.maxQusdPerOperation,
          config.risk.maxConcurrentQusdExposure,
          config.risk.maxDailyAppliedQusd,
          config.risk.maxConcurrentOperations,
          config.risk.minQusdReserve,
          config.risk.maxQuoteAgeSeconds,
          config.risk.minExpectedMarginPercent,
          config.risk.maxSlippagePercent,
          config.risk.maxConsecutiveErrors,
          config.risk.marketCooldownSeconds,
          config.risk.counterpartyCooldownSeconds,
          config.risk.reviewedAt,
        );
      this.db.prepare("DELETE FROM payment_details").run();
      this.db.prepare("DELETE FROM fiat_accounts").run();
      this.db.prepare("DELETE FROM market_config").run();
      const insertMarket = this.db.prepare(
        "INSERT INTO market_config(code, label, currency, icon_url, color, active, hunt_buy_enabled, hunt_sell_enabled, fiat_balance, buy_max_rate, sell_min_rate, purchase_max_qusd, sell_fee_percent, outgoing_transfer_fee) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      );
      const insertDetail = this.db.prepare(
        "INSERT INTO payment_details(market_code, position, name, value) VALUES (?, ?, ?, ?)",
      );
      const insertAccount = this.db.prepare(
        "INSERT INTO fiat_accounts(market_code, declared_balance, updated_at) VALUES (?, ?, ?)",
      );
      for (const market of config.markets) {
        const balance = market.fiatBalance;
        insertMarket.run(
          market.code,
          market.label,
          market.currency,
          market.iconUrl ?? null,
          market.color ?? null,
          Number(market.active),
          Number(market.huntBuyEnabled),
          Number(market.huntSellEnabled),
          balance,
          market.buyMaxRate,
          market.sellMinRate,
          market.purchaseMaxQusd,
          market.sellFeePercent,
          market.outgoingTransferFee,
        );
        insertAccount.run(market.code, balance, Date.now());
        this.set(`fiat_balance:${market.code}`, String(balance));
        market.paymentDetails.forEach((detail, position) =>
          insertDetail.run(market.code, position, detail.name, detail.value),
        );
      }
      this.recordConfigRevision(config, source, reason);
    });
  }

  configRevisionHistory(limit = 20): ConfigRevision[] {
    return (
      this.db
        .prepare(
          "SELECT id, created_at, source, reason, config_json, previous_hash, hash FROM config_revisions ORDER BY id DESC LIMIT ?",
        )
        .all(limit) as Record<string, unknown>[]
    ).map((row) => ({
      id: Number(row.id),
      createdAt: Number(row.created_at),
      source: String(row.source),
      reason: row.reason === null ? null : String(row.reason),
      config: JSON.parse(String(row.config_json)) as TradingConfig,
      previousHash:
        row.previous_hash === null ? null : String(row.previous_hash),
      hash: String(row.hash),
    }));
  }

  verifyConfigRevisionChain(): boolean {
    const revisions = this.db
      .prepare(
        "SELECT created_at, source, reason, config_json, previous_hash, hash FROM config_revisions ORDER BY id ASC",
      )
      .all() as Record<string, unknown>[];
    let previousHash: string | null = null;
    for (const revision of revisions) {
      if (revision.previous_hash !== previousHash) return false;
      const hash = configRevisionHash(
        previousHash,
        Number(revision.created_at),
        String(revision.source),
        revision.reason === null ? null : String(revision.reason),
        String(revision.config_json),
      );
      if (hash !== revision.hash) return false;
      previousHash = hash;
    }
    return true;
  }

  private recordConfigRevision(
    config: TradingConfig,
    source: string,
    reason?: string,
  ): void {
    const previous = this.db
      .prepare("SELECT hash FROM config_revisions ORDER BY id DESC LIMIT 1")
      .get() as { hash?: string } | undefined;
    const previousHash = previous?.hash ?? null;
    const createdAt = Date.now();
    const configJson = JSON.stringify(config);
    const normalizedReason = reason?.trim() || null;
    const hash = configRevisionHash(
      previousHash,
      createdAt,
      source,
      normalizedReason,
      configJson,
    );
    this.db
      .prepare(
        "INSERT INTO config_revisions(created_at, source, reason, config_json, previous_hash, hash) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(
        createdAt,
        source,
        normalizedReason,
        configJson,
        previousHash,
        hash,
      );
  }

  createMutationIntent(
    intent: Omit<MutationIntent, "state" | "createdAt" | "updatedAt">,
  ): void {
    const now = Date.now();
    this.db
      .prepare(
        "INSERT INTO mutation_intents(intent_id, operation_uuid, kind, idempotency_key, state, request_json, created_at, updated_at) VALUES (?, ?, ?, ?, 'submitted', ?, ?, ?)",
      )
      .run(
        intent.intentId,
        intent.operationUuid ?? null,
        intent.kind,
        intent.idempotencyKey ?? null,
        JSON.stringify(intent.request),
        now,
        now,
      );
  }

  updateMutationIntent(
    intentId: string,
    state: MutationIntent["state"],
    response?: unknown,
    error?: string,
  ): void {
    this.db
      .prepare(
        "UPDATE mutation_intents SET state = ?, response_json = ?, error = ?, updated_at = ? WHERE intent_id = ?",
      )
      .run(
        state,
        response === undefined ? null : JSON.stringify(response),
        error ?? null,
        Date.now(),
        intentId,
      );
  }

  recentMutationIntents(limit = 20): MutationIntent[] {
    return (
      this.db
        .prepare(
          "SELECT intent_id, operation_uuid, kind, idempotency_key, state, request_json, response_json, error, created_at, updated_at FROM mutation_intents ORDER BY created_at DESC LIMIT ?",
        )
        .all(limit) as Record<string, unknown>[]
    ).map((row) => ({
      intentId: String(row.intent_id),
      ...(row.operation_uuid === null
        ? {}
        : { operationUuid: String(row.operation_uuid) }),
      kind: String(row.kind),
      ...(row.idempotency_key === null
        ? {}
        : { idempotencyKey: String(row.idempotency_key) }),
      state: String(row.state) as MutationIntent["state"],
      request: JSON.parse(String(row.request_json)),
      ...(row.response_json === null
        ? {}
        : { response: JSON.parse(String(row.response_json)) }),
      ...(row.error === null ? {} : { error: String(row.error) }),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    }));
  }

  hasUnresolvedMutation(): boolean {
    return Boolean(
      this.db
        .prepare(
          "SELECT 1 FROM mutation_intents WHERE state IN ('submitted', 'uncertain') LIMIT 1",
        )
        .get(),
    );
  }

  createTradeWorkflow(
    workflow: Pick<TradeWorkflow, "id" | "targetOffer" | "riskDecision">,
    ownOffers: Array<RestorableOwnOffer | PlannedOwnOffer>,
  ): void {
    this.transaction(() => {
      const now = Date.now();
      this.db
        .prepare(
          `INSERT INTO trade_workflows(
            id, target_offer_uuid, target_json, risk_decision_json,
            state, created_at, updated_at
          ) VALUES (?, ?, ?, ?, 'planned', ?, ?)`,
        )
        .run(
          workflow.id,
          workflow.targetOffer.uuid,
          JSON.stringify(workflow.targetOffer),
          JSON.stringify(workflow.riskDecision),
          now,
          now,
        );
      const insertOwn = this.db.prepare(
        `INSERT INTO workflow_own_offers(
          workflow_id, original_uuid, snapshot_json, state,
          restore_idempotency_key
        ) VALUES (?, ?, ?, 'planned', ?)`,
      );
      for (const offer of ownOffers)
        insertOwn.run(
          workflow.id,
          offer.uuid,
          JSON.stringify(offer),
          restoreIdempotencyKey(workflow.id, offer.uuid),
        );
    });
  }

  getTradeWorkflow(id: string): TradeWorkflow | undefined {
    const row = this.db
      .prepare(
        "SELECT id, target_json, risk_decision_json, state, error, created_at, updated_at FROM trade_workflows WHERE id = ?",
      )
      .get(id) as Record<string, unknown> | undefined;
    return row ? workflowFromRow(row) : undefined;
  }

  findWorkflowByTarget(targetOfferUuid: string): TradeWorkflow | undefined {
    const row = this.db
      .prepare(
        "SELECT id, target_json, risk_decision_json, state, error, created_at, updated_at FROM trade_workflows WHERE target_offer_uuid = ?",
      )
      .get(targetOfferUuid) as Record<string, unknown> | undefined;
    return row ? workflowFromRow(row) : undefined;
  }

  recoverableWorkflows(): TradeWorkflow[] {
    return (
      this.db
        .prepare(
          `SELECT id, target_json, risk_decision_json, state, error, created_at, updated_at
           FROM trade_workflows
           WHERE state NOT IN ('applied', 'restored', 'blocked')
           ORDER BY created_at ASC`,
        )
        .all() as Record<string, unknown>[]
    ).map(workflowFromRow);
  }

  tradeWorkflows(limit = 100): TradeWorkflow[] {
    return (
      this.db
        .prepare(
          `SELECT id, target_json, risk_decision_json, state, error, created_at, updated_at
           FROM trade_workflows ORDER BY created_at DESC LIMIT ?`,
        )
        .all(limit) as Record<string, unknown>[]
    ).map(workflowFromRow);
  }

  updateWorkflowState(
    id: string,
    state: WorkflowState,
    error?: string,
  ): void {
    this.db
      .prepare(
        "UPDATE trade_workflows SET state = ?, error = ?, updated_at = ? WHERE id = ?",
      )
      .run(state, error ?? null, Date.now(), id);
  }

  workflowOwnOffers(workflowId: string): WorkflowOwnOffer[] {
    return (
      this.db
        .prepare(
          `SELECT workflow_id, original_uuid, snapshot_json, state,
                  restore_idempotency_key, restored_uuid, error
           FROM workflow_own_offers WHERE workflow_id = ? ORDER BY rowid`,
        )
        .all(workflowId) as Record<string, unknown>[]
    ).map((row) => ({
      workflowId: String(row.workflow_id),
      originalUuid: String(row.original_uuid),
      snapshot: JSON.parse(String(row.snapshot_json)) as PlannedOwnOffer,
      state: String(row.state) as WorkflowOwnOffer["state"],
      restoreIdempotencyKey: String(row.restore_idempotency_key),
      restoredUuid:
        row.restored_uuid === null ? null : String(row.restored_uuid),
      error: row.error === null ? null : String(row.error),
    }));
  }

  updateWorkflowOwnOffer(
    workflowId: string,
    originalUuid: string,
    state: WorkflowOwnOffer["state"],
    options: { restoredUuid?: string; error?: string } = {},
  ): void {
    this.db
      .prepare(
        `UPDATE workflow_own_offers
         SET state = ?, restored_uuid = COALESCE(?, restored_uuid), error = ?
         WHERE workflow_id = ? AND original_uuid = ?`,
      )
      .run(
        state,
        options.restoredUuid ?? null,
        options.error ?? null,
        workflowId,
        originalUuid,
      );
  }

  reserveQusd(
    workflowId: string,
    market: FiatMarket,
    amount: number,
    maximumTotal: number,
  ): boolean {
    if (!Number.isFinite(amount) || amount <= 0)
      throw new Error("La reserva QUSD debe ser positiva.");
    return this.transaction(() => {
      const current = this.activeReservedQusd();
      if (current + amount > maximumTotal + 0.0000001) return false;
      const inserted = this.db
        .prepare(
          `INSERT INTO capital_reservations(
            workflow_id, asset, market_code, amount, state, created_at
          ) VALUES (?, 'QUSD', ?, ?, 'active', ?)
          ON CONFLICT(workflow_id) DO NOTHING`,
        )
        .run(workflowId, market, amount, Date.now());
      return inserted.changes > 0;
    });
  }

  activeReservedQusd(): number {
    const row = this.db
      .prepare(
        "SELECT COALESCE(SUM(amount), 0) AS total FROM capital_reservations WHERE asset = 'QUSD' AND state = 'active'",
      )
      .get() as { total: number };
    return Number(row.total);
  }

  releaseCapitalReservation(workflowId: string): void {
    this.db
      .prepare(
        "UPDATE capital_reservations SET state = 'released', released_at = ? WHERE workflow_id = ? AND state = 'active'",
      )
      .run(Date.now(), workflowId);
  }

  capitalReservations(limit = 100): CapitalReservation[] {
    return (
      this.db
        .prepare(
          `SELECT workflow_id, market_code, amount, state, created_at, released_at
           FROM capital_reservations ORDER BY created_at DESC LIMIT ?`,
        )
        .all(limit) as Record<string, unknown>[]
    ).map((row) => ({
      workflowId: String(row.workflow_id),
      market: String(row.market_code),
      amount: Number(row.amount),
      state: String(row.state) as CapitalReservation["state"],
      createdAt: Number(row.created_at),
      releasedAt:
        row.released_at === null ? null : Number(row.released_at),
    }));
  }

  reconcileWorkflowMutationIntents(workflowId: string): number {
    return Number(
      this.db
        .prepare(
          `UPDATE mutation_intents
           SET state = 'reconciled', updated_at = ?
           WHERE state IN ('submitted', 'uncertain')
             AND json_extract(request_json, '$.workflowId') = ?`,
        )
        .run(Date.now(), workflowId).changes,
    );
  }

  dailyAppliedQusd(since: number): number {
    const row = this.db
      .prepare(
        "SELECT COALESCE(SUM(amount), 0) AS total FROM operations WHERE created_at >= ?",
      )
      .get(since) as { total: number };
    return Number(row.total);
  }

  lastOperationAt(
    market: FiatMarket,
    counterpartyId?: string,
  ): number | undefined {
    const row = counterpartyId
      ? this.db
          .prepare(
            "SELECT MAX(created_at) AS created_at FROM operations WHERE coin = ? AND counterparty_id = ?",
          )
          .get(market, counterpartyId)
      : this.db
          .prepare(
            "SELECT MAX(created_at) AS created_at FROM operations WHERE coin = ?",
          )
          .get(market);
    const value = (row as { created_at: number | null }).created_at;
    return value === null ? undefined : Number(value);
  }

  private currentSchemaVersion(): number {
    const table = this.db
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'",
      )
      .get();
    if (!table) return 0;
    return Number(
      (
        this.db
          .prepare(
            "SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations",
          )
          .get() as { version: number }
      ).version,
    );
  }

  private backupBeforeMigration(dataDir: string): void {
    this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    const backupDir = join(dataDir, "backups");
    mkdirSync(backupDir, { recursive: true, mode: 0o700 });
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    copyFileSync(
      this.dbPath,
      join(
        backupDir,
        `qvaapply-before-v${LATEST_SCHEMA_VERSION}-${timestamp}.sqlite`,
      ),
    );
  }

  private transaction<T>(action: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = action();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  get(key: string): string | undefined {
    return (
      this.db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as
        | { value?: string }
        | undefined
    )?.value;
  }

  set(key: string, value: string): void {
    this.db
      .prepare(
        "INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      )
      .run(key, value);
  }

  saveRemoteResource<T>(key: string, data: T, updatedAt = Date.now()): void {
    if (!/^[a-z0-9:_-]{1,100}$/i.test(key))
      throw new Error("Clave de recurso remoto inválida.");
    this.db
      .prepare(
        `INSERT INTO remote_resource_cache(resource_key, payload_json, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(resource_key) DO UPDATE SET
           payload_json = excluded.payload_json,
           updated_at = excluded.updated_at`,
      )
      .run(key, JSON.stringify(data), updatedAt);
  }

  loadRemoteResource<T>(key: string): CachedRemoteResource<T> | undefined {
    const row = this.db
      .prepare(
        "SELECT resource_key, payload_json, updated_at FROM remote_resource_cache WHERE resource_key = ?",
      )
      .get(key) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    try {
      return {
        key: String(row.resource_key),
        data: JSON.parse(String(row.payload_json)) as T,
        updatedAt: Number(row.updated_at),
      };
    } catch {
      // Una entrada corrupta no debe impedir abrir el panel local.
      return undefined;
    }
  }

  recordFiatMovement(
    uuid: string,
    coin: FiatMarket,
    direction: "debit" | "credit",
    amount: number,
    source: string,
  ): boolean {
    if (!Number.isFinite(amount) || amount <= 0)
      throw new Error("El movimiento fiat debe tener un importe positivo.");
    return this.transaction(() => {
      const inserted = this.db
        .prepare(
          "INSERT OR IGNORE INTO fiat_ledger(operation_uuid, direction, amount, source, created_at, coin) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .run(uuid, direction, amount, source, Date.now(), coin);
      if (!inserted.changes) return false;
      const current = Number(this.get(`fiat_balance:${coin}`) ?? 0);
      const next = direction === "credit" ? current + amount : current - amount;
      this.set(`fiat_balance:${coin}`, String(next));
      this.db
        .prepare("UPDATE market_config SET fiat_balance = ? WHERE code = ?")
        .run(next, coin);
      this.db
        .prepare(
          "UPDATE fiat_accounts SET declared_balance = ?, updated_at = ? WHERE market_code = ?",
        )
        .run(next, Date.now(), coin);
      this.audit(
        "fiat_ledger",
        `${direction === "credit" ? "+" : "-"}${amount} ${coin} (${source})`,
        uuid,
      );
      return true;
    });
  }

  recentFiat(
    coin: FiatMarket,
    limit = 5,
  ): { uuid: string; direction: string; amount: number; createdAt: number }[] {
    return (
      this.db
        .prepare(
          "SELECT operation_uuid, direction, amount, created_at FROM fiat_ledger WHERE coin = ? ORDER BY id DESC LIMIT ?",
        )
        .all(coin, limit) as Record<string, unknown>[]
    ).map((row) => ({
      uuid: String(row.operation_uuid),
      direction: String(row.direction),
      amount: Number(row.amount),
      createdAt: Number(row.created_at),
    }));
  }

  isSeen(uuid: string): boolean {
    return Boolean(
      this.db.prepare("SELECT 1 FROM seen_offers WHERE uuid = ?").get(uuid),
    );
  }
  markSeen(uuid: string): void {
    this.db
      .prepare("INSERT OR IGNORE INTO seen_offers(uuid, seen_at) VALUES (?, ?)")
      .run(uuid, Date.now());
  }

  createOperation(operation: Operation): void {
    this.db
      .prepare(
        `INSERT INTO operations(uuid, offer_type, coin, amount, receive, rate, state, auto_applied, cancel_at, created_at, updated_at, counterparty_id, reference_rate)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(uuid) DO NOTHING`,
      )
      .run(
        operation.uuid,
        operation.offerType,
        operation.coin,
        operation.amount,
        operation.receive,
        operation.rate,
        operation.state,
        Number(operation.autoApplied),
        operation.cancelAt,
        operation.createdAt,
        operation.createdAt,
        operation.counterpartyId ?? null,
        operation.referenceRate ?? null,
      );
  }

  getOperation(uuid: string): Operation | undefined {
    const row = this.db
      .prepare(
        "SELECT uuid, offer_type, coin, amount, receive, rate, state, auto_applied, cancel_at, created_at, counterparty_id, reference_rate FROM operations WHERE uuid = ?",
      )
      .get(uuid) as Record<string, unknown> | undefined;
    return row ? this.operationFromRow(row) : undefined;
  }

  pendingCancellations(now: number): Operation[] {
    return (
      this.db
        .prepare(
          "SELECT uuid, offer_type, coin, amount, receive, rate, state, auto_applied, cancel_at, created_at, counterparty_id, reference_rate FROM operations WHERE state = 'applied' AND cancel_at <= ?",
        )
        .all(now) as Record<string, unknown>[]
    ).map((row) => this.operationFromRow(row));
  }

  activeOperations(): Operation[] {
    return (
      this.db
        .prepare(
          "SELECT uuid, offer_type, coin, amount, receive, rate, state, auto_applied, cancel_at, created_at, counterparty_id, reference_rate FROM operations WHERE state IN ('applied','acknowledged','paid','revision') ORDER BY created_at DESC",
        )
        .all() as Record<string, unknown>[]
    ).map((row) => this.operationFromRow(row));
  }

  operations(limit = 100): Operation[] {
    return (
      this.db
        .prepare(
          `SELECT uuid, offer_type, coin, amount, receive, rate, state,
                  auto_applied, cancel_at, created_at, counterparty_id, reference_rate
           FROM operations ORDER BY created_at DESC LIMIT ?`,
        )
        .all(limit) as Record<string, unknown>[]
    ).map((row) => this.operationFromRow(row));
  }

  visibleOperations(limit = 100): Operation[] {
    return (
      this.db
        .prepare(
          `SELECT uuid, offer_type, coin, amount, receive, rate, state,
                  auto_applied, cancel_at, created_at, counterparty_id, reference_rate
           FROM operations WHERE state IN ('applied','acknowledged','paid','revision')
           ORDER BY created_at DESC LIMIT ?`,
        )
        .all(limit) as Record<string, unknown>[]
    ).map((row) => this.operationFromRow(row));
  }

  updateOperation(
    uuid: string,
    state: OperationState,
    cancelAt: number | null = null,
  ): void {
    this.db
      .prepare(
        "UPDATE operations SET state = ?, cancel_at = ?, updated_at = ? WHERE uuid = ?",
      )
      .run(state, cancelAt, Date.now(), uuid);
  }

  audit(action: string, detail: string, uuid?: string): void {
    this.db
      .prepare(
        "INSERT INTO audit_log(created_at, action, offer_uuid, detail) VALUES (?, ?, ?, ?)",
      )
      .run(Date.now(), action, uuid ?? null, detail);
  }

  recentAudit(
    limit = 10,
  ): {
    createdAt: number;
    action: string;
    uuid: string | null;
    detail: string;
  }[] {
    return (
      this.db
        .prepare(
          "SELECT created_at, action, offer_uuid, detail FROM audit_log ORDER BY id DESC LIMIT ?",
        )
        .all(limit) as Record<string, unknown>[]
    ).map((row) => ({
      createdAt: Number(row.created_at),
      action: String(row.action),
      uuid: row.offer_uuid === null ? null : String(row.offer_uuid),
      detail: String(row.detail),
    }));
  }

  syncTradingAlerts(
    alerts: Omit<TradingAlert, "createdAt" | "updatedAt" | "resolvedAt">[],
    offerTypes?: P2pType[],
  ): void {
    const now = Date.now();
    if (offerTypes?.length) {
      const placeholders = offerTypes.map(() => "?").join(", ");
      this.db
        .prepare(
          `UPDATE trading_alerts SET resolved_at = ? WHERE resolved_at IS NULL AND offer_type IN (${placeholders})`,
        )
        .run(now, ...offerTypes);
    } else {
      this.db
        .prepare(
          "UPDATE trading_alerts SET resolved_at = ? WHERE resolved_at IS NULL",
        )
        .run(now);
    }
    const upsert = this.db
      .prepare(`INSERT INTO trading_alerts(offer_uuid, coin, offer_type, amount, receive, rate, decision, reason, reference_rate, created_at, updated_at, resolved_at, resolution)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)
      ON CONFLICT(offer_uuid) DO UPDATE SET
        coin = excluded.coin, offer_type = excluded.offer_type, amount = excluded.amount,
        receive = excluded.receive, rate = excluded.rate, decision = excluded.decision,
        reason = excluded.reason, reference_rate = excluded.reference_rate,
        updated_at = excluded.updated_at,
        resolved_at = CASE
          WHEN trading_alerts.resolution = 'dismissed'
            AND trading_alerts.rate = excluded.rate
            AND trading_alerts.reason = excluded.reason
          THEN trading_alerts.resolved_at ELSE NULL END,
        resolution = CASE
          WHEN trading_alerts.resolution = 'dismissed'
            AND trading_alerts.rate = excluded.rate
            AND trading_alerts.reason = excluded.reason
          THEN trading_alerts.resolution ELSE NULL END`);
    for (const alert of alerts)
      upsert.run(
        alert.uuid,
        alert.coin,
        alert.offerType,
        alert.amount,
        alert.receive,
        alert.rate,
        alert.decision,
        alert.reason,
        alert.referenceRate ?? null,
        now,
        now,
      );
  }

  upsertTradingAlert(
    alert: Omit<TradingAlert, "createdAt" | "updatedAt" | "resolvedAt">,
  ): void {
    const now = Date.now();
    this.db.prepare(`INSERT INTO trading_alerts(offer_uuid, coin, offer_type, amount, receive, rate, decision, reason, reference_rate, created_at, updated_at, resolved_at, resolution)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)
      ON CONFLICT(offer_uuid) DO UPDATE SET
        coin = excluded.coin, offer_type = excluded.offer_type, amount = excluded.amount,
        receive = excluded.receive, rate = excluded.rate, decision = excluded.decision,
        reason = excluded.reason, reference_rate = excluded.reference_rate,
        updated_at = excluded.updated_at,
        resolved_at = CASE
          WHEN trading_alerts.resolution = 'dismissed' AND trading_alerts.rate = excluded.rate
            AND trading_alerts.reason = excluded.reason THEN trading_alerts.resolved_at ELSE NULL END,
        resolution = CASE
          WHEN trading_alerts.resolution = 'dismissed' AND trading_alerts.rate = excluded.rate
            AND trading_alerts.reason = excluded.reason THEN trading_alerts.resolution ELSE NULL END`).run(
      alert.uuid, alert.coin, alert.offerType, alert.amount, alert.receive, alert.rate,
      alert.decision, alert.reason, alert.referenceRate ?? null, now, now,
    );
  }

  tradingAlert(uuid: string): TradingAlert | undefined {
    return this.readTradingAlert(
      this.db.prepare(
        "SELECT offer_uuid, coin, offer_type, amount, receive, rate, decision, reason, reference_rate, created_at, updated_at, resolved_at, resolution FROM trading_alerts WHERE offer_uuid = ?",
      ).get(uuid) as Record<string, unknown> | undefined,
    );
  }

  resolveTradingAlert(
    uuid: string,
    resolution: NonNullable<TradingAlert["resolution"]>,
  ): boolean {
    const result = this.db.prepare(
      "UPDATE trading_alerts SET resolved_at = ?, resolution = ?, updated_at = ? WHERE offer_uuid = ? AND resolved_at IS NULL",
    ).run(Date.now(), resolution, Date.now(), uuid);
    return result.changes > 0;
  }

  recentTradingAlerts(limit = 12): TradingAlert[] {
    return (
      this.db
        .prepare(
          "SELECT offer_uuid, coin, offer_type, amount, receive, rate, decision, reason, reference_rate, created_at, updated_at, resolved_at, resolution FROM trading_alerts ORDER BY resolved_at IS NULL DESC, updated_at DESC LIMIT ?",
        )
        .all(limit) as Record<string, unknown>[]
    ).map((row) => this.readTradingAlert(row)!);
  }

  recordDecisionEvent(input: {
    uuid: string;
    coin: FiatMarket;
    offerType: P2pType;
    amount: number;
    receive: number;
    rate: number;
    decision: DecisionEvent["decision"];
    reason: string;
    checks?: RiskDecision["checks"];
    referenceRate?: number;
  }): DecisionEvent {
    const checks = input.checks ?? [];
    const version = createHash("sha256")
      .update(JSON.stringify({
        uuid: input.uuid,
        rate: input.rate,
        decision: input.decision,
        reason: input.reason,
      }))
      .digest("hex");
    const now = Date.now();
    this.db.prepare(
      "UPDATE decision_events SET resolved_at = ?, resolution = 'resolved', updated_at = ? WHERE offer_uuid = ? AND version <> ? AND resolved_at IS NULL",
    ).run(now, now, input.uuid, version);
    this.db.prepare(`INSERT INTO decision_events(
      version, offer_uuid, coin, offer_type, amount, receive, rate, decision,
      reason, checks_json, reference_rate, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(version) DO UPDATE SET
      amount = excluded.amount, receive = excluded.receive,
      checks_json = excluded.checks_json, reference_rate = excluded.reference_rate,
      updated_at = excluded.updated_at`).run(
      version, input.uuid, input.coin, input.offerType, input.amount, input.receive,
      input.rate, input.decision, input.reason, JSON.stringify(checks),
      input.referenceRate ?? null, now, now,
    );
    const row = this.db.prepare(
      "SELECT * FROM decision_events WHERE version = ?",
    ).get(version) as Record<string, unknown>;
    return this.readDecisionEvent(row);
  }

  decisionEvents(options: {
    decision?: DecisionEvent["decision"];
    status?: "pending" | "resolved" | "all";
    page?: number;
    pageSize?: number;
  } = {}): DecisionEventPage {
    const page = Math.max(1, Math.trunc(options.page ?? 1));
    const pageSize = Math.min(100, Math.max(1, Math.trunc(options.pageSize ?? 20)));
    const conditions: string[] = [];
    const parameters: Array<string | number> = [];
    if (options.decision) {
      conditions.push("decision = ?");
      parameters.push(options.decision);
    }
    const pendingConditions = [
      ...conditions,
      "decision IN ('blocked', 'manual_review')",
      "resolved_at IS NULL",
    ];
    const pendingParameters = [...parameters];
    if (options.status === "pending") conditions.push("resolved_at IS NULL");
    if (options.status === "resolved") conditions.push("resolved_at IS NOT NULL");
    const where = conditions.length ? ` WHERE ${conditions.join(" AND ")}` : "";
    const total = Number((this.db.prepare(
      `SELECT COUNT(*) AS count FROM decision_events${where}`,
    ).get(...parameters) as { count: number }).count);
    const pending = Number((this.db.prepare(
      `SELECT COUNT(*) AS count FROM decision_events WHERE ${pendingConditions.join(" AND ")}`,
    ).get(...pendingParameters) as { count: number }).count);
    const rows = this.db.prepare(
      `SELECT * FROM decision_events${where}
       ORDER BY resolved_at IS NULL DESC, updated_at DESC, id DESC LIMIT ? OFFSET ?`,
    ).all(...parameters, pageSize, (page - 1) * pageSize) as Record<string, unknown>[];
    return { items: rows.map((row) => this.readDecisionEvent(row)), total, pending, page, pageSize };
  }

  decisionEvent(id: number): DecisionEvent | undefined {
    const row = this.db.prepare("SELECT * FROM decision_events WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return row ? this.readDecisionEvent(row) : undefined;
  }

  enqueueNotification(input: {
    id: string;
    kind: NotificationKind;
    message: string;
    operationUuid?: string;
    payload: Record<string, unknown>;
    createdAt?: number;
  }): DurableNotification {
    const now = input.createdAt ?? Date.now();
    this.db.prepare(
      `INSERT INTO notification_events(
        id, kind, message, operation_uuid, payload_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO NOTHING`,
    ).run(
      input.id,
      input.kind,
      input.message,
      input.operationUuid ?? null,
      JSON.stringify(input.payload),
      now,
      now,
    );
    const row = this.db.prepare(
      "SELECT * FROM notification_events WHERE id = ?",
    ).get(input.id) as Record<string, unknown>;
    return notificationFromRow(row);
  }

  pendingNotificationDeliveries(
    now = Date.now(),
    limit = 50,
  ): DurableNotification[] {
    return (
      this.db.prepare(
        `SELECT * FROM notification_events
         WHERE (telegram_delivered_at IS NULL AND telegram_next_attempt_at <= ?)
            OR (push_delivered_at IS NULL AND push_next_attempt_at <= ?)
         ORDER BY created_at ASC LIMIT ?`,
      ).all(now, now, limit) as Record<string, unknown>[]
    ).map(notificationFromRow);
  }

  markNotificationDelivered(
    id: string,
    channel: "telegram" | "push",
    deliveredAt = Date.now(),
  ): void {
    const prefix = channel === "telegram" ? "telegram" : "push";
    this.db.prepare(
      `UPDATE notification_events
       SET ${prefix}_delivered_at = ?, ${prefix}_last_error = NULL, updated_at = ?
       WHERE id = ?`,
    ).run(deliveredAt, deliveredAt, id);
  }

  markNotificationFailed(
    id: string,
    channel: "telegram" | "push",
    error: string,
    nextAttemptAt: number,
  ): void {
    const prefix = channel === "telegram" ? "telegram" : "push";
    this.db.prepare(
      `UPDATE notification_events
       SET ${prefix}_attempts = ${prefix}_attempts + 1,
           ${prefix}_next_attempt_at = ?, ${prefix}_last_error = ?, updated_at = ?
       WHERE id = ?`,
    ).run(nextAttemptAt, error, Date.now(), id);
  }

  pendingUserNotifications(limit = 20): DurableNotification[] {
    return (
      this.db.prepare(
        `SELECT * FROM notification_events
         WHERE acknowledged_at IS NULL
           AND kind IN ('operation-applied', 'reconciliation-required', 'rebalance-completed', 'rebalance-attention')
         ORDER BY created_at DESC LIMIT ?`,
      ).all(limit) as Record<string, unknown>[]
    ).map(notificationFromRow);
  }

  acknowledgeNotification(id: string): boolean {
    const now = Date.now();
    return this.db.prepare(
      `UPDATE notification_events SET acknowledged_at = ?, updated_at = ?
       WHERE id = ? AND acknowledged_at IS NULL`,
    ).run(now, now, id).changes > 0;
  }

  createRebalanceJob(
    id: string,
    adjustments: RebalanceJobAdjustment[],
    createdAt = Date.now(),
  ): RebalanceJob {
    this.db.prepare(
      `INSERT INTO capital_rebalance_jobs(
        id, state, adjustments_json, created_at, updated_at
      ) VALUES (?, 'pending', ?, ?, ?)`,
    ).run(id, JSON.stringify(adjustments), createdAt, createdAt);
    return this.rebalanceJob(id)!;
  }

  rebalanceJob(id: string): RebalanceJob | undefined {
    const row = this.db.prepare(
      "SELECT * FROM capital_rebalance_jobs WHERE id = ?",
    ).get(id) as Record<string, unknown> | undefined;
    return row ? rebalanceJobFromRow(row) : undefined;
  }

  pendingRebalanceJobs(limit = 10): RebalanceJob[] {
    return (
      this.db.prepare(
        `SELECT * FROM capital_rebalance_jobs
         WHERE state IN ('pending', 'applying', 'reconciliation_required')
         ORDER BY created_at ASC LIMIT ?`,
      ).all(limit) as Record<string, unknown>[]
    ).map(rebalanceJobFromRow);
  }

  updateRebalanceJob(
    id: string,
    state: RebalanceJobState,
    adjustments: RebalanceJobAdjustment[],
    error?: string,
  ): void {
    this.db.prepare(
      `UPDATE capital_rebalance_jobs
       SET state = ?, adjustments_json = ?, error = ?, updated_at = ?
       WHERE id = ?`,
    ).run(state, JSON.stringify(adjustments), error ?? null, Date.now(), id);
  }

  resolveDecisionEvent(
    id: number,
    resolution: NonNullable<DecisionEvent["resolution"]>,
  ): boolean {
    const now = Date.now();
    return this.db.prepare(
      "UPDATE decision_events SET resolved_at = ?, resolution = ?, updated_at = ? WHERE id = ? AND resolved_at IS NULL",
    ).run(now, resolution, now, id).changes > 0;
  }

  resolveDecisionEventsForOffer(
    uuid: string,
    resolution: NonNullable<DecisionEvent["resolution"]>,
  ): number {
    const now = Date.now();
    return Number(this.db.prepare(
      "UPDATE decision_events SET resolved_at = ?, resolution = ?, updated_at = ? WHERE offer_uuid = ? AND decision = 'blocked' AND resolved_at IS NULL",
    ).run(now, resolution, now, uuid).changes);
  }

  private readDecisionEvent(row: Record<string, unknown>): DecisionEvent {
    let checks: RiskDecision["checks"] = [];
    try {
      const parsed = JSON.parse(String(row.checks_json));
      if (Array.isArray(parsed)) checks = parsed as RiskDecision["checks"];
    } catch { /* una explicación corrupta no debe ocultar el evento */ }
    return {
      id: Number(row.id), version: String(row.version), uuid: String(row.offer_uuid),
      coin: String(row.coin), offerType: String(row.offer_type) as P2pType,
      amount: Number(row.amount), receive: Number(row.receive), rate: Number(row.rate),
      decision: String(row.decision) as DecisionEvent["decision"],
      reason: String(row.reason), checks,
      ...(row.reference_rate === null ? {} : { referenceRate: Number(row.reference_rate) }),
      ...(row.resolution === null ? {} : { resolution: String(row.resolution) as NonNullable<DecisionEvent["resolution"]> }),
      createdAt: Number(row.created_at), updatedAt: Number(row.updated_at),
      resolvedAt: row.resolved_at === null ? null : Number(row.resolved_at),
    };
  }

  private readTradingAlert(row?: Record<string, unknown>): TradingAlert | undefined {
    if (!row) return undefined;
    return {
      uuid: String(row.offer_uuid),
      coin: String(row.coin),
      offerType: String(row.offer_type) as P2pType,
      amount: Number(row.amount),
      receive: Number(row.receive),
      rate: Number(row.rate),
      decision: String(row.decision) as TradingAlert["decision"],
      reason: String(row.reason),
      ...(row.reference_rate === null || row.reference_rate === undefined
        ? {}
        : { referenceRate: Number(row.reference_rate) }),
      ...(row.resolution === null || row.resolution === undefined
        ? {}
        : { resolution: String(row.resolution) as NonNullable<TradingAlert["resolution"]> }),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
      resolvedAt: row.resolved_at === null ? null : Number(row.resolved_at),
    };
  }

  recordDashboardSnapshot(snapshot: {
    qusdBalance: number;
    cupBalance: number;
    prepagoBalance: number;
    openOffers: number;
    activeOperations: number;
  }): void {
    const latest = this.db
      .prepare(
        "SELECT created_at FROM dashboard_snapshots ORDER BY id DESC LIMIT 1",
      )
      .get() as { created_at?: number } | undefined;
    if (latest?.created_at && Date.now() - latest.created_at < 55_000) return;
    this.db
      .prepare(
        "INSERT INTO dashboard_snapshots(created_at, qusd_balance, cup_balance, prepago_balance, open_offers, active_operations) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(
        Date.now(),
        snapshot.qusdBalance,
        snapshot.cupBalance,
        snapshot.prepagoBalance,
        snapshot.openOffers,
        snapshot.activeOperations,
      );
    this.db
      .prepare(
        "DELETE FROM dashboard_snapshots WHERE id NOT IN (SELECT id FROM dashboard_snapshots ORDER BY id DESC LIMIT 2160)",
      )
      .run();
  }

  dashboardHistory(
    since: number,
  ): {
    createdAt: number;
    qusdBalance: number;
    openOffers: number;
    activeOperations: number;
  }[] {
    return (
      this.db
        .prepare(
          "SELECT created_at, qusd_balance, open_offers, active_operations FROM dashboard_snapshots WHERE created_at >= ? ORDER BY created_at ASC",
        )
        .all(since) as Record<string, unknown>[]
    ).map((row) => ({
      createdAt: Number(row.created_at),
      qusdBalance: Number(row.qusd_balance),
      openOffers: Number(row.open_offers),
      activeOperations: Number(row.active_operations),
    }));
  }

  recordMarketObservation(observation: {
    coin: FiatMarket;
    averageBuy?: number;
    averageSell?: number;
    medianBuy?: number;
    medianSell?: number;
    bestBuy?: number;
    bestSell?: number;
    openOffers: number;
    eligible: number;
  }): void {
    const latest = this.db
      .prepare(
        "SELECT created_at FROM market_observations WHERE coin = ? ORDER BY id DESC LIMIT 1",
      )
      .get(observation.coin) as { created_at?: number } | undefined;
    if (latest?.created_at && Date.now() - latest.created_at < 55_000) return;
    this.db
      .prepare(
        "INSERT INTO market_observations(created_at, coin, average_buy, average_sell, median_buy, median_sell, best_buy, best_sell, open_offers, eligible) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        Date.now(),
        observation.coin,
        observation.averageBuy ?? null,
        observation.averageSell ?? null,
        observation.medianBuy ?? null,
        observation.medianSell ?? null,
        observation.bestBuy ?? null,
        observation.bestSell ?? null,
        observation.openOffers,
        observation.eligible,
      );
    this.db
      .prepare(
        "DELETE FROM market_observations WHERE id NOT IN (SELECT id FROM market_observations ORDER BY id DESC LIMIT 20_000)",
      )
      .run();
  }

  marketHistory(
    since: number,
    coin?: FiatMarket,
  ): {
    createdAt: number;
    coin: FiatMarket;
    averageBuy?: number;
    averageSell?: number;
    medianBuy?: number;
    medianSell?: number;
    bestBuy?: number;
    bestSell?: number;
    openOffers: number;
    eligible: number;
  }[] {
    const statement = coin
      ? this.db.prepare(
          "SELECT created_at, coin, average_buy, average_sell, median_buy, median_sell, best_buy, best_sell, open_offers, eligible FROM market_observations WHERE created_at >= ? AND coin = ? ORDER BY created_at ASC",
        )
      : this.db.prepare(
          "SELECT created_at, coin, average_buy, average_sell, median_buy, median_sell, best_buy, best_sell, open_offers, eligible FROM market_observations WHERE created_at >= ? ORDER BY created_at ASC",
        );
    return (
      statement.all(...(coin ? [since, coin] : [since])) as Record<
        string,
        unknown
      >[]
    ).map((row) => ({
      createdAt: Number(row.created_at),
      coin: String(row.coin),
      ...optionalNumber("averageBuy", row.average_buy),
      ...optionalNumber("averageSell", row.average_sell),
      ...optionalNumber("medianBuy", row.median_buy),
      ...optionalNumber("medianSell", row.median_sell),
      ...optionalNumber("bestBuy", row.best_buy),
      ...optionalNumber("bestSell", row.best_sell),
      openOffers: Number(row.open_offers),
      eligible: Number(row.eligible),
    }));
  }

  countAudit(action: string): number {
    return Number(
      (
        this.db
          .prepare("SELECT COUNT(*) AS count FROM audit_log WHERE action = ?")
          .get(action) as { count: number }
      ).count,
    );
  }

  private operationFromRow(row: Record<string, unknown>): Operation {
    return {
      uuid: String(row.uuid),
      offerType: String(row.offer_type) as P2pType,
      coin: String(row.coin) as FiatMarket,
      amount: Number(row.amount),
      receive: Number(row.receive),
      rate: Number(row.rate),
      state: String(row.state) as OperationState,
      autoApplied: Boolean(row.auto_applied),
      cancelAt: row.cancel_at === null ? null : Number(row.cancel_at),
      createdAt: Number(row.created_at),
      ...(row.counterparty_id === null || row.counterparty_id === undefined
        ? {}
        : { counterpartyId: String(row.counterparty_id) }),
      ...optionalNumber("referenceRate", row.reference_rate),
    };
  }
}

function numberOrUndefined(value: unknown): number | undefined {
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function optionalNumber<K extends string>(
  key: K,
  value: unknown,
): Partial<Record<K, number>> {
  const number = numberOrUndefined(value);
  return number === undefined ? {} : ({ [key]: number } as Record<K, number>);
}

function configRevisionHash(
  previousHash: string | null,
  createdAt: number,
  source: string,
  reason: string | null,
  configJson: string,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({ previousHash, createdAt, source, reason, configJson }),
    )
    .digest("hex");
}

function workflowFromRow(row: Record<string, unknown>): TradeWorkflow {
  return {
    id: String(row.id),
    targetOffer: JSON.parse(String(row.target_json)) as P2pOffer,
    riskDecision: JSON.parse(String(row.risk_decision_json)) as RiskDecision,
    state: String(row.state) as WorkflowState,
    error: row.error === null ? null : String(row.error),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function restoreIdempotencyKey(workflowId: string, offerUuid: string): string {
  return createHash("sha256")
    .update(`restore:${workflowId}:${offerUuid}`)
    .digest("hex");
}

function notificationFromRow(row: Record<string, unknown>): DurableNotification {
  let payload: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(String(row.payload_json));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
      payload = parsed as Record<string, unknown>;
  } catch {
    /* Un payload antiguo no debe ocultar el aviso persistido. */
  }
  return {
    id: String(row.id),
    kind: String(row.kind) as NotificationKind,
    message: String(row.message),
    ...(row.operation_uuid === null || row.operation_uuid === undefined
      ? {}
      : { operationUuid: String(row.operation_uuid) }),
    payload,
    telegramDeliveredAt:
      row.telegram_delivered_at === null ? null : Number(row.telegram_delivered_at),
    telegramAttempts: Number(row.telegram_attempts),
    telegramNextAttemptAt: Number(row.telegram_next_attempt_at),
    ...(row.telegram_last_error === null
      ? {}
      : { telegramLastError: String(row.telegram_last_error) }),
    pushDeliveredAt:
      row.push_delivered_at === null ? null : Number(row.push_delivered_at),
    pushAttempts: Number(row.push_attempts),
    pushNextAttemptAt: Number(row.push_next_attempt_at),
    ...(row.push_last_error === null
      ? {}
      : { pushLastError: String(row.push_last_error) }),
    acknowledgedAt:
      row.acknowledged_at === null ? null : Number(row.acknowledged_at),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function rebalanceJobFromRow(row: Record<string, unknown>): RebalanceJob {
  const adjustments = JSON.parse(String(row.adjustments_json)) as RebalanceJobAdjustment[];
  return {
    id: String(row.id),
    state: String(row.state) as RebalanceJobState,
    adjustments,
    ...(row.error === null || row.error === undefined
      ? {}
      : { error: String(row.error) }),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}
