/**
 * Escenarios de contrato: `test/qvapay-gateway.test.ts` (27 casos).
 *
 * `fetch`, reloj, `sleep` y estado de throttle inyectados. Los tiempos de
 * aplicación usan el reloj inyectado; las lecturas que miden con
 * `performance.now()` se observan por su forma, no por milisegundos reales.
 */
import assert from "node:assert/strict";
import {
  QvaApiError,
  QvaConnectionError,
  QvaPayClient,
} from "../../../src/qvapay.js";
import type { ApplyTiming } from "../../../src/qvapay.js";
import type { ContractScenario } from "../../../lib/contract/scenario.js";

const scenarios: ContractScenario[] = [
  {
    id: "qvapay-gateway/01-apply-quota-release",
    file: "test/qvapay-gateway.test.ts",
    source: "test/qvapay-gateway.test.ts:6",
    async run(ctx) {
      let now = 1000;
      let calls = 0;
      const timings: ApplyTiming[] = [];
      const client = new QvaPayClient(() => "token", {
        now: () => now,
        sleep: async () => {
          assert.fail("la evaluación automática no debe dormir por cuota");
        },
        fetch: async () => {
          calls += 1;
          now += 10;
          return new Response("{}");
        },
        onApplyTiming: (timing) => {
          timings.push(timing);
        },
      });
      const options = { beforeDispatch: () => true };
      await ctx.observe("apply:first", client.apply("first", options));
      await ctx.observe("apply:second", client.apply("second", options));
      const third = await ctx.observe("apply:third", client.apply("third", options));
      assert.equal(third.ok, false);
      if (!third.ok) assert.equal((third.error as unknown as { code: string }).code, "LOCAL_APPLY_QUOTA");
      assert.equal(calls, 2);
      assert.equal(timings[2]?.dispatchedAt, null);
      assert.equal(timings[2]?.outcome, "LOCAL_APPLY_QUOTA");
      now += 60_001;
      await ctx.observe("apply:fresh", client.apply("fresh-observation", options));
      assert.equal(calls, 3);
      assert.equal(timings[3]?.finishedAt! - timings[3]?.dispatchedAt!, 10);
      ctx.effect("apply.timings", timings);
      ctx.value("calls", calls);
    },
  },
  {
    id: "qvapay-gateway/02-telemetry-safe",
    file: "test/qvapay-gateway.test.ts",
    source: "test/qvapay-gateway.test.ts:20",
    async run(ctx) {
      const client = new QvaPayClient(() => "token", {
        fetch: async () => new Response("{}"),
        onApplyTiming: () => {
          throw new Error("telemetry unavailable");
        },
      });
      const outcome = await ctx.observe(
        "apply",
        client.apply("confirmed", { beforeDispatch: () => true }),
      );
      assert.equal(outcome.ok, true);
    },
  },
  {
    id: "qvapay-gateway/03-empty-peer-open-offer",
    file: "test/qvapay-gateway.test.ts",
    source: "test/qvapay-gateway.test.ts:29",
    async run(ctx) {
      const client = new QvaPayClient(() => "token", {
        fetch: async () =>
          new Response(
            JSON.stringify({
              p2p: {
                uuid: "open-without-peer",
                type: "buy",
                coin: "BANK_CUP",
                amount: "10.00",
                receive: "10200.00",
                status: "open",
                User: { uuid: "creator" },
                Peer: {},
              },
            }),
            { status: 200 },
          ),
      });
      const outcome = await ctx.observe("getOffer", client.getOffer("open-without-peer"));
      assert.equal(outcome.ok, true);
      if (outcome.ok) {
        const offer = outcome.value as { Peer: unknown; User?: { uuid: string } };
        assert.equal(offer.Peer, null);
        assert.equal(offer.User?.uuid, "creator");
      }
    },
  },
  {
    id: "qvapay-gateway/04-documented-chat",
    file: "test/qvapay-gateway.test.ts",
    source: "test/qvapay-gateway.test.ts:42",
    async run(ctx) {
      const client = new QvaPayClient(() => "token", {
        fetch: async (_input, init) =>
          new Response(
            JSON.stringify(
              init?.method === "POST"
                ? { message: "automatic-1" }
                : {
                    message: "chat",
                    chat: [
                      {
                        id: "own-2",
                        peer_id: "me",
                        message: "Voy a pagar",
                        created_at: "2026-09-09T12:01:00Z",
                      },
                    ],
                  },
            ),
            { status: 200 },
          ),
      });
      const sent = await ctx.observe("sendChat", client.sendChat("offer", "Hola"));
      assert.equal(sent.ok, true);
      if (sent.ok) assert.equal((sent.value as { id: string }).id, "automatic-1");
      const list = await ctx.observe("listChat", client.listChat("offer"));
      assert.equal(list.ok, true);
      assert.deepEqual(list.ok ? list.value : undefined, [
        {
          id: "own-2",
          peerId: "me",
          message: "Voy a pagar",
          createdAt: Date.parse("2026-09-09T12:01:00Z"),
        },
      ]);
    },
  },
  {
    id: "qvapay-gateway/05-legacy-chat",
    file: "test/qvapay-gateway.test.ts",
    source: "test/qvapay-gateway.test.ts:54",
    async run(ctx) {
      const client = new QvaPayClient(() => "token", {
        fetch: async (_input, init) =>
          new Response(
            JSON.stringify(
              init?.method === "POST"
                ? { message: { id: "automatic-1", created_at: "2026-09-09T12:00:00Z" } }
                : {
                    messages: [
                      {
                        id: "own-2",
                        peer_id: "me",
                        message: "Voy a pagar",
                        created_at: "2026-09-09T12:01:00Z",
                      },
                    ],
                  },
            ),
            { status: 200 },
          ),
      });
      const sent = await ctx.observe("sendChat", client.sendChat("offer", "Hola"));
      assert.equal(sent.ok, true);
      if (sent.ok) assert.equal((sent.value as { id: string }).id, "automatic-1");
      const list = await ctx.observe("listChat", client.listChat("offer"));
      assert.equal(list.ok, true);
      assert.deepEqual(list.ok ? list.value : undefined, [
        {
          id: "own-2",
          peerId: "me",
          message: "Voy a pagar",
          createdAt: Date.parse("2026-09-09T12:01:00Z"),
        },
      ]);
    },
  },
  {
    id: "qvapay-gateway/06-invalid-peer-with-counterpart",
    file: "test/qvapay-gateway.test.ts",
    source: "test/qvapay-gateway.test.ts:67",
    async run(ctx) {
      const client = new QvaPayClient(() => "token", {
        fetch: async () =>
          new Response(
            JSON.stringify({
              p2p: {
                uuid: "processing-with-peer",
                type: "sell",
                coin: "BANK_CUP",
                amount: 10,
                receive: 9_400,
                status: "processing",
                User: { uuid: "creator" },
                Peer: {},
              },
            }),
            { status: 200 },
          ),
      });
      const outcome = await ctx.observe("getOffer", client.getOffer("processing-with-peer"));
      assert.equal(outcome.ok, false);
      if (!outcome.ok) assert.match(outcome.error.message, /oferta solicitada, Peer.*identidad inválida/);
    },
  },
  {
    id: "qvapay-gateway/07-payment-details-array",
    file: "test/qvapay-gateway.test.ts",
    source: "test/qvapay-gateway.test.ts:81",
    async run(ctx) {
      for (const [details, expected] of [
        [null, undefined],
        [[], undefined],
        [
          [
            { name: "Cuenta", value: "001234" },
            { name: "Banco", value: "BPA" },
          ],
          { Cuenta: "001234", Banco: "BPA" },
        ],
      ] as const) {
        const client = new QvaPayClient(() => "token", {
          fetch: async () =>
            new Response(
              JSON.stringify({
                p2p: {
                  uuid: "offer-details-1",
                  type: "buy",
                  coin: "BANK_CUP",
                  amount: 10,
                  receive: 9_400,
                  status: "open",
                  details,
                },
              }),
              { status: 200 },
            ),
        });
        const outcome = await ctx.observe("getOffer", client.getOffer("offer-details-1"));
        assert.equal(outcome.ok, true);
        if (outcome.ok) assert.deepEqual((outcome.value as { details: unknown }).details, expected);
      }
    },
  },
  {
    id: "qvapay-gateway/08-malformed-payment-details",
    file: "test/qvapay-gateway.test.ts",
    source: "test/qvapay-gateway.test.ts:100",
    async run(ctx) {
      for (const details of [
        [{ name: "Cuenta", value: 123 }],
        [
          { name: "Cuenta", value: "001" },
          { name: "Cuenta", value: "002" },
        ],
        { Cuenta: 123 },
      ]) {
        const client = new QvaPayClient(() => "token", {
          fetch: async () =>
            new Response(
              JSON.stringify({
                p2p: {
                  uuid: "offer-details-invalid",
                  type: "buy",
                  coin: "BANK_CUP",
                  amount: 10,
                  receive: 9_400,
                  status: "open",
                  details,
                },
              }),
              { status: 200 },
            ),
        });
        const outcome = await ctx.observe("getOffer", client.getOffer("offer-details-invalid"));
        assert.equal(outcome.ok, false);
        if (!outcome.ok) assert.match(outcome.error.message, /datos de pago/);
      }
    },
  },
  {
    id: "qvapay-gateway/09-hung-read-no-block",
    file: "test/qvapay-gateway.test.ts",
    source: "test/qvapay-gateway.test.ts:117",
    async run(ctx) {
      let release!: () => void;
      let reading!: () => void;
      const started = new Promise<void>((resolve) => {
        reading = resolve;
      });
      const blocked = new Promise<void>((resolve) => {
        release = resolve;
      });
      const calls: string[] = [];
      const client = new QvaPayClient(() => "token", {
        sleep: async () => undefined,
        fetch: async (_input, init) => {
          calls.push(init?.method ?? "GET");
          if (init?.method === "GET") {
            reading();
            await blocked;
          }
          return new Response(
            JSON.stringify({
              p2p: { uuid: "slow", type: "sell", coin: "BANK_CUP", amount: 5, receive: 4600, status: "open" },
            }),
          );
        },
      });
      const read = client.getOffer("slow");
      const readObserved = ctx.observe("getOffer", read);
      await started;
      const applying = ctx.observe("apply", client.apply("fast"));
      await new Promise((resolve) => setImmediate(resolve));
      assert.deepEqual(calls, ["GET", "POST"], "el POST debe salir antes de que termine el GET");
      release();
      await readObserved;
      await applying;
      ctx.effect("calls", calls);
    },
  },
  {
    id: "qvapay-gateway/10-independent-mutation-quota",
    file: "test/qvapay-gateway.test.ts",
    source: "test/qvapay-gateway.test.ts:139",
    async run(ctx) {
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
      await ctx.observe("mutations", Promise.all([client.apply("one"), client.cancel("two")]));
      assert.equal(calls.length, 2);
      assert.match(calls[0]!.url, /one\/apply$/);
      assert.match(calls[1]!.url, /two\/cancel$/);
      assert.equal(calls[1]!.at, calls[0]!.at);
      ctx.effect("calls", calls);
    },
  },
  {
    id: "qvapay-gateway/11-critical-balance-priority",
    file: "test/qvapay-gateway.test.ts",
    source: "test/qvapay-gateway.test.ts:158",
    async run(ctx) {
      let release!: () => void;
      let reading!: () => void;
      const started = new Promise<void>((resolve) => {
        reading = resolve;
      });
      const blocked = new Promise<void>((resolve) => {
        release = resolve;
      });
      const client = new QvaPayClient(() => "token", {
        sleep: async () => undefined,
        fetch: async (input) => {
          if (String(input).includes("/p2p/slow")) {
            reading();
            await blocked;
          }
          return new Response(
            JSON.stringify({
              balance: 100,
              p2p: { uuid: "slow", type: "sell", coin: "BANK_CUP", amount: 5, receive: 4600, status: "open" },
            }),
          );
        },
      });
      const read = ctx.observe("getOffer", client.getOffer("slow"));
      await started;
      const balance = await ctx.observe("qusdBalance", client.qusdBalance({ priority: true }));
      assert.equal(balance.ok && balance.value, 100);
      release();
      await read;
      const failing = new QvaPayClient(() => "token", {
        sleep: async () => undefined,
        fetch: async () => {
          throw new TypeError("fetch failed");
        },
      });
      const failed = await ctx.observe("qusdBalance:network", failing.qusdBalance({ priority: true }));
      assert.equal(failed.ok, false);
      if (!failed.ok) assert.equal((failed.error as unknown as { reason: string }).reason, "network");
      assert.ok(QvaConnectionError);
    },
  },
  {
    id: "qvapay-gateway/12-apply-window-across-restarts",
    file: "test/qvapay-gateway.test.ts",
    source: "test/qvapay-gateway.test.ts:179",
    async run(ctx) {
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
      ctx.effect("waits", waits);
      ctx.effect("calls", calls);
    },
  },
  {
    id: "qvapay-gateway/13-conditions-changed-no-quota",
    file: "test/qvapay-gateway.test.ts",
    source: "test/qvapay-gateway.test.ts:206",
    async run(ctx) {
      const state = new Map<string, string>();
      let calls = 0;
      const client = new QvaPayClient(() => "token", {
        throttleState: {
          get: (key) => state.get(key),
          set: (key, value) => void state.set(key, value),
        },
        fetch: async () => {
          calls += 1;
          return new Response("{}");
        },
      });
      const outcome = await ctx.observe(
        "apply",
        client.apply("changed", { beforeDispatch: () => false }),
      );
      assert.equal(outcome.ok, false);
      if (!outcome.ok) assert.equal((outcome.error as unknown as { code: string }).code, "LOCAL_CONDITIONS_CHANGED");
      assert.equal(calls, 0);
      assert.equal(state.get("qva_throttle:apply"), undefined);
      ctx.value("calls", calls);
      ctx.effect("state", [...state.entries()]);
    },
  },
  {
    id: "qvapay-gateway/14-retry-after-across-restart",
    file: "test/qvapay-gateway.test.ts",
    source: "test/qvapay-gateway.test.ts:224",
    async run(ctx) {
      let now = 1_000;
      let calls = 0;
      const state = new Map<string, string>();
      const runtime = {
        now: () => now,
        sleep: async (ms: number) => {
          now += ms;
        },
        throttleState: {
          get: (key: string) => state.get(key),
          set: (key: string, value: string) => void state.set(key, value),
        },
        fetch: async () => {
          calls += 1;
          return calls === 1
            ? new Response('{"error":"Demasiadas solicitudes"}', {
                status: 429,
                headers: { "retry-after": "90" },
              })
            : new Response("{}");
        },
      };
      const first = await ctx.observe("apply:429", new QvaPayClient(() => "token", runtime).apply("one"));
      assert.equal(first.ok, false);
      assert.equal(calls, 1);
      await ctx.observe("apply:after-retry", new QvaPayClient(() => "token", runtime).apply("two"));
      assert.equal(now, 91_000);
      assert.equal(calls, 2);
      ctx.value("calls", calls);
      ctx.value("now", now);
    },
  },
  {
    id: "qvapay-gateway/15-preflight-failure-no-quota",
    file: "test/qvapay-gateway.test.ts",
    source: "test/qvapay-gateway.test.ts:250",
    async run(ctx) {
      let calls = 0;
      const state = new Map<string, string>();
      const client = new QvaPayClient(() => "token", {
        throttleState: {
          get: (key) => state.get(key),
          set: (key, value) => void state.set(key, value),
        },
        fetch: async () => {
          calls += 1;
          return new Response("{}");
        },
      });
      const outcome = await ctx.observe(
        "apply",
        client.apply("preflight-failed", {
          beforeDispatch: async () => {
            throw new QvaConnectionError("timeout", new Error("offline"));
          },
        }),
      );
      assert.equal(outcome.ok, false);
      if (!outcome.ok) {
        assert.equal((outcome.error as unknown as { code: string }).code, "LOCAL_PREFLIGHT_FAILED");
        assert.ok((outcome.error as unknown as { status: number }).status < 500);
      }
      assert.equal(calls, 0);
      assert.equal(state.get("qva_throttle:apply"), undefined);
      ctx.value("calls", calls);
    },
  },
  {
    id: "qvapay-gateway/16-idempotency-key",
    file: "test/qvapay-gateway.test.ts",
    source: "test/qvapay-gateway.test.ts:271",
    async run(ctx) {
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
      await ctx.observe(
        "createOffer",
        client.createOffer({
          type: "buy",
          coin: "BANK_CUP",
          amount: 1,
          receive: 900,
          details: [{ name: "cuenta", value: "123" }],
          idempotencyKey: "intent-12345678",
        }),
      );
      assert.equal(sent?.idempotency_key, "intent-12345678");
      ctx.effect("request.body", sent);
    },
  },
  {
    id: "qvapay-gateway/17-decimal-strings",
    file: "test/qvapay-gateway.test.ts",
    source: "test/qvapay-gateway.test.ts:295",
    async run(ctx) {
      const client = new QvaPayClient(() => "token", {
        now: () => 1_000,
        sleep: async () => undefined,
        fetch: async () =>
          new Response(
            JSON.stringify({
              data: [
                {
                  uuid: "documentada",
                  type: "buy",
                  coin: "BANK_CUP",
                  amount: "20.50",
                  receive: "20000.25",
                  status: "open",
                },
              ],
            }),
            { status: 200 },
          ),
      });
      const page = await client.listOffersPage({ take: 20 });
      ctx.value("listOffersPage", {
        offers: page.offers.map((offer) => ({ amount: offer.amount, receive: offer.receive })),
      });
      assert.equal(page.offers[0]?.amount, 20.5);
      assert.equal(page.offers[0]?.receive, 20_000.25);
    },
  },
  {
    id: "qvapay-gateway/18-ambiguous-amounts",
    file: "test/qvapay-gateway.test.ts",
    source: "test/qvapay-gateway.test.ts:307",
    async run(ctx) {
      let amount = "20 QUSD";
      const client = new QvaPayClient(() => "token", {
        now: () => 1_000,
        sleep: async () => undefined,
        fetch: async () =>
          new Response(
            JSON.stringify({
              data: [{ uuid: "rota", type: "buy", coin: "BANK_CUP", amount, receive: "20000", status: "open" }],
            }),
            { status: 200 },
          ),
      });
      for (const value of ["20 QUSD", "0", "1e3"]) {
        amount = value;
        const outcome = await ctx.observe(`list:${value}`, client.listOffersPage({ take: 20 }));
        assert.equal(outcome.ok, false);
        if (!outcome.ok) assert.match(outcome.error.message, /amount.*debe ser positivo/);
      }
    },
  },
  {
    id: "qvapay-gateway/19-averages-numeric",
    file: "test/qvapay-gateway.test.ts",
    source: "test/qvapay-gateway.test.ts:318",
    async run(ctx) {
      let invalid = false;
      const client = new QvaPayClient(() => "token", {
        now: () => 1_000,
        sleep: async () => undefined,
        fetch: async () =>
          new Response(
            JSON.stringify(
              invalid ? { BANK_CUP: { average_buy: "NaN" } } : { BANK_CUP: { average_buy: "1010.5" } },
            ),
            { status: 200 },
          ),
      });
      const valid = await ctx.observe("p2pAverages", client.p2pAverages());
      assert.equal(valid.ok, true);
      if (valid.ok) assert.equal((valid.value as Record<string, { average_buy: number }>).BANK_CUP?.average_buy, 1010.5);
      invalid = true;
      const rejected = await ctx.observe("p2pAverages:invalid", client.p2pAverages());
      assert.equal(rejected.ok, false);
      if (!rejected.ok) assert.match(rejected.error.message, /promedio BANK_CUP.average_buy/);
    },
  },
  {
    id: "qvapay-gateway/20-read-network-classification",
    file: "test/qvapay-gateway.test.ts",
    source: "test/qvapay-gateway.test.ts:330",
    async run(ctx) {
      const client = new QvaPayClient(() => "token", {
        sleep: async () => undefined,
        fetch: async () => {
          throw new TypeError("fetch failed");
        },
      });
      const outcome = await ctx.observe("listOffersPage", client.listOffersPage({ take: 20 }));
      assert.equal(outcome.ok, false);
      if (!outcome.ok) {
        assert.equal((outcome.error as unknown as { reason: string }).reason, "network");
        assert.match(outcome.error.message, /QvaPay/);
      }
    },
  },
  {
    id: "qvapay-gateway/21-list-429",
    file: "test/qvapay-gateway.test.ts",
    source: "test/qvapay-gateway.test.ts:346",
    async run(ctx) {
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
      const outcome = await ctx.observe("listOffersPage", client.listOffersPage({ take: 20 }));
      assert.equal(outcome.ok, false);
      if (!outcome.ok) {
        assert.equal((outcome.error as unknown as { status: number }).status, 429);
        assert.equal((outcome.error as unknown as { retryAfterMs: number }).retryAfterMs, 7_000);
      }
      assert.equal(calls, 1);
      ctx.value("calls", calls);
    },
  },
  {
    id: "qvapay-gateway/22-edit-timeout-uncertain",
    file: "test/qvapay-gateway.test.ts",
    source: "test/qvapay-gateway.test.ts:362",
    async run(ctx) {
      const client = new QvaPayClient(() => "token", {
        mutationTimeoutMs: 5,
        fetch: async (_input, init) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
          }),
      });
      const keepAlive = setTimeout(() => {}, 100);
      const outcome = await ctx.observe(
        "editOffer",
        client.editOffer("offer-timeout", { amount: 10, receive: 9_000 }),
      );
      clearTimeout(keepAlive);
      assert.equal(outcome.ok, false);
      if (!outcome.ok) assert.match(outcome.error.message, /No se recibió confirmación/);
    },
  },
  {
    id: "qvapay-gateway/23-malformed-2xx-uncertain",
    file: "test/qvapay-gateway.test.ts",
    source: "test/qvapay-gateway.test.ts:376",
    async run(ctx) {
      const client = new QvaPayClient(() => "token", {
        now: () => 1_000,
        sleep: async () => undefined,
        fetch: async () => new Response(JSON.stringify({ message: "ok" }), { status: 200 }),
      });
      const created = await ctx.observe(
        "createOffer",
        client.createOffer({
          type: "buy",
          coin: "BANK_CUP",
          amount: 1,
          receive: 900,
          details: [{ name: "cuenta", value: "123" }],
        }),
      );
      assert.equal(created.ok, false);
      if (!created.ok) assert.match(created.error.message, /No se recibió confirmación/);
      const edited = await ctx.observe(
        "editOffer",
        client.editOffer("offer-with-invalid-response", { amount: 1 }),
      );
      assert.equal(edited.ok, false);
      if (!edited.ok) assert.match(edited.error.message, /No se recibió confirmación/);
    },
  },
  {
    id: "qvapay-gateway/24-second-apply-no-wait",
    file: "test/qvapay-gateway.test.ts",
    source: "test/qvapay-gateway.test.ts:400",
    async run(ctx) {
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const sent: string[] = [];
      const client = new QvaPayClient(() => "token", {
        fetch: async (input) => {
          sent.push(String(input));
          if (String(input).includes("/first/")) await held;
          return Response.json({});
        },
      });
      const first = ctx.observe("apply:first", client.apply("first", { beforeDispatch: () => true }));
      const second = ctx.observe("apply:second", client.apply("second", { beforeDispatch: () => true }));
      try {
        const result = await Promise.race([
          second.then(() => true),
          new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 100)),
        ]);
        assert.equal(result, true, "la espera HTTP no retiene el permiso de envío");
        const third = await ctx.observe(
          "apply:third",
          client
            .apply("third", { beforeDispatch: () => true })
            .then(() => null)
            .catch((error: unknown) => ({ code: (error as { code?: string }).code ?? null })),
        );
        assert.equal(third.ok, true);
        if (third.ok) assert.equal((third.value as { code: string } | null)?.code, "LOCAL_APPLY_QUOTA");
        assert.equal(sent.length, 2);
      } finally {
        release();
        await Promise.allSettled([first, second]);
      }
      ctx.effect("sent", sent);
    },
  },
  {
    id: "qvapay-gateway/25-liquidity-revalidation",
    file: "test/qvapay-gateway.test.ts",
    source: "test/qvapay-gateway.test.ts:412",
    async run(ctx) {
      let release!: () => void;
      let active = true;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const sent: string[] = [];
      const client = new QvaPayClient(() => "token", {
        fetch: async (input) => {
          const url = String(input);
          sent.push(url);
          if (url.endsWith("/user")) {
            await held;
            return Response.json({ uuid: "me" });
          }
          return Response.json({});
        },
      });
      const read = ctx.observe("profile", client.profile());
      const edit = ctx.observe(
        "editOffer",
        client.editOffer("own", { amount: 1, receive: 100 }, { beforeDispatch: () => active }),
      );
      active = false;
      release();
      await read;
      const outcome = await edit;
      assert.equal(outcome.ok, false);
      if (!outcome.ok) assert.equal((outcome.error as unknown as { code: string }).code, "LOCAL_CONDITIONS_CHANGED");
      assert.equal(sent.some((url) => url.endsWith("/edit")), false);
      ctx.effect("sent", sent);
    },
  },
  {
    id: "qvapay-gateway/26-flexible-completed-no-peer",
    file: "test/qvapay-gateway.test.ts",
    source: "test/qvapay-gateway.test.ts:424",
    async run(ctx) {
      const client = new QvaPayClient(() => "token", {
        fetch: async () =>
          Response.json({
            p2p: {
              uuid: "range",
              type: "sell",
              coin: "CLASICA",
              amount: "40",
              receive: "40",
              status: "completed",
              offer_kind: "flexible",
              Peer: {},
              Orders: [
                { uuid: "child", amount: "40", receive: "40", status: "completed", Taker: { uuid: "me" } },
              ],
            },
          }),
      });
      const outcome = await ctx.observe("getOffer", client.getOffer("range"));
      assert.equal(outcome.ok, true);
      if (outcome.ok) {
        const offer = outcome.value as { Peer: unknown; Orders?: Array<{ status: string }> };
        assert.equal(offer.Peer, null);
        assert.equal(offer.Orders?.[0]?.status, "completed");
      }
    },
  },
  {
    id: "qvapay-gateway/27-accounting-validates-capital",
    file: "test/qvapay-gateway.test.ts",
    source: "test/qvapay-gateway.test.ts:434",
    async run(ctx) {
      let now = 1000;
      const client = new QvaPayClient(() => "token", {
        now: () => now,
        sleep: async (ms) => {
          now += ms;
        },
        fetch: async () =>
          Response.json({
            p2p: {
              uuid: "paid",
              type: "sell",
              coin: "CLASICA",
              amount: "10",
              receive: "10.9",
              status: "paid",
              Peer: { uuid: "me" },
              details: [{ name: "Tarjeta", value: 1234 }],
            },
          }),
      });
      const strict = await ctx.observe("getOffer", client.getOffer("paid"));
      assert.equal(strict.ok, false);
      if (!strict.ok) assert.match(strict.error.message, /datos de pago/);
      const analytics = await ctx.observe("getOffer:analytics", client.getOffer("paid", { analyticsOnly: true }));
      assert.equal(analytics.ok, true);
      if (analytics.ok) assert.equal((analytics.value as { receive: number }).receive, 10.9);
    },
  },
];

export { scenarios };
