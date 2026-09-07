import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, relative } from "node:path";

const root = process.cwd();
const excluded = new Set([".git", ".pnpm-store", "node_modules", "data", "dist", "public"]);
const extensions = new Set([".ts", ".js", ".jsx", ".json", ".md", ".yaml", ".yml"]);
const patterns = [
  { name: "Telegram bot token", expression: /\b\d{7,12}:[A-Za-z0-9_-]{30,}\b/ },
  { name: "Private key", expression: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
  { name: "Bearer token literal", expression: /authorization\s*[:=]\s*["'`]Bearer\s+[A-Za-z0-9._-]{20,}/i },
];
const findings = [];

for (const file of walk(root)) {
  const relativePath = relative(root, file);
  if (relativePath === "package-lock.json" || relativePath === "pnpm-lock.yaml") continue;
  const content = readFileSync(file, "utf8");
  for (const pattern of patterns)
    if (pattern.expression.test(content)) findings.push(`${relativePath}: ${pattern.name}`);
}

if (findings.length) {
  console.error(`Posibles secretos detectados:\n${findings.join("\n")}`);
  process.exitCode = 1;
} else {
  console.log("Comprobación de secretos: sin credenciales literales detectadas.");
}

function* walk(directory) {
  for (const name of readdirSync(directory)) {
    if (excluded.has(name) || name === ".env") continue;
    const path = join(directory, name);
    const stat = statSync(path);
    if (stat.isDirectory()) yield* walk(path);
    else if (extensions.has(extname(name)) || name === ".env.example") yield path;
  }
}
