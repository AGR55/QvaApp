#!/usr/bin/env node
import { DatabaseSync } from 'node:sqlite';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const ACTIONS = ['market_poll_timing', 'market_evaluation_timing', 'qva_list_timing', 'market_feed_queue_timing', 'offer_apply_timing', 'qusd_read_timing', 'qusd_cache_timing'];
const MARKETS = new Set(['BANK_CUP', 'BANDECPREPAGO', 'CLASICA', 'ETECSA', 'ZELLE']);
const APPLY_OUTCOMES = new Set(['confirmed', 'uncertain', 'HTTP_400', 'HTTP_401', 'HTTP_403', 'HTTP_409', 'HTTP_429', 'HTTP_500', 'OFFER_CONTENDED', 'OFFER_PAUSED', 'LOCAL_APPLY_QUOTA', 'LOCAL_CONDITIONS_CHANGED', 'LOCAL_PREFLIGHT_FAILED']);
const safe = (value, allowed) => typeof value === 'string' && allowed.has(value) ? value : 'unknown';
const finite = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const outcomes = new Set(['success', 'failed', 'discarded']);
const sides = new Set(['buy', 'sell']);
const caches = new Set(['HIT', 'MISS']);
const clocks = new Set(['wall', 'monotonic']);
const reasons = new Set(['superseded', 'capacity', 'control', 'shutdown']);
const pollReasons = new Set(['credential_changed', 'superseded']);
const qusdContexts = new Set(['fast_lane', 'readiness', 'readiness_after_edit', 'manual', 'warmup']);
const qusdCacheOutcomes = new Set(['hit', 'miss_absent', 'miss_expired', 'miss_epoch', 'read_fresh', 'read_stale', 'read_failed', 'discarded_control']);
const qusdPriorities = new Set(['urgent', 'normal']);

function percentile(sorted, fraction) {
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
}

/** Aggregate only approved timing fields; neither raw audit details nor identifiers leave this function. */
export function buildHuntingLatencyReport(dbPath, since, until = Date.now()) {
  if (typeof dbPath !== 'string' || !dbPath || !Number.isFinite(since) || !Number.isFinite(until) || since >= until)
    throw new Error('Parámetros del informe inválidos.');
  let db;
  try { db = new DatabaseSync(dbPath, { readOnly: true }); }
  catch { throw new Error('No se pudo abrir la base de datos en modo de solo lectura.'); }
  try {
    let rows;
    try {
      rows = db.prepare(`SELECT action, detail FROM audit_log WHERE created_at >= ? AND created_at < ? AND action IN (${ACTIONS.map(() => '?').join(',')})`).iterate(since, until, ...ACTIONS);
    } catch { throw new Error('La base de datos no contiene un esquema de auditoría compatible.'); }
    const counts = { rows: 0, malformed: 0, invalidFields: 0, omittedFields: 0 };
    const byAction = Object.fromEntries(ACTIONS.map(action => [action, 0]));
    const evaluationReasons = { superseded: 0, capacity: 0, control: 0, shutdown: 0, unknown: 0 };
    const pollDiscardReasons = { credential_changed: 0, superseded: 0, unknown: 0 };
    const qusdCacheCounts = {};
    const groups = new Map();
    function add(base, phase, value) {
      if (value === undefined || value === null) { counts.omittedFields++; return; }
      if (!finite(value)) { counts.invalidFields++; return; }
      const dimensions = { ...base, phase };
      const key = JSON.stringify(dimensions);
      const current = groups.get(key) ?? { ...dimensions, values: [] };
      current.values.push(value);
      groups.set(key, current);
    }
    for (const row of rows) {
      counts.rows++;
      byAction[row.action]++;
      let data;
      try { data = JSON.parse(row.detail); } catch { counts.malformed++; continue; }
      if (!data || typeof data !== 'object' || Array.isArray(data)) { counts.malformed++; continue; }
      const market = safe(data.coin, MARKETS);
      const side = safe(data.side, sides);
      if (row.action === 'market_poll_timing') {
        const reason = safe(data.discardReason, pollReasons);
        if (data.outcome === 'discarded') pollDiscardReasons[reason]++;
        const base = { channel: 'polling', market, side, outcome: safe(data.outcome, outcomes), cache: safe(data.cacheStatus, caches), reason };
        add(base, 'requestMs', data.requestMs);
        add(base, 'coverageGapMs', data.coverageGapMs);
        const transport = data.transport && typeof data.transport === 'object' && !Array.isArray(data.transport) ? data.transport : {};
        for (const name of ['queueMs', 'responseMs', 'totalMs']) add(base, `transport.${name}`, transport[name]);
      } else if (row.action === 'market_evaluation_timing') {
        const reason = safe(data.reason, reasons);
        if (data.outcome === 'discarded') evaluationReasons[reason]++;
        const base = { channel: 'polling', market, side, outcome: safe(data.outcome, outcomes), reason };
        add(base, 'queueMs', data.queueMs);
        add(base, 'evaluationMs', data.evaluationMs);
      } else if (row.action === 'qva_list_timing') {
        const base = { channel: 'unknown', market: 'unknown', side: 'unknown', outcome: safe(data.outcome, outcomes), cache: safe(data.cacheStatus, caches) };
        for (const name of ['queueMs', 'responseMs', 'totalMs']) add(base, name, data[name]);
      } else if (row.action === 'market_feed_queue_timing') {
        add({ channel: 'feed', market: 'unknown', side, outcome: 'unknown', clock: safe(data.clock, clocks) }, 'queueMs', data.queueMs);
      } else if (row.action === 'qusd_read_timing') {
        const base = { channel: 'qusd_read', market: 'unknown', side: 'unknown', priority: safe(data.priority, qusdPriorities), outcome: safe(data.outcome, outcomes) };
        for (const name of ['queueMs', 'responseMs', 'totalMs']) add(base, name, data[name]);
      } else if (row.action === 'qusd_cache_timing') {
        const context = safe(data.context, qusdContexts), outcome = safe(data.outcome, qusdCacheOutcomes);
        const key = `${context}:${outcome}`;
        qusdCacheCounts[key] = (qusdCacheCounts[key] ?? 0) + 1;
        const base = { channel: 'qusd_cache', market: 'unknown', side: 'unknown', context, outcome };
        for (const name of ['cacheAgeMs', 'totalMs']) add(base, name, data[name]);
      } else if (row.action === 'offer_apply_timing') {
        const base = { channel: 'unknown', market: 'unknown', side: 'unknown', outcome: safe(data.outcome, APPLY_OUTCOMES) };
        const queued = data.queuedAt, dispatched = data.dispatchedAt, finished = data.finishedAt;
        add(base, 'queueMs', finite(queued) && finite(dispatched) ? dispatched - queued : dispatched == null ? undefined : NaN);
        add(base, 'responseMs', finite(dispatched) && finite(finished) ? finished - dispatched : dispatched == null ? undefined : NaN);
        add(base, 'budgetWaitMs', data.budgetWaitMs);
      }
    }
    const series = [...groups.values()].map(({ values, ...dimensions }) => {
      values.sort((a, b) => a - b);
      return { ...dimensions, n: values.length, p50: percentile(values, .5), p95: percentile(values, .95), p99: percentile(values, .99), max: values.at(-1) };
    }).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    return { window: { since: new Date(since).toISOString(), until: new Date(until).toISOString(), bounds: '[since, until)' }, counts, byAction, evaluationReasons, pollDiscardReasons, qusdCacheCounts, series };
  } catch (error) {
    if (error instanceof Error && error.message === 'La base de datos no contiene un esquema de auditoría compatible.') throw error;
    throw new Error('No se pudo leer la auditoría de forma segura.');
  } finally { db.close(); }
}

function parseUtc(value) {
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(value ?? '')) throw new Error('Las fechas deben ser ISO 8601 UTC con Z.');
  const timestamp = Date.parse(value);
  const canonical = value.replace(/(?:\.(\d{1,3}))?Z$/, (_, fraction = '') => `.${fraction.padEnd(3, '0')}Z`);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== canonical) throw new Error('Fecha inválida.');
  return timestamp;
}

export function main(args) {
  const values = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--json') { if (values.json) throw new Error('Opción duplicada.'); values.json = true; continue; }
    if (!['--db', '--since', '--until'].includes(arg) || values[arg] !== undefined || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error('Argumentos inválidos.');
    values[arg] = args[++i];
  }
  if (!values['--db'] || !values['--since']) throw new Error('Se requieren --db y --since.');
  const report = buildHuntingLatencyReport(values['--db'], parseUtc(values['--since']), values['--until'] ? parseUtc(values['--until']) : Date.now());
  if (values.json) return JSON.stringify(report, null, 2);
  const lines = [`Ventana UTC ${report.window.since} ≤ fecha < ${report.window.until}`,
    `Filas ${report.counts.rows}; JSON inválido ${report.counts.malformed}; campos omitidos ${report.counts.omittedFields}; campos inválidos ${report.counts.invalidFields}`,
    `Descartes: ${Object.entries(report.evaluationReasons).map(([reason, count]) => `${reason}=${count}`).join(', ')}`,
    `Descartes de sondeo: ${Object.entries(report.pollDiscardReasons).map(([reason, count]) => `${reason}=${count}`).join(', ')}`,
    `Caché QUSD (contexto:resultado): ${Object.entries(report.qusdCacheCounts).map(([key, count]) => `${key}=${count}`).join(', ') || 'sin datos'}`,
    'Canal | Mercado | Lado | Resultado | Fase | n | p50 ms | p95 ms | p99 ms | máx ms | Detalle'];
  for (const item of report.series) lines.push([item.channel, item.market, item.side, item.outcome, item.phase, item.n, item.p50, item.p95, item.p99, item.max, [item.cache && `cache=${item.cache}`, item.clock && `clock=${item.clock}`, item.context && `context=${item.context}`, item.priority && `priority=${item.priority}`, item.outcome === 'discarded' && item.reason && `reason=${item.reason}`].filter(Boolean).join(', ')].join(' | '));
  return lines.join('\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { console.log(main(process.argv.slice(2))); }
  catch (error) {
    console.error(error instanceof Error ? error.message : 'Error al generar el informe.');
    console.error('Uso: node scripts/report-hunting-latency.mjs --db RUTA --since FECHA_UTC [--until FECHA_UTC] [--json]');
    console.error('--until por defecto es el instante actual UTC.');
    process.exitCode = 1;
  }
}
