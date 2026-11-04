const terminal = (state: string) => ["completed", "cancelled", "canceled"].includes(state);

/** Read-only projection. Never advances the trading ledger or authorizes a mutation. */
export function operationDisplayState(local: string, remote?: string): string {
  if (terminal(local)) return local;
  if (!remote) return local;
  if (terminal(remote) || remote === "paid" || remote === "revision") return remote;
  // Processing is also the provider state before acknowledgement and after a
  // local payment. Preserve those more precise local states until reconciled.
  return local;
}
