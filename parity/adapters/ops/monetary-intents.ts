/**
 * Operaciones de conformidad para `src/application/monetary-intents.ts`.
 *
 * El repositorio es un doble en memoria determinista: registra eventos
 * (`created`, `confirmed`/`uncertain`/`rejected`, `audit`) para demostrar que
 * la intención se persiste antes de despachar y que el fallo se clasifica de
 * forma conservadora.
 */
import { MonetaryIntents, mutationFailureOutcome } from "../../../src/application/monetary-intents.js";
import { QvaApiError, QvaMutationUncertainError } from "../../../src/qvapay.js";
import type { MutationIntent } from "../../../src/store.js";

type Input = Record<string, unknown>;

class MemoryIntentRepository {
  readonly intents = new Map<string, MutationIntent>();
  readonly events: string[] = [];
  failCreate = false;

  createMutationIntent(input: Omit<MutationIntent, "state" | "createdAt" | "updatedAt">): void {
    if (this.failCreate) throw new Error("sqlite unavailable");
    const createdAt = 1;
    this.intents.set(input.intentId, {
      ...input,
      state: "submitted",
      createdAt,
      updatedAt: createdAt,
    });
    this.events.push(`created:${input.intentId}`);
  }

  updateMutationIntent(
    intentId: string,
    state: MutationIntent["state"],
    response?: unknown,
    error?: string,
  ): void {
    const current = this.intents.get(intentId);
    if (!current) throw new Error("intent missing");
    this.intents.set(intentId, {
      ...current,
      state,
      ...(response === undefined ? {} : { response }),
      ...(error === undefined ? {} : { error }),
      updatedAt: current.updatedAt + 1,
    });
    this.events.push(`${state}:${intentId}`);
  }

  audit(action: string): void {
    this.events.push(`audit:${action}`);
  }
}

function errorFor(kind: string): unknown {
  switch (kind) {
    case "4xx":
      return new QvaApiError(409, "conflict");
    case "5xx":
      return new QvaApiError(503, "unavailable");
    case "timeout":
      return new QvaMutationUncertainError("apply", new Error("timeout"));
    default:
      return new Error("unexpected response");
  }
}

export const ops = {
  "monetary.timing": async () => {
    const repository = new MemoryIntentRepository();
    const phases: string[] = [];
    const durations: number[] = [];
    const intents = new MonetaryIntents(repository, { createId: () => "timed" });
    await intents.execute({
      kind: "received",
      request: {},
      action: async () => undefined,
      onTiming: (phase, milliseconds) => {
        durations.push(milliseconds);
        phases.push(phase);
        throw new Error("observer failed");
      },
    });
    return {
      phases,
      durationsFinite: durations.every((value) => Number.isFinite(value) && value >= 0),
      state: repository.intents.get("timed")?.state,
    };
  },

  "monetary.persist-before-dispatch": async () => {
    const repository = new MemoryIntentRepository();
    const intents = new MonetaryIntents(repository, { createId: () => "intent-1" });
    const result = await intents.execute({
      kind: "apply",
      operationUuid: "offer-1",
      request: { uuid: "offer-1" },
      action: async () => {
        if (repository.intents.get("intent-1")?.state !== "submitted") {
          throw new Error("la intención no estaba submitted");
        }
        repository.events.push("remote:apply");
        return { ok: true };
      },
    });
    return { result, state: repository.intents.get("intent-1")?.state, events: repository.events };
  },

  "monetary.persist-failure": async () => {
    const repository = new MemoryIntentRepository();
    repository.failCreate = true;
    const intents = new MonetaryIntents(repository, { createId: () => "intent-2" });
    let dispatched = false;
    let message = "";
    try {
      await intents.execute({
        kind: "cancel",
        request: {},
        action: async () => {
          dispatched = true;
        },
      });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    return { dispatched, message };
  },

  "monetary.failure-classification": async (input: Input) => {
    const kind = typeof input.kind === "string" ? input.kind : "unknown";
    const repository = new MemoryIntentRepository();
    const intentId = "intent-classified";
    const intents = new MonetaryIntents(repository, { createId: () => intentId });
    const expected = errorFor(kind);
    let sameError = false;
    try {
      await intents.execute({
        kind: "apply",
        operationUuid: "offer-1",
        request: {},
        action: async () => {
          throw expected;
        },
      });
    } catch (error) {
      sameError = error === expected;
    }
    return {
      sameError,
      state: repository.intents.get(intentId)?.state,
      events: repository.events,
    };
  },

  "monetary.failure-classification-all": async (input: Input) => {
    const kinds = Array.isArray(input.kinds) ? (input.kinds as string[]) : [];
    const results: unknown[] = [];
    for (const [index, kind] of kinds.entries()) {
      const repository = new MemoryIntentRepository();
      const intentId = `intent-classified-${index + 3}`;
      const intents = new MonetaryIntents(repository, { createId: () => intentId });
      const expected = errorFor(kind);
      let sameError = false;
      try {
        await intents.execute({
          kind: "apply",
          operationUuid: "offer-1",
          request: {},
          action: async () => {
            throw expected;
          },
        });
      } catch (error) {
        sameError = error === expected;
      }
      results.push({
        kind,
        sameError,
        state: repository.intents.get(intentId)?.state,
        events: repository.events,
      });
    }
    return { results };
  },

  "monetary.outcome-all": (input: Input) => {
    const kinds = Array.isArray(input.kinds) ? (input.kinds as string[]) : [];
    return { results: kinds.map((kind) => ({ kind, outcome: mutationFailureOutcome(errorFor(kind)) })) };
  },

  "monetary.outcome": (input: Input) => {
    const kind = typeof input.kind === "string" ? input.kind : "unknown";
    return { outcome: mutationFailureOutcome(errorFor(kind)) };
  },
};
