import assert from 'node:assert/strict';
import test from 'node:test';
import { QvaApiError, QvaPayClient } from '../src/qvapay.js';
import type { QusdReadTiming } from '../src/types.js';

test('mide cola prioritaria y reintentos hasta JSON sin exponer saldo o credenciales', async () => {
  let clock = 0, calls = 0;
  const seen: QusdReadTiming[] = [];
  const client = new QvaPayClient(() => 'private-token', {
    now: () => 1000, monotonicNow: () => clock, sleep: async ms => { clock += ms; },
    fetch: async () => { clock += 5; if (++calls === 2) throw new Error('network'); return new Response('{"balance":42}'); },
    onQusdReadTiming: timing => seen.push(timing),
  });
  assert.equal(await client.qusdBalance({ priority: true }), 42);
  assert.equal(await client.qusdBalance({ priority: true }), 42);
  assert.deepEqual(seen[0], { priority: 'urgent', outcome: 'success', queueMs: 0, responseMs: 5, totalMs: 5 });
  assert.deepEqual(seen[1], { priority: 'urgent', outcome: 'success', queueMs: 1667, responseMs: 810, totalMs: 2477 });
  assert.doesNotMatch(JSON.stringify(seen), /private-token|balance|42/);
});

test('callback fallido no altera resultado y errores conservan etapas medidas', async () => {
  const seen: QusdReadTiming[] = [];
  let clock = 0, calls = 0;
  const client = new QvaPayClient(() => 'token', {
    monotonicNow: () => clock,
    fetch: async () => { clock += 10; return new Response(++calls === 1 ? '{"balance":1}' : '{}'); },
    sleep: async ms => { clock += ms; }, now: () => 1000,
    onQusdReadTiming: timing => { seen.push(timing); throw new Error('observer'); },
  });
  assert.equal(await client.qusdBalance(), 1);
  await assert.rejects(client.qusdBalance(), /saldo QUSD reconocible/);
  assert.equal(seen[1]?.outcome, 'failed');
  assert.equal(seen[1]?.priority, 'normal');
  assert.equal(seen[1]?.responseMs, 10);
  const absent = new QvaPayClient(() => undefined, { monotonicNow: () => clock, onQusdReadTiming: timing => seen.push(timing) });
  await assert.rejects(absent.qusdBalance(), QvaApiError);
  assert.deepEqual(seen[2], { priority: 'normal', outcome: 'failed', queueMs: null, responseMs: null, totalMs: 0 });
});
