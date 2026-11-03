import type { MarketSourceCoordinator } from "../market-feed.js";
import type { Scheduler } from "../scheduler.js";
import type { TradingEngine } from "../trading.js";
import type { MarketPageUpdate } from "../market-source.js";

const MAX_PENDING_PAGES = 64;

export interface MarketEvaluationTiming {
  coin: MarketPageUpdate["coin"];
  side: MarketPageUpdate["side"];
  scannedAt: number;
  queueMs: number;
  evaluationMs: number;
  outcome: "success" | "failed" | "discarded";
  reason?: "superseded" | "capacity" | "control" | "shutdown";
}

/** Separate scheduler registrations: a slow request in either source never owns the other's timer. */
export function registerMarketHuntingLoops(
  scheduler: Pick<Scheduler, "register">,
  source: Pick<MarketSourceCoordinator, "mode" | "processNext" | "pollNext">,
  trading: Pick<TradingEngine, "isPaused" | "ingestMarketUpdate">,
  options: { onError?: (error: unknown) => void; generation?: () => string;
    monotonicNow?: () => number; onEvaluationTiming?: (timing: MarketEvaluationTiming) => void } = {},
): { stop(): Promise<void> } {
  const pending = new Map<string, { update: MarketPageUpdate; realtimeRecovery: boolean; generation: string; mode: ReturnType<typeof source.mode>; enqueuedAt: number }>();
  let consuming = false;
  let stopped = false;
  let pollsInFlight = 0;
  const active = new Set<Promise<unknown>>();
  const generation = () => options.generation?.() ?? `${trading.isPaused()}:${source.mode()}`;
  const now = options.monotonicNow ?? (() => performance.now());
  const timing = (item: { update: MarketPageUpdate; enqueuedAt: number }, startedAt: number, outcome: MarketEvaluationTiming["outcome"], reason?: MarketEvaluationTiming["reason"]) => {
    try { options.onEvaluationTiming?.({ coin: item.update.coin, side: item.update.side, scannedAt: item.update.scannedAt,
      queueMs: Math.max(0, startedAt - item.enqueuedAt), evaluationMs: Math.max(0, now() - startedAt), outcome, ...(reason ? { reason } : {}) }); }
    catch { /* Telemetry cannot affect hunting. */ }
  };
  const discardPending = (reason: "control" | "shutdown") => {
    for (const item of pending.values()) timing(item, now(), "discarded", reason);
    pending.clear();
  };
  const track = <T>(work: Promise<T>): Promise<T> => {
    active.add(work);
    void work.then(() => active.delete(work), () => active.delete(work));
    return work;
  };
  const report = (error: unknown) => {
    try { if (options.onError) options.onError(error); else console.error("Error al evaluar una página del mercado."); }
    catch { console.error("Error al registrar un fallo de evaluación del mercado."); }
  };
  const consume = async () => {
    if (consuming || stopped) return;
    consuming = true;
    try {
      while (!stopped && !trading.isPaused() && pending.size) {
        const [key, item] = pending.entries().next().value!;
        pending.delete(key);
        const startedAt = now();
        let rejectedByGuard = false;
        const isCurrent = () => {
          const current = !stopped && !trading.isPaused() && item.generation === generation() && item.mode === source.mode();
          if (!current) rejectedByGuard = true;
          return current;
        };
        if (!isCurrent()) { timing(item, startedAt, "discarded", stopped ? "shutdown" : "control"); continue; }
        try {
          await trading.ingestMarketUpdate(item.update, { realtimeRecovery: item.realtimeRecovery, isCurrent });
          timing(item, startedAt, rejectedByGuard ? "discarded" : "success", rejectedByGuard ? (stopped ? "shutdown" : "control") : undefined);
        } catch (error) { timing(item, startedAt, "failed"); report(error); }
      }
      if (stopped || trading.isPaused()) discardPending(stopped ? "shutdown" : "control");
    } finally { consuming = false; }
  };
  const enqueue = (update: MarketPageUpdate, mode: ReturnType<typeof source.mode>, currentGeneration: string) => {
    const key = `${update.coin}:${update.side}`;
    const previous = pending.get(key);
    const isOlder = previous && (previous.update.dispatchSequence !== undefined && update.dispatchSequence !== undefined
      ? previous.update.dispatchSequence >= update.dispatchSequence
      : previous.update.scannedAt >= update.scannedAt);
    if (previous && previous.generation === currentGeneration && previous.mode === mode && isOlder) {
      timing({ update, enqueuedAt: now() }, now(), "discarded", "superseded");
      return;
    }
    if (previous) timing(previous, now(), "discarded", "superseded");
    if (!previous && pending.size >= MAX_PENDING_PAGES) {
      const oldest = pending.keys().next().value!;
      timing(pending.get(oldest)!, now(), "discarded", "capacity");
      pending.delete(oldest);
    }
    pending.set(key, { update, realtimeRecovery: mode === "hybrid", mode, generation: currentGeneration, enqueuedAt: now() });
    void track(consume()).catch(report);
  };
  scheduler.register("market_feed", 250, () => track((async () => {
    if (!stopped && !trading.isPaused() && source.mode() === "hybrid") await source.processNext();
  })()));
  scheduler.register("scan", 250, async () => {
    if (stopped || trading.isPaused()) { discardPending(stopped ? "shutdown" : "control"); return; }
    if (pollsInFlight >= 4) return;
    const mode = source.mode();
    const currentGeneration = generation();
    pollsInFlight++;
    const work = (async () => {
      try {
        const update = await source.pollNext();
        if (update && !stopped && !trading.isPaused() && mode === source.mode() && currentGeneration === generation())
          enqueue(update, mode, currentGeneration);
      } catch (error) { report(error); }
      finally { pollsInFlight--; }
    })();
    void track(work);
  });
  return { async stop() {
    stopped = true;
    discardPending("shutdown");
    while (active.size) await Promise.allSettled([...active]);
  } };
}
