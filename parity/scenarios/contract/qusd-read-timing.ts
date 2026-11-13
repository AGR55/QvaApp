/**
 * Escenarios de contrato: `test/qusd-read-timing.test.ts`.
 *
 * Reloj monotónico inyectado; nunca se observan saldo ni credenciales.
 */
import assert from "node:assert/strict";
import { QvaApiError, QvaPayClient } from "../../../src/qvapay.js";
import type { QusdReadTiming } from "../../../src/types.js";
import type { ContractScenario } from "../../../lib/contract/scenario.js";

const scenarios: ContractScenario[] = [
  {
    id: "qusd-read-timing/01-priority-retries",
    file: "test/qusd-read-timing.test.ts",
    source: "test/qusd-read-timing.test.ts:7",
    async run(ctx) {
      let clock = 0;
      let calls = 0;
      const seen: QusdReadTiming[] = [];
      const client = new QvaPayClient(() => "private-token", {
        now: () => 1000,
        monotonicNow: () => clock,
        sleep: async (ms) => {
          clock += ms;
        },
        fetch: async () => {
          clock += 5;
          if (++calls === 2) throw new Error("network");
          return new Response('{"balance":42}');
        },
        onQusdReadTiming: (timing) => seen.push(timing),
      });
      const first = await ctx.observe("qusd#1", client.qusdBalance({ priority: true }));
      const second = await ctx.observe("qusd#2", client.qusdBalance({ priority: true }));
      assert.equal(first.ok && first.value, 42);
      assert.equal(second.ok && second.value, 42);
      assert.deepEqual(seen[0], {
        priority: "urgent",
        outcome: "success",
        queueMs: 0,
        responseMs: 5,
        totalMs: 5,
      });
      assert.deepEqual(seen[1], {
        priority: "urgent",
        outcome: "success",
        queueMs: 1667,
        responseMs: 810,
        totalMs: 2477,
      });
      assert.doesNotMatch(JSON.stringify(seen), /private-token|balance|42/);
      ctx.effect("qusd.timings", seen);
    },
  },
  {
    id: "qusd-read-timing/02-callback-failure-stages",
    file: "test/qusd-read-timing.test.ts",
    source: "test/qusd-read-timing.test.ts:25",
    async run(ctx) {
      const seen: QusdReadTiming[] = [];
      let clock = 0;
      let calls = 0;
      const client = new QvaPayClient(() => "token", {
        monotonicNow: () => clock,
        fetch: async () => {
          clock += 10;
          return new Response(++calls === 1 ? '{"balance":1}' : "{}");
        },
        sleep: async (ms) => {
          clock += ms;
        },
        now: () => 1000,
        onQusdReadTiming: (timing) => {
          seen.push(timing);
          throw new Error("observer");
        },
      });
      const first = await ctx.observe("qusd:ok", client.qusdBalance());
      assert.equal(first.ok && first.value, 1);
      const second = await ctx.observe("qusd:invalid", client.qusdBalance());
      assert.equal(second.ok, false);
      if (!second.ok) assert.match(second.error.message, /saldo QUSD reconocible/);
      assert.equal(seen[1]?.outcome, "failed");
      assert.equal(seen[1]?.priority, "normal");
      assert.equal(seen[1]?.responseMs, 10);
      const absent = new QvaPayClient(() => undefined, {
        monotonicNow: () => clock,
        onQusdReadTiming: (timing) => seen.push(timing),
      });
      const noSession = await ctx.observe("qusd:no-session", absent.qusdBalance());
      assert.equal(noSession.ok, false);
      if (!noSession.ok) assert.ok(QvaApiError);
      assert.deepEqual(seen[2], {
        priority: "normal",
        outcome: "failed",
        queueMs: null,
        responseMs: null,
        totalMs: 0,
      });
      ctx.effect("qusd.timings", seen);
    },
  },
];

export { scenarios };
