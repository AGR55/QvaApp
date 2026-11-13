/**
 * Escenarios de contrato: `test/qvapay-list-timing.test.ts`.
 *
 * Reloj monotónico inyectado: `queueMs`/`responseMs` son canónicos.
 */
import assert from "node:assert/strict";
import { QvaApiError, QvaConnectionError, QvaPayClient } from "../../../src/qvapay.js";
import type { ListTiming } from "../../../src/types.js";
import type { ContractScenario } from "../../../lib/contract/scenario.js";

const scenarios: ContractScenario[] = [
  {
    id: "qvapay-list-timing/01-queue-response-cache",
    file: "test/qvapay-list-timing.test.ts",
    source: "test/qvapay-list-timing.test.ts:7",
    async run(ctx) {
      let clock = 0;
      const seen: ListTiming[] = [];
      const client = new QvaPayClient(() => "secret", {
        monotonicNow: () => clock,
        now: () => 1000,
        sleep: async (ms) => {
          clock += ms;
        },
        fetch: async () => {
          clock += 7;
          return new Response('{"data":[]}', { headers: { "X-Cache": " hIt " } });
        },
        onListTiming: (timing) => {
          seen.push(timing);
          throw new Error("callback failed");
        },
      });
      const first = await ctx.observe("list#1", client.listOffersPage({ coin: "CUP" }));
      const second = await ctx.observe("list#2", client.listOffersPage({ coin: "CUP" }));
      assert.equal(first.ok, true);
      assert.equal(second.ok, true);
      if (first.ok) {
        const page = first.value as { cacheStatus: string; timing: ListTiming };
        assert.equal(page.cacheStatus, "HIT");
        assert.deepEqual(page.timing, {
          queueMs: 0,
          responseMs: 7,
          totalMs: 7,
          attempts: 1,
          outcome: "success",
          status: 200,
          cacheStatus: "HIT",
        });
      }
      if (second.ok) assert.equal((second.value as { timing: ListTiming }).timing?.queueMs, 2401);
      assert.deepEqual(
        seen,
        [first.ok ? (first.value as { timing: ListTiming }).timing : undefined, second.ok ? (second.value as { timing: ListTiming }).timing : undefined],
      );
      assert.equal(JSON.stringify(seen).includes("secret"), false);
      ctx.effect("list.timings", seen);
    },
  },
  {
    id: "qvapay-list-timing/02-retry-http-error",
    file: "test/qvapay-list-timing.test.ts",
    source: "test/qvapay-list-timing.test.ts:22",
    async run(ctx) {
      let clock = 0;
      let calls = 0;
      const seen: ListTiming[] = [];
      const client = new QvaPayClient(() => "token", {
        monotonicNow: () => clock,
        sleep: async (ms) => {
          clock += ms;
        },
        fetch: async () => {
          clock += 5;
          if (++calls === 1) throw new Error("network");
          return new Response('{"error":"busy"}', {
            status: 429,
            headers: { "X-Cache": "private arbitrary value" },
          });
        },
        onListTiming: (timing) => seen.push(timing),
      });
      const outcome = await ctx.observe("list", client.listOffersPage({}));
      assert.equal(outcome.ok, false);
      if (!outcome.ok) {
        assert.equal((outcome.error as unknown as { status: number }).status, 429);
        assert.ok(QvaApiError);
      }
      assert.deepEqual(seen[0], {
        queueMs: 0,
        responseMs: 810,
        totalMs: 810,
        attempts: 2,
        outcome: "failed",
        status: 429,
      });
      ctx.effect("list.timings", seen);
    },
  },
  {
    id: "qvapay-list-timing/03-network-and-no-session",
    file: "test/qvapay-list-timing.test.ts",
    source: "test/qvapay-list-timing.test.ts:35",
    async run(ctx) {
      let clock = 0;
      const seen: ListTiming[] = [];
      const client = new QvaPayClient(() => "token", {
        monotonicNow: () => clock,
        sleep: async (ms) => {
          clock += ms;
        },
        fetch: async () => {
          clock += 2;
          throw new Error("offline");
        },
        onListTiming: (timing) => seen.push(timing),
      });
      const network = await ctx.observe("list:network", client.listOffersPage({}));
      assert.equal(network.ok, false);
      if (!network.ok) {
        assert.equal((network.error as unknown as { reason: string }).reason, "network");
        assert.ok(QvaConnectionError);
      }
      assert.deepEqual(seen[0], {
        queueMs: 0,
        responseMs: 2406,
        totalMs: 2406,
        attempts: 3,
        outcome: "failed",
      });
      const noSession = new QvaPayClient(() => undefined, {
        monotonicNow: () => clock,
        onListTiming: (timing) => seen.push(timing),
      });
      const absent = await ctx.observe("list:no-session", noSession.listOffersPage({}));
      assert.equal(absent.ok, false);
      if (!absent.ok) assert.equal((absent.error as unknown as { status: number }).status, 401);
      assert.deepEqual(seen[1], {
        queueMs: null,
        responseMs: null,
        totalMs: 0,
        attempts: 0,
        outcome: "failed",
      });
      ctx.effect("list.timings", seen);
    },
  },
];

export { scenarios };
