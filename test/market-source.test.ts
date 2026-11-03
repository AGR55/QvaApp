import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { MarketAccountService } from "../src/market-accounts.js";
import { PollingMarketSource, weightedMarketJobs, type MarketPollTiming } from "../src/market-source.js";
import { QvaApiError } from "../src/qvapay.js";
import { Store } from "../src/store.js";
import { Vault } from "../src/vault.js";

const emptyPage = { offers: [], total: 0, currentPage: 1, perPage: 100 };

async function setup(
  read: (token: string, at: number) => Promise<typeof emptyPage>,
  secondaryTokens = ["secondary-reader-token"],
) {
  let now = 1_000_000;
  let ready = false;
  const calls: Array<{ token: string; at: number }> = [];
  const timings: MarketPollTiming[] = [];
  const store = new Store(mkdtempSync(join(tmpdir(), "qvaapply-market-source-")));
  const vault = new Vault("a".repeat(64));
  const factory = (token: string) => ({
    listOffersPage: async () => {
      calls.push({ token, at: now });
      return ready ? read(token, now) : emptyPage;
    },
  });
  const accounts = new MarketAccountService(store, vault, factory);
  for (const [index, token] of secondaryTokens.entries())
    await accounts.add({
      label: `Secundaria ${index + 1}`,
      token,
      intervalSeconds: 3,
    });
  ready = true;
  calls.length = 0;
  const createSource = () => new PollingMarketSource(
    store,
    accounts,
    factory("primary-token"),
    () => 3,
    () => [{ coin: "BANK_CUP", side: "sell" }],
    { now: () => now, onPollTiming: timing => timings.push(timing) },
  );
  return {
    store,
    accounts,
    source: createSource(),
    createSource,
    calls,
    timings,
    setNow(value: number) { now = value; },
  };
}

test("intercala dos cuentas a tres segundos en turnos de 1.5 segundos", async () => {
  const state = await setup(async () => emptyPage);

  await state.source.pollNext();
  state.setNow(1_001_499);
  await state.source.pollNext();
  state.setNow(1_001_500);
  await state.source.pollNext();
  state.setNow(1_003_000);
  await state.source.pollNext();

  assert.deepEqual(state.calls, [
    { token: "primary-token", at: 1_000_000 },
    { token: "secondary-reader-token", at: 1_001_500 },
    { token: "primary-token", at: 1_003_000 },
  ]);
  assert.equal(state.source.status().effectiveCadenceSeconds, 1.5);
  assert.equal(state.source.status().estimatedRequestsPerMinute, 40);
  state.store.close();
});

test("reparte de forma justa una cantidad arbitraria de cuentas", async () => {
  const state = await setup(async () => emptyPage, [
    "secondary-reader-one",
    "secondary-reader-two",
  ]);

  await state.source.pollNext();
  state.setNow(1_001_000);
  await state.source.pollNext();
  state.setNow(1_002_000);
  await state.source.pollNext();
  state.setNow(1_003_000);
  await state.source.pollNext();

  assert.deepEqual(state.calls.map((call) => call.at), [
    1_000_000,
    1_001_000,
    1_002_000,
    1_003_000,
  ]);
  assert.equal(state.calls[0]?.token, "primary-token");
  assert.deepEqual(
    state.calls.slice(1, 3).map((call) => call.token).sort(),
    ["secondary-reader-one", "secondary-reader-two"],
  );
  assert.equal(state.calls[3]?.token, "primary-token");
  assert.equal(state.source.status().healthyAccounts, 3);
  assert.equal(state.source.status().effectiveCadenceSeconds, 1);
  state.store.close();
});

test("un 429 enfría solo la cuenta afectada y respeta Retry-After", async () => {
  const state = await setup(async (token) => {
    if (token.startsWith("secondary"))
      throw new QvaApiError(429, "Demasiadas solicitudes", 10_000);
    return emptyPage;
  });

  await state.source.pollNext();
  state.setNow(1_001_500);
  await state.source.pollNext();
  state.setNow(1_003_000);
  await state.source.pollNext();

  assert.deepEqual(state.calls.map((call) => call.token), [
    "primary-token",
    "secondary-reader-token",
    "primary-token",
  ]);
  const secondary = state.accounts.list()[0]!;
  assert.equal(secondary.health, "cooldown");
  assert.equal(secondary.nextEligibleAt, 1_011_500);
  state.store.close();
});

test("conserva el Retry-After de una lectora al reiniciar la fuente", async () => {
  let failSecondary = true;
  const state = await setup(async (token) => {
    if (token.startsWith("secondary") && failSecondary)
      throw new QvaApiError(429, "Demasiadas solicitudes", 10_000);
    return emptyPage;
  });

  await state.source.pollNext();
  state.setNow(1_001_500);
  await state.source.pollNext();
  const restarted = state.createSource();
  state.setNow(1_002_000);
  assert.equal(restarted.status().accounts.find(account => account.role === "reader")?.nextEligibleAt, 1_011_500);
  await restarted.pollNext();
  state.setNow(1_011_499);
  await restarted.pollNext();
  assert.equal(state.calls.filter(call => call.token.startsWith("secondary")).length, 1);
  failSecondary = false;
  state.setNow(1_011_500);
  await restarted.pollNext();
  assert.equal(state.calls.filter(call => call.token.startsWith("secondary")).length, 2);
  assert.equal(state.accounts.list()[0]?.health, "healthy");
  state.store.close();
});

test("una lectura lenta impide solapamientos y libera el turno para la otra cuenta", async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const state = await setup(async (token) => {
    if (token === "primary-token") await gate;
    return emptyPage;
  });

  const pending = state.source.pollNext();
  state.setNow(1_001_500);
  assert.equal(await state.source.pollNext(), undefined);
  assert.deepEqual(state.calls.map(call => call.token), ["primary-token"]);
  release();
  assert.equal((await pending)?.sourceAccountId, "primary");
  assert.equal((await state.source.pollNext())?.sourceAccountId, state.accounts.list()[0]?.id);
  state.setNow(1_003_000);
  await state.source.pollNext();
  assert.deepEqual(state.calls.map(call => call.token), [
    "primary-token", "secondary-reader-token", "primary-token",
  ]);
  state.store.close();
});

test("cuentas con titulares verificados distintos avanzan mientras una lectura está bloqueada", async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const state = await setup(async token => { if (token === "primary-token") await gate; return emptyPage; });
  state.store.set("analytics_account_uuid", "owner-primary");
  const reader = state.accounts.list()[0]!;
  state.store.updateMarketReaderAccount(reader.id, { qvaPayUuid: "owner-secondary" });
  const first = state.source.pollNext();
  state.setNow(1_001_500);
  const second = await state.source.pollNext();
  assert.equal(second?.sourceAccountId, reader.id);
  release();
  await first;
  state.store.close();
});

test("una cuenta desconocida elegible espera al turno activo sin ser adelantada indefinidamente", async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const state = await setup(async token => { if (token === "primary-token") await gate; return emptyPage; },
    ["unknown-reader-token", "known-reader-token"]);
  state.store.set("analytics_account_uuid", "owner-primary");
  const [unknown, known] = state.accounts.list();
  state.store.updateMarketReaderAccount(known!.id, { qvaPayUuid: "owner-known" });
  const active = state.source.pollNext();
  state.setNow(1_002_000);
  assert.equal(await state.source.pollNext(), undefined);
  assert.deepEqual(state.calls.map(item => item.token), ["primary-token"]);
  release(); await active;
  assert.equal((await state.source.pollNext())?.sourceAccountId, unknown!.id);
  state.store.close();
});

test("tokens del mismo titular comparten espera y no se solapan", async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const state = await setup(async token => { if (token === "primary-token") await gate; return emptyPage; });
  state.store.set("analytics_account_uuid", "same-owner");
  state.store.updateMarketReaderAccount(state.accounts.list()[0]!.id, { qvaPayUuid: "same-owner" });
  const first = state.source.pollNext();
  state.setNow(1_001_500);
  assert.equal(await state.source.pollNext(), undefined);
  release(); await first;
  assert.equal(await state.source.pollNext(), undefined, "se respeta el intervalo común");
  state.setNow(1_003_000);
  assert.ok(await state.source.pollNext());
  state.store.close();
});

test("una lectora deshabilitada no alarga el intervalo del titular activo", async () => {
  const state = await setup(async () => emptyPage);
  state.store.set("analytics_account_uuid", "same-owner");
  const reader = state.accounts.list()[0]!;
  state.store.updateMarketReaderAccount(reader.id, { qvaPayUuid: "same-owner", intervalSeconds: 3600, enabled: false });
  assert.ok(await state.source.pollNext());
  state.setNow(1_003_000);
  assert.ok(await state.source.pollNext());
  assert.equal(state.calls.length, 2);
  state.store.close();
});

test("descarta respuesta de lectora deshabilitada durante la consulta", async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const state = await setup(async token => { if (token.startsWith("secondary")) await gate; return emptyPage; });
  state.store.set("analytics_account_uuid", "owner-primary");
  const reader = state.accounts.list()[0]!;
  state.store.updateMarketReaderAccount(reader.id, { qvaPayUuid: "owner-secondary" });
  await state.source.pollNext();
  state.setNow(1_001_500);
  const pending = state.source.pollNext();
  state.accounts.update(reader.id, { enabled: false });
  release();
  assert.equal(await pending, undefined);
  assert.equal(state.timings.at(-1)?.outcome, "discarded");
  assert.equal(state.timings.at(-1)?.discardReason, "credential_changed");
  assert.equal(state.accounts.list()[0]?.enabled, false);
  state.store.close();
});

test("descarta respuesta tras deshabilitar y habilitar durante una consulta", async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const state = await setup(async token => { if (token.startsWith("secondary")) await gate; return emptyPage; });
  const reader = state.accounts.list()[0]!;
  await state.source.pollNext();
  state.setNow(1_001_500);
  const pending = state.source.pollNext();
  state.accounts.update(reader.id, { enabled: false });
  state.accounts.update(reader.id, { enabled: true });
  release();
  assert.equal(await pending, undefined);
  assert.equal(state.timings.at(-1)?.discardReason, "credential_changed");
  state.store.close();
});

test("una respuesta anterior no reemplaza otra despachada y recibida después", async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const state = await setup(async token => { if (token === "primary-token") await gate; return emptyPage; });
  state.store.set("analytics_account_uuid", "owner-primary");
  state.store.updateMarketReaderAccount(state.accounts.list()[0]!.id, { qvaPayUuid: "owner-secondary" });
  const first = state.source.pollNext();
  state.setNow(1_001_500);
  const newer = await state.source.pollNext();
  assert.equal(newer?.dispatchSequence, 2);
  release();
  assert.equal(await first, undefined);
  assert.equal(state.timings.at(-1)?.outcome, "discarded");
  assert.equal(state.timings.at(-1)?.discardReason, "superseded");
  state.store.close();
});

test("libera el turno si falla persistir el intervalo del titular", async () => {
  const state = await setup(async () => emptyPage, []);
  state.store.set("analytics_account_uuid", "owner-primary");
  const original = state.store.set.bind(state.store);
  let fail = true;
  state.store.set = (key, value) => {
    if (fail && key.startsWith("market_reader_owner_ready:")) { fail = false; throw new Error("disco"); }
    return original(key, value);
  };
  assert.equal(await state.source.pollNext(), undefined);
  assert.equal(state.calls.length, 0);
  state.setNow(1_003_000);
  assert.ok(await state.source.pollNext(), "el turno anterior se liberó pese al fallo");
  assert.equal(state.calls.length, 1);
  state.store.close();
});

test("limita a cuatro consultas activas incluso con más titulares distintos", async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const state = await setup(async () => { await gate; return emptyPage; }, ["reader-token-one", "reader-token-two", "reader-token-three", "reader-token-four"]);
  state.store.set("analytics_account_uuid", "owner-primary");
  for (const [i, reader] of state.accounts.list().entries())
    state.store.updateMarketReaderAccount(reader.id, { qvaPayUuid: `owner-${i}` });
  const pending: Array<ReturnType<typeof state.source.pollNext>> = [];
  for (let i = 0; i < 4; i++) { state.setNow(1_000_000 + i * 1_000); pending.push(state.source.pollNext()); }
  state.setNow(1_004_000);
  assert.equal(await state.source.pollNext(), undefined);
  assert.equal(state.calls.length, 4);
  release(); await Promise.all(pending);
  state.store.close();
});

test("un 429 tardío conserva el cooldown del titular tras deshabilitar la credencial", async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const state = await setup(async token => { if (token.startsWith("secondary")) { await gate; throw new QvaApiError(429, "límite", 10_000); } return emptyPage; });
  state.store.set("analytics_account_uuid", "other-owner");
  const reader = state.accounts.list()[0]!;
  state.store.updateMarketReaderAccount(reader.id, { qvaPayUuid: "limited-owner" });
  await state.source.pollNext();
  state.setNow(1_001_500);
  const pending = state.source.pollNext();
  state.accounts.update(reader.id, { enabled: false });
  release(); await pending;
  assert.notEqual(state.accounts.list()[0]?.health, "cooldown", "no altera la credencial deshabilitada");
  state.accounts.update(reader.id, { enabled: true });
  const restarted = state.createSource();
  state.setNow(1_004_000);
  await restarted.pollNext();
  assert.equal(state.calls.filter(call => call.token.startsWith("secondary")).length, 1);
  state.store.close();
});

test("un error del token anterior no marca fallida la credencial rotada", async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const state = await setup(async token => { if (token === "secondary-reader-token") { await gate; throw new QvaApiError(401, "vencido"); } return emptyPage; });
  const reader = state.accounts.list()[0]!;
  await state.source.pollNext();
  state.setNow(1_001_500);
  const pending = state.source.pollNext();
  await state.accounts.rotate(reader.id, "new-secondary-token");
  release(); await pending;
  assert.equal(state.accounts.list()[0]?.health, "healthy");
  state.store.close();
});

test("un 401 aparta la secundaria sin detener a la principal", async () => {
  const state = await setup(async (token) => {
    if (token.startsWith("secondary"))
      throw new QvaApiError(401, "Token vencido");
    return emptyPage;
  });

  await state.source.pollNext();
  state.setNow(1_001_500);
  await state.source.pollNext();
  state.setNow(1_003_000);
  await state.source.pollNext();

  assert.equal(state.accounts.list()[0]?.health, "requires_attention");
  assert.equal(state.source.status().healthyAccounts, 1);
  assert.equal(state.calls.at(-1)?.token, "primary-token");
  state.store.close();
});

test("pondera dos turnos de compra de QUSD por uno de venta", () => {
  assert.deepEqual(
    weightedMarketJobs({
      markets: [{ code: "BANK_CUP", buyEnabled: true, sellEnabled: true }],
    }),
    [
      { coin: "BANK_CUP", side: "sell" },
      { coin: "BANK_CUP", side: "buy" },
      { coin: "BANK_CUP", side: "sell" },
    ],
  );
});
