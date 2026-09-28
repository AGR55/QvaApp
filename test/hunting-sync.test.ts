import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  HuntingSyncCoordinator,
  SyncCoreClient,
  SyncCoreError,
  parseCooperativeContributions,
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

test("normaliza únicamente los aportes activos de la cuenta autenticada", () => {
  assert.deepEqual(
    parseCooperativeContributions({
      data: [{
        coin: "BANK_CUP",
        fiat: 25000,
        minimal: 1000,
        price: 390,
        updated_at: "2026-09-27T12:00:00Z",
      }],
    }),
    {
      BANK_CUP: {
        coin: "BANK_CUP",
        fiat: 25000,
        minimal: 1000,
        price: 390,
        state: "confirmed",
        updatedAt: Date.parse("2026-09-27T12:00:00Z"),
      },
    },
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
    if (String(input).endsWith("/auth/login"))
      return Response.json({ api_key: "csk_test" });
    if (String(input).includes("/hunts?")) return Response.json({ data: [] });
    return Response.json({ data: {} });
  };
  const client = new SyncCoreClient("http://127.0.0.1:8080", fetchMock);
  const token = await client.login("bot@example.com", "secret");
  await client.snapshot(token);
  await client.contributions(token);
  assert.deepEqual(calls, [
    { url: "http://127.0.0.1:8080/auth/login" },
    {
      url: "http://127.0.0.1:8080/hunts/sync",
      authorization: "Bearer csk_test",
    },
    {
      url: "http://127.0.0.1:8080/hunts?me=true&active=true&page_size=100",
      authorization: "Bearer csk_test",
    },
  ]);
});

test("retira el aporte usando la ruta REST por moneda", async () => {
  const calls: { url: string; method?: string; body?: BodyInit | null }[] = [];
  const client = new SyncCoreClient("http://127.0.0.1:8080", async (input, init) => {
    calls.push({
      url: String(input),
      ...(init?.method ? { method: init.method } : {}),
      ...(init?.body !== undefined ? { body: init.body } : {}),
    });
    return Response.json({});
  });
  await client.withdraw("csk_test", "BANK_CUP");
  assert.deepEqual(calls, [{
    url: "http://127.0.0.1:8080/hunts/BANK_CUP",
    method: "DELETE",
  }]);
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
