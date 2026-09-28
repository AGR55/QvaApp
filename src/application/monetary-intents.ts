import { randomUUID } from "node:crypto";
import { QvaApiError, QvaMutationUncertainError } from "../qvapay.js";
import type { MutationIntent, Store } from "../store.js";

export type MutationIntentRepository = Pick<
  Store,
  "audit" | "createMutationIntent" | "updateMutationIntent"
>;

export interface MonetaryMutation<T> {
  kind: string;
  operationUuid?: string;
  workflowId?: string;
  request: unknown;
  action: () => Promise<T>;
  idempotencyKey?: string;
}

export interface MonetaryIntentsRuntime {
  createId?: () => string;
}

export type MutationFailureOutcome = Extract<
  MutationIntent["state"],
  "rejected" | "uncertain"
>;

/**
 * Owns the durable protocol around one remote monetary mutation. Business
 * transitions remain in the caller; persistence always precedes dispatch.
 */
export class MonetaryIntents {
  private readonly createId: () => string;

  constructor(
    private readonly repository: MutationIntentRepository,
    runtime: MonetaryIntentsRuntime = {},
  ) {
    this.createId = runtime.createId ?? randomUUID;
  }

  async execute<T>(mutation: MonetaryMutation<T>): Promise<T> {
    const intentId = this.createId();
    this.repository.createMutationIntent({
      intentId,
      ...(mutation.operationUuid
        ? { operationUuid: mutation.operationUuid }
        : {}),
      ...(mutation.workflowId ? { workflowId: mutation.workflowId } : {}),
      kind: mutation.kind,
      ...(mutation.idempotencyKey
        ? { idempotencyKey: mutation.idempotencyKey }
        : {}),
      request: mutation.request,
    });

    try {
      const response = await mutation.action();
      this.repository.updateMutationIntent(intentId, "confirmed", response);
      return response;
    } catch (error) {
      const outcome = mutationFailureOutcome(error);
      const detail = errorMessage(error);
      this.repository.updateMutationIntent(
        intentId,
        outcome,
        undefined,
        detail,
      );
      this.repository.audit(
        outcome === "uncertain" ? "mutation_uncertain" : "mutation_rejected",
        `${mutation.kind}: ${detail}`,
        mutation.operationUuid,
      );
      throw error;
    }
  }
}

export function mutationFailureOutcome(
  error: unknown,
): MutationFailureOutcome {
  if (error instanceof QvaApiError && error.status < 500) return "rejected";
  if (
    error instanceof QvaMutationUncertainError ||
    (error instanceof QvaApiError && error.status >= 500)
  )
    return "uncertain";
  return "uncertain";
}

export function isMutationUncertain(error: unknown): boolean {
  return mutationFailureOutcome(error) === "uncertain";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
