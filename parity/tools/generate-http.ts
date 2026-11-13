/**
 * Generador repetible de goldens HTTP — capa L2 (F0).
 *
 * Ejecuta los escenarios de `parity/scenarios/http/*.ts` dos veces y exige que
 * ambas observaciones sean idénticas. Congela petición/respuesta/efectos en
 * `parity/golden/v1/http/<archivo>.json`.
 *
 * Uso:
 *   node --import tsx parity/tools/generate-http.ts          # regenera
 *   node --import tsx parity/tools/generate-http.ts --check  # solo verifica
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalHash } from "../lib/canonical.js";
import { loadHttpScenarios } from "../lib/http/registry.js";
import { runHttpScenario, type HttpScenario, type HttpScenarioObservation } from "../lib/http/scenario.js";

const COMMIT = "02bb5afc04b5eb95f5ac3996ef7634dedf073d02";
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");
const goldenDir = join(repoRoot, "parity", "golden", "v1", "http");

interface HttpCase {
  caseId: string;
  kind: "pure";
  op: "http.run";
  source: string;
  input: { scenario: string };
  expect: HttpScenarioObservation;
}

interface HttpFile {
  schema: "qvaapply.parity/v1";
  suite: "http";
  targetService: string;
  sourceTests: string[];
  generatedFrom: { impl: "typescript"; commit: string; approvedBy: string };
  notes: string;
  cases: HttpCase[];
}

function fileSlug(file: string): string {
  return basename(file).replace(/\.test\.ts$/, "");
}

function targetService(file: string): string {
  if (file.includes("http-dashboard")) return "gateway";
  if (file.includes("mobile")) return "gateway";
  if (file.includes("operation-chat")) return "gateway";
  if (file.includes("recovery")) return "gateway";
  if (file.includes("static-assets")) return "gateway";
  if (file.includes("trading-analytics")) return "gateway";
  if (file.includes("bulk-dismiss")) return "gateway";
  if (file.includes("cooperative")) return "gateway";
  return "gateway";
}

async function observe(scenario: HttpScenario): Promise<HttpScenarioObservation> {
  const first = await runHttpScenario(scenario);
  const second = await runHttpScenario(scenario);
  const firstHash = canonicalHash(first);
  const secondHash = canonicalHash(second);
  if (firstHash !== secondHash) {
    throw new Error(`${scenario.id}: observación no determinista (${firstHash} != ${secondHash}).`);
  }
  return first;
}

async function buildFiles(): Promise<Map<string, HttpFile>> {
  const registry = await loadHttpScenarios();
  const scenarios = [...registry.values()].sort((left, right) =>
    `${left.file}:${left.source}`.localeCompare(`${right.file}:${right.source}`),
  );
  const grouped = new Map<string, HttpScenario[]>();
  for (const scenario of scenarios) {
    const list = grouped.get(scenario.file) ?? [];
    list.push(scenario);
    grouped.set(scenario.file, list);
  }

  const files = new Map<string, HttpFile>();
  for (const [file, list] of [...grouped.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    const cases: HttpCase[] = [];
    for (const scenario of list) {
      cases.push({
        caseId: `http/${scenario.id}`,
        kind: "pure",
        op: "http.run",
        source: scenario.source,
        input: { scenario: scenario.id },
        expect: await observe(scenario),
      });
    }
    const hash = canonicalHash(cases);
    files.set(`${fileSlug(file)}.json`, {
      schema: "qvaapply.parity/v1",
      suite: "http",
      targetService: targetService(file),
      sourceTests: [file],
      generatedFrom: { impl: "typescript", commit: COMMIT, approvedBy: "f0-bootstrap" },
      notes: `Superficie HTTP congelada con \`buildDashboard\` in-process (${list.length} escenarios). Cookies, CSRF, Bearer, ETag y Last-Modified se normalizan; el body y los efectos sobre el modelo son canónicos. · goldenHash=${hash}`,
      cases,
    });
  }
  return files;
}

async function main(): Promise<void> {
  const check = process.argv.includes("--check");
  const files = await buildFiles();
  let stale = false;
  let total = 0;

  if (!check && !existsSync(goldenDir)) mkdirSync(goldenDir, { recursive: true });

  for (const [name, content] of [...files.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    total += content.cases.length;
    const path = join(goldenDir, name);
    const serialized = `${JSON.stringify(content, null, 2)}\n`;
    if (check) {
      if (!existsSync(path)) {
        console.error(`✗ falta ${path}`);
        stale = true;
        continue;
      }
      if (readFileSync(path, "utf8") !== serialized) {
        console.error(`✗ ${path} no coincide con el generador`);
        stale = true;
        continue;
      }
      console.log(`✓ golden/v1/http/${name}`);
    } else {
      writeFileSync(path, serialized, "utf8");
      console.log(`→ golden/v1/http/${name}`);
    }
  }

  if (check && stale) {
    console.error("generate-http: ejecuta `node --import tsx parity/tools/generate-http.ts` y revisa el diff.");
    process.exit(1);
  }
  console.log(`\n${files.size} archivos, ${total} casos HTTP ${check ? "verificados" : "generados"}.`);
}

main().catch((error) => {
  console.error(`generate-http: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
