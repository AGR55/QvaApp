import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { MarketSourceCoordinator } from "../src/market-feed.js";
import type { PollingMarketSource } from "../src/market-source.js";
import { Store } from "../src/store.js";
import { Vault } from "../src/vault.js";

test("stop espera eventos iniciados por webhook, incluidos estados, y no inicia pendientes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "feed-shutdown-"));
  const store = new Store(dir);
  const now = Date.now(), secret = "feed-secret-for-tests-2026";
  let releaseOffer!: () => void, releaseState!: () => void;
  let offerEntered!: () => void, stateEntered!: () => void;
  const offerBlocked = new Promise<void>(resolve => { releaseOffer = resolve; });
  const stateBlocked = new Promise<void>(resolve => { releaseState = resolve; });
  const offerStarted = new Promise<void>(resolve => { offerEntered = resolve; });
  const stateStarted = new Promise<void>(resolve => { stateEntered = resolve; });
  let offers = 0, states = 0;
  const source = new MarketSourceCoordinator(store, new Vault("a".repeat(64)), {} as PollingMarketSource, "",
    async () => { offers++; offerEntered(); await offerBlocked; }, () => true, () => now, {},
    async () => { states++; stateEntered(); await stateBlocked; });
  source.saveWebhookSecret(secret);
  store.set("market_source_mode", "hybrid");
  const accept = (uuid: string, event: string) => {
    const raw = Buffer.from(JSON.stringify({ event, sent_at: new Date(now).toISOString(),
      data: { uuid, type: "sell", coin: "BANK_CUP", amount: "25", receive: "25000", status: "open" } }));
    source.acceptWebhook(raw, { timestamp: String(Math.floor(now / 1000)), signature: `sha256=${createHmac("sha256", secret).update(raw).digest("hex")}` });
  };
  try {
    accept("offer-first", "p2p.created");
    accept("state-first", "p2p.paused");
    await Promise.all([offerStarted, stateStarted]);
    accept("state-pending", "p2p.paused");
    let stopped = false;
    const closing = Promise.resolve(source.stop()).then(() => { stopped = true; });
    assert.throws(() => accept("after-stop", "p2p.created"), /cerrando/);
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(stopped, false);
    releaseOffer();
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(stopped, false, "espera también el procesador de estados separado");
    releaseState();
    await closing;
    assert.equal(offers, 1);
    assert.equal(states, 1, "el evento pendiente no comienza tras stop");
    assert.equal(await source.processNext(), false);
  } finally {
    releaseOffer(); releaseState();
    await source.stop();
    store.close(); rmSync(dir, { recursive: true, force: true });
  }
});
