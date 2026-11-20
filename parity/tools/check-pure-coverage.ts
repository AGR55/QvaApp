/**
 * Verifica que todos los archivos L1 (puros portables) del manifest tengan
 * cobertura en `parity/golden/v1/pure/**`.
 *
 * La cobertura es por archivo de test: cada fila L1 debe aparecer en el campo
 * `sourceTests` de al menos un golden. El conteo de casos de origen (107) se
 * toma del manifest; los goldens pueden tener más casos porque un mismo test
 * se desdobla en varias observaciones (redondeo, escenarios, etc.).
 *
 * Uso:
 *   node --import tsx parity/tools/check-pure-coverage.ts
 */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

interface ManifestFile {
  file: string;
  category: string;
  cases: number;
  lote: string;
  status: string;
}

interface Manifest {
  files: ManifestFile[];
}

interface Golden {
  sourceTests?: string[];
  cases: { caseId: string; source?: string }[];
}

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");
const manifest = JSON.parse(readFileSync(join(repoRoot, "parity", "manifest.json"), "utf8")) as Manifest;
const goldenDir = join(repoRoot, "parity", "golden", "v1", "pure");

const goldens = new Map<string, Golden>();
for (const file of readdirSync(goldenDir).sort()) {
  if (!file.endsWith(".json")) continue;
  goldens.set(file, JSON.parse(readFileSync(join(goldenDir, file), "utf8")) as Golden);
}

const l1 = manifest.files.filter((entry) => entry.lote === "L1");
const errors: string[] = [];
let coveredCases = 0;
let goldenCases = 0;

for (const entry of l1) {
  const owners = [...goldens.entries()].filter(([, golden]) => golden.sourceTests?.includes(entry.file));
  if (!owners.length) {
    errors.push(`${entry.file}: sin golden que lo declare en sourceTests.`);
    continue;
  }
  coveredCases += entry.cases;
  const cases = owners.reduce(
    (total, [, golden]) => total + golden.cases.filter((item) => item.source?.startsWith(`${entry.file}:`)).length,
    0,
  );
  goldenCases += cases;
  console.log(
    `${entry.file} · ${entry.cases} casos L1 · ${owners.length} golden(s) · ${cases} caso(s) de golden`,
  );
}

console.log(
  `\n${l1.length - errors.length}/${l1.length} archivos L1 cubiertos · ` +
    `${coveredCases}/${l1.reduce((total, entry) => total + entry.cases, 0)} casos de origen · ` +
    `${goldenCases} casos de golden que citan fuentes L1.`,
);

if (errors.length) {
  console.error("\nCobertura incompleta:");
  for (const error of errors) console.error(`✗ ${error}`);
  process.exit(1);
}
