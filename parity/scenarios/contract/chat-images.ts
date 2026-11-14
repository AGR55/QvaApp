/**
 * Escenarios de contrato: `test/chat-images.test.ts`.
 *
 * `fetch` inyectado; validación real de MIME/dimensiones/multipart y SSRF.
 */
import assert from "node:assert/strict";
import {
  CHAT_IMAGE_MAX_BYTES,
  chatImageUrl,
  parseChatImageMultipart,
  validateChatImage,
} from "../../../src/chat-images.js";
import { QvaMutationUncertainError, QvaPayClient } from "../../../src/qvapay.js";
import type { ContractScenario } from "../../../lib/contract/scenario.js";

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
  "base64",
);

const scenarios: ContractScenario[] = [
  {
    id: "chat-images/01-malformed-success-uncertain",
    file: "test/chat-images.test.ts",
    source: "test/chat-images.test.ts:7",
    async run(ctx) {
      for (const body of ["not-json", "{}", '{"message":null}']) {
        let calls = 0;
        const client = new QvaPayClient(() => "secret", {
          fetch: async () => {
            calls += 1;
            return new Response(body);
          },
        });
        const outcome = await ctx.observe(
          `sendChat:${body}`,
          client.sendChat("offer", "caption", undefined, { bytes: png, mimeType: "image/png" }),
        );
        assert.equal(outcome.ok, false);
        if (!outcome.ok) {
          assert.equal(outcome.error.kind, "chat");
          assert.match(outcome.error.message, /No se recibió confirmación/);
        }
        assert.equal(calls, 1);
        ctx.value(`calls:${body}`, calls);
      }
    },
  },
  {
    id: "chat-images/02-validate-mime-dimensions-bytes",
    file: "test/chat-images.test.ts",
    source: "test/chat-images.test.ts:16",
    async run(ctx) {
      const ok = await ctx.observe("valid", validateChatImage(png, "image/png"));
      assert.equal(ok.ok, true);
      if (ok.ok) assert.equal((ok.value as { mimeType: string }).mimeType, "image/png");

      const huge = Buffer.from(png);
      huge.writeUInt32BE(1001, 16);
      for (const [label, bytes, mime] of [
        ["wrong-mime", png, "image/jpeg"],
        ["svg", Buffer.from("<svg/>"), "image/png"],
        ["oversized", Buffer.alloc(CHAT_IMAGE_MAX_BYTES + 1), "image/png"],
        ["dimensions", huge, "image/png"],
      ] as const) {
        const outcome = await ctx.observe(label, Promise.resolve().then(() => validateChatImage(bytes, mime)));
        assert.equal(outcome.ok, false);
      }
    },
  },
  {
    id: "chat-images/03-multipart-single-image",
    file: "test/chat-images.test.ts",
    source: "test/chat-images.test.ts:23",
    async run(ctx) {
      const form = new FormData();
      form.set("file", new Blob([png], { type: "image/png" }), "../untrusted.png");
      form.set("attemptId", "attempt-0000000001");
      const request = new Request("https://local.invalid", { method: "POST", body: form });
      const parsed = await ctx.observe(
        "parse",
        parseChatImageMultipart(Buffer.from(await request.arrayBuffer()), request.headers.get("content-type")!),
      );
      assert.equal(parsed.ok, true);
      if (parsed.ok) {
        const value = parsed.value as { message: string; image: { bytes: Uint8Array } };
        assert.equal(value.message, "");
        assert.deepEqual(Buffer.from(value.image.bytes), png);
        ctx.value("parsed", { message: value.message, imageBytes: value.image.bytes.length });
      }
      form.append("file", new Blob([png], { type: "image/png" }), "second.png");
      const duplicate = new Request("https://local.invalid", { method: "POST", body: form });
      const rejected = await ctx.observe(
        "parse-duplicate",
        parseChatImageMultipart(Buffer.from(await duplicate.arrayBuffer()), duplicate.headers.get("content-type")!),
      );
      assert.equal(rejected.ok, false);
    },
  },
  {
    id: "chat-images/04-remote-url-ssrf",
    file: "test/chat-images.test.ts",
    source: "test/chat-images.test.ts:32",
    async run(ctx) {
      for (const url of [
        "http://www.qvapay.com/storage/a.png",
        "https://127.0.0.1/storage/a.png",
        "https://api.qvapay.com.evil.test/storage/a.png",
        "https://user:pass@api.qvapay.com/storage/a.png",
        "https://api.qvapay.com:444/storage/a.png",
        "https://www.qvapay.com/storage/a.png?token=secret",
        "https://www.qvapay.com/p2p/a.png",
        "/storage/a.png",
        "https://www.qvapay.com/storage/%2e%2e/private.png",
      ]) {
        const outcome = await ctx.observe("chatImageUrl", Promise.resolve().then(() => chatImageUrl(url)));
        assert.equal(outcome.ok, false);
      }

      let calls = 0;
      const client = new QvaPayClient(() => "secret", {
        fetch: async (_url, init) => {
          calls += 1;
          assert.equal(new Headers(init?.headers).has("authorization"), false);
          assert.equal(init?.redirect, "error");
          return new Response(png, { headers: { "content-type": "image/png" } });
        },
      });
      const rejected = await ctx.observe(
        "download-private",
        client.downloadChatImage("https://127.0.0.1/storage/a.png"),
      );
      assert.equal(rejected.ok, false);
      assert.equal(calls, 0);
      const downloaded = await ctx.observe(
        "download-public",
        client.downloadChatImage("https://www.qvapay.com/storage/a.png"),
      );
      assert.equal(downloaded.ok, true);
      if (downloaded.ok) {
        assert.deepEqual(Buffer.from((downloaded.value as { bytes: Uint8Array }).bytes), png);
      }
      ctx.value("calls", calls);
    },
  },
  {
    id: "chat-images/05-remote-body-limits",
    file: "test/chat-images.test.ts",
    source: "test/chat-images.test.ts:44",
    async run(ctx) {
      const responses = [
        new Response(Buffer.alloc(CHAT_IMAGE_MAX_BYTES + 1), { headers: { "content-type": "image/png" } }),
        new Response(png, { headers: { "content-type": "text/html" } }),
        new Response(null, { status: 302, headers: { location: "http://127.0.0.1" } }),
      ];
      for (const [index, response] of responses.entries()) {
        const client = new QvaPayClient(() => "secret", { fetch: async () => response });
        const outcome = await ctx.observe(
          `download:${index}`,
          client.downloadChatImage("https://www.qvapay.com/storage/a.png"),
        );
        assert.equal(outcome.ok, false);
      }
    },
  },
  {
    id: "chat-images/06-upstream-multipart-send",
    file: "test/chat-images.test.ts",
    source: "test/chat-images.test.ts:51",
    async run(ctx) {
      const client = new QvaPayClient(() => "secret", {
        fetch: async (url, init) => {
          assert.equal(String(url), "https://api.qvapay.com/p2p/offer/chat?order=child");
          assert.equal(new Headers(init?.headers).get("authorization"), "Bearer secret");
          assert.equal(new Headers(init?.headers).has("content-type"), false);
          assert.ok(init?.body instanceof FormData);
          assert.equal(init.body.get("message"), "Recibo");
          assert.equal((init.body.get("file") as File).type, "image/png");
          assert.equal(init?.redirect, "error");
          return new Response(JSON.stringify({ message: "image-id" }));
        },
      });
      const outcome = await ctx.observe(
        "sendChat",
        client.sendChat("offer", "Recibo", "child", { bytes: png, mimeType: "image/png" }),
      );
      assert.equal(outcome.ok, true);
      if (outcome.ok) assert.equal((outcome.value as { id: string }).id, "image-id");
    },
  },
  {
    id: "chat-images/07-list-preserves-images",
    file: "test/chat-images.test.ts",
    source: "test/chat-images.test.ts:62",
    async run(ctx) {
      const client = new QvaPayClient(() => "secret", {
        fetch: async () =>
          new Response(
            JSON.stringify({
              chat: [
                { peer_id: "peer", message: "Recibo", image: "https://www.qvapay.com/storage/a.png" },
                { peer_id: "peer", image: "https://www.qvapay.com/storage/b.png" },
                { peer_id: "peer", image: "https://www.qvapay.com/storage/c.png" },
              ],
            }),
          ),
      });
      const outcome = await ctx.observe("listChat", client.listChat("offer"));
      assert.equal(outcome.ok, true);
      if (outcome.ok) {
        const messages = outcome.value as Array<{ id: string; message: string; image?: string }>;
        assert.equal(messages.length, 3);
        assert.equal(messages[0]?.message, "Recibo");
        assert.equal(messages[0]?.image, "https://www.qvapay.com/storage/a.png");
        assert.equal(messages[1]?.message, "📎 Imagen adjunta");
        assert.notEqual(messages[1]?.id, messages[2]?.id);
        ctx.value(
          "messages",
          messages.map((message) => ({ id: message.id, message: message.message, image: message.image ?? null })),
        );
      }
    },
  },
];

export { scenarios };
