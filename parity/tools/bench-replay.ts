#!/usr/bin/env node
/**
 * Benchmark local del oráculo TS sobre el corpus replay F2.
 * Uso:
 *   node --import tsx parity/tools/bench-replay.ts --iterations 100
 */
import { readFileSync } from "node:fs";
import { ReplaySession } from "../lib/replay/session.ts";

function arg(name: string, fallback: string): string {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1]! : fallback;
}

const document = JSON.parse(
  readFileSync("parity/fixtures/replay/2026-11-12/scenarios.json", "utf8"),
) as {
  defaults: { session: unknown };
  cases: Array<{ caseId: string; steps: Array<{ op: string; input: Record<string, unknown> }> }>;
};
const events = readFileSync("parity/fixtures/replay/2026-11-12/events.ndjson", "utf8")
  .trim()
  .split("\n")
  .map((line) => JSON.parse(line) as { event: string; payload: unknown; receivedAt: number });
const iterations = Number(arg("--iterations", "100"));

function expandStops(steps: Array<{ op: string; input: Record<string, unknown> }>) {
  return steps.map((step) => {
    const input = { ...(step.input ?? {}) } as Record<string, unknown>;
    const ingest = input.ingest as { events?: number[] } | undefined;
    if (ingest) {
      delete input.ingest;
      input.events = (ingest.events ?? []).map((index) => {
        const event = events[index]!;
        return { event: event.event, payload: event.payload, state: "pending", receivedAt: event.receivedAt };
      });
    }
    return { op: step.op, input };
  });
}

async function runOnce(): Promise<void> {
  for (const scenario of document.cases) {
    const session = ReplaySession.start(document.defaults.session as never);
    try {
      await session.step("trading.state", {});
      for (const step of expandStops(scenario.steps)) {
        await session.step(step.op, step.input as never);
      }
      await session.step("trading.state", {});
    } finally {
      await session.close();
    }
  }
}

for (let index = 0; index < 3; index += 1) await runOnce();
const durations: number[] = [];
const started = process.hrtime.bigint();
for (let index = 0; index < iterations; index += 1) {
  const start = process.hrtime.bigint();
  await runOnce();
  durations.push(Number(process.hrtime.bigint() - start) / 1e6);
}
const totalMs = Number(process.hrtime.bigint() - started) / 1e6;
durations.sort((left, right) => left - right);
const percentile = (value: number) => durations[Math.floor((durations.length - 1) * value)] ?? 0;
const steps = iterations * 14;
const decisions = iterations * 18;
console.log(
  `replay-bench-ts: iterations=${iterations} total=${totalMs.toFixed(1)}ms ` +
    `p50=${percentile(0.5).toFixed(2)}ms p95=${percentile(0.95).toFixed(2)}ms ` +
    `p99=${percentile(0.99).toFixed(2)}ms steps/s=${(steps / (totalMs / 1000)).toFixed(0)} ` +
    `decisions/s=${(decisions / (totalMs / 1000)).toFixed(0)} ` +
    `rss=${(process.memoryUsage().rss / 1024 / 1024).toFixed(1)}MB`,
);
