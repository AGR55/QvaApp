/**
 * Escenarios de contrato: `test/qvapay-operation-timing.test.ts`.
 *
 * Los tiempos de operación usan `performance.now()` y `requestId` aleatorio:
 * se observa su *forma* (etapas presentes, suma coherente, sin secretos), no
 * los milisegundos ni el UUID efímero.
 */
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { withOperationTrace, type OperationRequestTiming } from "../../../src/operation-trace.js";
import { QvaMutationUncertainError, QvaPayClient } from "../../../src/qvapay.js";
import type { ContractScenario } from "../../../lib/contract/scenario.js";

const trace = { traceId: "trace", operationUuid: "operation", action: "paid" };

function timingShape(timing: OperationRequestTiming) {
  const sumOk =
    timing.queueMs !== undefined && timing.throttleMs !== undefined && timing.upstreamMs !== undefined
      ? Math.abs(timing.totalMs - timing.queueMs - timing.throttleMs - timing.upstreamMs) < 0.001
      : null;
  return {
    traceId: timing.traceId,
    operationUuid: timing.operationUuid,
    action: timing.action,
    policy: timing.policy,
    method: timing.method,
    outcome: timing.outcome,
    hasQueue: timing.queueMs !== undefined,
    hasThrottle: timing.throttleMs !== undefined,
    hasUpstream: timing.upstreamMs !== undefined,
    sumOk,
    hasRequestId: typeof timing.requestId === "string" && timing.requestId.length > 0,
    leaksPrivate: JSON.stringify(timing).includes("private-"),
  };
}

const scenarios: ContractScenario[] = [
  {
    id: "qvapay-operation-timing/01-separates-stages",
    file: "test/qvapay-operation-timing.test.ts",
    source: "test/qvapay-operation-timing.test.ts:8",
    async run(ctx) {
      const timings: OperationRequestTiming[] = [];
      let now = 1000;
      const client = new QvaPayClient(() => "private-token", {
        now: () => now,
        sleep: async (milliseconds) => {
          now += milliseconds;
        },
        fetch: async () => new Response("{}"),
      });
      await ctx.observe("markPaid:outside", client.markPaid("outside", "private-reference"));
      await ctx.observe(
        "trace",
        withOperationTrace(trace, (timing) => timings.push(timing), async () => {
          await Promise.all([
            client.markPaid("operation", "private-reference"),
            client.confirmReceived("operation"),
          ]);
        }),
      );
      assert.equal(timings.length, 2);
      for (const timing of timings) {
        assert.equal(timing.traceId, "trace");
        assert.equal(timing.method, "POST");
        assert.equal(timing.outcome, "success");
        assert.ok(timing.queueMs! >= 0);
        assert.ok(timing.throttleMs! >= 0);
        assert.ok(timing.upstreamMs! >= 0);
        assert.ok(
          Math.abs(timing.totalMs - timing.queueMs! - timing.throttleMs! - timing.upstreamMs!) < 0.001,
        );
        assert.equal(JSON.stringify(timing).includes("private-"), false);
      }
      assert.notEqual(timings[0]?.requestId, timings[1]?.requestId);
      const shapes = timings.map(timingShape).sort((left, right) =>
        `${left.policy}:${left.method}`.localeCompare(`${right.policy}:${right.method}`),
      );
      ctx.value("timings", shapes);
      ctx.value("distinctRequestIds", timings[0]?.requestId !== timings[1]?.requestId);
    },
  },
  {
    id: "qvapay-operation-timing/02-failure-stages",
    file: "test/qvapay-operation-timing.test.ts",
    source: "test/qvapay-operation-timing.test.ts:32",
    async run(ctx) {
      const timings: OperationRequestTiming[] = [];
      let sends = 0;
      const client = new QvaPayClient(() => "token", {
        fetch: async () => {
          sends += 1;
          throw new TypeError("network");
        },
      });
      const failed = await ctx.observe(
        "trace",
        withOperationTrace(trace, (timing) => timings.push(timing), async () => {
          const before = await ctx.observe(
            "cancel:before-dispatch",
            client.cancel("operation", undefined, { beforeDispatch: () => false }),
          );
          assert.equal(before.ok, false);
          if (!before.ok) assert.match(before.error.message, /no se envió/);
          const uncertain = await ctx.observe("markPaid:network", client.markPaid("operation", "reference"));
          assert.equal(uncertain.ok, false);
          if (!uncertain.ok) assert.match(uncertain.error.message, /No se recibió confirmación/);
        }),
      );
      assert.equal(failed.ok, true);
      assert.equal(sends, 1);
      assert.equal(timings.length, 2);
      assert.equal(timings[0]?.outcome, "failed");
      assert.equal(timings[0]?.upstreamMs, undefined);
      assert.ok(timings[0]?.queueMs !== undefined);
      assert.equal(timings[1]?.outcome, "failed");
      assert.ok(timings[1]?.upstreamMs !== undefined);
      assert.ok(QvaMutationUncertainError);
      ctx.value("timings", timings.map(timingShape));
      ctx.value("sends", sends);
    },
  },
  {
    id: "qvapay-operation-timing/03-observer-failure-safe",
    file: "test/qvapay-operation-timing.test.ts",
    source: "test/qvapay-operation-timing.test.ts:52",
    async run(ctx) {
      const client = new QvaPayClient(() => "token", { fetch: async () => new Response("{}") });
      const result = await ctx.observe(
        "trace",
        withOperationTrace(
          trace,
          () => {
            throw new Error("observer failed");
          },
          () => client.markPaid("operation", "reference"),
        ),
      );
      assert.equal(result.ok, true);
    },
  },
  {
    id: "qvapay-operation-timing/04-slow-queued-action",
    file: "test/qvapay-operation-timing.test.ts",
    source: "test/qvapay-operation-timing.test.ts:57",
    async run(ctx) {
      const timings: OperationRequestTiming[] = [];
      let now = 1000;
      let releaseBlocker!: () => void;
      let notifyDispatched!: () => void;
      const blocker = new Promise<void>((resolve) => {
        releaseBlocker = resolve;
      });
      const dispatched = new Promise<void>((resolve) => {
        notifyDispatched = resolve;
      });
      let requests = 0;
      const client = new QvaPayClient(() => "token", {
        now: () => now,
        sleep: async (milliseconds) => {
          now += milliseconds;
          await delay(20);
        },
        fetch: async () => {
          requests += 1;
          if (requests === 1) {
            notifyDispatched();
            await blocker;
            return new Response("{}");
          }
          return new Response(
            new ReadableStream<Uint8Array>({
              async start(controller) {
                await delay(20);
                controller.enqueue(new TextEncoder().encode("{}"));
                controller.close();
              },
            }),
          );
        },
      });
      const first = ctx.observe("markPaid:outside", client.markPaid("outside", "reference"));
      await dispatched;
      const second = ctx.observe(
        "trace",
        withOperationTrace(trace, (timing) => timings.push(timing), () => client.confirmReceived("operation")),
      );
      await delay(20);
      releaseBlocker();
      await Promise.all([first, second]);
      assert.equal(timings.length, 1);
      assert.ok(timings[0]!.queueMs! >= 10);
      assert.ok(timings[0]!.throttleMs! >= 10);
      assert.ok(timings[0]!.upstreamMs! >= 10);
      assert.equal(requests, 2);
      ctx.value("timing", timingShape(timings[0]!));
      ctx.value("thresholds", {
        queueGte10: timings[0]!.queueMs! >= 10,
        throttleGte10: timings[0]!.throttleMs! >= 10,
        upstreamGte10: timings[0]!.upstreamMs! >= 10,
      });
      ctx.value("requests", requests);
    },
  },
  {
    id: "qvapay-operation-timing/05-concurrent-contexts",
    file: "test/qvapay-operation-timing.test.ts",
    source: "test/qvapay-operation-timing.test.ts:94",
    async run(ctx) {
      const timings: OperationRequestTiming[] = [];
      let now = 1000;
      const client = new QvaPayClient(() => "token", {
        now: () => now,
        sleep: async (milliseconds) => {
          now += milliseconds;
        },
        fetch: async () => new Response("{}"),
      });
      await ctx.observe(
        "concurrent",
        Promise.all(
          ["first", "second"].map((operationUuid) =>
            withOperationTrace(
              { traceId: operationUuid, operationUuid, action: "paid" },
              (timing) => timings.push(timing),
              () => client.markPaid(operationUuid, "reference"),
            ),
          ),
        ),
      );
      assert.deepEqual(
        timings.map((timing) => [timing.traceId, timing.operationUuid]),
        [
          ["first", "first"],
          ["second", "second"],
        ],
      );
      ctx.value(
        "contexts",
        timings.map((timing) => ({ traceId: timing.traceId, operationUuid: timing.operationUuid })),
      );
    },
  },
];

export { scenarios };
