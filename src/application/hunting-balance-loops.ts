import type { Scheduler } from "../scheduler.js";
import type { TradingEngine } from "../trading.js";

/** Track full jobs, including post-read guards and liquidity preparation, before closing SQLite. */
export function registerHuntingBalanceLoops(
  scheduler: Pick<Scheduler, "register">,
  trading: Pick<TradingEngine, "refreshHuntingQusdBalance" | "prepareHuntingLiquidity" | "stopHuntingBalanceReads">,
): { stop(): Promise<void> } {
  let stopped = false;
  const active = new Set<Promise<void>>();
  const run = (job: () => Promise<void>): Promise<void> => {
    if (stopped) return Promise.resolve();
    const work = job();
    active.add(work);
    void work.then(() => active.delete(work), () => active.delete(work));
    return work;
  };
  scheduler.register("hunting_balance", 5_000, () => run(() => trading.refreshHuntingQusdBalance()));
  scheduler.register("hunting_liquidity", 10_000, () => run(() => trading.prepareHuntingLiquidity()));
  return { async stop() {
    stopped = true;
    while (active.size) await Promise.allSettled([...active]);
    await trading.stopHuntingBalanceReads();
  } };
}
