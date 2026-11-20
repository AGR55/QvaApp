/**
 * Ejecuta uno o varios escenarios L2 sin generar goldens. Útil para depurar.
 *
 *   node --import tsx parity/tools/run-scenario.ts --suite http --filter dashboard
 *   node --import tsx parity/tools/run-scenario.ts --suite contract --id web-push/02-subscribe-notify-once
 */
import { canonicalHash } from "../lib/canonical.js";
import { loadHttpScenarios } from "../lib/http/registry.js";
import { runHttpScenario } from "../lib/http/scenario.js";
import { loadContractScenarios } from "../lib/contract/registry.js";
import { runContractScenario } from "../lib/contract/scenario.js";

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main(): Promise<void> {
  const suite = arg("--suite") ?? "http";
  const filter = arg("--filter");
  const id = arg("--id");

  if (suite === "http") {
    const registry = await loadHttpScenarios();
    const selected = [...registry.values()].filter((scenario) =>
      id ? scenario.id === id : filter ? scenario.id.includes(filter) : true,
    );
    if (!selected.length) throw new Error("No hay escenarios HTTP que coincidan.");
    for (const scenario of selected) {
      const observation = await runHttpScenario(scenario);
      console.log(`✓ ${scenario.id} · ${observation.steps.length} pasos · ${canonicalHash(observation).slice(0, 12)}`);
    }
    return;
  }

  if (suite === "contract") {
    const registry = await loadContractScenarios();
    const selected = [...registry.values()].filter((scenario) =>
      id ? scenario.id === id : filter ? scenario.id.includes(filter) : true,
    );
    if (!selected.length) throw new Error("No hay escenarios de contrato que coincidan.");
    for (const scenario of selected) {
      const observation = await runContractScenario(scenario);
      console.log(
        `✓ ${scenario.id} · ${observation.observations.length} observaciones · ${canonicalHash(observation).slice(0, 12)}`,
      );
    }
    return;
  }

  throw new Error(`Suite desconocida: ${suite}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
