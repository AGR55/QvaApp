import assert from 'node:assert/strict';
import test from 'node:test';
import { QvaApiError, QvaPayClient } from '../src/qvapay.js';
import type { ListTiming } from '../src/types.js';
import { ListingReadBudget } from '../src/market-list-budget.js';

test('identidad de listado queda vinculada al token autenticado aunque cambie la sesión durante perfil', async () => {
  let token = 'fixture-session-a', release!: () => void, entered!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  const settings = new Map<string, string>([['analytics_account_uuid', 'stale-owner']]);
  const client = new QvaPayClient(() => token, {
    throttleState: { get: key => settings.get(key), set: (key, value) => { settings.set(key, value); } },
    sleep: async () => {},
    fetch: async (_url, init) => {
      const original = new Headers(init?.headers).get('authorization') === 'Bearer fixture-session-a';
      if (original) { entered(); await blocked; }
      return new Response(JSON.stringify({ uuid: original ? 'owner-a' : 'owner-b' }));
    },
  });
  const oldProfile = client.profile();
  await started;
  token = 'fixture-session-b';
  release(); await oldProfile;
  assert.equal(settings.get('analytics_account_uuid'), 'owner-a');
  assert.equal(client.verifiedListingOwner(token), undefined, 'no hereda el dueño de la sesión anterior');
  assert.equal(client.verifiedListingOwner('fixture-session-a'), 'owner-a');
  await client.profile();
  assert.equal(client.verifiedListingOwner(token), 'owner-b');
});

test('dos clientes del mismo titular comparten intervalo y 429 desconocido bloquea al resto', async () => {
  let clock = 10000;
  const values = new Map<string, string>();
  const budget = new ListingReadBudget({ get: key => values.get(key), set: (key, value) => { values.set(key, value); } },
    { now: () => clock, sleep: async ms => { clock += ms; } });
  const dispatches: number[] = [];
  const client = (owner: string | undefined, limited = false) => new QvaPayClient(() => 'fixture-token', {
    now: () => clock, sleep: async ms => { clock += ms; },
    listBudget: { waitForDispatch: () => budget.waitForDispatch(() => owner), noteRateLimit: (identity, ms) => budget.noteRateLimit(identity, ms) },
    fetch: async () => { dispatches.push(clock); return new Response('{"data":[]}', limited ? { status: 429, headers: { 'retry-after': '10' } } : {}); },
  });
  await client('same-owner').listOffersPage({});
  await client('SAME-OWNER').listOffersPage({});
  assert.deepEqual(dispatches, [10000, 12401]);
  await assert.rejects(client(undefined, true).listOffersPage({}), QvaApiError);
  const limitedAt = clock;
  await client('independent-owner').listOffersPage({});
  assert.equal(clock, limitedAt + 10000);
});

test('presupuesto recibe el token capturado que realmente se enviará tras esperar', async () => {
  let token = 'fixture-original', release!: () => void, entered!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  let reservedToken: string | undefined, authorization: string | null = null;
  const client = new QvaPayClient(() => token, {
    listBudget: { waitForDispatch: async captured => { reservedToken = captured; entered(); await blocked; return 'owner-original'; }, noteRateLimit: () => {} },
    fetch: async (_url, init) => { authorization = new Headers(init?.headers).get('authorization'); return new Response('{"data":[]}'); },
  });
  const request = client.listOffersPage({});
  await started;
  token = 'fixture-replacement';
  release(); await request;
  assert.equal(reservedToken, 'fixture-original');
  assert.equal(authorization, 'Bearer fixture-original');
});

test('cada reintento de red reserva su propio presupuesto y 429 conserva el propietario del intento', async () => {
  const calls: string[] = [];
  let attempt = 0, clock = 0;
  const timings: ListTiming[] = [];
  const client = new QvaPayClient(() => 'token', {
    monotonicNow: () => clock,
    sleep: async ms => { clock += ms; },
    listBudget: {
      waitForDispatch: async () => { calls.push(`reserve-${++attempt}`); clock += 10; return `owner-${attempt}`; },
      noteRateLimit: (owner, retry) => { calls.push(`429-${owner}-${retry}`); },
    },
    fetch: async () => { calls.push(`fetch-${attempt}`); clock += 5; if (attempt === 1) throw new Error('network'); return new Response('{}', { status: 429, headers: { 'retry-after': '4' } }); },
    onListTiming: timing => timings.push(timing),
  });
  await assert.rejects(client.listOffersPage({}), (error: unknown) => error instanceof QvaApiError && error.status === 429);
  assert.deepEqual(calls, ['reserve-1', 'fetch-1', 'reserve-2', 'fetch-2', '429-owner-2-4000']);
  assert.equal(timings[0]?.queueMs, 10);
  assert.equal(timings[0]?.responseMs, 820);
  assert.equal(timings[0]?.attempts, 2);
});

test('fallar al reservar detiene sin red ni reintento y conserva las métricas sin despacho', async () => {
  let waits = 0, fetches = 0;
  const timings: ListTiming[] = [];
  const problem = new Error('budget unavailable');
  const client = new QvaPayClient(() => 'token', {
    listBudget: { waitForDispatch: async () => { waits++; throw problem; }, noteRateLimit: () => assert.fail('no hubo respuesta') },
    fetch: async () => { fetches++; return new Response('{}'); }, onListTiming: timing => timings.push(timing),
  });
  await assert.rejects(client.listOffersPage({}), error => error === problem);
  assert.equal(waits, 1);
  assert.equal(fetches, 0);
  assert.equal(timings[0]?.attempts, 0);
  assert.equal(timings[0]?.queueMs, null);
  assert.equal(timings[0]?.responseMs, null);
});

test('fallo al registrar 429 no repite consulta; otras políticas no usan presupuesto', async () => {
  let waits = 0, posts = 0, notes = 0;
  const failure = new Error('store unavailable');
  const client = new QvaPayClient(() => 'token', {
    sleep: async () => {}, now: () => 100000,
    listBudget: { waitForDispatch: async () => { waits++; return undefined; }, noteRateLimit: (owner, retry) => { assert.equal(owner, undefined); assert.equal(retry, undefined); notes++; throw failure; } },
    fetch: async input => {
      if (String(input).endsWith('/apply')) { posts++; return new Response('{}'); }
      if (String(input).includes('/p2p/other')) return new Response(JSON.stringify({ p2p: { uuid: 'other', type: 'sell', coin: 'BANK_CUP', amount: 1, receive: 1, status: 'open' } }));
      return new Response('{}', { status: 429 });
    },
  });
  await assert.rejects(client.listOffersPage({}), error => error === failure);
  assert.equal(waits, 1);
  assert.equal(notes, 1);
  await client.getOffer('other');
  await client.apply('other', { beforeDispatch: () => true });
  assert.equal(waits, 1);
  assert.equal(posts, 1);
});
