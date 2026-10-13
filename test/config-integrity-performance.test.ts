import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { Store } from "../src/store.js";
import { MarketConfigService } from "../src/market-config.js";

const runtime = { qusdReserve: 2, maxOpenOwnOffers: 4, buyQusdMaxRate: 930, sellQusdMinRate: 980,
  buyQusdUsdMaxRate: 1.06, sellQusdUsdMinRate: 1.12, cupPurchaseMaxQusd: 35, initialUsdFiatBalance: 110,
  paymentDetails: { BANK_CUP: [], BANDECPREPAGO: [] } };

test("una sincronización de saldo sin cambios no crea revisiones ni reescribe la configuración", () => {
  const directory = mkdtempSync(join(tmpdir(), "qva-config-noop-"));
  const store = new Store(directory);
  const config = new MarketConfigService(directory, runtime as never, store);
  const before = store.configRevisionHistory();
  for (let i = 0; i < 5; i++) for (const market of config.markets()) config.updateBalance(market.code, market.fiatBalance);
  assert.deepEqual(store.configRevisionHistory(), before);
  store.set("fiat_balance:BANK_CUP", "321");
  config.updateBalance("BANK_CUP", 321);
  assert.equal(store.configRevisionHistory().length, before.length + 1);
  assert.equal(config.current().markets.find(market => market.code === "BANK_CUP")?.fiatBalance, 321);
  store.close();
});

test("la verificación en segundo plano reutiliza el prefijo y detecta alteraciones y borrados históricos", async () => {
  const directory = mkdtempSync(join(tmpdir(), "qva-config-integrity-"));
  const store = new Store(directory);
  const config = new MarketConfigService(directory, runtime as never, store);
  const initial = await store.refreshConfigIntegrity();
  assert.equal(initial.valid, true);
  assert.equal(initial.verifiedRows, 1);
  assert.equal((await store.refreshConfigIntegrity()).verifiedRows, 0);
  config.updateBalance("BANK_CUP", 444);
  assert.equal((await store.refreshConfigIntegrity()).verifiedRows, 1);
  const db = new DatabaseSync(join(directory, "qvaapply.sqlite"));
  const head = db.prepare("SELECT * FROM config_revisions ORDER BY id DESC LIMIT 1").get()!;
  db.prepare(`INSERT OR REPLACE INTO config_revisions(id,created_at,source,reason,config_json,previous_hash,hash)
    VALUES(?,?,?,?,?,?,?)`).run(head.id!, head.created_at!, head.source!, head.reason!, "tampered", head.previous_hash!, head.hash!);
  assert.equal((await store.refreshConfigIntegrity()).valid, false);
  db.prepare("UPDATE config_revisions SET config_json=? WHERE id=?").run(head.config_json!, head.id!);
  assert.equal((await store.refreshConfigIntegrity()).valid, true);
  db.prepare("UPDATE config_revisions SET config_json=? WHERE id=1").run("tampered");
  assert.equal((await store.refreshConfigIntegrity()).valid, false);
  assert.equal(store.verifyConfigRevisionChain(), false);
  db.exec("DELETE FROM config_revisions WHERE id=1");
  assert.equal((await store.refreshConfigIntegrity()).valid, false);
  db.exec("DELETE FROM config_revisions");
  assert.equal((await store.refreshConfigIntegrity()).valid, false);
  db.close(); store.close();
});
