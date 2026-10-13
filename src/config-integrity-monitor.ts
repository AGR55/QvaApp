import { Worker } from "node:worker_threads";
import type { RevisionCheck } from "./config-integrity.js";

export interface ConfigIntegrityState {
  valid: boolean | null;
  checkedAt: number | null;
  checking: boolean;
  verifiedRows: number;
  error?: string;
}

/** One worker and one request at a time; the cached result is small and bounded. */
export class ConfigIntegrityMonitor {
  private worker: Worker | undefined;
  private pending: Promise<ConfigIntegrityState> | undefined;
  private settle: ((state: ConfigIntegrityState) => void) | undefined;
  private closed = false;
  private value: ConfigIntegrityState = { valid: null, checkedAt: null, checking: false, verifiedRows: 0 };

  constructor(private readonly path: string) {}

  state(): ConfigIntegrityState {
    if (!this.closed && (!this.value.checkedAt || Date.now() - this.value.checkedAt >= 30_000)) void this.refresh();
    return { ...this.value };
  }

  refresh(): Promise<ConfigIntegrityState> {
    if (this.pending) return this.pending;
    if (this.closed) return Promise.resolve({ ...this.value });
    this.value = { ...this.value, checking: true };
    this.pending = new Promise(resolve => { this.settle = resolve; });
    try {
      if (!this.worker) {
        const url = new URL("./config-integrity.js", import.meta.url);
        if (import.meta.url.endsWith(".ts")) url.pathname = url.pathname.replace(/\.js$/, ".ts");
        const worker = this.worker = new Worker(url, { workerData: { path: this.path } });
        worker.on("message", (message: { result?: RevisionCheck; error?: string }) => {
          if (this.worker !== worker) return;
          this.finish(message.result ? { valid: message.result.valid, verifiedRows: message.result.verifiedRows,
            checking: false, checkedAt: Date.now() } : { valid: null, verifiedRows: 0, checking: false,
            checkedAt: Date.now(), error: message.error ?? "No se pudo comprobar la integridad." });
        });
        worker.on("error", () => {
          if (this.worker !== worker) return;
          this.worker = undefined;
          this.finish({ valid: null, checkedAt: Date.now(), checking: false, verifiedRows: 0, error: "No se pudo comprobar la integridad." });
        });
        worker.on("exit", () => {
          if (this.worker !== worker) return;
          this.worker = undefined;
          if (this.pending) this.finish({ valid: null, checkedAt: Date.now(), checking: false, verifiedRows: 0, error: "Comprobación interrumpida." });
        });
      }
      this.worker.ref();
      this.worker.postMessage("check");
    } catch {
      this.finish({ valid: null, checkedAt: Date.now(), checking: false, verifiedRows: 0, error: "No se pudo iniciar la comprobación." });
    }
    return this.pending ?? Promise.resolve({ ...this.value });
  }

  private finish(state: ConfigIntegrityState): void {
    this.value = state;
    this.settle?.({ ...state });
    this.settle = undefined;
    this.pending = undefined;
    this.worker?.unref();
  }

  close(): void {
    this.closed = true;
    this.finish({ ...this.value, checking: false });
    const worker = this.worker;
    this.worker = undefined;
    void worker?.terminate();
  }
}
