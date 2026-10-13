import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { isMainThread, parentPort, workerData } from "node:worker_threads";

export interface RevisionCheckpoint {
  lastId: number;
  hash: string | null;
  epoch: number;
  valid: boolean;
}
export interface RevisionCheck extends RevisionCheckpoint { verifiedRows: number }

export function configRevisionHash(previousHash: string | null, createdAt: number, source: string,
  reason: string | null, configJson: string): string {
  return createHash("sha256").update(JSON.stringify({ previousHash, createdAt, source, reason, configJson })).digest("hex");
}

/** Historical edits invalidate the checkpoint; normal appends only verify the new tail. */
export function checkConfigRevisions(db: DatabaseSync, previous?: RevisionCheckpoint): RevisionCheck {
  db.exec("BEGIN");
  try {
    const epoch = Number((db.prepare("SELECT version FROM config_integrity_epoch WHERE id=1").get() as { version: number }).version);
    const head = db.prepare("SELECT id,hash FROM config_revisions ORDER BY id DESC LIMIT 1").get() as { id: number; hash: string } | undefined;
    const lastId = head?.id ?? 0;
    const hash = head?.hash ?? null;
    if (!head && epoch > 0) return { lastId, hash, epoch, valid: false, verifiedRows: 0 };
    if (previous?.epoch === epoch && previous.lastId === lastId && previous.hash === hash)
      return { ...previous, verifiedRows: 0 };
    const incremental = previous?.valid && previous.epoch === epoch && previous.lastId < lastId;
    let previousHash = incremental ? previous.hash : null;
    let verifiedRows = 0;
    const rows = db.prepare(`SELECT created_at,source,reason,config_json,previous_hash,hash FROM config_revisions
      WHERE id > ? ORDER BY id ASC`).iterate(incremental ? previous.lastId : 0);
    for (const row of rows) {
      verifiedRows++;
      if (row.previous_hash !== previousHash || configRevisionHash(previousHash, Number(row.created_at), String(row.source),
        row.reason === null ? null : String(row.reason), String(row.config_json)) !== row.hash)
        return { lastId, hash, epoch, valid: false, verifiedRows };
      previousHash = String(row.hash);
    }
    return { lastId, hash, epoch, valid: true, verifiedRows };
  } finally { db.exec("ROLLBACK"); }
}

// This module also runs as a worker so neither startup verification nor historical
// tampering requires scanning the chain on the hunting event loop.
if (!isMainThread) {
  const db = new DatabaseSync((workerData as { path: string }).path, { readOnly: true });
  db.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=1000;");
  let checkpoint: RevisionCheckpoint | undefined;
  parentPort!.on("message", () => {
    try {
      const result = checkConfigRevisions(db, checkpoint);
      checkpoint = result;
      parentPort!.postMessage({ result });
    } catch { parentPort!.postMessage({ error: "No se pudo comprobar la integridad de la configuración." }); }
  });
}
