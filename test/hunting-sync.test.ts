import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  HuntingSyncCoordinator,
  SyncCoreClient,
  SyncCoreError,
  parseCooperativeSnapshot,
} from "../src/hunting-sync.js";
import { Store } from "../src/store.js";
import { Vault } from "../src/vault.js";

test("normaliza el snapshot global que publica Sync Core", () => {
  assert.deepEqual(
    parseCooperativeSnapshot({
      data: {
        BANK_CUP: {
          coin: "BANK_CUP",
          fiat: 12_500,
          price: 390,
          minimal: 1_000,
          offers_count: 3,
        },
      },
    }),
    {
      BANK_CUP: {
        coin: "BANK_CUP",
        fiat: 12_500,
        price: 390,
        minimal: 1_000,
        offersCount: 3,
      },
    },
  );
});

test("rechaza snapshots con importes no finitos o mercados ambiguos", () => {
  assert.throws(
    () => parseCooperativeSnapshot({
      data: {
        CUP: { coin: "USD", fiat: "NaN", price: 1, minimal: 1, offers_count: 1 },
      },
    }),
    /código de mercado|no es válido/,
  );
});

test("el cliente autentica y envía la API key solo al recurso protegido", async () => {
  const calls: { url: string; authorization?: string }[] = [];
  const fetchMock: typeof fetch = async (input, init) => {
    calls.push({
      url: String(input),
      ...(new Headers(init?.headers).get("authorization")
        ? { authorization: new Headers(init?.headers).get("authorization")! }
        : {}),
    });
    if (String(input).endsWith("/login"))
      return Response.json({ api_key: "csk_test" });
    return Response.json({ data: {} });
  };
  const client = new SyncCoreClient("http://127.0.0.1:8080", fetchMock);
  const token = await client.login("bot@example.com", "secret");
  await client.snapshot(token);
  assert.deepEqual(calls, [
    { url: "http://127.0.0.1:8080/login" },
    {
      url: "http://127.0.0.1:8080/hunts/sync",
      authorization: "Bearer csk_test",
    },
  ]);
});

test("clasifica rechazos HTTP sin incluir credenciales", async () => {
  const client = new SyncCoreClient(
    "http://127.0.0.1:8080",
    async () => Response.json({ error: "invalid api key" }, { status: 401 }),
  );
  await assert.rejects(
    client.snapshot("csk_secret"),
    (error) => error instanceof SyncCoreError && error.status === 401 && !error.message.includes("csk_secret"),
  );
});

test("la integración desactivada conserva un snapshot local y no abre conexiones", async () => {
  const directory = mkdtempSync(join(tmpdir(), "qvaapply-sync-disabled-"));
  const store = new Store(directory);
  try {
    const coordinator = new HuntingSyncCoordinator(
      { enabled: false },
      store,
      new Vault("a".repeat(64)),
      async () => {
        throw new Error("no debe conectar");
      },
    );
    await coordinator.start();
    assert.deepEqual(coordinator.state(), {
      enabled: false,
      httpConnected: false,
      natsConnected: false,
      snapshot: {},
      contributions: {},
      lastHttpAt: null,
      lastNatsAt: null,
      lastError: null,
    });
    await assert.rejects(
      coordinator.publish({ coin: "BANK_CUP", fiat: 100, minimal: 10, price: 390 }),
      /no está habilitada/,
    );
    assert.deepEqual(coordinator.state().contributions, {});
  } finally {
    store.close();
  }
});
