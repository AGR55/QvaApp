/**
 * Operaciones de conformidad para los controles de `DashboardReadModel`
 * (`src/dashboard.ts`) usados por el panel.
 *
 * - `dashboard.controls.pause`    → reanudar valida QvaPay; pausar es local.
 * - `dashboard.controls.hunting`  → delega la configuración de cacería.
 * - `dashboard.controls.refresh`  → el refresco periódico reutiliza mercados.
 */
import { DashboardReadModel } from "../../../src/dashboard.js";

type Input = Record<string, unknown>;

export const ops = {
  "dashboard.controls.pause": async () => {
    const calls: string[] = [];
    const trading = {
      setPaused: (paused: boolean, source: string) => calls.push(`pause:${paused}:${source}`),
      activate: async () => void calls.push("activate"),
    };
    const dashboard = new DashboardReadModel(
      trading as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    await dashboard.setPaused(true);
    await dashboard.setPaused(false);
    return { calls };
  },

  "dashboard.controls.hunting": (input: Input) => {
    const calls: unknown[] = [];
    const dashboard = new DashboardReadModel(
      { updateHunting: (value: unknown) => calls.push(value) } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    const value = input.value;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("El campo value debe ser un objeto.");
    }
    dashboard.updateHunting(value as never);
    return { calls };
  },

  "dashboard.controls.refresh": async () => {
    const calls: string[] = [];
    const dashboard = new DashboardReadModel(
      { activeMarkets: () => [{ code: "CUP" }, { code: "CLASICA" }] } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    dashboard.refreshBalance = async () => {
      calls.push("balance");
      return undefined as never;
    };
    dashboard.refreshOwnOffers = async () => {
      calls.push("own");
      return undefined as never;
    };
    dashboard.refreshTransactions = async () => {
      calls.push("transactions");
      return undefined as never;
    };
    dashboard.refreshMarket = async (code: string) => {
      calls.push(code);
      return undefined as never;
    };
    await dashboard.refreshCache({ refreshMarkets: false });
    const first = [...calls];
    calls.length = 0;
    await dashboard.refreshCache();
    return { first, second: [...calls] };
  },
};
