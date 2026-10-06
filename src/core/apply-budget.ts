export interface ApplyBudgetState {
  get(key: string): string | undefined;
}

export const APPLY_WINDOW_KEY = "qva_throttle:apply_window";
export const APPLY_WINDOW_MS = 60_001;

export function applyAttempts(state: ApplyBudgetState): number[] {
  const raw = state.get(APPLY_WINDOW_KEY);
  if (raw !== undefined) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length <= 2 &&
        parsed.every((value) => Number.isSafeInteger(value) && value > 0))
        return (parsed as number[]).sort((a, b) => a - b);
    } catch { /* Retain the legacy throttle if the window is damaged. */ }
  }
  const last = Number(state.get("qva_throttle:apply") ?? 0);
  // The previous version spaced attempts by 30 seconds. On migration retain
  // both possible attempts, rather than granting extra quota after a restart.
  return Number.isFinite(last) && last > 0
    ? [Math.max(1, last - 30_001), last] : [];
}

export function applyReadyAt(state: ApplyBudgetState, now: number): number {
  const attempts = applyAttempts(state).filter((at) => at + APPLY_WINDOW_MS > now);
  const cooldown = Number(state.get("qva_throttle:apply_retry_at") ?? 0);
  return Math.max(now, attempts.length >= 2 ? attempts[0]! + APPLY_WINDOW_MS : now,
    Number.isFinite(cooldown) ? cooldown : 0);
}
