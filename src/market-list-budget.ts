import { createHash } from "node:crypto";

type BudgetStore = { get(key: string): string | undefined; set(key: string, value: string): unknown };

const STATE_KEY = "market_list_budget:v1";
const INTERVAL_MS = 2_401;
interface BudgetState { version: 1; universal: number; lastAny: number; owners: Record<string, number> }

/** Coordinates all listing clients in this process through durable per-owner gates. */
export class ListingReadBudget {
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private poisoned = false;

  constructor(private readonly store: BudgetStore, runtime: { now?: () => number; sleep?: (ms: number) => Promise<void> } = {}) {
    this.now = runtime.now ?? Date.now;
    this.sleep = runtime.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  }

  /** Returns the identity used for this reservation so a later 429 uses the same owner. */
  async waitForDispatch(ownerProvider: () => string | undefined): Promise<string | undefined> {
    for (;;) {
      if (this.poisoned) throw new Error("No se pudo guardar el límite de consultas; despachos bloqueados.");
      const owner = normalize(ownerProvider());
      const now = this.now();
      const state = this.read(now);
      const ready = owner
        ? Math.max(state.universal, state.owners[ownerKey(owner)] ?? 0)
        : Math.max(state.universal, state.lastAny);
      if (ready > now) {
        await this.sleep(ready - now);
        continue;
      }
      const next = now + INTERVAL_MS;
      state.lastAny = Math.max(state.lastAny, next);
      if (owner) state.owners[ownerKey(owner)] = next;
      else state.universal = next;
      this.write(state);
      return owner;
    }
  }

  noteRateLimit(owner: string | undefined, retryAfterMs = 60_000): void {
    if (this.poisoned) throw new Error("No se pudo guardar el límite de consultas; despachos bloqueados.");
    const normalized = normalize(owner);
    const delay = Number.isFinite(retryAfterMs) && retryAfterMs >= 0 ? retryAfterMs : 60_000;
    const now = this.now();
    try {
      const state = this.read(now);
      const ready = now + delay;
      state.lastAny = Math.max(state.lastAny, ready);
      if (normalized) {
        const key = ownerKey(normalized);
        state.owners[key] = Math.max(state.owners[key] ?? 0, ready);
      } else state.universal = Math.max(state.universal, ready);
      this.write(state);
    } catch (error) {
      this.poisoned = true;
      throw error;
    }
  }

  private read(now: number): BudgetState {
    const raw = this.store.get(STATE_KEY);
    if (raw === undefined) return { version: 1, universal: 0, lastAny: 0, owners: {} };
    let state: unknown;
    try { state = JSON.parse(raw); } catch { throw new Error("Presupuesto de consultas inválido."); }
    if (!state || typeof state !== "object" || Array.isArray(state)) throw new Error("Presupuesto de consultas inválido.");
    const value = state as Record<string, unknown>;
    const valid = (item: unknown): item is number => typeof item === "number" && Number.isFinite(item) && item >= 0;
    if (value.version !== 1 || !valid(value.universal) || !valid(value.lastAny) || !value.owners || typeof value.owners !== "object" || Array.isArray(value.owners))
      throw new Error("Presupuesto de consultas inválido.");
    const owners: Record<string, number> = {};
    for (const [key, ready] of Object.entries(value.owners)) {
      if (!/^[a-f0-9]{64}$/.test(key) || !valid(ready)) throw new Error("Presupuesto de consultas inválido.");
      if (ready > now) owners[key] = ready;
    }
    return { version: 1, universal: value.universal, lastAny: value.lastAny, owners };
  }

  private write(state: BudgetState): void {
    this.store.set(STATE_KEY, JSON.stringify(state));
  }
}

function normalize(owner: string | undefined): string | undefined {
  return owner?.trim().toLowerCase() || undefined;
}

function ownerKey(owner: string): string {
  return createHash("sha256").update(owner).digest("hex");
}
