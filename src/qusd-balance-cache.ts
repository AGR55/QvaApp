export type QusdBalanceContext = "fast_lane" | "readiness" | "readiness_after_edit" | "manual" | "warmup";
type QusdBalanceOutcome = "hit" | "miss_absent" | "miss_expired" | "miss_epoch" | "read_fresh" | "read_stale" | "read_failed" | "discarded_control";
export interface QusdBalanceSnapshot { value: number; epoch: string; updatedAt: number }
export interface QusdBalanceTiming { context: QusdBalanceContext; outcome: QusdBalanceOutcome; cacheAgeMs?: number; totalMs?: number }

type ReadResult = { kind: "fresh"; value: number; epoch: string; revision: number; sequence: number } | { kind: "stale"; epoch: string; revision: number; sequence: number } | { kind: "stopped" };
type CacheRuntime = {
  read(priority: boolean): Promise<number>;
  epoch(): string;
  now?: () => number;
  monotonicNow?: () => number;
  observe?: (event: QusdBalanceTiming) => void;
};

/** Gross balance only. Callers must subtract current reservations and debt. */
export class QusdBalanceCache {
  private snapshot?: QusdBalanceSnapshot;
  private revision = 0;
  private nextSequence = 0;
  private publishedSequence = 0;
  private remoteSnapshot?: { epoch: string; revision: number; sequence: number };
  private stopped = false;
  private readonly active = new Map<string, Promise<ReadResult>>();
  private readonly now: () => number;
  private readonly monotonicNow: () => number;

  constructor(private readonly runtime: CacheRuntime) {
    this.now = runtime.now ?? Date.now;
    this.monotonicNow = runtime.monotonicNow ?? (() => performance.now());
  }

  peek(): QusdBalanceSnapshot | undefined {
    const item = this.snapshot;
    if (!item || item.epoch !== this.runtime.epoch()) return undefined;
    const age = this.now() - item.updatedAt;
    return age >= 0 && age <= 15_000 ? { ...item } : undefined;
  }

  replace(value: number, epoch = this.runtime.epoch()): void {
    if (!Number.isFinite(value) || value < 0) throw new Error("Saldo QUSD inválido.");
    this.revision++;
    delete this.remoteSnapshot;
    this.snapshot = { value, epoch, updatedAt: this.now() };
  }

  invalidate(): void { this.revision++; delete this.snapshot; delete this.remoteSnapshot; }

  version(): string { return JSON.stringify([this.runtime.epoch(), this.revision, this.publishedSequence]); }

  async get(options: { priority: boolean; force?: boolean; context: QusdBalanceContext; isCurrent?: () => boolean }): Promise<number> {
    const started = this.monotonicNow();
    const emit = (outcome: QusdBalanceOutcome, cacheAgeMs?: number) => {
      try { this.runtime.observe?.({ context: options.context, outcome,
        ...(cacheAgeMs === undefined ? {} : { cacheAgeMs }), totalMs: Math.max(0, this.monotonicNow() - started) }); } catch { /* telemetry is best effort */ }
    };
    const current = () => {
      try { return options.isCurrent?.() !== false; } catch { return false; }
    };
    for (let attempt = 0; attempt < 3; attempt++) {
      if (this.stopped) { emit("discarded_control"); throw new Error("Caché de saldo cerrada."); }
      if (!current()) { emit("discarded_control"); throw new Error("Consulta de saldo detenida."); }
      const item = this.snapshot;
      const age = item ? this.now() - item.updatedAt : undefined;
      const cached = this.peek();
      if (!options.force && cached) { emit("hit", age); return cached.value; }
      if (attempt === 0 && !options.force) emit(!item ? "miss_absent" : item.epoch !== this.runtime.epoch() ? "miss_epoch" : "miss_expired", age);
      const epoch = this.runtime.epoch(), revision = this.revision;
      const key = JSON.stringify([options.priority, epoch, revision]);
      let work = this.active.get(key);
      if (!work) {
        if (this.active.size >= 4) { emit("discarded_control"); throw new Error("Demasiadas consultas de saldo pendientes."); }
        work = this.read(epoch, revision, ++this.nextSequence, options.priority);
        this.active.set(key, work);
        void work.then(() => { if (this.active.get(key) === work) this.active.delete(key); },
          () => { if (this.active.get(key) === work) this.active.delete(key); });
      }
      let result: ReadResult;
      try { result = await work; }
      catch (error) {
        if (this.stopped || !current()) { emit("discarded_control"); throw new Error("Consulta de saldo detenida."); }
        emit("read_failed"); throw error;
      }
      if (result.kind === "stopped" || this.stopped) { emit("discarded_control"); throw new Error("Caché de saldo cerrada."); }
      if (!current()) { emit("discarded_control"); throw new Error("Consulta de saldo detenida."); }
      if (result.kind === "fresh" && result.epoch === this.runtime.epoch() && result.revision === this.revision && result.sequence === this.publishedSequence) {
        emit("read_fresh"); return result.value;
      }
      emit("read_stale");
      const remote = this.remoteSnapshot;
      if (remote && remote.epoch === result.epoch && remote.epoch === this.runtime.epoch() &&
          remote.revision === result.revision && remote.revision === this.revision && remote.sequence > result.sequence) {
        const newer = this.peek();
        if (newer) return newer.value;
      }
    }
    emit("discarded_control");
    throw new Error("El saldo QUSD cambió durante su consulta.");
  }

  async stop(): Promise<void> {
    this.stopped = true;
    while (this.active.size) await Promise.allSettled([...this.active.values()]);
  }

  private async read(epoch: string, revision: number, sequence: number, priority: boolean): Promise<ReadResult> {
    const value = await this.runtime.read(priority);
    if (this.stopped) return { kind: "stopped" };
    if (epoch !== this.runtime.epoch() || revision !== this.revision || sequence < this.publishedSequence) return { kind: "stale", epoch, revision, sequence };
    if (!Number.isFinite(value) || value < 0) throw new Error("Saldo QUSD inválido.");
    this.snapshot = { value, epoch, updatedAt: this.now() };
    this.publishedSequence = sequence;
    this.remoteSnapshot = { epoch, revision, sequence };
    return { kind: "fresh", value, epoch, revision, sequence };
  }
}
