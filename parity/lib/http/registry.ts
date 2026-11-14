/**
 * Registro de escenarios HTTP. Cada archivo de `parity/scenarios/http/`
 * exporta `scenarios: HttpScenario[]` y se carga bajo demanda para que un error
 * en un escenario no rompa las suites puras.
 */
import { readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { HttpScenario } from "./scenario.js";

const here = dirname(fileURLToPath(import.meta.url));
const scenariosDir = resolve(here, "..", "..", "scenarios", "http");

let cache: Promise<Map<string, HttpScenario>> | null = null;

export function loadHttpScenarios(): Promise<Map<string, HttpScenario>> {
  cache ??= load();
  return cache;
}

async function load(): Promise<Map<string, HttpScenario>> {
  const registry = new Map<string, HttpScenario>();
  const files = readdirSync(scenariosDir)
    .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
    .sort();
  for (const file of files) {
    const module = (await import(pathToFileURL(join(scenariosDir, file)).href)) as {
      scenarios?: HttpScenario[];
    };
    if (!Array.isArray(module.scenarios)) {
      throw new Error(`El escenario HTTP ${file} no exporta { scenarios }.`);
    }
    for (const scenario of module.scenarios) {
      if (registry.has(scenario.id)) throw new Error(`Escenario HTTP duplicado: ${scenario.id}`);
      registry.set(scenario.id, scenario);
    }
  }
  return registry;
}
