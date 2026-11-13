#!/usr/bin/env node
/**
 * Genera un fixture SQLite mínimo compatible con el importador y los triggers.
 * No contiene datos reales. Uso en CI:
 *   node services/db/generate-fixture.mjs --out /tmp/minimal-v31.sqlite
 */
import { mkdirSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

const outIndex = process.argv.indexOf("--out");
const out = resolve(outIndex >= 0 ? process.argv[outIndex + 1] : "services/db/fixtures/minimal-v31.sqlite");
mkdirSync(dirname(out), { recursive: true });
rmSync(out, { force: true });

const db = new DatabaseSync(out);
db.exec(`
  PRAGMA journal_mode = DELETE;
  CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY);
  INSERT INTO schema_migrations(version) VALUES (31);

  CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  INSERT INTO settings(key, value) VALUES
    ('fiat_balance:CUP', '100'),
    ('analytics_account_uuid', 'fixture-owner');

  CREATE TABLE config_integrity_epoch (id INTEGER PRIMARY KEY, version INTEGER NOT NULL);
  INSERT INTO config_integrity_epoch(id, version) VALUES (1, 0);

  CREATE TABLE config_revisions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at INTEGER,
    source TEXT,
    reason TEXT,
    config_json TEXT,
    previous_hash TEXT,
    hash TEXT
  );
  INSERT INTO config_revisions(id, created_at, source, reason, config_json, previous_hash, hash)
    VALUES (1, 1, 'fixture', 'one', '{}', '', 'h1'),
           (2, 2, 'fixture', 'two', '{}', 'h1', 'h2');

  CREATE TABLE mutation_intents (
    intent_id TEXT PRIMARY KEY,
    operation_uuid TEXT,
    kind TEXT,
    idempotency_key TEXT,
    state TEXT,
    request_json TEXT,
    response_json TEXT,
    error TEXT,
    created_at INTEGER,
    updated_at INTEGER,
    workflow_id TEXT
  );
  INSERT INTO mutation_intents(intent_id, operation_uuid, kind, state, created_at)
    VALUES ('intent-1', 'offer-1', 'apply', 'submitted', 1);

  CREATE TABLE application_capital_reservations (
    intent_id TEXT PRIMARY KEY,
    offer_uuid TEXT,
    coin TEXT,
    fiat REAL,
    qusd REAL,
    amount REAL
  );
  INSERT INTO application_capital_reservations(intent_id, offer_uuid, coin, fiat, qusd, amount)
    VALUES ('intent-1', 'offer-1', 'CUP', 100, 100, 1);

  CREATE TABLE fiat_balance_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    coin TEXT NOT NULL,
    balance_before REAL,
    balance_after REAL,
    amount REAL,
    operation_uuid TEXT,
    ledger_id INTEGER,
    source TEXT,
    kind TEXT,
    created_at INTEGER
  );
`);
db.close();
console.log(out);
