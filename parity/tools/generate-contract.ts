/**
 * Generador repetible de goldens de contrato — capa L2 (F0).
 *
 * Ejecuta dos veces cada escenario de `parity/scenarios/contract/*.ts` y exige
 * observaciones idénticas. Congela resultados/errores normalizados y efectos
 * en `parity/golden/v1/contract/<archivo>.json`.
 *
 * Uso:
 *   node --import tsx parity/tools/generate-contract.ts          # regenera
 *   node --import tsx parity/tools/generate-contract.ts --check  # solo verifica
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalHash } from "../lib/canonical.js";
import { loadContractScenarios } from "../lib/contract/registry.js";
import {
  runContractScenario,
  type ContractScenario,
  type ContractScenarioObservation,
} from "../lib/contract/scenario.js";

const COMMIT = "02bb5afc04b5eb95f5ac3996ef7634dedf073d02";
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");
const goldenDir = join(repoRoot, "parity", "golden", "v1", "contract");

interface ContractCase {
  caseId: string;
  kind: "pure";
  op: "contract.run";
  source: string;
  input: { scenario: string };
  expect: ContractScenarioObservation;
}

interface ContractFile {
  schema: "qvaapply.parity/v1";
  suite: "contract";
  targetService: string;
  sourceTests: string[];
  generatedFrom: { impl: "typescript"; commit: string; approvedBy: string };
  notes: string;
  cases: ContractCase[];
}

function fileSlug(file: string): string {
  return basename(file).replace(/\.test\.ts$/, "");
}

function targetService(file: string): string {
  if (file.includes("telegram") || file.includes("web-push")) return "notifier";
  if (file.includes("chat-images")) return "chat";
  return "qvapay-adapter";
}

async function observe(scenario: ContractScenario): Promise<ContractScenarioObservation> {
  const first = await runContractScenario(scenario);
  const second = await runContractScenario(scenario);
  const firstHash = canonicalHash(first);
  const secondHash = canonicalHash(second);
  if (firstHash !== secondHash) {
    throw new Error(`${scenario.id}: observación no determinista (${firstHash} != ${secondHash}).`);
  }
  return first;
}

async function buildFiles(): Promise<Map<string, ContractFile>> {
  const registry = await loadContractScenarios();
  const scenarios = [...registry.values()].sort((left, right) =>
    `${left.file}:${left.source}`.localeCompare(`${right.file}:${right.source}`),
  );
  const grouped = new Map<string, ContractScenario[]>();
  for (const scenario of scenarios) {
    const list = grouped.get(scenario.file) ?? [];
    list.push(scenario);
    grouped.set(scenario.file, list);
  }

  const files = new Map<string, ContractFile>();
  for (const [file, list] of [...grouped.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    const cases: ContractCase[] = [];
    for (const scenario of list) {
      cases.push({
        caseId: `contract/${scenario.id}`,
        kind: "pure",
        op: "contract.run",
        source: scenario.source,
        input: { scenario: scenario.id },
        expect: await observe(scenario),
      });
    }
    const hash = canonicalHash(cases);
    files.set(`${fileSlug(file)}.json`, {
      schema: "qvaapply.parity/v1",
      suite: "contract",
      targetService: targetService(file),
      sourceTests: [file],
      generatedFrom: { impl: "typescript", commit: COMMIT, approvedBy: "f0-bootstrap" },
      notes: `Contrato de adaptador congelado con runtime inyectado (${list.length} escenarios). Resultados, errores, timings y llamadas upstream son canónicos; nunca hay red externa ni reloj real. · goldenHash=${hash}`,
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
      console.log(`✓ golden/v1/contract/${name}`);
    } else {
      writeFileSync(path, serialized, "utf8");
      console.log(`→ golden/v1/contract/${name}`);
    }
  }

  if (check && stale) {
    console.error("generate-contract: ejecuta el generador sin --check y revisa el diff.");
    process.exit(1);
  }
  console.log(`\n${files.size} archivos, ${total} casos de contrato ${check ? "verificados" : "generados"}.`);
}

main().catch((error) => {
  console.error(`generate-contract: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
