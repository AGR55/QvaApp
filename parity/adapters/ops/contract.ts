/**
 * Suite de contrato (capa L2): ejecuta escenarios con fetch/runtime inyectado
 * y devuelve la observación canónica congelada en `golden/v1/contract/**`.
 */
export const ops = {
  "contract.run": async (input: Record<string, unknown>): Promise<unknown> => {
    const id = typeof input.scenario === "string" ? input.scenario : "";
    if (!id) throw new Error("contract.run requiere `scenario`.");
    const { loadContractScenarios } = await import("../../lib/contract/registry.js");
    const { runContractScenario } = await import("../../lib/contract/scenario.js");
    const scenario = (await loadContractScenarios()).get(id);
    if (!scenario) throw new Error(`Escenario de contrato desconocido: ${id}`);
    return runContractScenario(scenario);
  },
};
