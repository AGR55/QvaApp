export interface ReconciliationRetryState {
  get(key: string): string | undefined;
  set(key: string, value: string): void;
}

interface RetryRecord {
  attempts: number;
  nextAttemptAt: number;
}

const INITIAL_DELAY_MS = 60_000;
const MAX_DELAY_MS = 15 * 60_000;
const KEY_PREFIX = "reconciliation_retry:";

/** Persisted per-intent backoff. It schedules checks; it never resolves an intent. */
export class ReconciliationScheduler {
  constructor(private readonly state: ReconciliationRetryState) {}

  canAttempt(intentId: string, now: number): boolean {
    validateIntentId(intentId);
    validateTime(now);
    const record = this.read(intentId);
    return !record || record.nextAttemptAt <= now;
  }

  recordFailure(intentId: string, now: number): RetryRecord {
    validateIntentId(intentId);
    validateTime(now);
    const previous = this.read(intentId);
    const attempts = (previous?.attempts ?? 0) + 1;
    const delay = Math.min(
      MAX_DELAY_MS,
      INITIAL_DELAY_MS * 2 ** Math.min(attempts - 1, 30),
    );
    const record = { attempts, nextAttemptAt: now + delay };
    this.state.set(this.key(intentId), JSON.stringify(record));
    return record;
  }

  clear(intentId: string): void {
    validateIntentId(intentId);
    // Settings has no delete operation; an empty value is the cleared sentinel.
    this.state.set(this.key(intentId), "");
  }

  private read(intentId: string): RetryRecord | undefined {
    const raw = this.state.get(this.key(intentId));
    if (!raw) return undefined;
    try {
      const value = JSON.parse(raw) as Partial<RetryRecord>;
      if (
        Number.isSafeInteger(value.attempts) && value.attempts! > 0 &&
        Number.isSafeInteger(value.nextAttemptAt) && value.nextAttemptAt! >= 0
      ) return { attempts: value.attempts!, nextAttemptAt: value.nextAttemptAt! };
    } catch {
      // A corrupt retry marker must not become a permanent reconciliation lock.
    }
    return undefined;
  }

  private key(intentId: string): string {
    return `${KEY_PREFIX}${intentId}`;
  }
}

function validateIntentId(intentId: string): void {
  if (!intentId.trim() || intentId.length > 200)
    throw new Error("El identificador de intención no es válido.");
}

function validateTime(now: number): void {
  if (!Number.isSafeInteger(now) || now < 0)
    throw new Error("La hora de conciliación no es válida.");
}
