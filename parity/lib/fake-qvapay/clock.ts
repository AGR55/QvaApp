/**
 * Reloj virtual inyectable del fake QvaPay.
 *
 * Regla del arnés (docs/migration/verification.md §4): sin reloj real, sin azar
 * y sin `sleep` arbitrarios. La latencia se simula avanzando este reloj; los
 * timeouts de transporte se simulan con abort del socket o cuelgue sin
 * respuesta (ver `AbortMode`), nunca durmiendo el proceso.
 */

/** 2026-01-01T00:00:00.000Z — epoch fijo por defecto. */
export const DEFAULT_CLOCK_MS = Date.UTC(2026, 0, 1, 0, 0, 0);

export class VirtualClock {
  private current: number;

  constructor(epochMs: number = DEFAULT_CLOCK_MS) {
    if (!Number.isFinite(epochMs) || epochMs < 0) {
      throw new Error(`Reloj virtual inválido: ${String(epochMs)}`);
    }
    this.current = Math.trunc(epochMs);
  }

  now(): number {
    return this.current;
  }

  set(epochMs: number): void {
    if (!Number.isFinite(epochMs) || epochMs < 0) {
      throw new Error(`Reloj virtual inválido: ${String(epochMs)}`);
    }
    this.current = Math.trunc(epochMs);
  }

  /** Avanza el reloj. Solo acepta incrementos no negativos. */
  advance(milliseconds: number): number {
    if (!Number.isFinite(milliseconds) || milliseconds < 0) {
      throw new Error(`Avance de reloj inválido: ${String(milliseconds)}`);
    }
    this.current += Math.trunc(milliseconds);
    return this.current;
  }
}
