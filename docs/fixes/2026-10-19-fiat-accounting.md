# Fiat accounting recovery

## Verified causes

- Closed flexible parent offers may return `Peer: {}`; the actual counterparty is in the child order. Rejecting the parent prevented completed orders from reaching the fiat ledger.
- Accounting previously required string payment instructions. Unexpected nonfinancial payment detail values could reject an entire reconciliation page.
- Joint hunt participants did not import their own committed share when another account applied. Aggregate market capacity cannot identify a person's spending.
- Joint eligibility and advertised capacity could include funds reserved by a pending personal application.

## Changes

Financial reconciliation uses accounting parsing while retaining validation of amounts and identities. Flexible order state and timestamps are selected by the stored order ID. Historic recovered movements remain in the idempotent ledger without changing a newer manually declared balance.

Sync Core adds an authenticated read-only personal participation endpoint. It excludes owner allocations and other participants' identities. QvaApply imports it at startup and in a background capacity task, at most every 30 seconds, plus before publishing a contribution. Each batch atomically records states, ledger debits and a checkpoint. Completed allocations debit once; reservations earmark capital; release does not credit a payment that never happened. Terminal history is skipped after catchup, while unresolved reservations are revisited.

Only individual pending commitments reduce the local delta advertised to Sync Core: joint allocations already deducted there must not be subtracted twice. Manual publication also respects all locally reserved capital. No HTTP requests were added to individual offer evaluation/application.

## Deployment verification

Deploy Sync Core first, then QvaApply. Check health, authenticated pagination, preserved manual balances, recovered flexible child statuses, and enabled hunting flags. Do not replay real bank payments or apply to live offers as tests.

A periodic cross-service view is not an atomic lock between independent bots. These changes fix the observed missing accounting and duplicate-capacity paths; they do not infer bank transfers performed outside the tracked workflow.
