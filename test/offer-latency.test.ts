import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { MarketConfigService } from "../src/market-config.js";
import { QvaPayClient } from "../src/qvapay.js";
import { Store } from "../src/store.js";
import { TradingEngine } from "../src/trading.js";

test("mide recepción a POST con persistencia real y una consulta del panel bloqueada", async t => {
  const dataDir = mkdtempSync(join(tmpdir(), "qva-offer-latency-"));
  const store = new Store(dataDir);
  t.after(() => store.close());
  const cfg = { dataDir, initialUsdFiatBalance: 0, buyQusdMaxRate: 930, sellQusdMinRate: 1000,
    buyQusdUsdMaxRate: 1.06, sellQusdUsdMinRate: 1.12, cupPurchaseMaxQusd: 150,
    maxOpenOwnOffers: 10, priceGuardPercent: 15, qusdReserve: 0, realTradingAllowed: true,
    autoCancelMs: 600000, offerRefreshIntervalMs: 300000, paymentDetails: { BANK_CUP: [], BANDECPREPAGO: [] } };
  const markets = new MarketConfigService(dataDir, cfg as never, store);
  store.set("paused", "false");
  store.set("mode", "real");
  store.set("fiat_balance:BANK_CUP", "10000000");
  store.recordMarketObservation({ coin: "BANK_CUP", medianSell: 930, openOffers: 20, eligible: 0 });
  let release!: () => void;
  let ready!: () => void;
  const reading = new Promise<void>(resolve => { ready = resolve; });
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const measurements: number[] = [];
  let receivedAt = 0;
  let now = Date.now();
  const client = new QvaPayClient(() => "test-token", {
    now: () => now, sleep: async ms => { now += ms; }, throttleState: store,
    fetch: async input => {
      if (String(input).endsWith("/p2p/slow-panel")) { ready(); await blocked; }
      if (String(input).endsWith("/apply")) measurements.push(performance.now() - receivedAt);
      return new Response(JSON.stringify({ p2p: { uuid: "slow-panel", type: "sell", coin: "BANK_CUP", amount: 5, receive: 4600, status: "open" } }));
    },
  });
  const trading = new TradingEngine(store, client, cfg as never, markets, async () => undefined);
  const background = client.getOffer("slow-panel");
  await reading;
  for (let i = 0; i < 50; i++) {
    // This benchmark measures local processing with available remote quota;
    // advancing the fake clock must never perform a real monetary request.
    now += 60_001;
    receivedAt = performance.now();
    await trading.ingestMarketOffer({ uuid: `latency-${i}`, type: "sell", coin: "BANK_CUP", amount: 10, receive: 9200, status: "open" });
  }
  assert.equal(measurements.length, 50);
  assert.equal(store.activeOperations().length, 50);
  assert.equal(store.hasUnresolvedMutation(), false);
  assert.equal(store.get("qva_apply_last_queue_ms"), "0");
  release();
  await background;
  await new Promise(resolve => setImmediate(resolve));
  measurements.sort((a, b) => a - b);
  t.diagnostic(`Sin red ni espera de cuota, 50 ofertas: p50 ${measurements[24]!.toFixed(2)} ms; p95 ${measurements[47]!.toFixed(2)} ms de recepción a POST. SQLite e intención durable incluidos.`);
});
