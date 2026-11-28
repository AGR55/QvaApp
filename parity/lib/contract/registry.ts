/**
 * Registro de escenarios de contrato. Cada archivo de
 * `parity/scenarios/contract/` exporta `scenarios: ContractScenario[]`.
 */
import { readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { ContractScenario } from "./scenario.js";

const here = dirname(fileURLToPath(import.meta.url));
const scenariosDir = resolve(here, "..", "..", "scenarios", "contract");

let cache: Promise<Map<string, ContractScenario>> | null = null;

export function loadContractScenarios(): Promise<Map<string, ContractScenario>> {
  cache ??= load();
  return cache;
}

async function load(): Promise<Map<string, ContractScenario>> {
  const registry = new Map<string, ContractScenario>();
  const files = readdirSync(scenariosDir)
    .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
    .sort();
  for (const file of files) {
    const module = (await import(pathToFileURL(join(scenariosDir, file)).href)) as {
      scenarios?: ContractScenario[];
    };
    if (!Array.isArray(module.scenarios)) {
      throw new Error(`El escenario de contrato ${file} no exporta { scenarios }.`);
    }
    for (const scenario of module.scenarios) {
      if (registry.has(scenario.id)) throw new Error(`Escenario de contrato duplicado: ${scenario.id}`);
      registry.set(scenario.id, scenario);
    }
  }
  return registry;
}
