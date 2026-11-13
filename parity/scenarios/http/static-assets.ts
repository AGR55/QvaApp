/**
 * Escenarios HTTP: `test/static-assets.test.ts`.
 */
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brotliCompressSync, brotliDecompressSync, gzipSync, gunzipSync } from "node:zlib";
import Fastify from "fastify";
import { sendStaticAsset } from "../../../src/static-assets.js";
import type { HttpScenario } from "../../../lib/http/scenario.js";

const FIXED_MS = 1_788_744_000_000;
const BODY = "export const fixture = 'panel';\n".repeat(200);

const scenarios: HttpScenario[] = [
  {
    id: "static-assets/01-compressed-head-etag",
    file: "test/static-assets.test.ts",
    source: "test/static-assets.test.ts:9",
    build() {
      const directory = mkdtempSync(join(tmpdir(), "qva-static-"));
      const file = join(directory, "app.js");
      writeFileSync(file, BODY);
      writeFileSync(`${file}.br`, brotliCompressSync(BODY));
      writeFileSync(`${file}.gz`, gzipSync(BODY));
      utimesSync(file, new Date(FIXED_MS), new Date(FIXED_MS));
      const app = Fastify();
      app.get("/asset", (request, reply) =>
        sendStaticAsset(request, reply, file, "text/javascript", "public, no-cache", true),
      );
      (app as unknown as { __file: string }).__file = file;
      return app;
    },
    async run(app, ctx) {
      const file = (app as unknown as { __file: string }).__file;
      const br = await ctx.call(app, { url: "/asset", headers: { "accept-encoding": "gzip, br" } });
      assert.equal(br.headers["content-encoding"], "br");
      assert.equal(br.headers.vary, "Accept-Encoding");
      assert.equal(brotliDecompressSync(br.rawPayload).toString(), BODY);

      const gzip = await ctx.call(app, { url: "/asset", headers: { "accept-encoding": "br;q=0, gzip;q=1" } });
      assert.equal(gzip.headers["content-encoding"], "gzip");
      assert.equal(gunzipSync(gzip.rawPayload).toString(), BODY);

      const identity = await ctx.call(app, { url: "/asset", headers: { "accept-encoding": "br;q=0, gzip;q=0" } });
      assert.equal(identity.headers["content-encoding"], undefined);
      assert.equal(identity.body, BODY);
      assert.notEqual(identity.headers.etag, br.headers.etag);

      const unchanged = await ctx.call(app, {
        url: "/asset",
        headers: { "if-none-match": String(br.headers.etag), "accept-encoding": "br" },
      });
      assert.equal(unchanged.statusCode, 304);
      assert.equal(unchanged.rawPayload.length, 0);

      const head = await ctx.call(app, { method: "HEAD", url: "/asset", headers: { "accept-encoding": "br" } });
      assert.equal(head.rawPayload.length, 0);
      assert.equal(head.headers["content-length"], br.headers["content-length"]);
      assert.equal(head.headers.etag, br.headers.etag);

      writeFileSync(file, BODY.replaceAll("panel", "other"));
      utimesSync(file, new Date(FIXED_MS + 2_000), new Date(FIXED_MS + 2_000));
      const changed = await ctx.call(app, {
        url: "/asset",
        headers: { "if-none-match": String(identity.headers.etag) },
      });
      assert.equal(changed.statusCode, 200);
      assert.notEqual(changed.headers.etag, identity.headers.etag);

      ctx.effect("static.encodings", ["br", "gzip", "identity"]);
      ctx.effect("static.conditional", {
        unchanged: unchanged.statusCode,
        changed: changed.statusCode,
        headBytes: head.rawPayload.length,
      });
    },
  },
];

export { scenarios };
