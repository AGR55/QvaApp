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
test("acepta el mínimo cero autorizado por Sync Core en capacidades y aportes", () => {
 const snapshot=parseCooperativeSnapshot({data:{BANK_CUP:{coin:"BANK_CUP",fiat:100,price:100,minimal:0,offers_count:1,
   capacities:[{fiat:100,price:100,minimal:0}]}}});
 assert.equal(snapshot.BANK_CUP?.capacities?.[0]?.minimal,0);
 const contributions=parseCooperativeContributions({data:[{coin:"BANK_CUP",fiat:100,price:100,minimal:0}]});
 assert.equal(contributions.BANK_CUP?.minimal,0);
 assert.throws(()=>parseCooperativeSnapshot({data:{BANK_CUP:{coin:"BANK_CUP",fiat:100,price:100,minimal:0,offers_count:1,
   capacities:[{fiat:100,price:100,minimal:-1}]}}}),/no es válido/);
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
        revision: "2026-09-27T12:00:00Z",
      },
    },
  );
});

test("acepta que Sync Core agote un aporte sin desactivarlo todavía", () => {
  const current = parseCooperativeContributions({ data: [{
    coin: "BANK_CUP", fiat: 0, minimal: 100, price: 100,
    updated_at: "2026-10-05T12:00:00Z",
  }] });
  assert.equal(current.BANK_CUP?.fiat, 0);
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

test("acepta el booleano de éxito que devuelve Sync Core al retirar", async () => {
  const client = new SyncCoreClient("http://127.0.0.1:8080", async () => Response.json(true));
  await client.withdraw("csk_test", "BANK_CUP");
});

test("la reserva cooperativa valida el reparto y exige el protocolo nuevo antes de aplicar", async () => {
  let legacy = false;
  const calls: string[] = [];
  const client = new SyncCoreClient("http://127.0.0.1:8080", async (url,init) => {
    calls.push(String(url));
    if (String(url).endsWith("/hunts/reserve")) {
      assert.equal(JSON.parse(String(init?.body)).external_id,"offer-1");
      return Response.json({ external_id:"offer-1", ...(legacy?{}:{state:"reserved"}), owner_fiat:400,
        contributions:[{user_id:"friend",fiat_amount:600,qusd_owed:6}] });
    }
    return Response.json({state:"completed"});
  });
  const offer={uuid:"offer-1",coin:"BANK_CUP",amount:10,receive:1000};
  assert.equal((await client.reserve("csk_test",offer)).ownerFiat,400);
  await client.settle("csk_test",offer.uuid,"commit");
  assert.ok(calls[1]?.endsWith("/hunts/reservations/offer-1/commit"));
  legacy=true; await assert.rejects(client.reserve("csk_test",offer),/reserva verificable/);
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
      coordinator.publish({ coin: "BANK_CUP", minimal: 10, price: 390 }),
      /no está habilitada/,
    );
    assert.deepEqual(coordinator.state().contributions, {});
  } finally {
    store.close();
  }
});

test("sincroniza deltas de saldo sin restaurar el fiat gastado por otra cacería", async () => {
  const directory = mkdtempSync(join(tmpdir(), "qvaapply-sync-capacity-"));
  const store = new Store(directory);
  store.set("fiat_balance:BANK_CUP", "1000");
  store.set("fiat_balance:CLASICA", "20");
  const remote = new Map([
    ["BANK_CUP", { coin: "BANK_CUP", fiat: 800, minimal: 50, price: 100 }],
    ["CLASICA", { coin: "CLASICA", fiat: 20, minimal: 1, price: 1 }],
  ]);
  const actions: string[] = [];
  store.saveRemoteResource("cooperative-network", {
    enabled: true, httpConnected: true, natsConnected: false, snapshot: {},
    contributions: {
      BANK_CUP: { ...remote.get("BANK_CUP")!, state: "confirmed", updatedAt: Date.now() },
      CLASICA: { ...remote.get("CLASICA")!, state: "confirmed", updatedAt: Date.now() },
    },
    lastHttpAt: Date.now(), lastNatsAt: null, lastError: null,
  });
  const coordinator = new HuntingSyncCoordinator(
    { enabled: true, baseUrl: "http://127.0.0.1:8080", natsUrl: "nats://127.0.0.1:4222", email: "test@example.com", password: "secret" },
    store, new Vault("a".repeat(64)), async (input, init) => {
      const url = String(input), method = init?.method ?? "GET";
      if (url.endsWith("/auth/login")) return Response.json({ api_key: "csk_test" });
      if (url.includes("/hunts?")) return Response.json({ data: [...remote.values()] });
      if (method === "POST" && url.endsWith("/hunts")) {
        const contribution = JSON.parse(String(init?.body));
        actions.push(`publish:${contribution.fiat}`);
        remote.set(contribution.coin, contribution);
        return Response.json(contribution, { status: 201 });
      }
      if (method === "DELETE") {
        actions.push(`withdraw:${url.split("/").at(-1)}`);
        remote.delete(url.split("/").at(-1)!);
        return Response.json(true);
      }
      throw new Error(`Unexpected ${method} ${url}`);
    },
  );
  try {
    await coordinator.syncCapacity();
    assert.deepEqual(actions, []);
    store.set("fiat_balance:BANK_CUP", "1100");
    await coordinator.syncCapacity();
    assert.deepEqual(actions, ["publish:900"]);
    store.set("fiat_balance:BANK_CUP", "600");
    store.set("cooperative_balance_declared:BANK_CUP", "true");
    await coordinator.syncCapacity();
    assert.deepEqual(actions, ["publish:900", "publish:600"]);
    store.set("fiat_balance:BANK_CUP", "400");
    await coordinator.syncCapacity();
    assert.deepEqual(actions, ["publish:900", "publish:600", "withdraw:BANK_CUP"]);
    assert.equal(coordinator.state().contributions.BANK_CUP, undefined);
    assert.equal(coordinator.state().contributions.CLASICA?.fiat, 20);
  } finally { await coordinator.stop(); store.close(); }
});

test("el alta manual toma el saldo fiat local y no permite publicar menos de cinco QUSD", async () => {
  const directory = mkdtempSync(join(tmpdir(), "qvaapply-sync-manual-"));
  const store = new Store(directory);
  store.set("fiat_balance:CLASICA", "12");
  const bodies: unknown[] = [];
  const coordinator = new HuntingSyncCoordinator(
    { enabled: true, baseUrl: "http://127.0.0.1:8080", natsUrl: "nats://127.0.0.1:4222", email: "test@example.com", password: "secret" },
    store, new Vault("a".repeat(64)), async (input, init) => {
      if (String(input).endsWith("/auth/login")) return Response.json({ api_key: "csk_test" });
      bodies.push(JSON.parse(String(init?.body)));
      return Response.json({ id: "created" }, { status: 201 });
    },
  );
  try {
    await coordinator.publish({ coin: "CLASICA", price: 2, minimal: 1 });
    assert.deepEqual(bodies, [{ coin: "CLASICA", fiat: 12, minimal: 1, price: 2 }]);
    store.set("fiat_balance:CLASICA", "9.99");
    await assert.rejects(coordinator.publish({ coin: "CLASICA", price: 2, minimal: 1 }), /5 QUSD/);
    store.set("fiat_balance:CLASICA", "5.629");
    await assert.rejects(coordinator.publish({ coin: "CLASICA", price: 1.125, minimal: 1 }), /5 QUSD/);
    assert.equal(bodies.length, 1);
  } finally { await coordinator.stop(); store.close(); }
});
