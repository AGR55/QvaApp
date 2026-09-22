import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { MarketAccountService } from "../src/market-accounts.js";
import { Store } from "../src/store.js";
import { Vault } from "../src/vault.js";

function setup(factory?: (token: string) => { listOffersPage: () => Promise<never> }) {
  const store = new Store(mkdtempSync(join(tmpdir(), "qvaapply-market-accounts-")));
  const vault = new Vault("a".repeat(64));
  const service = new MarketAccountService(
    store,
    vault,
    factory ?? (() => ({
      listOffersPage: async () => ({ offers: [], total: 0, currentPage: 1, perPage: 1 }),
    })),
  );
  return { store, vault, service };
}

test("guarda tokens lectores cifrados y nunca los devuelve en el DTO público", async () => {
  const { store, vault, service } = setup();
  const token = "reader-token-super-seguro";

  const added = await service.add({
    label: "Observadora dos",
    token,
    intervalSeconds: 3,
  });

  assert.equal(added.label, "Observadora dos");
  assert.equal(added.tokenConfigured, true);
  assert.doesNotMatch(JSON.stringify(added), /reader-token/);
  const stored = store.marketReaderAccount(added.id)!;
  assert.notEqual(stored.encryptedToken, token);
  assert.equal(vault.decrypt(stored.encryptedToken), token);
  assert.doesNotMatch(JSON.stringify(service.list()), /encryptedToken|fingerprint|reader-token/);
  store.close();
});

test("rechaza intervalos inseguros y tokens secundarios duplicados", async () => {
  const { store, service } = setup();
  await assert.rejects(
    () => service.add({ label: "Rápida", token: "reader-token-one", intervalSeconds: 2 }),
    /entre 3 y 3600/,
  );
  await service.add({ label: "Primera", token: "reader-token-one", intervalSeconds: 3 });
  await assert.rejects(
    () => service.add({ label: "Duplicada", token: "reader-token-one", intervalSeconds: 3 }),
    /ya está vinculada/i,
  );
  store.close();
});

test("una rotación inválida conserva el token anterior", async () => {
  const { store, vault, service } = setup((token) => ({
    listOffersPage: async () => {
      if (token.includes("invalido")) throw new Error("Token rechazado");
      return { offers: [], total: 0, currentPage: 1, perPage: 1 } as never;
    },
  }));
  const added = await service.add({
    label: "Respaldo",
    token: "reader-token-original",
    intervalSeconds: 3,
  });

  await assert.rejects(
    () => service.rotate(added.id, "reader-token-invalido"),
    /rechazado/,
  );

  assert.equal(
    vault.decrypt(store.marketReaderAccount(added.id)!.encryptedToken),
    "reader-token-original",
  );
  store.close();
});
