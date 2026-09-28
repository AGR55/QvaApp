import assert from "node:assert/strict";
import test from "node:test";
import { QvaApiError, QvaConnectionError, QvaMutationUncertainError, QvaPayClient } from "../src/qvapay.js";

test("normaliza un Peer vacío como contraparte ausente en una oferta abierta", async () => {
  const client = new QvaPayClient(() => "token", {
    fetch: async () => new Response(JSON.stringify({ p2p: {
      uuid: "open-without-peer", type: "buy", coin: "BANK_CUP",
      amount: "10.00", receive: "10200.00", status: "open",
      User: { uuid: "creator" }, Peer: {},
    } }), { status: 200 }),
  });

  const offer = await client.getOffer("open-without-peer");

  assert.equal(offer.Peer, null);
  assert.equal(offer.User?.uuid, "creator");
});

test("normaliza el chat documentado e identifica al autor por peer_id", async () => {
  const client = new QvaPayClient(() => "token", {
    fetch: async (_input, init) => new Response(JSON.stringify(init?.method === "POST"
      ? { message: { id: "automatic-1", created_at: "2026-09-09T12:00:00Z" } }
      : { messages: [{ id: "own-2", peer_id: "me", message: "Voy a pagar", created_at: "2026-09-09T12:01:00Z" }] }), { status: 200 }),
  });

  assert.equal((await client.sendChat("offer", "Hola")).id, "automatic-1");
  assert.deepEqual(await client.listChat("offer"), [{
    id: "own-2", peerId: "me", message: "Voy a pagar",
    createdAt: Date.parse("2026-09-09T12:01:00Z"),
  }]);
});

test("rechaza un Peer inválido cuando la oferta ya tiene contraparte", async () => {
  const client = new QvaPayClient(() => "token", {
    fetch: async () => new Response(JSON.stringify({ p2p: {
      uuid: "processing-with-peer", type: "sell", coin: "BANK_CUP",
      amount: 10, receive: 9_400, status: "processing",
      User: { uuid: "creator" }, Peer: {},
    } }), { status: 200 }),
  });

  await assert.rejects(
    () => client.getOffer("processing-with-peer"),
    /oferta solicitada, Peer.*identidad inválida/,
  );
});

test("serializa mutaciones distintas bajo un único límite global", async () => {
  let now = 1_000;
  const calls: { url: string; at: number }[] = [];
  const client = new QvaPayClient(() => "token", {
    now: () => now,
    sleep: async (milliseconds) => {
      now += milliseconds;
    },
    fetch: async (input) => {
      calls.push({ url: String(input), at: now });
      return new Response(JSON.stringify({ message: "ok" }), { status: 200 });
    },
  });

  await Promise.all([client.apply("one"), client.cancel("two")]);

  assert.equal(calls.length, 2);
  assert.match(calls[0]!.url, /one\/apply$/);
  assert.match(calls[1]!.url, /two\/cancel$/);
  assert.ok(calls[1]!.at - calls[0]!.at >= 1_600);
});

test("conserva entre reinicios la separación de aplicaciones", async () => {
  let now = 1_000;
  const state = new Map<string, string>();
  const waits: number[] = [];
  const calls: number[] = [];
  const runtime = {
    now: () => now,
    sleep: async (milliseconds: number) => {
      waits.push(milliseconds);
      now += milliseconds;
    },
    throttleState: {
      get: (key: string) => state.get(key),
      set: (key: string, value: string) => void state.set(key, value),
    },
    fetch: async () => {
      calls.push(now);
      return new Response(JSON.stringify({ message: "ok" }), { status: 200 });
    },
  };

  await new QvaPayClient(() => "token", runtime).apply("one");
  await new QvaPayClient(() => "token", runtime).apply("two");
  await new QvaPayClient(() => "token", runtime).apply("three");

  assert.ok(waits.some((milliseconds) => milliseconds >= 30_000));
  assert.ok(calls[2]! - calls[0]! > 60_000);
});

test("incluye una clave de idempotencia al crear ofertas", async () => {
  let sent: Record<string, unknown> | undefined;
  const client = new QvaPayClient(() => "token", {
    now: () => 1_000,
    sleep: async () => undefined,
    fetch: async (_input, init) => {
      sent = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(
        JSON.stringify({
          p2p: {
            uuid: "created",
            type: "buy",
            coin: "BANK_CUP",
            amount: 1,
            receive: 900,
            status: "open",
          },
        }),
        { status: 201 },
      );
    },
  });

  await client.createOffer({
    type: "buy",
    coin: "BANK_CUP",
    amount: 1,
    receive: 900,
    details: [{ name: "cuenta", value: "123" }],
    idempotencyKey: "intent-12345678",
  });

  assert.equal(sent?.idempotency_key, "intent-12345678");
});

test("normaliza los strings decimales documentados antes de llegar al dominio", async () => {
  const client = new QvaPayClient(() => "token", {
    now: () => 1_000,
    sleep: async () => undefined,
    fetch: async () => new Response(JSON.stringify({ data: [{ uuid: "documentada", type: "buy", coin: "BANK_CUP", amount: "20.50", receive: "20000.25", status: "open" }] }), { status: 200 }),
  });
  const page = await client.listOffersPage({ take: 20 });
  assert.equal(page.offers[0]?.amount, 20.5);
  assert.equal(page.offers[0]?.receive, 20_000.25);
});

test("rechaza strings ambiguos o importes no positivos", async () => {
  let amount = "20 QUSD";
  const client = new QvaPayClient(() => "token", {
    now: () => 1_000,
    sleep: async () => undefined,
    fetch: async () => new Response(JSON.stringify({ data: [{ uuid: "rota", type: "buy", coin: "BANK_CUP", amount, receive: "20000", status: "open" }] }), { status: 200 }),
  });
  await assert.rejects(() => client.listOffersPage({ take: 20 }), /amount.*debe ser positivo/);
  amount = "0";
  await assert.rejects(() => client.listOffersPage({ take: 20 }), /amount.*debe ser positivo/);
  amount = "1e3";
  await assert.rejects(() => client.listOffersPage({ take: 20 }), /amount.*debe ser positivo/);
});

test("normaliza promedios numéricos y rechaza valores no finitos", async () => {
  let invalid = false;
  const client = new QvaPayClient(() => "token", {
    now: () => 1_000,
    sleep: async () => undefined,
    fetch: async () => new Response(JSON.stringify(invalid ? { BANK_CUP: { average_buy: "NaN" } } : { BANK_CUP: { average_buy: "1010.5" } }), { status: 200 }),
  });
  assert.equal((await client.p2pAverages()).BANK_CUP?.average_buy, 1010.5);
  invalid = true;
  await assert.rejects(() => client.p2pAverages(), /promedio BANK_CUP.average_buy/);
});

test("clasifica un fetch fallido de lectura como conexión con QvaPay", async () => {
  const client = new QvaPayClient(() => "token", {
    sleep: async () => undefined,
    fetch: async () => {
      throw new TypeError("fetch failed");
    },
  });

  await assert.rejects(
    () => client.listOffersPage({ take: 20 }),
    (error: unknown) =>
      error instanceof QvaConnectionError &&
      error.reason === "network" &&
      /QvaPay/.test(error.message),
  );
});

test("entrega el 429 de listado al coordinador sin consumir más cupo", async () => {
  let calls = 0;
  const client = new QvaPayClient(() => "token", {
    sleep: async () => undefined,
    fetch: async () => {
      calls += 1;
      return new Response(JSON.stringify({ error: "Demasiadas solicitudes" }), {
        status: 429,
        headers: { "retry-after": "7" },
      });
    },
  });

  await assert.rejects(
    () => client.listOffersPage({ take: 20 }),
    (error: unknown) =>
      error instanceof QvaApiError &&
      error.status === 429 &&
      error.retryAfterMs === 7_000,
  );
  assert.equal(calls, 1);
});

test("interrumpe una edición remota colgada y exige conciliación", async () => {
  const client = new QvaPayClient(() => "token", {
    mutationTimeoutMs: 5,
    fetch: async (_input, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
    }),
  });

  await assert.rejects(
    () => client.editOffer("offer-timeout", { amount: 10, receive: 9_000 }),
    (error: unknown) => error instanceof QvaMutationUncertainError,
  );
});

test("trata un 2xx malformado de creación o edición como resultado incierto", async () => {
  const client = new QvaPayClient(() => "token", {
    now: () => 1_000,
    sleep: async () => undefined,
    fetch: async () => new Response(JSON.stringify({ message: "ok" }), { status: 200 }),
  });

  await assert.rejects(
    () => client.createOffer({
      type: "buy",
      coin: "BANK_CUP",
      amount: 1,
      receive: 900,
      details: [{ name: "cuenta", value: "123" }],
    }),
    (error: unknown) => error instanceof QvaMutationUncertainError,
  );
  await assert.rejects(
    () => client.editOffer("offer-with-invalid-response", { amount: 1 }),
    (error: unknown) => error instanceof QvaMutationUncertainError,
  );
});
