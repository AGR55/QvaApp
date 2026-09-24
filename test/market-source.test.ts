import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { MarketAccountService } from "../src/market-accounts.js";
import { PollingMarketSource, weightedMarketJobs } from "../src/market-source.js";
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
  const source = new PollingMarketSource(
    store,
    accounts,
    factory("primary-token"),
    () => 3,
    () => [{ coin: "BANK_CUP", side: "sell" }],
    { now: () => now },
  );
  return {
    store,
    accounts,
    source,
    calls,
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
