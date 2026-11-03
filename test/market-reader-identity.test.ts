import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { MarketAccountService } from "../src/market-accounts.js";
import { QvaApiError } from "../src/qvapay.js";
import { Store } from "../src/store.js";
import { Vault } from "../src/vault.js";

const page = { offers: [], total: 0, currentPage: 1, perPage: 100 };
function fixture(profile: (token: string) => Promise<{ uuid: string }>) {
  const dir = mkdtempSync(join(tmpdir(), "qva-reader-identity-"));
  const store = new Store(dir);
  const vault = new Vault("a".repeat(64));
  const service = new MarketAccountService(store, vault, token => ({ listOffersPage: async () => page, profile: () => profile(token) }));
  return { store, service, async close() { await service.stop(); store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test("identidad procede del perfil autenticado y rota junto al token", async t => {
  const f = fixture(async token => ({ uuid: token.endsWith("original") ? "OWNER-A" : "owner-b" }));
  t.after(() => f.close());
  const account = await f.service.add({ label: "Lectura", token: "reader-token-original", intervalSeconds: 3 });
  assert.equal(account.qvaPayUuid, "owner-a");
  assert.equal((await f.service.rotate(account.id, "reader-token-replacement")).qvaPayUuid, "owner-b");
  assert.equal(f.store.marketReaderAccount(account.id)?.qvaPayUuid, "owner-b");
});

test("p2p:read sigue válido sin permiso de perfil; probes con backoff no alteran salud", async t => {
  let calls = 0;
  const f = fixture(async () => { calls++; throw new QvaApiError(403, "scope denied"); });
  t.after(() => f.close());
  const account = await f.service.add({ label: "Solo P2P", token: "reader-token-restricted", intervalSeconds: 3 });
  assert.equal(account.qvaPayUuid, undefined);
  assert.equal(account.health, "healthy");
  await f.service.refreshIdentity(1000);
  await f.service.refreshIdentity(2000);
  assert.equal(calls, 2, "una prueba al agregar y una del refresco, sin repetir antes de una hora");
  await f.service.refreshIdentity(3_601_000);
  assert.equal(calls, 3);
  assert.equal(f.store.marketReaderAccount(account.id)?.health, "healthy");
});

for (const change of ["rotate", "remove", "disable", "stop"] as const) test(`no guarda identidad antigua durante ${change}`, async t => {
  let hold = false, release!: () => void, entered!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  const f = fixture(async token => {
    if (hold && token.endsWith("original")) { entered(); await blocked; return { uuid: "old-owner" }; }
    if (token.endsWith("original")) throw new QvaApiError(403, "scope denied");
    return { uuid: "new-owner" };
  });
  t.after(() => f.close());
  const account = await f.service.add({ label: "Lectura", token: "reader-token-original", intervalSeconds: 3 });
  hold = true;
  const refresh = f.service.refreshIdentity(1000);
  await started;
  let stopping: Promise<void> | undefined;
  if (change === "rotate") await f.service.rotate(account.id, "reader-token-replacement");
  else if (change === "remove") f.service.remove(account.id);
  else if (change === "disable") f.service.update(account.id, { enabled: false });
  else {
    let stopped = false;
    stopping = f.service.stop().then(() => { stopped = true; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(stopped, false, "cierre espera el perfil en vuelo");
  }
  release(); await refresh; await stopping;
  assert.equal(f.store.marketReaderAccount(account.id)?.qvaPayUuid, change === "rotate" ? "new-owner" : undefined);
});

test("un fallo de credencial al refrescar identidad no impide el cierre", async t => {
  const f = fixture(async () => { throw new QvaApiError(403, "no profile permission"); });
  t.after(() => f.close());
  const account = await f.service.add({ label: "Lectura", token: "reader-token-original", intervalSeconds: 3 });
  f.store.updateMarketReaderAccount(account.id, { encryptedToken: "invalid-ciphertext" });
  const refresh = f.service.refreshIdentity(1000);
  const closing = f.service.stop();
  await assert.rejects(refresh);
  await closing;
});
