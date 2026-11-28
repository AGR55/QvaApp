#!/usr/bin/env node
/**
 * Compara saldos, ledger y operaciones entre una COPIA SQLite v31 y Postgres.
 * No abre ni modifica el origen real.
 *
 * Uso:
 *   PGDATABASE=qvaapply_f1 node services/db/verify-money.mjs \
 *     --source /tmp/copy-v31.sqlite
 */
import { createHash } from "node:crypto";
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";

const sourceIndex = process.argv.indexOf("--source");
if (sourceIndex < 0) throw new Error("Falta --source");
const source = resolve(process.argv[sourceIndex + 1]);
const database = process.env.PGDATABASE ?? "qvaapply_f1";
const before = sha256(source);
const temp = mkdtempSync(join(tmpdir(), "qva-verify-money-"));
const copy = join(temp, basename(source));
copyFileSync(source, copy);

let sqlite;
try {
  sqlite = new DatabaseSync(copy, { readOnly: true });
  const sqliteBalances = Object.fromEntries(
    sqlite
      .prepare("SELECT key, value FROM settings WHERE key LIKE 'fiat_balance:%' ORDER BY key")
      .all()
      .map((row) => [row.key, String(row.value)]),
  );
  const sqliteLedger = sqlite
    .prepare(
      "SELECT coin, direction, COUNT(*) AS count, printf('%.8f', COALESCE(SUM(amount),0)) AS total " +
        "FROM fiat_ledger GROUP BY coin, direction ORDER BY coin, direction",
    )
    .all()
    .map((row) => `${row.coin}\t${row.direction}\t${row.count}\t${row.total}`);
  const sqliteOperations = sqlite
    .prepare("SELECT COUNT(*) AS count, printf('%.8f', COALESCE(SUM(amount),0)) AS total FROM operations")
    .get();

  const pgBalances = Object.fromEntries(
    psql(
      "SELECT key, value FROM core.settings WHERE key LIKE 'fiat_balance:%' ORDER BY key",
    )
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => line.split("\t")),
  );
  const pgLedger = psql(
    "SELECT coin, direction, count(*), to_char(SUM(amount), 'FM999999999999999990.00000000') " +
      "FROM core.fiat_ledger GROUP BY coin, direction ORDER BY coin, direction",
  )
    .trim()
    .split("\n")
    .filter(Boolean);
  const [pgOperationsCount, pgOperationsTotal] = psql(
    "SELECT count(*), to_char(SUM(amount), 'FM999999999999999990.00000000') FROM core.operations",
  )
    .trim()
    .split("\t");

  const errors = [];
  if (JSON.stringify(sqliteBalances) !== JSON.stringify(pgBalances))
    errors.push("saldos fiat distintos");
  if (JSON.stringify(sqliteLedger) !== JSON.stringify(pgLedger))
    errors.push("agregados de ledger distintos");
  if (String(sqliteOperations.count) !== String(pgOperationsCount))
    errors.push(`operaciones: ${sqliteOperations.count} != ${pgOperationsCount}`);
  if (String(sqliteOperations.total) !== String(pgOperationsTotal))
    errors.push(`importe de operaciones: ${sqliteOperations.total} != ${pgOperationsTotal}`);

  if (sha256(source) !== before) throw new Error("la copia de origen cambió");
  if (errors.length) {
    console.error(`verify-money: ${errors.join("; ")}`);
    process.exitCode = 1;
  } else {
    console.log(
      `verify-money: OK · ${Object.keys(pgBalances).length} saldos · ` +
        `${pgLedger.length} grupos de ledger · ${pgOperationsCount} operaciones`,
    );
  }
} finally {
  sqlite?.close();
  rmSync(temp, { recursive: true, force: true });
}

function psql(sql) {
  const result = spawnSync(
    "psql",
    ["-X", "-q", "-At", "-F", "\t", "-v", "ON_ERROR_STOP=1", "-d", database, "-c", sql],
    { encoding: "utf8" },
  );
  if (result.status !== 0) throw new Error((result.stderr || "").trim());
  return result.stdout;
}

function sha256(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}
