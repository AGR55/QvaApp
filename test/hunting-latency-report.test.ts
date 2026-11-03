import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../scripts/report-hunting-latency.mjs';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

const since = '2026-01-01T00:00:00Z', until = '2026-01-02T00:00:00Z';
const start = Date.parse(since), end = Date.parse(until);
function run(db: string, extra: string[] = ['--json']) {
  return main(['--db', db, '--since', since, '--until', until, ...extra]);
}
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'qva-report-'));
  const path = join(directory, 'test.sqlite');
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode=WAL; CREATE TABLE audit_log (id INTEGER PRIMARY KEY, created_at INTEGER NOT NULL, action TEXT NOT NULL, offer_uuid TEXT, detail TEXT NOT NULL)');
  const insert = db.prepare('INSERT INTO audit_log(created_at,action,offer_uuid,detail) VALUES(?,?,?,?)');
  const add = (at: number, action: string, detail: unknown) => insert.run(at, action, 'private-uuid', typeof detail === 'string' ? detail : JSON.stringify(detail));
  return { directory, path, db, add, close: () => { db.close(); rmSync(directory, { recursive: true, force: true }); } };
}

test('informe agrega percentiles, ventanas y datos WAL sin exponer texto libre', t => {
  const f = fixture(); t.after(f.close);
  for (let i = 1; i <= 100; i++) f.add(start + i, 'market_poll_timing', { coin: 'BANK_CUP', side: 'sell', outcome: 'success', requestMs: i, coverageGapMs: i * 2, cacheStatus: 'HIT', sourceAccountId: 'secret-account' });
  f.add(start - 1, 'market_poll_timing', { coin: 'BANK_CUP', side: 'sell', outcome: 'success', requestMs: 9999 });
  f.add(end, 'market_poll_timing', { coin: 'BANK_CUP', side: 'sell', outcome: 'success', requestMs: 9999 });
  f.add(start, 'market_evaluation_timing', { coin: 'unsafe-secret', side: 'unsafe-secret', outcome: 'discarded', reason: 'superseded', queueMs: 10, evaluationMs: 5 });
  f.add(start, 'market_poll_timing', { coin: 'BANK_CUP', side: 'buy', outcome: 'discarded', discardReason: 'credential_changed', requestMs: 13, cacheStatus: 'MISS' });
  f.add(start, 'market_poll_timing', { coin: 'BANK_CUP', side: 'buy', outcome: 'discarded', discardReason: 'secret-token', requestMs: 14 });
  f.add(start + 1, 'offer_apply_timing', { uuid: 'secret-uuid', outcome: 'uncertain', queuedAt: 10, dispatchedAt: null, finishedAt: 20, budgetWaitMs: 0 });
  f.add(start + 1, 'market_feed_queue_timing', { side: 'buy', clock: 'wall', queueMs: 12, uuid: 'secret-uuid' });
  f.add(start + 1, 'qva_list_timing', '{invalid secret-token');
  f.add(start + 1, 'qva_list_timing', { outcome: 'failed', queueMs: -1, responseMs: null, totalMs: 'secret-token' });
  f.add(start + 1, 'qva_list_timing', '{"outcome":"failed","totalMs":1e999}');
  f.add(start + 1, 'qusd_cache_timing', { context: 'fast_lane', outcome: 'hit', cacheAgeMs: 5, balance: 'secret-token' });
  f.add(start + 1, 'qusd_cache_timing', { context: 'fast_lane', outcome: 'miss_epoch', totalMs: 7 });
  f.add(start + 1, 'qusd_cache_timing', { context: 'secret-context', outcome: 'secret-outcome' });
  f.add(start + 1, 'qusd_read_timing', { priority: 'urgent', outcome: 'success', queueMs: 2, responseMs: 10, totalMs: 12, balance: 'secret-balance' });
  f.add(start + 1, 'other_action', { secret: 'secret-token' });
  const before = readFileSync(f.path);
  const result = run(f.path);
  const report = JSON.parse(result);
  assert.equal(report.counts.rows, 112);
  assert.equal(report.counts.malformed, 1);
  assert.ok(report.counts.omittedFields > 0);
  assert.equal(report.counts.invalidFields, 3);
  assert.deepEqual(report.evaluationReasons, { superseded: 1, capacity: 0, control: 0, shutdown: 0, unknown: 0 });
  assert.deepEqual(report.pollDiscardReasons, { credential_changed: 1, superseded: 0, unknown: 1 });
  assert.deepEqual(report.qusdCacheCounts, { 'fast_lane:hit': 1, 'fast_lane:miss_epoch': 1, 'unknown:unknown': 1 });
  assert.ok(report.series.some((item: { channel: string; priority: string; phase: string; p50: number }) => item.channel === 'qusd_read' && item.priority === 'urgent' && item.phase === 'responseMs' && item.p50 === 10));
  const series = report.series.find((item: { channel: string; phase: string; outcome: string }) => item.channel === 'polling' && item.phase === 'requestMs' && item.outcome === 'success');
  assert.deepEqual({ n: series.n, p50: series.p50, p95: series.p95, p99: series.p99, max: series.max }, { n: 100, p50: 50, p95: 95, p99: 99, max: 100 });
  assert.equal(report.series.find((item: { outcome: string; reason: string }) => item.outcome === 'discarded' && item.reason === 'superseded').market, 'unknown');
  assert.match(run(f.path, []), /cache=MISS, reason=credential_changed/);
  assert.ok(report.series.some((item: { channel: string; clock: string }) => item.channel === 'feed' && item.clock === 'wall'));
  assert.equal(report.series.some((item: { outcome: string; phase: string }) => item.outcome === 'uncertain' && item.phase === 'responseMs'), false);
  assert.doesNotMatch(result, /secret|private-uuid/);
  assert.deepEqual(readFileSync(f.path), before);
});

test('errores de argumentos y esquema son seguros y no crean bases', t => {
  const f = fixture(); t.after(f.close);
  const missing = join(f.directory, 'missing.sqlite');
  assert.throws(() => run(missing), /solo lectura/);
  assert.equal(existsSync(missing), false);
  const wrongPath = join(f.directory, 'wrong.sqlite');
  const wrong = new DatabaseSync(wrongPath); wrong.exec('CREATE TABLE other(x)'); wrong.close();
  assert.throws(() => run(wrongPath), /esquema de auditoría/);
  assert.throws(() => main(['--db', f.path]), /--since/);
  assert.throws(() => main(['--db', f.path, '--since', '2026-02-31T00:00:00Z']), /Fecha inválida/);
  assert.throws(() => main(['--db', f.path, '--since', since, '--until', since]), /inválidos/);
  assert.throws(() => main(['--db', f.path, '--since', until, '--until', since]), /inválidos/);
  for (const fraction of ['.1', '.12', '.123']) {
    assert.doesNotThrow(() => main(['--db', f.path, '--since', `2026-01-01T00:00:00${fraction}Z`, '--until', until]));
  }
  const table = run(f.path, []);
  assert.match(table, /Ventana UTC/);
});
