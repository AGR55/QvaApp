import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brotliCompressSync, brotliDecompressSync, gzipSync, gunzipSync } from "node:zlib";
import test from "node:test";
import Fastify from "fastify";
import { sendStaticAsset } from "../src/static-assets.js";

test("sirve texto comprimido, respeta q=0 y mantiene caché y HEAD sin cuerpo", async () => {
  const directory = mkdtempSync(join(tmpdir(), "qva-static-"));
  const file = join(directory, "app.js");
  const body = "export const fixture = 'panel';\n".repeat(200);
  writeFileSync(file, body);
  writeFileSync(`${file}.br`, brotliCompressSync(body));
  writeFileSync(`${file}.gz`, gzipSync(body));
  const app = Fastify();
  app.get("/asset", (request, reply) => sendStaticAsset(request, reply, file, "text/javascript", "public, no-cache", true));
  try {
    const br = await app.inject({ url: "/asset", headers: { "accept-encoding": "gzip, br" } });
    assert.equal(br.headers["content-encoding"], "br");
    assert.equal(br.headers.vary, "Accept-Encoding");
    assert.equal(brotliDecompressSync(br.rawPayload).toString(), body);
    const gzip = await app.inject({ url: "/asset", headers: { "accept-encoding": "br;q=0, gzip;q=1" } });
    assert.equal(gzip.headers["content-encoding"], "gzip");
    assert.equal(gunzipSync(gzip.rawPayload).toString(), body);
    const identity = await app.inject({ url: "/asset", headers: { "accept-encoding": "br;q=0, gzip;q=0" } });
    assert.equal(identity.headers["content-encoding"], undefined);
    assert.equal(identity.body, body);
    assert.notEqual(identity.headers.etag, br.headers.etag);
    const unchanged = await app.inject({ url: "/asset", headers: { "if-none-match": String(br.headers.etag), "accept-encoding": "br" } });
    assert.equal(unchanged.statusCode, 304);
    assert.equal(unchanged.rawPayload.length, 0);
    const head = await app.inject({ method: "HEAD", url: "/asset", headers: { "accept-encoding": "br" } });
    assert.equal(head.rawPayload.length, 0);
    assert.equal(head.headers["content-length"], br.headers["content-length"]);
    assert.equal(head.headers.etag, br.headers.etag);
    writeFileSync(file, body.replaceAll("panel", "other"));
    utimesSync(file, new Date(), new Date(Date.now() + 2000));
    const changed = await app.inject({ url: "/asset", headers: { "if-none-match": String(identity.headers.etag) } });
    assert.equal(changed.statusCode, 200);
    assert.notEqual(changed.headers.etag, identity.headers.etag);
  } finally { await app.close(); }
});
