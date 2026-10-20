# Medians and flexible order accounting

## Confirmed production evidence

`market-side:*` for BANK_CUP, CLASICA and ETECSA had timestamps around 1792164910000, approximately 101 hours old, while `market:*`, `averages` and fiat polling were current. Hybrid recovery refreshed market caches but did not renew the per-side observations read by Telegram and the web.

Authenticated offer listings omit `Orders`. For example, an owned flexible CLASICA sell parent was open while its detail contained four completed orders. Children expose `paid_at` and `released_at`, not `updated_at`; the parent timestamp can change independently through edits.

## Correction

- An independent scheduled observation reads one active market/side every 15 seconds, rotates fairly and skips samples younger than 60 seconds. Both display caches update. Only a validated side reference renews its safety observation.
- Fiat reconciliation hydrates at most three flexible details per existing background cycle, with persistent fair rotation, a 60-second detail cache and isolated error handling. The time of each child payment/release governs the ledger and its relation to a later manual balance declaration.
- Ledger identities use the child UUID, with compatibility for an earlier bot operation recorded under its parent UUID. Cancelled or unconfirmed children never create credits.
- History and analytics use completed children and their actual amounts, including children whose parent remains open. Parent transactions and legacy parent aggregates are excluded when child records are available. The changed history query has a versioned pagination checkpoint and reuses accounting details without extra HTTP reads.

No HTTP reads or decision queue changes were added to offer ingestion/application. A controlled 50-offer local test with a blocked background read reported baseline p50/p95 3.19/6.17 ms and patched 2.65/6.59 ms. These are local measurements without network or quota waiting, not production latency guarantees.

## Verification

Regression tests cover stale display caches, independent refresh, sparse samples, owned/third-party child identity, payment/release timestamps, manual balance baselines, legacy deduplication, detail read bounds/fairness, unchanged parent timestamps and completed child statistics. Full `pnpm check` passes.

Production checks should confirm current per-side timestamps for active markets, child ledger entries, completed child analytics, healthy release, and unchanged user pause preferences. External manual orders can only be discovered if QvaPay exposes their parent in the authenticated listings or the bot already tracks the order; the confirmed owned-offer path uses the authenticated own listing.
