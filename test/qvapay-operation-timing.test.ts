import assert from "node:assert/strict";
import test from "node:test";
import { withOperationTrace, type OperationRequestTiming } from "../src/operation-trace.js";
import { QvaPayClient, QvaMutationUncertainError } from "../src/qvapay.js";
import { setTimeout as delay } from "node:timers/promises";

const trace = { traceId: "trace", operationUuid: "operation", action: "paid" };

test("request timing separates queue, throttle and upstream only inside an action trace", async () => {
  const timings: OperationRequestTiming[] = [];
  let now = 1000;
  const client = new QvaPayClient(() => "private-token", {
    now: () => now,
    sleep: async milliseconds => { now += milliseconds; },
    fetch: async () => new Response("{}"),
  });
  await client.markPaid("outside", "private-reference");
  await withOperationTrace(trace, timing => timings.push(timing), async () => {
    await Promise.all([client.markPaid("operation", "private-reference"), client.confirmReceived("operation")]);
  });
  assert.equal(timings.length, 2);
  for (const timing of timings) {
    assert.equal(timing.traceId, "trace");
    assert.equal(timing.method, "POST");
    assert.equal(timing.outcome, "success");
    assert.ok(timing.queueMs! >= 0);
    assert.ok(timing.throttleMs! >= 0);
    assert.ok(timing.upstreamMs! >= 0);
    assert.ok(Math.abs(timing.totalMs - timing.queueMs! - timing.throttleMs! - timing.upstreamMs!) < 0.001);
    assert.equal(JSON.stringify(timing).includes("private-"), false);
  }
  assert.notEqual(timings[0]?.requestId, timings[1]?.requestId);
});

test("timing reports failure before dispatch without upstream and preserves uncertain errors after dispatch", async () => {
  const timings: OperationRequestTiming[] = [];
  let sends = 0;
  const client = new QvaPayClient(() => "token", {
    fetch: async () => { sends++; throw new TypeError("network"); },
  });
  await withOperationTrace(trace, timing => timings.push(timing), async () => {
    await assert.rejects(client.cancel("operation", undefined, {beforeDispatch: () => false}), /no se envió/);
    await assert.rejects(client.markPaid("operation", "reference"), QvaMutationUncertainError);
  });
  assert.equal(sends, 1);
  assert.equal(timings.length, 2);
  assert.equal(timings[0]?.outcome, "failed");
  assert.equal(timings[0]?.upstreamMs, undefined);
  assert.ok(timings[0]?.queueMs !== undefined);
  assert.equal(timings[1]?.outcome, "failed");
  assert.ok(timings[1]?.upstreamMs !== undefined);
});

test("an observer failure cannot change the result of a confirmed request", async () => {
  const client = new QvaPayClient(() => "token", { fetch: async () => new Response("{}") });
  await withOperationTrace(trace, () => { throw new Error("observer failed"); }, () => client.markPaid("operation", "reference"));
});

test("a slow queued action separates queue waiting, throttle and response body time", async () => {
  const timings: OperationRequestTiming[] = [];
  let now = 1000;
  let releaseBlocker!: () => void;
  let notifyDispatched!: () => void;
  const blocker = new Promise<void>(resolve => { releaseBlocker = resolve; });
  const dispatched = new Promise<void>(resolve => { notifyDispatched = resolve; });
  let requests = 0;
  const client = new QvaPayClient(() => "token", {
    now: () => now,
    sleep: async milliseconds => { now += milliseconds; await delay(20); },
    fetch: async () => {
      requests++;
      if (requests === 1) { notifyDispatched(); await blocker; return new Response("{}"); }
      return new Response(new ReadableStream<Uint8Array>({
        async start(controller) {
          await delay(20);
          controller.enqueue(new TextEncoder().encode("{}"));
          controller.close();
        },
      }));
    },
  });
  const first = client.markPaid("outside", "reference");
  await dispatched;
  const second = withOperationTrace(trace, timing => timings.push(timing), () => client.confirmReceived("operation"));
  await delay(20);
  releaseBlocker();
  await Promise.all([first, second]);
  assert.equal(timings.length, 1);
  assert.ok(timings[0]!.queueMs! >= 10);
  assert.ok(timings[0]!.throttleMs! >= 10);
  assert.ok(timings[0]!.upstreamMs! >= 10);
  assert.equal(requests, 2);
});

test("concurrent action contexts do not mix their identities", async () => {
  const timings: OperationRequestTiming[] = [];
  let now = 1000;
  const client = new QvaPayClient(() => "token", {
    now: () => now,
    sleep: async milliseconds => { now += milliseconds; },
    fetch: async () => new Response("{}"),
  });
  await Promise.all(["first", "second"].map(operationUuid => withOperationTrace({
    traceId: operationUuid, operationUuid, action: "paid",
  }, timing => timings.push(timing), () => client.markPaid(operationUuid, "reference"))));
  assert.deepEqual(timings.map(timing => [timing.traceId, timing.operationUuid]), [["first", "first"], ["second", "second"]]);
});
