/**
 * Driver de escenarios de contrato L2 (`--suite contract`).
 *
 * Cada escenario reproduce un `test()` de la suite TypeScript usando los
 * módulos reales con `fetch`/runtime inyectado. No hay red externa, reloj real
 * ni sleeps: el escenario controla el reloj y las respuestas.
 *
 * La observación congelada incluye el resultado o error normalizado de cada
 * paso y los efectos deterministas (llamadas upstream, timings, callbacks).
 */
import { normalizeValue, settle, type Settled } from "../scenario/normalize.js";

export interface ContractObservation {
  label: string;
  outcome: Settled<unknown>;
}

export interface ContractScenario {
  /** Identificador estable, p. ej. `qvapay-gateway/03-peer-null`. */
  id: string;
  /** Archivo de origen. */
  file: string;
  /** Línea/origen del test que congela el escenario. */
  source: string;
  run(ctx: ContractScenarioContext): Promise<void> | void;
}

export class ContractScenarioContext {
  readonly observations: ContractObservation[] = [];
  readonly effects: Array<{ effect: string; value: unknown }> = [];

  /**
   * Ejecuta un paso (promesa o valor) y registra el resultado/error canónico.
   * Devuelve el `Settled` para que el escenario pueda seguir aseverando sobre
   * el valor real sin duplicar la llamada.
   */
  async observe<T>(label: string, value: Promise<T> | T): Promise<Settled<T>> {
    const outcome = await settle(value);
    this.observations.push({
      label,
      outcome: normalizeValue(outcome) as Settled<unknown>,
    });
    return outcome;
  }

  /** Registra un valor ya calculado sin ejecutar nada. */
  value(label: string, value: unknown): void {
    this.observations.push({
      label,
      outcome: { ok: true, value: normalizeValue(value) },
    });
  }

  /** Registra un efecto determinista (log de fetch, timings, llamadas). */
  effect(name: string, value: unknown): void {
    this.effects.push({ effect: name, value: normalizeValue(value) });
  }
}

export interface ContractScenarioObservation {
  observations: ContractObservation[];
  effects: Array<{ effect: string; value: unknown }>;
}

export async function runContractScenario(scenario: ContractScenario): Promise<ContractScenarioObservation> {
  const ctx = new ContractScenarioContext();
  await scenario.run(ctx);
  return { observations: ctx.observations, effects: ctx.effects };
}
