import assert from "node:assert/strict";
import test from "node:test";
import {
  MonetaryIntents,
  mutationFailureOutcome,
  type MutationIntentRepository,
} from "../src/application/monetary-intents.js";
import { QvaApiError, QvaMutationUncertainError } from "../src/qvapay.js";
import type { MutationIntent } from "../src/store.js";

class MemoryIntentRepository implements MutationIntentRepository {
  readonly intents = new Map<string, MutationIntent>();
  readonly events: string[] = [];
  failCreate = false;

  createMutationIntent(
    input: Omit<MutationIntent, "state" | "createdAt" | "updatedAt">,
  ): void {
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

test("mide persistencias y mutación sin permitir que el observador cambie el resultado", async () => {
  const repository = new MemoryIntentRepository();
  const phases: string[] = [];
  const durations: number[] = [];
  const intents = new MonetaryIntents(repository, { createId: () => "timed" });
  await intents.execute({
    kind: "received", request: {}, action: async () => undefined,
    onTiming: (phase, milliseconds) => {
      durations.push(milliseconds);
      phases.push(phase);
      throw new Error("observer failed");
    },
  });
  assert.deepEqual(phases, ["intentPersistMs", "mutationMs", "resultPersistMs"]);
  assert.ok(durations.every(milliseconds => Number.isFinite(milliseconds) && milliseconds >= 0));
  assert.equal(repository.intents.get("timed")?.state, "confirmed");
});

test("persiste submitted antes de despachar y confirma después de responder", async () => {
  const repository = new MemoryIntentRepository();
  const intents = new MonetaryIntents(repository, { createId: () => "intent-1" });

  const result = await intents.execute({
    kind: "apply",
    operationUuid: "offer-1",
    request: { uuid: "offer-1" },
    action: async () => {
      assert.equal(repository.intents.get("intent-1")?.state, "submitted");
      repository.events.push("remote:apply");
      return { ok: true };
    },
  });

  assert.deepEqual(result, { ok: true });
  assert.equal(repository.intents.get("intent-1")?.state, "confirmed");
  assert.deepEqual(repository.events, [
    "created:intent-1",
    "remote:apply",
    "confirmed:intent-1",
  ]);
});

test("no despacha si no puede persistir la intención inicial", async () => {
  const repository = new MemoryIntentRepository();
  repository.failCreate = true;
  const intents = new MonetaryIntents(repository, { createId: () => "intent-2" });
  let dispatched = false;

  await assert.rejects(
    () =>
      intents.execute({
        kind: "cancel",
        request: {},
        action: async () => {
          dispatched = true;
        },
      }),
    /sqlite unavailable/,
  );

  assert.equal(dispatched, false);
});

test("clasifica de forma conservadora y audita el resultado fallido", async () => {
  const cases = [
    {
      name: "4xx",
      error: new QvaApiError(409, "conflict"),
      state: "rejected",
    },
    {
      name: "5xx",
      error: new QvaApiError(503, "unavailable"),
      state: "uncertain",
    },
    {
      name: "timeout",
      error: new QvaMutationUncertainError("apply", new Error("timeout")),
      state: "uncertain",
    },
    {
      name: "unknown",
      error: new Error("unexpected response"),
      state: "uncertain",
    },
  ] as const;

  for (const [index, scenario] of cases.entries()) {
    const repository = new MemoryIntentRepository();
    const intentId = `intent-${index + 3}`;
    const intents = new MonetaryIntents(repository, { createId: () => intentId });

    await assert.rejects(
      () =>
        intents.execute({
          kind: "apply",
          operationUuid: "offer-1",
          request: {},
          action: async () => {
            throw scenario.error;
          },
        }),
      (error: unknown) => error === scenario.error,
      scenario.name,
    );

    assert.equal(repository.intents.get(intentId)?.state, scenario.state);
    assert.ok(
      repository.events.includes(
        `audit:mutation_${scenario.state === "uncertain" ? "uncertain" : "rejected"}`,
      ),
    );
  }
});

test("expone una única clasificación para los consumidores", () => {
  assert.equal(mutationFailureOutcome(new QvaApiError(400, "bad")), "rejected");
  assert.equal(mutationFailureOutcome(new QvaApiError(500, "down")), "uncertain");
  assert.equal(
    mutationFailureOutcome(
      new QvaMutationUncertainError("create", new Error("timeout")),
    ),
    "uncertain",
  );
  assert.equal(mutationFailureOutcome(new Error("unknown")), "uncertain");
});
