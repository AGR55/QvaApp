/**
 * Suite HTTP (capa L2): ejecuta escenarios in-process contra `buildDashboard`
 * y devuelve la observación canónica congelada en `golden/v1/http/**`.
 *
 * El escenario se identifica por nombre; la implementación del oráculo vive en
 * `parity/scenarios/http/*.ts`. Un SUT nuevo implementa `http.run` con sus
 * propias rutas y datos sembrados, y debe reproducir la misma observación.
 */
export const ops = {
  "http.run": async (input: Record<string, unknown>): Promise<unknown> => {
    const id = typeof input.scenario === "string" ? input.scenario : "";
    if (!id) throw new Error("http.run requiere `scenario`.");
    const { loadHttpScenarios } = await import("../../lib/http/registry.js");
    const { runHttpScenario } = await import("../../lib/http/scenario.js");
    const scenario = (await loadHttpScenarios()).get(id);
    if (!scenario) throw new Error(`Escenario HTTP desconocido: ${id}`);
    return runHttpScenario(scenario);
  },
};
