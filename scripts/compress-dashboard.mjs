import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { brotliCompress, constants, gzip } from "node:zlib";

const brotli = promisify(brotliCompress);
const gzipAsync = promisify(gzip);
const directory = "public/dashboard";
let count = 0;
// Sequential files keep build memory bounded. Compression never runs on the VPS request path.
for (const name of await readdir(directory)) {
  if (!/\.(?:js|css)$/.test(name)) continue;
  const path = join(directory, name);
  const content = await readFile(path);
  if (content.length < 512) continue;
  const br = await brotli(content, { params: { [constants.BROTLI_PARAM_QUALITY]: 5, [constants.BROTLI_PARAM_MODE]: constants.BROTLI_MODE_TEXT } });
  const gz = await gzipAsync(content, { level: 9 });
  await writeFile(`${path}.br`, br);
  await writeFile(`${path}.gz`, gz);
  count++;
}
console.log(`Panel: ${count} recursos preparados con Brotli y gzip.`);
