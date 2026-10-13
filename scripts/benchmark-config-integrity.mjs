import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";
import { Store } from "../dist/store.js";

const rows = Number(process.argv[2] ?? 146625);
if (!Number.isInteger(rows) || rows < 1 || rows > 200000) throw new Error("Usa entre 1 y 200000 revisiones.");
const directory = mkdtempSync(join(tmpdir(), "qva-integrity-benchmark-"));
const store = new Store(directory);
try {
  const db = new DatabaseSync(join(directory, "qvaapply.sqlite"));
  try {
    const insert = db.prepare("INSERT INTO config_revisions(created_at,source,reason,config_json,previous_hash,hash) VALUES(?,?,?,?,?,?)");
    const configJson = JSON.stringify({ note: "x".repeat(2280) });
    let previousHash = null;
    db.exec("BEGIN");
    for (let index = 0; index < rows; index++) {
      const revision = { previousHash, createdAt: index + 1, source: "system", reason: null, configJson };
      const hash = createHash("sha256").update(JSON.stringify(revision)).digest("hex");
      insert.run(revision.createdAt, revision.source, null, configJson, previousHash, hash);
      previousHash = hash;
    }
    db.exec("COMMIT");
  } finally { db.close(); }
  global.gc?.();
  const rssBefore = process.memoryUsage().rss;
  const start = performance.now();
  let mainTimerMs;
  const timer = new Promise(resolve => setTimeout(() => { mainTimerMs = performance.now() - start; resolve(); }, 0));
  const first = await store.refreshConfigIntegrity();
  const firstCheckMs = performance.now() - start;
  await timer;
  const repeatedStart = performance.now();
  const repeated = await store.refreshConfigIntegrity();
  console.log(JSON.stringify({ rows, valid: first.valid, firstCheckMs, mainTimerMs,
    repeatedCheckMs: performance.now() - repeatedStart, repeatedVerifiedRows: repeated.verifiedRows,
    rssBeforeMiB: rssBefore / 1048576, rssAfterMiB: process.memoryUsage().rss / 1048576,
    peakMiB: process.resourceUsage().maxRSS / 1024 }, null, 2));
} finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
