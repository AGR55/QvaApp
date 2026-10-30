import type { MarketSourceCoordinator } from "../market-feed.js";
import type { Scheduler } from "../scheduler.js";
import type { TradingEngine } from "../trading.js";

/** Separate scheduler registrations: a slow request in either source never owns the other's timer. */
export function registerMarketHuntingLoops(
  scheduler: Pick<Scheduler, "register">,
  source: Pick<MarketSourceCoordinator, "mode" | "processNext" | "pollNext">,
  trading: Pick<TradingEngine, "isPaused" | "ingestMarketUpdate">,
): void {
  scheduler.register("market_feed", 250, async () => {
    if (!trading.isPaused() && source.mode() === "hybrid") await source.processNext();
  });
  scheduler.register("scan", 250, async () => {
    if (trading.isPaused()) return;
    const update = await source.pollNext();
    if (update) await trading.ingestMarketUpdate(update, { realtimeRecovery: source.mode() === "hybrid" });
  });
}
