/**
 * Generador del corpus de replay stateful (F0).
 *
 * Lee el corpus sanitizado de `parity/fixtures/replay/<fecha>/` y ejecuta cada
 * escenario contra el oráculo TypeScript con el mismo motor que usa el SUT
 * (`parity/lib/replay/session.ts`): SQLite temporal, reloj inyectado y gateway
 * guionizado, sin red. Escribe:
 *
 *   - `parity/golden/v1/replay/*.json`   casos stateful con `expect`,
 *   - `fixtures/replay/<fecha>/decisions.ndjson`  traza canónica por paso,
 *   - `fixtures/replay/<fecha>/manifest.json`     conteos y hash de cada archivo.
 *
 * Uso:
 *   node --import tsx parity/tools/generate-replay.ts          # regenera
 *   node --import tsx parity/tools/generate-replay.ts --check  # solo verifica
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { canonicalHash, canonicalJson } from "../lib/canonical.js";
import {
  runScenario,
  type ReplayScenario,
  type ReplaySessionSpec,
  type ReplayStepInput,
} from "../lib/replay/session.js";

const COMMIT = "02bb5afc04b5eb95f5ac3996ef7634dedf073d02";
const CORPUS = "2026-11-12";
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");
const fixtureDir = join(repoRoot, "parity", "fixtures", "replay", CORPUS);
const goldenPath = join(repoRoot, "parity", "golden", "v1", "replay", "money-core.json");
const decisionsPath = join(fixtureDir, "decisions.ndjson");
const manifestPath = join(fixtureDir, "manifest.json");

interface CorpusEvent {
  channel: string;
  durableSeq: number;
  event: string;
  receivedAt: number;
  payload: unknown;
}

interface ScenarioStep {
  op: string;
  input?: ReplayStepInput & { ingest?: { events: number[] } };
}

interface ScenarioCase {
  caseId: string;
  source: string;
  session?: ReplaySessionSpec;
  steps: ScenarioStep[];
}

interface ScenarioFile {
  schema: string;
  corpus: string;
  defaults: { session: ReplaySessionSpec };
  cases: ScenarioCase[];
}

function sha256(content: string | Buffer): string {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

function readEvents(): { events: CorpusEvent[]; raw: string } {
  const raw = readFileSync(join(fixtureDir, "events.ndjson"), "utf8");
  const events = raw
    .split("\n")
    .filter((line) => line.trim())
    .map((line, index) => {
      try {
        return JSON.parse(line) as CorpusEvent;
      } catch (error) {
        throw new Error(`events.ndjson:${index + 1}: JSON inválido (${String(error)})`);
      }
    });
  return { events, raw };
}

function expand(caseDef: ScenarioCase, events: CorpusEvent[], defaults: ReplaySessionSpec): ReplayScenario {
  const session = caseDef.session ?? defaults;
  const steps = caseDef.steps.map((step, index) => {
    const input = { ...(step.input ?? {}) };
    if (input.ingest) {
      const indices = input.ingest.events;
      delete input.ingest;
      input.events = indices.map((eventIndex) => {
        const event = events[eventIndex];
        if (!event) throw new Error(`${caseDef.caseId}: events[${eventIndex}] no existe en el corpus.`);
        return {
          event: event.event,
          payload: event.payload,
          state: "pending" as const,
          receivedAt: event.receivedAt,
        };
      });
    }
    if (step.op === "market.ingest" && !input.events?.length) {
      throw new Error(`${caseDef.caseId}: paso ${index + 1} (market.ingest) sin eventos.`);
    }
    return { op: step.op, input };
  });
  return { session, steps };
}

async function main(): Promise<void> {
  const checkOnly = process.argv.includes("--check");
  const { events, raw: eventsRaw } = readEvents();
  const scenariosRaw = readFileSync(join(fixtureDir, "scenarios.json"), "utf8");
  const scenarios = JSON.parse(scenariosRaw) as ScenarioFile;
  if (scenarios.schema !== "qvaapply.replay-scenarios/v1") {
    throw new Error(`scenarios.json: schema desconocido ${scenarios.schema}`);
  }
  if (scenarios.corpus !== CORPUS) {
    throw new Error(`scenarios.json: corpus ${scenarios.corpus} no coincide con ${CORPUS}`);
  }

  const cases: Record<string, unknown>[] = [];
  const decisionLines: string[] = [];
  let totalSteps = 0;

  for (const caseDef of scenarios.cases) {
    const scenario = expand(caseDef, events, scenarios.defaults.session);
    const run = await runScenario(scenario);
    totalSteps += scenario.steps.length;
    const steps = scenario.steps.map((step, index) => {
      const observed = run.steps[index]!;
      decisionLines.push(canonicalJson({
        caseId: caseDef.caseId,
        seq: index + 1,
        op: step.op,
        result: observed.result,
        upstream: observed.upstream,
        stateDigest: observed.stateDigest,
      }));
      return {
        op: step.op,
        input: step.input,
        expect: observed.result,
        expectUpstream: observed.upstream,
        expectStateDigest: observed.stateDigest,
      };
    });
    decisionLines.push(canonicalJson({
      caseId: caseDef.caseId,
      seq: "final",
      op: "trading.final",
      stateDigest: run.finalStateDigest,
    }));
    cases.push({
      caseId: caseDef.caseId,
      kind: "stateful",
      source: caseDef.source,
      session: scenario.session,
      sessionExpect: { stateDigest: run.startStateDigest },
      steps,
    });
  }

  const decisions = `${decisionLines.join("\n")}\n`;
  const sourceTests = [...new Set(scenarios.cases.map((item) => item.source))].sort();
  const goldenHash = canonicalHash(cases);
  const golden = {
    schema: "qvaapply.parity/v1",
    suite: "replay",
    targetService: "trading-core",
    module: "src/application/opportunity-orchestrator.ts",
    sourceTests,
    generatedFrom: {
      impl: "typescript",
      commit: COMMIT,
      approvedBy: "f0-bootstrap",
    },
    notes:
      `Replay stateful del corpus ${CORPUS}: feed sanitizado → dedupe durable → decisión/riesgo/liquidez → ` +
      `reserva e intención → mutación guionizada → conciliación. Sin red, sin reloj real, sin sleeps; ` +
      `UUID de workflow e intención normalizados por orden de aparición. · goldenHash=${goldenHash}`,
    cases,
  };
  const goldenSerialized = `${JSON.stringify(golden, null, 2)}\n`;

  const manifest = {
    schema: "qvaapply.replay-manifest/v1",
    corpus: CORPUS,
    generatedFrom: { impl: "typescript", commit: COMMIT },
    clock: scenarios.defaults.session.clock,
    sanitization: {
      included: ["market feed events", "market observations", "decision traces"],
      excluded: ["tokens", "cookies", "VAPID keys", "encrypted tokens", "payment data", "user/peer PII"],
      note: "Corpus sintético derivado del oráculo TS congelado; sin datos de producción.",
    },
    counts: {
      events: events.length,
      scenarios: scenarios.cases.length,
      steps: totalSteps,
      decisions: decisionLines.length,
    },
    files: {
      events: {
        sha256: sha256(eventsRaw),
        bytes: Buffer.byteLength(eventsRaw),
        lines: events.length,
      },
      scenarios: {
        sha256: sha256(scenariosRaw),
        bytes: Buffer.byteLength(scenariosRaw),
      },
      decisions: {
        sha256: sha256(decisions),
        bytes: Buffer.byteLength(decisions),
        lines: decisionLines.length,
      },
    },
  };
  const manifestSerialized = `${JSON.stringify(manifest, null, 2)}\n`;

  const outputs = [
    { path: goldenPath, content: goldenSerialized, label: "golden/v1/replay/money-core.json" },
    { path: decisionsPath, content: decisions, label: `fixtures/replay/${CORPUS}/decisions.ndjson` },
    { path: manifestPath, content: manifestSerialized, label: `fixtures/replay/${CORPUS}/manifest.json` },
  ];

  let drift = false;
  for (const output of outputs) {
    if (checkOnly) {
      const current = existsSync(output.path) ? readFileSync(output.path, "utf8") : "";
      if (current !== output.content) {
        drift = true;
        console.error(`✗ ${output.label}: desactualizado respecto del oráculo.`);
      } else {
        console.log(`✓ ${output.label}`);
      }
      continue;
    }
    writeFileSync(output.path, output.content);
    console.log(`→ ${output.label}`);
  }

  console.log(
    `\n${scenarios.cases.length} escenarios, ${totalSteps} pasos, ${decisionLines.length} líneas de decisión` +
      `${checkOnly ? " verificados" : " generados"} (goldenHash=${goldenHash.slice(0, 12)}…).`,
  );
  if (checkOnly && drift) {
    console.error("El corpus de replay no coincide con el oráculo; regenera con el script sin --check.");
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exit(2);
});
