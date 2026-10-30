import assert from "node:assert/strict";
import test from "node:test";
import {
  consumeSse,
  QvaPayFeedStream,
  type QvaPayStreamState,
} from "../src/qvapay-feed-stream.js";

test("parsea SSE fragmentado, retry, keepalive y eventos con varias líneas", async () => {
  const encoder = new TextEncoder();
  const chunks = [
    "retry: 10000\r\nevent: init\r\ndata: {\"ok\":true}\r\n\r\n: keep",
    "alive 1\n\nevent: p2p.created\ndata: {\"event\":\"p2p.created\",\ndata: \"data\":{}}\n\n",
  ];
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      chunks.forEach((chunk) => controller.enqueue(encoder.encode(chunk)));
      controller.close();
    },
  });
  const events: Array<{ event: string; data: string }> = [];
  const retries: number[] = [];
  await consumeSse(body, (event) => events.push(event), (retry) => retries.push(retry));
  assert.deepEqual(retries, [10_000]);
  assert.deepEqual(events, [
    { event: "init", data: "{\"ok\":true}" },
    { event: "p2p.created", data: "{\"event\":\"p2p.created\",\n\"data\":{}}" },
  ]);
});

test("envía credenciales por cabeceras, publica estado y se puede detener", async () => {
  let headers: Headers | undefined;
  const states: QvaPayStreamState[] = [];
  const payloads: unknown[] = [];
  const stream = new QvaPayFeedStream(
    (payload) => payloads.push(payload),
    (state) => states.push(state),
    {
      fetch: async (_input, init) => {
        headers = new Headers(init?.headers);
        return new Response(
          "event: init\ndata: {\"ok\":true,\"expires_at\":\"2026-10-20T18:00:00Z\"}\n\n" +
          "event: p2p.created\ndata: {\"event\":\"p2p.created\",\"sent_at\":\"2026-09-28T12:00:00Z\",\"data\":{}}\n\n",
          { status: 200, headers: { "content-type": "text/event-stream" } },
        );
      },
      wait: (_milliseconds, signal) => new Promise<void>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
      }),
    },
  );
  stream.start({ appId: "app-id", appSecret: "secret-value" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(headers?.get("app-id"), "app-id");
  assert.equal(headers?.get("app-secret"), "secret-value");
  assert.equal(payloads.length, 1);
  assert.ok(states.some((state) => state.phase === "connected" && state.expiresAt));
  stream.stop();
  assert.equal(states.at(-1)?.phase, "idle");
});

test("clasifica credenciales rechazadas sin filtrar el secreto", async () => {
  const states: QvaPayStreamState[] = [];
  const stream = new QvaPayFeedStream(
    () => undefined,
    (state) => states.push(state),
    {
      fetch: async () => new Response("rechazado", { status: 401 }),
      wait: (_milliseconds, signal) => new Promise<void>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
      }),
    },
  );
  stream.start({ appId: "app-id", appSecret: "never-log-this-secret" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(states.some((state) => state.phase === "unauthorized"));
  assert.doesNotMatch(JSON.stringify(states), /never-log-this-secret/);
  stream.stop();
});

test("reconecta tras cierre limpio en un segundo y respeta retry del servidor", async () => {
  for (const [body, expected] of [["", 1_000], ["retry: 120000\n\n", 120_000]] as const) {
    let delay: number | undefined;
    const stream = new QvaPayFeedStream(() => undefined, () => undefined, {
      fetch: async () => new Response(body),
      wait: (milliseconds, signal) => {
        delay = milliseconds;
        return new Promise<void>((_resolve, reject) => signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true }));
      },
    });
    stream.start({ appId: "test", appSecret: "test" });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(delay, expected);
    stream.stop();
  }
});

test("respeta Retry-After en 429 y mantiene espera conservadora ante error", async () => {
  for (const [response, expected] of [[new Response("", { status: 429, headers: { "retry-after": "75" } }), 75_000], [new Response("", { status: 500 }), 10_000]] as const) {
    let delay: number | undefined;
    const stream = new QvaPayFeedStream(() => undefined, () => undefined, {
      fetch: async () => response,
      random: () => 0.5,
      wait: (milliseconds, signal) => {
        delay = milliseconds;
        return new Promise<void>((_resolve, reject) => signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true }));
      },
    });
    stream.start({ appId: "test", appSecret: "test" });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(delay, expected);
    stream.stop();
  }
});
