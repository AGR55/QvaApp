#!/usr/bin/env node
/**
 * QvaApply · F0 data rehearsal
 * ------------------------------------------------------------------
 * Ensaya la migración SQLite v16 → v31 sobre una COPIA de la base,
 * usando la clase `Store` real, y produce un manifiesto de verificación
 * reutilizable en F5.
 *
 * Uso:
 *   node --import tsx tools/db-rehearsal/rehearse.mjs
 *   node --import tsx tools/db-rehearsal/rehearse.mjs --source data/qvaapply.sqlite --keep
 *   node --import tsx tools/db-rehearsal/rehearse.mjs --json /tmp/manifest.json --clean
 *
 * Garantías:
 *   - Nunca abre la base de origen con SQLite (solo la lee para copiarla y
 *     calcula su sha256 antes/después para demostrar que no se modificó).
 *   - Todo el trabajo ocurre en un directorio temporal (`/tmp`).
 *   - Solo imprime estructura, conteos, sumas agregadas y hashes; nunca filas
 *     completas ni valores de secretos.
 *   - Exit code 0 solo si todas las comprobaciones de integridad pasan.
 */

import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../..");

const EXPECTED_SCHEMA = 31;
const EXPECTED_TABLES = 41;
const EXPECTED_INDEXES = 32;
const EXPECTED_TRIGGERS = 6;
const SCALE = 100_000_000n; // 8 decimales canónicos (roundQusd / roundDecimal)

// Tablas que existían antes de la migración y que no pueden perder filas.
const KEY_TABLES = [
  "audit_log",
  "bot_config",
  "capital_rebalance_jobs",
  "capital_reservations",
  "config_revisions",
  "dashboard_snapshots",
  "decision_events",
  "fiat_accounts",
  "fiat_ledger",
  "market_config",
  "market_feed_events",
  "market_observations",
  "market_reader_accounts",
  "mutation_intents",
  "notification_events",
  "operations",
  "payment_details",
  "remote_resource_cache",
  "risk_config",
  "scheduled_actions",
  "seen_offers",
  "settings",
  "trade_workflows",
  "trading_alerts",
  "trading_config",
  "workflow_own_offers",
];

// Tablas nuevas creadas por v17..v31: deben existir (pueden estar vacías).
const EXPECTED_NEW_TABLES = [
  "analytics_fee_evidence",
  "analytics_offers",
  "analytics_transactions",
  "application_capital_reservations",
  "chat_push_deliveries",
  "chat_push_devices",
  "chat_push_events",
  "chat_threads",
  "config_integrity_epoch",
  "fiat_balance_history",
  "manual_cancel_exclusions",
  "payment_receipts",
  "portfolio_snapshots",
  "sms_devices",
];

// ---------------------------------------------------------------- utilidades

function parseArgs(argv) {
  const out = {
    source: join(REPO_ROOT, "data/qvaapply.sqlite"),
    workdir: undefined,
    keep: false,
    clean: false,
    json: undefined,
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case "--source": out.source = argv[++i]; break;
      case "--workdir": out.workdir = argv[++i]; break;
      case "--keep": out.keep = true; break;
      case "--clean": out.clean = true; break;
      case "--json": out.json = argv[++i]; break;
      case "--help": case "-h": out.help = true; break;
      default: throw new Error(`Argumento no reconocido: ${arg}`);
    }
  }
  return out;
}

function usage() {
  console.log(`Uso: node --import tsx tools/db-rehearsal/rehearse.mjs [opciones]

  --source <ruta>   Base SQLite de origen (por defecto data/qvaapply.sqlite). Solo se copia.
  --workdir <dir>   Directorio de trabajo (por defecto /tmp/qva-rehearsal-XXXXXX).
  --keep            Conserva el directorio de trabajo (comportamiento por defecto).
  --clean           Borra el directorio de trabajo al terminar.
  --json <ruta>     Escribe el manifiesto JSON completo en esa ruta.
  -h, --help        Muestra esta ayuda.`);
}

function ensure(condition, message) {
  if (!condition) throw new Error(message);
}

function sha256File(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function qIdent(name) {
  return `"${String(name).replace(/"/g, '""')}"`;
}

function one(db, sql, ...params) {
  return db.prepare(sql).get(...params);
}

function all(db, sql, ...params) {
  return db.prepare(sql).all(...params);
}

function count(db, table) {
  return Number(one(db, `SELECT COUNT(*) AS c FROM ${qIdent(table)}`).c);
}

/** Suma exacta en 1e-8. Acepta más de 8 decimales y redondea half-away-from-zero. */
function dec8(text) {
  const raw = String(text).trim();
  const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(raw);
  ensure(m, "Decimal inválido en agregado (formato no soportado por el manifiesto)");
  const sign = m[1] === "-" ? -1n : 1n;
  const intPart = BigInt(m[2]);
  const frac = m[3] ?? "";
  const head = BigInt(frac.slice(0, 8).padEnd(8, "0"));
  let value = intPart * SCALE + head;
  if (frac.length > 8 && frac[8] >= "5") value += 1n;
  return sign * value;
}

function fmt8(value) {
  const sign = value < 0n ? "-" : "";
  const abs = value < 0n ? -value : value;
  return `${sign}${abs / SCALE}.${String(abs % SCALE).padStart(8, "0")}`;
}

function tableNames(db) {
  return all(
    db,
    `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
  ).map((row) => String(row.name));
}

function indexNames(db) {
  return all(
    db,
    `SELECT name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
  ).map((row) => String(row.name));
}

function triggerNames(db) {
  return all(db, `SELECT name FROM sqlite_master WHERE type='trigger' ORDER BY name`).map(
    (row) => String(row.name),
  );
}

function columnsOf(db, table) {
  const exists = one(
    db,
    `SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name=?`,
    table,
  );
  if (!exists) return [];
  return all(db, `PRAGMA table_info(${qIdent(table)})`).map((row) => String(row.name));
}

function tableSizes(db) {
  try {
    const rows = all(
      db,
      `SELECT name, SUM(pgsize) AS bytes FROM dbstat GROUP BY name ORDER BY bytes DESC`,
    );
    return rows.map((row) => ({ name: String(row.name), bytes: Number(row.bytes) }));
  } catch {
    return null; // dbstat no compilado en este SQLite
  }
}

function openSqlite(file, { readOnly = true } = {}) {
  if (readOnly) {
    try {
      const db = new DatabaseSync(file, { readOnly: true });
      db.prepare("PRAGMA query_only=ON").get();
      return db;
    } catch {
      // Copia con WAL que requiere recuperación: se abre la COPIA en r/w.
    }
  }
  const db = new DatabaseSync(file);
  db.exec("PRAGMA busy_timeout=5000;");
  return db;
}

function settingsBalanceRows(db) {
  return all(
    db,
    `SELECT key, value FROM settings WHERE key GLOB 'fiat_balance:*' ORDER BY key`,
  ).map((row) => ({ key: String(row.key), value: String(row.value) }));
}

function balancesDigest(db) {
  const rows = settingsBalanceRows(db);
  const canonical = rows.map((row) => `${row.key}=${dec8(row.value)}`).join("\n");
  return {
    count: rows.length,
    sha256: createHash("sha256").update(canonical).digest("hex"),
  };
}

function ledgerSums(db) {
  const rows = all(
    db,
    `SELECT coin, direction, printf('%.8f', amount) AS amount
       FROM fiat_ledger ORDER BY coin, direction`,
  );
  const groups = new Map();
  for (const row of rows) {
    const key = `${row.coin}|${row.direction}`;
    groups.set(key, (groups.get(key) ?? 0n) + dec8(row.amount));
  }
  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => {
      const [coin, direction] = key.split("|");
      return { coin, direction, sum: fmt8(value) };
    });
}

function ledgerFloatDrift(db) {
  // Compara la suma float completa (Number.toPrecision(17), representación
  // exacta del double acumulado) con la suma decimal canónica a 8 dp
  // construida fila a fila. Documenta cuánto drift binario existe y si llega
  // a afectar al quanto canónico de 1e-8.
  const groups = ledgerSums(db);
  const rows = all(
    db,
    `SELECT coin, direction, SUM(amount) AS float_sum
       FROM fiat_ledger GROUP BY coin, direction ORDER BY coin, direction`,
  );
  const canonical = new Map(groups.map((group) => [`${group.coin}|${group.direction}`, group.sum]));
  return rows.map((row) => {
    const key = `${row.coin}|${row.direction}`;
    const canonical8 = canonical.get(key) ?? "0.00000000";
    const precise = Number(row.float_sum).toPrecision(17);
    const rounded = dec8(String(Number(precise).toFixed(8)));
    const exact = dec8(canonical8);
    const diff = rounded - exact;
    return {
      coin: String(row.coin),
      direction: String(row.direction),
      canonical8,
      floatNative: precise,
      absDiff8: fmt8(diff < 0n ? diff * -1n : diff),
    };
  });
}

function settingsKeysDigest(db) {
  const rows = all(db, `SELECT key FROM settings ORDER BY key`).map((row) => String(row.key));
  return {
    count: rows.length,
    sha256: createHash("sha256").update(rows.join("\n")).digest("hex"),
  };
}

/** Reimplementa configRevisionHash para verificar la cadena sin migrar. */
function configRevisionHash(previousHash, createdAt, source, reason, configJson) {
  return createHash("sha256")
    .update(JSON.stringify({ previousHash, createdAt, source, reason, configJson }))
    .digest("hex");
}

function verifyConfigChain(db) {
  const head = one(db, `SELECT id, hash FROM config_revisions ORDER BY id DESC LIMIT 1`);
  const rows = all(
    db,
    `SELECT id, created_at, source, reason, config_json, previous_hash, hash
       FROM config_revisions ORDER BY id ASC`,
  );
  let previousHash = null;
  let verifiedRows = 0;
  let ok = true;
  let firstBrokenId = null;
  for (const row of rows) {
    verifiedRows += 1;
    const expected = configRevisionHash(
      previousHash,
      Number(row.created_at),
      String(row.source),
      row.reason === null ? null : String(row.reason),
      String(row.config_json),
    );
    if (row.previous_hash !== previousHash || expected !== row.hash) {
      ok = false;
      firstBrokenId = Number(row.id);
      break;
    }
    previousHash = String(row.hash);
  }
  return {
    valid: ok,
    rows: rows.length,
    verifiedRows,
    lastId: head ? Number(head.id) : 0,
    lastHash: head ? String(head.hash) : null,
    firstBrokenId,
  };
}

function epochOf(db) {
  const exists = one(
    db,
    `SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name='config_integrity_epoch'`,
  );
  if (!exists) return null;
  const row = one(db, `SELECT version FROM config_integrity_epoch WHERE id=1`);
  return row ? Number(row.version) : null;
}

function vipPending(db, table) {
  return Number(
    one(
      db,
      `SELECT COUNT(*) AS c FROM ${qIdent(table)}
        WHERE resolved_at IS NULL AND lower(reason) LIKE '%vip%'`,
    ).c,
  );
}

function resolvedCount(db, table) {
  if (!columnsOf(db, table).includes("resolution")) return null;
  return Number(
    one(db, `SELECT COUNT(*) AS c FROM ${qIdent(table)} WHERE resolution='resolved'`).c,
  );
}

function workflowIdState(db) {
  const cols = columnsOf(db, "mutation_intents");
  const total = count(db, "mutation_intents");
  if (!cols.includes("workflow_id")) {
    const inJson = Number(
      one(
        db,
        `SELECT COUNT(*) AS c FROM mutation_intents
          WHERE json_type(request_json,'$.workflowId')='text'`,
      ).c,
    );
    return { column: false, total, nulls: total, inJson };
  }
  const nulls = Number(
    one(db, `SELECT COUNT(*) AS c FROM mutation_intents WHERE workflow_id IS NULL`).c,
  );
  const inJson = Number(
    one(
      db,
      `SELECT COUNT(*) AS c FROM mutation_intents
        WHERE workflow_id IS NULL AND json_type(request_json,'$.workflowId')='text'`,
    ).c,
  );
  return { column: true, total, nulls, inJson };
}

function distinctCancelExclusions(db) {
  return Number(
    one(
      db,
      `SELECT COUNT(DISTINCT offer_uuid) AS c FROM audit_log
        WHERE offer_uuid IS NOT NULL AND action='cancel'`,
    ).c,
  );
}

function columnsMap(db) {
  const map = {};
  for (const table of tableNames(db)) map[table] = columnsOf(db, table);
  return map;
}

function fkViolations(db) {
  return all(db, `PRAGMA foreign_key_check`).length;
}

/** Baseline completo a partir de la COPIA. */
function baseline(db) {
  const tables = tableNames(db);
  const counts = {};
  for (const table of tables) counts[table] = count(db, table);
  return {
    journalMode: String(one(db, `PRAGMA journal_mode`).journal_mode),
    pageSize: Number(one(db, `PRAGMA page_size`).page_size),
    pageCount: Number(one(db, `PRAGMA page_count`).page_count),
    freelistCount: Number(one(db, `PRAGMA freelist_count`).freelist_count),
    userVersion: Number(one(db, `PRAGMA user_version`).user_version),
    integrityCheck: String(one(db, `PRAGMA integrity_check`).integrity_check),
    schemaVersion: Number(
      one(db, `SELECT COALESCE(MAX(version),0) AS v FROM schema_migrations`).v,
    ),
    migrationRows: Number(one(db, `SELECT COUNT(*) AS c FROM schema_migrations`).c),
    tables,
    indexes: indexNames(db),
    triggers: triggerNames(db),
    counts,
    columns: columnsMap(db),
    sizes: tableSizes(db),
    balances: balancesDigest(db),
    ledgerSums: ledgerSums(db),
    ledgerFloatDrift: ledgerFloatDrift(db),
    configChain: verifyConfigChain(db),
    vipPending: {
      decision_events: vipPending(db, "decision_events"),
      trading_alerts: vipPending(db, "trading_alerts"),
    },
    resolved: {
      decision_events: resolvedCount(db, "decision_events"),
      trading_alerts: resolvedCount(db, "trading_alerts"),
    },
    workflowId: workflowIdState(db),
    cancelExclusionsExpected: distinctCancelExclusions(db),
    fiatBalanceKeys: settingsBalanceRows(db).length,
    settingsKeys: settingsKeysDigest(db),
    fkViolations: fkViolations(db),
  };
}

/** Estado posterior: se ejecuta sobre la copia ya migrada. */
function snapshot(db) {
  const tables = tableNames(db);
  const counts = {};
  for (const table of tables) counts[table] = count(db, table);
  return {
    journalMode: String(one(db, `PRAGMA journal_mode`).journal_mode),
    pageSize: Number(one(db, `PRAGMA page_size`).page_size),
    pageCount: Number(one(db, `PRAGMA page_count`).page_count),
    integrityCheck: String(one(db, `PRAGMA integrity_check`).integrity_check),
    schemaVersion: Number(
      one(db, `SELECT COALESCE(MAX(version),0) AS v FROM schema_migrations`).v,
    ),
    migrationRows: Number(one(db, `SELECT COUNT(*) AS c FROM schema_migrations`).c),
    tables,
    indexes: indexNames(db),
    triggers: triggerNames(db),
    counts,
    columns: columnsMap(db),
    sizes: tableSizes(db),
    balances: balancesDigest(db),
    ledgerSums: ledgerSums(db),
    ledgerFloatDrift: ledgerFloatDrift(db),
    configChain: verifyConfigChain(db),
    configEpoch: epochOf(db),
    vipPending: {
      decision_events: vipPending(db, "decision_events"),
      trading_alerts: vipPending(db, "trading_alerts"),
    },
    resolved: {
      decision_events: resolvedCount(db, "decision_events"),
      trading_alerts: resolvedCount(db, "trading_alerts"),
    },
    workflowId: workflowIdState(db),
    settingsKeys: settingsKeysDigest(db),
    fkViolations: fkViolations(db),
  };
}

function diffKeys(a, b) {
  const setB = new Set(b);
  return a.filter((item) => !setB.has(item));
}

function columnsAdded(beforeColumns, afterColumns) {
  const added = {};
  for (const [table, before] of Object.entries(beforeColumns)) {
    const beforeSet = new Set(before);
    const newCols = (afterColumns[table] ?? []).filter((column) => !beforeSet.has(column));
    if (newCols.length) added[table] = newCols;
  }
  return added;
}

async function buildReference(refDir) {
  // Base v31 vacía: conjunto exacto de tablas/índices/triggers que debe existir.
  const storeUrl = pathToFileURL(join(REPO_ROOT, "src/store.ts")).href;
  let mod;
  try {
    mod = await import(storeUrl);
  } catch (error) {
    throw new Error(
      "No se pudo importar src/store.ts. Ejecuta el script con: node --import tsx tools/db-rehearsal/rehearse.mjs" +
        `\nDetalle: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const store = new mod.Store(refDir);
  const version = store.schemaVersion();
  store.close();
  const db = openSqlite(join(refDir, "qvaapply.sqlite"));
  const reference = {
    schemaVersion: version,
    tables: tableNames(db),
    indexes: indexNames(db),
    triggers: triggerNames(db),
  };
  db.close();
  return reference;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    usage();
    return;
  }

  const startedAt = new Date().toISOString();
  const scriptStart = performance.now();
  const sourcePath = resolve(args.source);
  ensure(existsSync(sourcePath), `No existe la base de origen: ${sourcePath}`);
  ensure(statSync(sourcePath).isFile(), `La ruta de origen no es un fichero: ${sourcePath}`);

  let workdir;
  if (args.workdir) {
    workdir = resolve(args.workdir);
    if (existsSync(workdir) && readdirSync(workdir).length > 0) {
      workdir = `${workdir}-${Date.now()}`;
      console.log(`# --workdir no vacío: se usa ${workdir}`);
    }
  } else {
    workdir = mkdtempSync(join(tmpdir(), "qva-rehearsal-"));
  }
  mkdirSync(workdir, { recursive: true });
  const dataDir = join(workdir, "data");
  mkdirSync(dataDir, { recursive: true });
  const copyPath = join(dataDir, "qvaapply.sqlite");
  const refDir = join(workdir, "reference-v31");

  const sourceHashBefore = sha256File(sourcePath);
  const walPath = `${sourcePath}-wal`;
  const shmPath = `${sourcePath}-shm`;
  const hadWal = existsSync(walPath) && statSync(walPath).size > 0;

  console.log(`# QvaApply F0 data rehearsal`);
  console.log(`source:  ${sourcePath}`);
  console.log(`workdir: ${workdir}`);
  console.log(`sha256:  ${sourceHashBefore}`);
  console.log("");

  // 1) Copia limpia: el origen nunca se abre con SQLite.
  copyFileSync(sourcePath, copyPath);
  if (hadWal) copyFileSync(walPath, `${copyPath}-wal`);
  if (existsSync(shmPath)) copyFileSync(shmPath, `${copyPath}-shm`);
  const copyBytes = statSync(copyPath).size;

  // 2) Línea base sobre la copia.
  const baseDb = openSqlite(copyPath);
  const base = baseline(baseDb);
  baseDb.close();
  console.log("## Línea base (copia)");
  console.log(
    `journal=${base.journalMode} page_size=${base.pageSize} pages=${base.pageCount} ` +
      `freelist=${base.freelistCount} user_version=${base.userVersion}`,
  );
  console.log(
    `integrity_check=${base.integrityCheck} schema=v${base.schemaVersion} ` +
      `migrations=${base.migrationRows} tables=${base.tables.length} ` +
      `indexes=${base.indexes.length} triggers=${base.triggers.length}`,
  );
  console.log(
    `config_chain=${base.configChain.valid ? "valid" : "INVALID"} ` +
      `rows=${base.configChain.rows} lastId=${base.configChain.lastId} hash=${base.configChain.lastHash}`,
  );
  console.log(
    `fiat ledger groups=${base.ledgerSums.length} balances_keys=${base.balances.count} ` +
      `cancel_exclusions_expected=${base.cancelExclusionsExpected}`,
  );
  for (const group of base.ledgerSums) {
    console.log(`ledger ${group.coin} ${group.direction} sum8=${group.sum}`);
  }
  for (const item of (base.sizes ?? []).slice(0, 6)) {
    console.log(`size ${item.name} bytes=${item.bytes}`);
  }
  console.log("");

  const baseFails = [];
  if (base.schemaVersion <= 0) baseFails.push("sin schema_migrations");
  if (base.schemaVersion >= EXPECTED_SCHEMA) baseFails.push(`ya está en v${base.schemaVersion}`);
  if (base.integrityCheck !== "ok") baseFails.push(`integrity=${base.integrityCheck}`);
  if (!base.configChain.valid) baseFails.push("cadena de configuración inválida");
  if (baseFails.length) {
    throw new Error(
      `La copia no sirve para el ensayo v16→v31: ${baseFails.join("; ")}. ` +
        "Usa el snapshot v16 (data/qvaapply.sqlite del repo).",
    );
  }

  // 3) Migración real con la clase Store.
  const migrationStart = performance.now();
  let schemaVersionAfter = null;
  let chainAfterStore = null;
  let migrationError = null;
  try {
    const storeUrl = pathToFileURL(join(REPO_ROOT, "src/store.ts")).href;
    let mod;
    try {
      mod = await import(storeUrl);
    } catch (error) {
      throw new Error(
        "No se pudo importar src/store.ts. Ejecuta con: node --import tsx tools/db-rehearsal/rehearse.mjs" +
          `\nDetalle: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const store = new mod.Store(dataDir);
    schemaVersionAfter = store.schemaVersion();
    chainAfterStore = store.verifyConfigRevisionChain();
    store.close();
  } catch (error) {
    migrationError = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  }
  const migrationMs = Math.round((performance.now() - migrationStart) * 10) / 10;

  console.log("## Migración v16 → v31");
  if (migrationError) {
    console.log(`ERROR: ${migrationError}`);
  } else {
    console.log(
      `ok schema_after=${schemaVersionAfter} open_and_migrate_ms=${migrationMs} ` +
        `chain_after_store=${chainAfterStore}`,
    );
  }
  const backupDir = join(dataDir, "backups");
  const backups = existsSync(backupDir)
    ? readdirSync(backupDir).map((name) => ({
        name,
        bytes: statSync(join(backupDir, name)).size,
        sha256: sha256File(join(backupDir, name)),
      }))
    : [];
  for (const backup of backups) {
    console.log(`backup ${backup.name} bytes=${backup.bytes} sha256=${backup.sha256}`);
  }
  console.log("");

  // 4) Verificación posterior sobre la copia migrada.
  const postDb = openSqlite(copyPath);
  const post = snapshot(postDb);
  const postBytes = statSync(copyPath).size;
  const addedColumns = columnsAdded(base.columns, post.columns);
  const reference = await buildReference(refDir);

  console.log("## Post-migración");
  console.log(
    `schema=v${post.schemaVersion} migrations=${post.migrationRows} ` +
      `tables=${post.tables.length} indexes=${post.indexes.length} triggers=${post.triggers.length}`,
  );
  console.log(
    `integrity_check=${post.integrityCheck} fk_violations=${post.fkViolations} ` +
      `config_epoch=${post.configEpoch}`,
  );
  console.log(
    `config_chain=${post.configChain.valid ? "valid" : "INVALID"} ` +
      `rows=${post.configChain.rows} lastId=${post.configChain.lastId} hash=${post.configChain.lastHash}`,
  );
  console.log(
    `backfill fiat_balance_history=${post.counts.fiat_balance_history ?? 0} ` +
      `manual_cancel_exclusions=${post.counts.manual_cancel_exclusions ?? 0} ` +
      `payment_receipts=${post.counts.payment_receipts ?? 0} ` +
      `chat_threads=${post.counts.chat_threads ?? 0}`,
  );
  const postSizes = post.sizes ?? [];
  const postTotal = postSizes.reduce((sum, item) => sum + item.bytes, 0);
  const configSize = postSizes.find((item) => item.name === "config_revisions")?.bytes ?? 0;
  console.log(
    `bytes_total=${postTotal} config_revisions=${configSize} ` +
      `share=${postTotal ? ((configSize / postTotal) * 100).toFixed(1) : "n/a"}%`,
  );
  console.log("");

  // 5) Comprobaciones duras.
  const checks = [];
  const check = (id, ok, detail) => {
    checks.push({ id, ok: Boolean(ok), detail });
    return Boolean(ok);
  };

  check(
    "source_sha256_unchanged_at_start",
    sha256File(sourcePath) === sourceHashBefore,
    "sha256 del origen antes de copiar",
  );
  check("baseline_integrity_ok", base.integrityCheck === "ok", base.integrityCheck);
  check("baseline_config_chain_valid", base.configChain.valid, `rows=${base.configChain.rows}`);
  check("migration_no_error", migrationError === null, migrationError ?? "sin error");
  check("post_schema_is_31", post.schemaVersion === EXPECTED_SCHEMA, `v${post.schemaVersion}`);
  const migrationsOk =
    post.migrationRows === EXPECTED_SCHEMA &&
    JSON.stringify(
      all(postDb, `SELECT version FROM schema_migrations ORDER BY version`).map((row) =>
        Number(row.version),
      ),
    ) === JSON.stringify(Array.from({ length: EXPECTED_SCHEMA }, (_, i) => i + 1));
  check("schema_migrations_31_rows", migrationsOk, `filas=${post.migrationRows}`);
  check("post_tables_41", post.tables.length === EXPECTED_TABLES, `${post.tables.length}`);
  check("post_indexes_32", post.indexes.length === EXPECTED_INDEXES, `${post.indexes.length}`);
  check("post_triggers_6", post.triggers.length === EXPECTED_TRIGGERS, `${post.triggers.length}`);
  check("post_integrity_ok", post.integrityCheck === "ok", post.integrityCheck);
  check("post_journal_mode_wal", post.journalMode === "wal", post.journalMode);
  check("post_foreign_keys_clean", post.fkViolations === 0, `${post.fkViolations}`);
  check("backup_created_once", backups.length === 1, `ficheros=${backups.length}`);
  check(
    "backup_named_before_v31",
    backups.length === 1 && /^qvaapply-before-v31-.+\.sqlite$/.test(backups[0].name),
    backups[0]?.name ?? "sin backup",
  );
  check(
    "backup_byte_identical_to_source",
    backups.length === 1 &&
      (hadWal ? backups[0].bytes > 0 : backups[0].sha256 === sourceHashBefore),
    hadWal ? "origen con WAL no vacío: se valida tamaño" : "sin WAL: byte-idéntico",
  );
  check(
    "new_tables_present",
    EXPECTED_NEW_TABLES.every((table) => post.tables.includes(table)),
    `faltan=${diffKeys(EXPECTED_NEW_TABLES, post.tables).join(",") || "ninguna"}`,
  );
  check(
    "reference_objects_match",
    diffKeys(reference.tables, post.tables).length === 0 &&
      diffKeys(post.tables, reference.tables).length === 0 &&
      diffKeys(reference.indexes, post.indexes).length === 0 &&
      diffKeys(post.indexes, reference.indexes).length === 0 &&
      diffKeys(reference.triggers, post.triggers).length === 0 &&
      diffKeys(post.triggers, reference.triggers).length === 0,
    `tables+${diffKeys(post.tables, reference.tables).length}` +
      ` indexes±${diffKeys(reference.indexes, post.indexes).length}/${diffKeys(post.indexes, reference.indexes).length}` +
      ` triggers±${diffKeys(reference.triggers, post.triggers).length}/${diffKeys(post.triggers, reference.triggers).length}`,
  );

  const keyCountFailures = KEY_TABLES.filter(
    (table) => (base.counts[table] ?? 0) !== (post.counts[table] ?? -1),
  );
  check(
    "key_table_counts_preserved",
    keyCountFailures.length === 0,
    keyCountFailures.length ? keyCountFailures.join(",") : `${KEY_TABLES.length}/${KEY_TABLES.length} tablas`,
  );
  check(
    "expected_fiat_balance_history",
    (post.counts.fiat_balance_history ?? 0) === base.fiatBalanceKeys,
    `post=${post.counts.fiat_balance_history ?? 0} esperado=${base.fiatBalanceKeys} ` +
      `(una fila 'opening' por clave fiat_balance:*)`,
  );
  check(
    "expected_manual_cancel_exclusions",
    (post.counts.manual_cancel_exclusions ?? 0) === base.cancelExclusionsExpected,
    `post=${post.counts.manual_cancel_exclusions ?? 0} esperado=${base.cancelExclusionsExpected}`,
  );
  check("config_integrity_epoch_present", post.configEpoch !== null, `epoch=${post.configEpoch}`);
  check("config_chain_still_valid", post.configChain.valid, `rows=${post.configChain.rows}`);
  check(
    "config_chain_head_unchanged",
    post.configChain.lastId === base.configChain.lastId &&
      post.configChain.lastHash === base.configChain.lastHash &&
      post.configChain.rows === base.configChain.rows,
    `lastId ${base.configChain.lastId}→${post.configChain.lastId}`,
  );
  check(
    "config_epoch_created_at_zero",
    post.configEpoch === 0,
    `epoch=${post.configEpoch} (la tabla se crea en v27 y la migración no inserta revisiones)`,
  );
  check("chain_verified_by_store_class", chainAfterStore === true, String(chainAfterStore));

  check(
    "money_ledger_sums_equal_8dp",
    JSON.stringify(base.ledgerSums) === JSON.stringify(post.ledgerSums),
    `${base.ledgerSums.length} grupos canónicos`,
  );
  check(
    "settings_balances_digest_equal",
    base.balances.sha256 === post.balances.sha256 && base.balances.count === post.balances.count,
    `keys=${base.balances.count} sha256=${post.balances.sha256.slice(0, 16)}…`,
  );
  check(
    "settings_keys_digest_equal",
    base.settingsKeys.sha256 === post.settingsKeys.sha256 &&
      base.settingsKeys.count === post.settingsKeys.count,
    `keys=${base.settingsKeys.count} sha256=${post.settingsKeys.sha256.slice(0, 16)}…`,
  );
  const duplicates = Number(
    one(
      postDb,
      `SELECT COUNT(*) AS c FROM (
         SELECT operation_uuid, direction FROM fiat_ledger
         GROUP BY operation_uuid, direction HAVING COUNT(*) > 1
       )`,
    ).c,
  );
  check("fiat_ledger_still_unique", duplicates === 0, `duplicados=${duplicates}`);

  const expectedWorkflowBackfill = base.workflowId.inJson;
  check(
    "workflow_id_backfill_exact",
    post.workflowId.nulls === base.workflowId.total - expectedWorkflowBackfill,
    `nulls ${base.workflowId.nulls}→${post.workflowId.nulls}, backfill=${expectedWorkflowBackfill}`,
  );
  const vipDecisionExpected = base.vipPending.decision_events;
  const vipDecisionDelta = (post.resolved.decision_events ?? 0) - (base.resolved.decision_events ?? 0);
  check(
    "vip_decision_backfill_exact",
    vipDecisionDelta === vipDecisionExpected,
    `delta=${vipDecisionDelta} esperado=${vipDecisionExpected}`,
  );
  const vipAlertExpected = base.vipPending.trading_alerts;
  const vipAlertDelta = (post.resolved.trading_alerts ?? 0) - (base.resolved.trading_alerts ?? 0);
  check(
    "vip_alert_backfill_exact",
    vipAlertDelta === vipAlertExpected,
    `delta=${vipAlertDelta} esperado=${vipAlertExpected}`,
  );

  // 6) Diferencias observadas / sorpresas.
  console.log("## Diferencias observadas");
  for (const [table, cols] of Object.entries(addedColumns)) {
    console.log(`new_columns ${table}: ${cols.join(", ")}`);
  }
  const emptyNewTables = EXPECTED_NEW_TABLES.filter((table) => (post.counts[table] ?? 0) === 0);
  console.log(
    `new_tables_empty=${emptyNewTables.length}/${EXPECTED_NEW_TABLES.length} ` +
      `(${emptyNewTables.join(",") || "ninguna"})`,
  );
  console.log(`triggers=${post.triggers.join(",")}`);
  const addedColumnTables = Object.keys(addedColumns).length;
  const addedColumnTotal = Object.values(addedColumns).reduce((sum, cols) => sum + cols.length, 0);
  console.log(`added_columns_tables=${addedColumnTables} added_columns_total=${addedColumnTotal}`);

  if (base.sizes && post.sizes) {
    const before = new Map(base.sizes.map((item) => [item.name, item.bytes]));
    const deltas = post.sizes
      .filter((item) => before.has(item.name))
      .map((item) => ({ name: item.name, delta: item.bytes - before.get(item.name) }))
      .filter((item) => item.delta !== 0)
      .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
      .slice(0, 8);
    for (const item of deltas) {
      console.log(`size_delta ${item.name} ${item.delta >= 0 ? "+" : ""}${item.delta}`);
    }
  }

  console.log(`float_drift_groups=${post.ledgerFloatDrift.length}`);
  for (const row of post.ledgerFloatDrift) {
    console.log(
      `float_drift ${row.coin} ${row.direction} canonical8=${row.canonical8} ` +
        `float17=${row.floatNative} diff_at_8dp=${row.absDiff8}`,
    );
  }
  console.log("");

  // 7) El origen sigue intacto.
  const sourceHashAfter = sha256File(sourcePath);
  check(
    "source_sha256_unchanged_at_end",
    sourceHashAfter === sourceHashBefore,
    sourceHashAfter === sourceHashBefore ? "intacto" : "¡MODIFICADO!",
  );

  const failed = checks.filter((item) => !item.ok);

  const manifest = {
    task: "F0-data-rehearsal",
    startedAt,
    finishedAt: new Date().toISOString(),
    source: { path: sourcePath, sha256: sourceHashBefore, walFrames: hadWal },
    workdir,
    expected: {
      schema: EXPECTED_SCHEMA,
      tables: EXPECTED_TABLES,
      indexes: EXPECTED_INDEXES,
      triggers: EXPECTED_TRIGGERS,
      migrations: EXPECTED_SCHEMA,
    },
    baseline: {
      schemaVersion: base.schemaVersion,
      migrationRows: base.migrationRows,
      tables: base.tables.length,
      indexes: base.indexes.length,
      triggers: base.triggers.length,
      integrityCheck: base.integrityCheck,
      pageCount: base.pageCount,
      pageSize: base.pageSize,
      counts: base.counts,
      ledgerSums: base.ledgerSums,
      balances: base.balances,
      configChain: base.configChain,
      configEpoch: null,
      sizes: base.sizes,
      vipPending: base.vipPending,
      resolved: base.resolved,
      workflowId: base.workflowId,
      cancelExclusionsExpected: base.cancelExclusionsExpected,
      fiatBalanceKeys: base.fiatBalanceKeys,
      settingsKeys: base.settingsKeys,
      fileBytes: copyBytes,
      foreignKeyViolations: base.fkViolations,
    },
    migration: {
      ok: migrationError === null,
      error: migrationError,
      schemaAfter: schemaVersionAfter,
      openAndMigrateMs: migrationMs,
      backups,
    },
    post: {
      schemaVersion: post.schemaVersion,
      migrationRows: post.migrationRows,
      tables: post.tables.length,
      indexes: post.indexes.length,
      triggers: post.triggers.length,
      integrityCheck: post.integrityCheck,
      foreignKeyViolations: post.fkViolations,
      counts: post.counts,
      ledgerSums: post.ledgerSums,
      balances: post.balances,
      configChain: post.configChain,
      configEpoch: post.configEpoch,
      ledgerFloatDrift: post.ledgerFloatDrift,
      settingsKeys: post.settingsKeys,
      fileBytes: postBytes,
      sizes: post.sizes,
      addedColumns,
      emptyNewTables,
      reference: {
        tables: reference.tables.length,
        indexes: reference.indexes.length,
        triggers: reference.triggers.length,
      },
    },
    manifest: {
      counts: "conteos por tabla antes/después; delta 0 en tablas preexistentes",
      money: "sumas de fiat_ledger por coin+direction, decimal canónico 8 dp",
      balances: "sha256 de settings.fiat_balance:* canónico (sin volcar valores)",
      config: "cadena SHA-256 completa re-verificada + último hash/epoch",
      checks: checks.map((item) => ({ id: item.id, ok: item.ok, detail: item.detail })),
    },
    checks: { total: checks.length, failed: failed.length, failures: failed },
    durationMs: Math.round((performance.now() - scriptStart) * 10) / 10,
    result: failed.length === 0 ? "PASS" : "FAIL",
  };

  console.log("## Resultado");
  for (const item of checks) {
    console.log(`${item.ok ? "PASS" : "FAIL"} ${item.id}: ${item.detail}`);
  }
  console.log("");
  console.log(`RESULT: ${manifest.result} (${checks.length - failed.length}/${checks.length} checks)`);
  if (failed.length) console.log(`FAILED: ${failed.map((item) => item.id).join(", ")}`);

  if (args.json) {
    const jsonPath = resolve(args.json);
    mkdirSync(dirname(jsonPath), { recursive: true });
    writeFileSync(jsonPath, `${JSON.stringify(manifest, null, 2)}\n`);
    console.log(`MANIFEST: ${jsonPath}`);
  }

  postDb.close();

  if (args.clean) {
    rmSync(workdir, { recursive: true, force: true });
    console.log(`workdir removed: ${workdir}`);
  } else {
    console.log(`workdir kept: ${workdir}`);
  }

  process.exitCode = failed.length === 0 ? 0 : 1;
}

try {
  await main();
} catch (error) {
  console.error(`\nERROR: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 2;
}
