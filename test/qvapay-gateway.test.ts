import assert from "node:assert/strict";
import test from "node:test";
import { QvaPayClient } from "../src/qvapay.js";

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
