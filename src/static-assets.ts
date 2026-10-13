import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";
import type { FastifyReply, FastifyRequest } from "fastify";

/** Stream with backpressure; even conditional requests never load the full asset. */
export async function sendStaticAsset(request: FastifyRequest, reply: FastifyReply, path: string,
  contentType: string, cacheControl: string, compressed = false) {
  let file = path;
  let info = await fileInfo(path);
  if (!info) return reply.status(404).send("Recurso no encontrado.");
  if (compressed) {
    reply.header("vary", "Accept-Encoding");
    for (const encoding of acceptedEncodings(request.headers["accept-encoding"])) {
      const candidate = `${path}.${encoding === "br" ? "br" : "gz"}`;
      const encodedInfo = await fileInfo(candidate);
      if (!encodedInfo) continue;
      file = candidate;
      info = encodedInfo;
      reply.header("content-encoding", encoding);
      break;
    }
  }
  const etag = `W/"${createHash("sha256").update(`${info.size}:${info.mtimeMs}:${info.ctimeMs}:${file}`).digest("base64url")}"`;
  reply.type(contentType).header("etag", etag).header("cache-control", cacheControl);
  const matches = request.headers["if-none-match"]?.split(",").some(value =>
    value.trim() === "*" || value.trim().replace(/^W\//, "") === etag.replace(/^W\//, ""));
  if (matches) return reply.status(304).send();
  reply.header("content-length", info.size);
  if (request.method === "HEAD") return reply.send(Readable.from([]));
  return reply.send(createReadStream(file));
}

async function fileInfo(path: string) {
  try { const info = await stat(path); return info.isFile() ? info : undefined; }
  catch (error) {
    if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) return;
    throw error;
  }
}

function acceptedEncodings(header?: string): Array<"br" | "gzip"> {
  const qualities = new Map<string, number>();
  for (const entry of (header ?? "").toLowerCase().split(",")) {
    const [encoding, ...parameters] = entry.trim().split(";");
    if (!encoding) continue;
    const quality = parameters.find(value => value.trim().startsWith("q="));
    const q = quality ? Number(quality.trim().slice(2)) : 1;
    qualities.set(encoding, Number.isFinite(q) && q >= 0 && q <= 1 ? q : 0);
  }
  return (["br", "gzip"] as const).map(encoding => ({ encoding, q: qualities.get(encoding) ?? qualities.get("*") ?? 0 }))
    .filter(item => item.q > 0).sort((a, b) => b.q - a.q).map(item => item.encoding);
}
