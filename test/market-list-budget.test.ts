import assert from "node:assert/strict";
import test from "node:test";
import { ListingReadBudget } from "../src/market-list-budget.js";

function setup() {
  let time = 10_000;
  const values = new Map<string, string>();
  const sleeps: number[] = [];
  const store = { get: (key: string) => values.get(key), set: (key: string, value: string) => { values.set(key, value); } };
  const create = () => new ListingReadBudget(store, { now: () => time, sleep: async ms => { sleeps.push(ms); time += ms; } });
  return { store, values, sleeps, create, now: () => time, setNow: (value: number) => { time = value; } };
}

test("titulares distintos avanzan y cada titular conserva su intervalo tras reinicio", async () => {
  const state = setup(), budget = state.create();
  assert.equal(await budget.waitForDispatch(() => " Owner-A "), "owner-a");
  assert.equal(await budget.waitForDispatch(() => "owner-b"), "owner-b");
  assert.equal(state.now(), 10_000);
  await state.create().waitForDispatch(() => "OWNER-A");
  assert.deepEqual(state.sleeps, [2_401]);
});

test("una espera de un titular no retiene el despacho de otro", async () => {
  let now = 10_000, release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const values = new Map<string, string>();
  const budget = new ListingReadBudget({ get: key => values.get(key), set: (key, value) => { values.set(key, value); } },
    { now: () => now, sleep: async ms => { await blocked; now += ms; } });
  await budget.waitForDispatch(() => "a");
  const waiting = budget.waitForDispatch(() => "a");
  assert.equal(await budget.waitForDispatch(() => "b"), "b");
  release();
  assert.equal(await waiting, "a");
});

test("titular desconocido espera a todos y bloquea a titulares conocidos", async () => {
  const state = setup(), budget = state.create();
  await budget.waitForDispatch(() => "a");
  state.setNow(11_000);
  await budget.waitForDispatch(() => "b");
  await budget.waitForDispatch(() => undefined);
  assert.equal(state.now(), 13_401);
  await budget.waitForDispatch(() => "c");
  assert.equal(state.now(), 15_802);
});

test("429 por titular alcanza alias y al desconocido; 429 desconocido bloquea a todos", async () => {
  const state = setup(), budget = state.create();
  budget.noteRateLimit("Owner-A", 10_000);
  await budget.waitForDispatch(() => "b");
  assert.equal(state.now(), 10_000);
  await state.create().waitForDispatch(() => "owner-a");
  assert.equal(state.now(), 20_000);
  budget.noteRateLimit(undefined, 8_000);
  await budget.waitForDispatch(() => "c");
  assert.equal(state.now(), 28_000);
});

test("un 429 conocido también retrasa una lectura sin identidad", async () => {
  const state = setup(), budget = state.create();
  budget.noteRateLimit("a", 10_000);
  await budget.waitForDispatch(() => undefined);
  assert.equal(state.now(), 20_000);
});

test("revalida identidad tras esperar y usa la identidad final en la reserva", async () => {
  let now = 10_000, owner = "a";
  const values = new Map<string, string>();
  const store = { get: (key: string) => values.get(key), set: (key: string, value: string) => { values.set(key, value); } };
  const budget = new ListingReadBudget(store, { now: () => now, sleep: async ms => { now += ms; owner = "b"; } });
  await budget.waitForDispatch(() => "a");
  assert.equal(await budget.waitForDispatch(() => owner), "b");
  assert.equal(now, 12_401);
});

test("un fallo al persistir no autoriza el despacho", async () => {
  const state = setup();
  let fail = true;
  const budget = new ListingReadBudget({ ...state.store, set: (key, value) => {
    if (fail) { fail = false; throw new Error("disco"); }
    state.store.set(key, value);
  } }, { now: state.now, sleep: async () => undefined });
  await assert.rejects(budget.waitForDispatch(() => "a"), /disco/);
  assert.equal(await budget.waitForDispatch(() => "a"), "a");
});

test("un fallo al registrar 429 bloquea las reservas posteriores", async () => {
  const state = setup();
  let fail = true;
  const budget = new ListingReadBudget({ ...state.store, set: (key, value) => {
    if (fail) { fail = false; throw new Error("disco"); }
    state.store.set(key, value);
  } }, { now: state.now, sleep: async () => undefined });
  assert.throws(() => budget.noteRateLimit("a", 5_000), /disco/);
  await assert.rejects(budget.waitForDispatch(() => "a"), /bloqueados/);
  await assert.rejects(budget.waitForDispatch(() => "b"), /bloqueados/);
});

test("cada reserva escribe un estado y poda titulares vencidos", async () => {
  const state = setup();
  let writes = 0;
  const budget = new ListingReadBudget({ ...state.store, set: (key, value) => { writes++; state.store.set(key, value); } },
    { now: state.now, sleep: async () => undefined });
  await budget.waitForDispatch(() => "a");
  assert.equal(writes, 1);
  state.setNow(13_000);
  await budget.waitForDispatch(() => "b");
  assert.equal(writes, 2);
  const stored = JSON.parse([...state.values.values()][0]!);
  assert.equal(Object.keys(stored.owners).length, 1);
});
