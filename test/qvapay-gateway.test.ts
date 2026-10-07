import assert from "node:assert/strict";
import test from "node:test";
import { QvaApiError, QvaConnectionError, QvaMutationUncertainError, QvaPayClient } from "../src/qvapay.js";
import type { ApplyTiming } from "../src/qvapay.js";

test("cuota automática agotada libera la cola sin dormir, enviar ni consumir otro intento", async () => {
  let now = 1000, calls = 0;
  const timings: ApplyTiming[] = [];
  const client = new QvaPayClient(() => "token", {
    now: () => now,
    sleep: async () => { assert.fail("la evaluación automática no debe dormir por cuota"); },
    fetch: async () => { calls++; now += 10; return new Response("{}"); },
    onApplyTiming: timing => { timings.push(timing); },
  });
  const options = { beforeDispatch: () => true };
  await client.apply("first", options);
  await client.apply("second", options);
  await assert.rejects(client.apply("third", options), (error: unknown) =>
    error instanceof QvaApiError && error.code === "LOCAL_APPLY_QUOTA");
  assert.equal(calls, 2);
  assert.equal(timings[2]?.dispatchedAt, null);
  assert.equal(timings[2]?.outcome, "LOCAL_APPLY_QUOTA");
  now += 60_001;
  await client.apply("fresh-observation", options);
  assert.equal(calls, 3);
  assert.equal(timings[3]?.finishedAt! - timings[3]?.dispatchedAt!, 10);
});

test("un fallo de telemetría no convierte un POST confirmado en error", async () => {
  const client = new QvaPayClient(() => "token", {
    fetch: async () => new Response("{}"),
    onApplyTiming: () => { throw new Error("telemetry unavailable"); },
  });
  await client.apply("confirmed", { beforeDispatch: () => true });
});

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

test("normaliza los detalles de pago en formato array y trata null o vacío como ausencia", async () => {
  for (const [details, expected] of [
    [null, undefined],
    [[], undefined],
    [[{ name: "Cuenta", value: "001234" }, { name: "Banco", value: "BPA" }], { Cuenta: "001234", Banco: "BPA" }],
  ] as const) {
    const client = new QvaPayClient(() => "token", {
      fetch: async () => new Response(JSON.stringify({ p2p: {
        uuid: "offer-details-1", type: "buy", coin: "BANK_CUP",
        amount: 10, receive: 9_400, status: "open", details,
      } }), { status: 200 }),
    });
    assert.deepEqual((await client.getOffer("offer-details-1")).details, expected);
  }
});

test("falla cerrado para detalles de pago malformados o con claves duplicadas", async () => {
  for (const details of [
    [{ name: "Cuenta", value: 123 }],
    [{ name: "Cuenta", value: "001" }, { name: "Cuenta", value: "002" }],
    { Cuenta: 123 },
  ]) {
    const client = new QvaPayClient(() => "token", {
      fetch: async () => new Response(JSON.stringify({ p2p: {
        uuid: "offer-details-invalid", type: "buy", coin: "BANK_CUP",
        amount: 10, receive: 9_400, status: "open", details,
      } }), { status: 200 }),
    });
    await assert.rejects(() => client.getOffer("offer-details-invalid"), /datos de pago/);
  }
});

test("las aplicaciones no esperan una lectura remota colgada", async () => {
  let release!: () => void;
  let reading!: () => void;
  const started = new Promise<void>(resolve => { reading = resolve; });
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const calls: string[] = [];
  const client = new QvaPayClient(() => "token", {
    sleep: async () => undefined,
    fetch: async (_input, init) => {
      calls.push(init?.method ?? "GET");
      if (init?.method === "GET") { reading(); await blocked; }
      return new Response(JSON.stringify({ p2p: { uuid: "slow", type: "sell", coin: "BANK_CUP", amount: 5, receive: 4600, status: "open" } }));
    },
  });
  const read = client.getOffer("slow");
  await started;
  const applying = client.apply("fast");
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls, ["GET", "POST"], "el POST debe salir antes de que termine el GET");
  release();
  await Promise.all([read, applying]);
});

test("mantiene la cuota independiente de las otras mutaciones", async () => {
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
  assert.equal(calls[1]!.at, calls[0]!.at);
});

test("una lectura crítica de saldo no espera el panel y conserva la clasificación de fallo de lectura", async () => {
  let release!: () => void;
  let reading!: () => void;
  const started = new Promise<void>(resolve => { reading = resolve; });
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const client = new QvaPayClient(() => "token", {
    sleep: async () => undefined,
    fetch: async input => {
      if (String(input).includes("/p2p/slow")) { reading(); await blocked; }
      return new Response(JSON.stringify({ balance: 100, p2p: { uuid: "slow", type: "sell", coin: "BANK_CUP", amount: 5, receive: 4600, status: "open" } }));
    },
  });
  const read = client.getOffer("slow");
  await started;
  assert.equal(await client.qusdBalance({ priority: true }), 100);
  release();
  await read;
  const failing = new QvaPayClient(() => "token", { sleep: async () => undefined, fetch: async () => { throw new TypeError("fetch failed"); } });
  await assert.rejects(failing.qusdBalance({ priority: true }), QvaConnectionError);
});

test("permite dos aplicaciones seguidas y conserva la ventana entre reinicios", async () => {
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

  assert.equal(calls[1], calls[0], "la segunda aplicación usa el segundo intento disponible");
  assert.ok(waits.some((milliseconds) => milliseconds >= 60_000));
  assert.ok(calls[2]! - calls[0]! > 60_000);
});

test("vuelve a comprobar las condiciones al despachar sin gastar cuota si cambiaron", async () => {
  const state = new Map<string, string>();
  let calls = 0;
  const client = new QvaPayClient(() => "token", {
    throttleState: { get: key => state.get(key), set: (key, value) => void state.set(key, value) },
    fetch: async () => { calls++; return new Response("{}"); },
  });
  await assert.rejects(client.apply("changed", { beforeDispatch: () => false }),
    (error: unknown) => error instanceof QvaApiError && error.code === "LOCAL_CONDITIONS_CHANGED");
  assert.equal(calls, 0);
  assert.equal(state.get("qva_throttle:apply"), undefined);
});

test("respeta Retry-After de aplicación incluso después de reiniciar y no reintenta POST", async () => {
  let now = 1_000;
  let calls = 0;
  const state = new Map<string, string>();
  const runtime = {
    now: () => now,
    sleep: async (ms: number) => { now += ms; },
    throttleState: { get: (key: string) => state.get(key), set: (key: string, value: string) => void state.set(key, value) },
    fetch: async () => {
      calls++;
      return calls === 1 ? new Response('{"error":"Demasiadas solicitudes"}', { status: 429, headers: { "retry-after": "90" } }) : new Response("{}");
    },
  };
  await assert.rejects(new QvaPayClient(() => "token", runtime).apply("one"), QvaApiError);
  assert.equal(calls, 1);
  await new QvaPayClient(() => "token", runtime).apply("two");
  assert.equal(now, 91_000);
  assert.equal(calls, 2);
});

test("una prevalidación fallida no envía POST, no consume cuota y no se declara incierta", async () => {
  let calls = 0;
  const state = new Map<string, string>();
  const client = new QvaPayClient(() => "token", {
    throttleState: { get: key => state.get(key), set: (key, value) => void state.set(key, value) },
    fetch: async () => { calls++; return new Response("{}"); },
  });
  await assert.rejects(client.apply("preflight-failed", { beforeDispatch: async () => { throw new QvaConnectionError("timeout", new Error("offline")); } }),
    (error: unknown) => error instanceof QvaApiError && error.code === "LOCAL_PREFLIGHT_FAILED" && error.status < 500);
  assert.equal(calls, 0);
  assert.equal(state.get("qva_throttle:apply"), undefined);
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
