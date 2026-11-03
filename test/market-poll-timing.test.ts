import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { MarketAccountService } from "../src/market-accounts.js";
import { PollingMarketSource, type MarketPollTiming } from "../src/market-source.js";
import { QvaApiError } from "../src/qvapay.js";
import { Store } from "../src/store.js";
import { Vault } from "../src/vault.js";
import type { P2pListPage } from "../src/types.js";

test("mide respuestas por mercado/lado con reloj monotónico y metadatos de caché", async t => {
  const store = new Store(mkdtempSync(join(tmpdir(), "qvaapply-poll-timing-")));
  t.after(() => store.close());
  let wall = 1_000_000, mono = 0;
  const timings: MarketPollTiming[] = [];
  const page: P2pListPage = { offers: [], total: 125, currentPage: 1, perPage: 100, cacheStatus: "HIT",
    timing: { queueMs: 2, responseMs: 5, totalMs: 7, attempts: 1, outcome: "success", status: 200 } };
  const source = new PollingMarketSource(store, new MarketAccountService(store, new Vault("a".repeat(64))), {
    listOffersPage: async () => { mono += 7; return page; },
  }, () => 3, () => [{ coin: "BANK_CUP", side: "sell" }, { coin: "BANK_CUP", side: "buy" }], {
    now: () => wall, monotonicNow: () => mono, onPollTiming: timing => timings.push(timing),
  });
  assert.equal((await source.pollNext())?.page, page);
  wall += 3000; mono = 3000;
  await source.pollNext();
  wall += 3000; mono = 6000;
  await source.pollNext();
  assert.equal(timings.length, 3);
  assert.deepEqual(timings[0], { coin: "BANK_CUP", side: "sell", sourceAccountId: "primary",
    startedAt: 1_000_000, finishedAt: 1_000_000, requestMs: 7, outcome: "success",
    offerCount: 0, totalOffers: 125, cacheStatus: "HIT", transport: page.timing });
  assert.equal(timings[1]?.coverageGapMs, undefined, "otro lado tiene cobertura independiente");
  assert.equal(timings[2]?.coverageGapMs, 6000);
  assert.equal((await source.pollNext()), undefined, "telemetría no crea consultas fuera de cupo");
  assert.equal(timings.length, 3);
});

test("el observador fallido no altera la página y el error remoto conserva cooldown", async t => {
  const store = new Store(mkdtempSync(join(tmpdir(), "qvaapply-poll-timing-error-")));
  t.after(() => store.close());
  let wall = 1_000_000, mono = 0, fail = false;
  const timings: MarketPollTiming[] = [];
  const source = new PollingMarketSource(store, new MarketAccountService(store, new Vault("a".repeat(64))), {
    listOffersPage: async () => {
      mono += 9;
      if (fail) throw new QvaApiError(429, "remote message must not enter timing", 10_000);
      return { offers: [], total: 0, currentPage: 1, perPage: 100 };
    },
  }, () => 3, () => [{ coin: "BANK_CUP", side: "sell" }], {
    now: () => wall, monotonicNow: () => mono,
    onPollTiming: timing => { timings.push(timing); throw new Error("observer"); },
  });
  assert.ok(await source.pollNext());
  fail = true; wall += 3000; mono = 3000;
  assert.equal(await source.pollNext(), undefined);
  assert.equal(timings[1]?.outcome, "failed");
  assert.equal(timings[1]?.requestMs, 9);
  assert.equal(timings[1]?.coverageGapMs, undefined);
  assert.equal(JSON.stringify(timings).includes("remote message"), false);
  assert.equal(source.status().accounts[0]?.nextEligibleAt, wall + 10_000);
  wall += 9999;
  assert.equal(await source.pollNext(), undefined);
  assert.equal(timings.length, 2);
  fail = false; wall += 1; mono = 13_000;
  assert.ok(await source.pollNext());
  assert.equal(timings[2]?.coverageGapMs, 13_000, "fallos no renuevan la cobertura observada");
});
