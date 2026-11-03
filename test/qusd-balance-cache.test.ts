import assert from "node:assert/strict";
import test from "node:test";
import { QusdBalanceCache, type QusdBalanceTiming } from "../src/qusd-balance-cache.js";

const options = { priority: true, context: "fast_lane" as const };
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test("reutiliza saldo bruto solo dentro del TTL y época, sin renovar su edad", async () => {
  let now = 100_000, epoch = "1", reads = 0;
  const events: QusdBalanceTiming[] = [];
  const cache = new QusdBalanceCache({ read: async () => ++reads * 10, epoch: () => epoch, now: () => now, observe: event => events.push(event) });
  assert.equal(await cache.get(options), 10);
  now += 15_000;
  assert.equal(await cache.get(options), 10);
  now++;
  assert.equal(await cache.get(options), 20);
  epoch = "2";
  assert.equal(await cache.get(options), 30);
  assert.deepEqual(events.filter(e => e.outcome.startsWith("miss")).map(e => e.outcome), ["miss_absent", "miss_expired", "miss_epoch"]);
});

test("una lectura normal retenida no bloquea la urgente y cada prioridad comparte su propia lectura", async () => {
  const background = deferred<number>(), priority = deferred<number>();
  const calls: boolean[] = [];
  const cache = new QusdBalanceCache({ epoch: () => "1", read: p => { calls.push(p); return p ? priority.promise : background.promise; } });
  const normal = cache.get({ priority: false, context: "warmup" });
  const first = cache.get(options), second = cache.get(options);
  assert.deepEqual(calls, [false, true]);
  priority.resolve(25);
  assert.deepEqual(await Promise.all([first, second]), [25, 25]);
  background.resolve(40);
  assert.equal(await normal, 25, "el resultado anterior no sustituye una lectura más reciente");
});

test("la respuesta urgente posterior prevalece aunque la normal termine primero", async () => {
  const normal = deferred<number>(), urgent = deferred<number>();
  const cache = new QusdBalanceCache({ epoch: () => "1", read: priority => priority ? urgent.promise : normal.promise });
  const background = cache.get({ priority: false, context: "warmup" });
  const priority = cache.get(options);
  normal.resolve(100);
  assert.equal(await background, 100);
  urgent.resolve(0);
  assert.equal(await priority, 0);
  assert.equal(cache.peek()?.value, 0);
});

test("la respuesta normal tardía no sustituye la urgente posterior", async () => {
  const normal = deferred<number>(), urgent = deferred<number>();
  const cache = new QusdBalanceCache({ epoch: () => "1", read: priority => priority ? urgent.promise : normal.promise });
  const background = cache.get({ priority: false, context: "warmup" });
  const priority = cache.get(options);
  urgent.resolve(0);
  assert.equal(await priority, 0);
  normal.resolve(100);
  assert.equal(await background, 0);
  assert.equal(cache.peek()?.value, 0);
});

test("un refresco forzado acepta la respuesta remota posterior sin consultar de nuevo", async () => {
  const normal = deferred<number>(), urgent = deferred<number>();
  let calls = 0;
  const cache = new QusdBalanceCache({ epoch: () => "1", read: priority => { calls++; return priority ? urgent.promise : normal.promise; } });
  const background = cache.get({ priority: false, context: "warmup", force: true });
  const priority = cache.get(options);
  urgent.resolve(0);
  assert.equal(await priority, 0);
  normal.resolve(100);
  assert.equal(await background, 0);
  assert.equal(cache.peek()?.value, 0);
  assert.equal(calls, 2);
});

test("época y revisión impiden devolver una respuesta vieja", async () => {
  let epoch = "old", calls = 0;
  const old = deferred<number>();
  const cache = new QusdBalanceCache({ epoch: () => epoch, read: () => ++calls === 1 ? old.promise : Promise.resolve(30) });
  const result = cache.get(options);
  epoch = "new";
  cache.replace(20);
  old.resolve(999);
  assert.equal(await result, 20);
  assert.equal(cache.peek()?.value, 20);
  assert.equal(calls, 1);
});

test("force renueva incluso con caché válida y ante invalidación reintenta", async () => {
  const first = deferred<number>(); let calls = 0;
  const cache = new QusdBalanceCache({ epoch: () => "1", read: () => ++calls === 1 ? first.promise : Promise.resolve(9) });
  cache.replace(5);
  const pending = cache.get({ ...options, force: true });
  cache.replace(6);
  first.resolve(500);
  assert.equal(await pending, 9);
  assert.equal(calls, 2);
});

test("limita a cuatro lecturas activas", async () => {
  const pending = Array.from({ length: 4 }, () => deferred<number>());
  let epoch = "0", calls = 0;
  const cache = new QusdBalanceCache({ epoch: () => epoch, read: () => pending[calls++]!.promise });
  const running: Promise<number>[] = [];
  for (let i = 0; i < 4; i++) { epoch = String(i); running.push(cache.get(options)); }
  epoch = "4";
  await assert.rejects(cache.get(options), /Demasiadas/);
  const stopping = cache.stop();
  for (const item of pending) item.resolve(10);
  assert.ok((await Promise.allSettled(running)).every(result => result.status === "rejected"));
  await stopping;
});

test("corta tras tres invalidaciones durante una lectura forzada", async () => {
  let epoch = 0, calls = 0;
  const cache = new QusdBalanceCache({ epoch: () => String(epoch), read: async () => { calls++; epoch++; return 10; } });
  await assert.rejects(cache.get({ ...options, force: true }), /cambió/);
  assert.equal(calls, 3);
  assert.equal(cache.peek(), undefined);
});

test("errores y saldo inválido no refrescan caché; telemetría no afecta el resultado", async () => {
  let calls = 0;
  const cache = new QusdBalanceCache({ epoch: () => "1", read: async () => ++calls === 1 ? NaN : 8,
    observe: () => { throw new Error("telemetría"); } });
  await assert.rejects(cache.get(options), /Saldo QUSD/);
  assert.equal(cache.peek(), undefined);
  assert.equal(await cache.get(options), 8);
  assert.throws(() => cache.replace(-1), /inválido/);
});

test("conserva el error original de la lectura", async () => {
  const expected = Object.assign(new Error("límite remoto"), { status: 429 });
  const cache = new QusdBalanceCache({ epoch: () => "1", read: async () => { throw expected; } });
  await assert.rejects(cache.get(options), error => error === expected);
});

test("stop espera lectura en curso e impide nuevas consultas", async () => {
  const read = deferred<number>(); let stopped = false, calls = 0;
  const cache = new QusdBalanceCache({ epoch: () => "1", read: () => { calls++; return read.promise; } });
  const request = cache.get(options);
  const closing = cache.stop().then(() => { stopped = true; });
  await assert.rejects(cache.get(options), /cerrada/);
  assert.equal(stopped, false);
  read.resolve(10);
  await assert.rejects(request, /cerrada/);
  await closing;
  assert.equal(calls, 1);
  assert.equal(cache.peek(), undefined);
});

test("si cambia el control durante la lectura no retorna ni reintenta", async () => {
  const read = deferred<number>();
  let current = true, epoch = "old", calls = 0;
  const events: QusdBalanceTiming[] = [];
  const cache = new QusdBalanceCache({ epoch: () => epoch, read: () => { calls++; return read.promise; }, observe: event => events.push(event) });
  const request = cache.get({ priority: false, context: "warmup", force: true, isCurrent: () => current });
  current = false;
  epoch = "new";
  read.resolve(10);
  await assert.rejects(request, /detenida/);
  assert.equal(cache.peek(), undefined);
  assert.equal(calls, 1);
  assert.equal(events.at(-1)?.outcome, "discarded_control");
});
