/**
 * Runner de paridad v1.
 *
 * Ejecuta casos dorados ({@link ParityFile}) contra una implementación
 * opaca mediante el protocolo CLI v1 (o, en el futuro, HTTP) y compara la
 * salida con `expect` bajo las reglas canónicas de `parity/lib/canonical.ts`.
 *
 * Uso:
 *   node --import tsx parity/runner/run.ts --sut ts --suite pure [--filter <sub>]
 *   node --import tsx parity/runner/run.ts --sut cli --command "binario" ...
 *
 * `--sut ts` es el oráculo TypeScript (`parity/adapters/ts-cli.ts`).
 * `--sut cli` lanza un binario Go/Rust que habla el mismo protocolo.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalHash, diffValues } from "../lib/canonical.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");
const goldenRoot = join(repoRoot, "parity", "golden", "v1");

interface CaseFile {
  schema: "qvaapply.parity/v1";
  cases: ParityCase[];
}

interface ParityCase {
  caseId: string;
  kind?: "pure" | "stateful";
  op?: string;
  source?: string;
  expect?: unknown;
  expectError?: { class?: string; messageIncludes?: string };
  input?: Record<string, unknown>;
  session?: Record<string, unknown>;
  sessionExpect?: { stateDigest?: string };
  steps?: StatefulStep[];
}

interface StatefulStep {
  op: string;
  input?: Record<string, unknown>;
  expect?: unknown;
  expectError?: { class?: string; messageIncludes?: string };
  expectUpstream?: unknown;
  expectStateDigest?: string;
}

interface Args {
  sut: "ts" | "cli";
  suite: string;
  filter?: string;
  command?: string[];
  report?: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { sut: "ts", suite: "pure" };
  const rest = [...argv];
  while (rest.length) {
    const flag = rest.shift();
    const value = rest[0];
    switch (flag) {
      case "--sut":
        rest.shift();
        if (value !== "ts" && value !== "cli") throw new Error(`--sut inválido: ${value}`);
        args.sut = value;
        break;
      case "--suite":
        rest.shift();
        args.suite = value ?? "pure";
        break;
      case "--filter":
        rest.shift();
        args.filter = value;
        break;
      case "--command":
        rest.shift();
        args.command = (value ?? "").split(/\s+/).filter(Boolean);
        break;
      case "--report":
        rest.shift();
        args.report = value;
        break;
      default:
        throw new Error(`Argumento no reconocido: ${flag}`);
    }
  }
  if (args.sut === "cli" && !args.command?.length) throw new Error("--sut cli requiere --command.");
  return args;
}

function collectCaseFiles(suiteDir: string): string[] {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir).sort()) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) walk(path);
      else if (entry.endsWith(".json")) files.push(path);
    }
  };
  if (existsSync(suiteDir)) walk(suiteDir);
  return files;
}

function loadCases(suite: string, filter?: string): { file: string; cases: ParityCase[] }[] {
  const suiteDir = join(goldenRoot, suite);
  const loaded = collectCaseFiles(suiteDir).map((file) => {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as CaseFile;
    if (parsed.schema !== "qvaapply.parity/v1") throw new Error(`${file}: schema desconocido`);
    if (!Array.isArray(parsed.cases)) throw new Error(`${file}: falta cases[]`);
    const cases = filter ? parsed.cases.filter((item) => item.caseId.includes(filter)) : parsed.cases;
    return { file, cases };
  });
  return loaded.filter((entry) => entry.cases.length > 0);
}

class SutProcess {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<string, (line: string) => void>();
  private readonly buffer: string[] = [];

  constructor(command: string[], cwd: string) {
    this.child = spawn(command[0]!, command.slice(1), { cwd, stdio: ["pipe", "pipe", "inherit"] });
    let partial = "";
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => {
      partial += chunk;
      let index = partial.indexOf("\n");
      while (index >= 0) {
        const line = partial.slice(0, index);
        partial = partial.slice(index + 1);
        this.dispatch(line);
        index = partial.indexOf("\n");
      }
    });
  }

  private dispatch(line: string) {
    if (!line.trim()) return;
    let response: { id?: string };
    try {
      response = JSON.parse(line) as { id?: string };
    } catch {
      throw new Error(`Respuesta no JSON del SUT: ${line.slice(0, 200)}`);
    }
    const waiter = response.id ? this.pending.get(response.id) : undefined;
    if (!waiter || !response.id) throw new Error(`Respuesta sin petición: ${line.slice(0, 200)}`);
    this.pending.delete(response.id);
    waiter(line);
  }

  request(request: { id: string; op: string; input?: Record<string, unknown> }): Promise<{ result?: unknown; error?: { class: string; message: string } }> {
    return new Promise((resolvePromise, rejectPromise) => {
      const timeout = setTimeout(() => rejectPromise(new Error(`Timeout esperando ${request.id}`)), 10_000);
      this.pending.set(request.id, (line) => {
        clearTimeout(timeout);
        resolvePromise(JSON.parse(line));
      });
      this.child.stdin.write(`${JSON.stringify(request)}\n`);
    });
  }

  close() {
    this.child.stdin.end();
    this.child.kill();
  }
}

async function runStateful(item: ParityCase, sut: SutProcess, ordinal: number): Promise<boolean> {
  const sessionId = item.caseId;
  const prefix = `${sessionId}#${ordinal}`;
  const start = await sut.request({ id: `${prefix}#start`, op: "replay.start", input: { sessionId, session: item.session } });
  if (start.error) {
    console.error(`✗ ${item.caseId}: replay.start falló: ${start.error.class}: ${start.error.message}`);
    return false;
  }
  const started = start.result as { stateDigest?: string };
  if (item.sessionExpect?.stateDigest && started.stateDigest !== item.sessionExpect.stateDigest) {
    console.error(`✗ ${item.caseId}: stateDigest inicial esperado ${item.sessionExpect.stateDigest} · real ${started.stateDigest}`);
    await sut.request({ id: `${prefix}#close`, op: "replay.close", input: { sessionId } }).catch(() => undefined);
    return false;
  }
  try {
    for (const [index, step] of (item.steps ?? []).entries()) {
      const response = await sut.request({
        id: `${prefix}#${index + 1}`,
        op: "replay.step",
        input: { sessionId, op: step.op, input: step.input ?? {} },
      });
      if (step.expectError) {
        const matchesClass = !step.expectError.class || response.error?.class === step.expectError.class;
        const matchesMessage = !step.expectError.messageIncludes || (response.error?.message ?? "").includes(step.expectError.messageIncludes);
        if (response.error && matchesClass && matchesMessage) continue;
        console.error(`✗ ${item.caseId} paso ${index + 1}: se esperaba error ${JSON.stringify(step.expectError)} y llegó ${JSON.stringify(response)}`);
        return false;
      }
      if (response.error) {
        console.error(`✗ ${item.caseId} paso ${index + 1}: ${response.error.class}: ${response.error.message}`);
        return false;
      }
      const result = response.result as { result?: unknown; upstream?: unknown; stateDigest?: string };
      const differences = diffValues(step.expect, result?.result);
      if (step.expectUpstream !== undefined) {
        differences.push(...diffValues(step.expectUpstream, result?.upstream).map((entry) => ({ ...entry, path: `$.upstream${entry.path.slice(1)}` })));
      }
      if (step.expectStateDigest !== undefined && step.expectStateDigest !== result?.stateDigest) {
        differences.push({ path: "$.stateDigest", expected: step.expectStateDigest, actual: result?.stateDigest });
      }
      if (differences.length) {
        console.error(`✗ ${item.caseId} paso ${index + 1} (${step.op})`);
        for (const difference of differences.slice(0, 5)) {
          console.error(`   ${difference.path}: esperado ${JSON.stringify(difference.expected)} · real ${JSON.stringify(difference.actual)}`);
        }
        return false;
      }
    }
    return true;
  } finally {
    await sut.request({ id: `${prefix}#close`, op: "replay.close", input: { sessionId } }).catch(() => undefined);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const files = loadCases(args.suite, args.filter);
  if (!files.length) {
    console.error(`No hay casos en suite=${args.suite}${args.filter ? ` filter=${args.filter}` : ""}.`);
    process.exit(2);
  }

  const command = args.sut === "ts"
    ? [process.execPath, "--import", "tsx", join(repoRoot, "parity", "adapters", "ts-cli.ts")]
    : args.command!;
  const sut = new SutProcess(command, repoRoot);

  const report = {
    schema: "qvaapply.parity-report/v1",
    sut: args.sut === "ts" ? "ts-cli" : args.command!.join(" "),
    suite: args.suite,
    startedAt: new Date().toISOString(),
    total: 0,
    passed: 0,
    failed: 0,
    cases: [] as unknown[],
  };

  try {
    for (const { file, cases } of files) {
      for (const item of cases) {
        report.total += 1;
        if (item.kind === "stateful") {
          const passed = await runStateful(item, sut, report.total);
          if (passed) {
            report.passed += 1;
            report.cases.push({ caseId: item.caseId, file, ok: true, steps: item.steps?.length ?? 0 });
            console.log(`✓ ${item.caseId} (stateful, ${item.steps?.length ?? 0} pasos)`);
          } else {
            report.failed += 1;
          }
          continue;
        }
        const requestId = `${item.caseId}#${report.total}`;
        const response = await sut.request({ id: requestId, op: item.op!, input: item.input });
        if (item.expectError) {
          const matchesClass = !item.expectError.class || response.error?.class === item.expectError.class;
          const matchesMessage = !item.expectError.messageIncludes || (response.error?.message ?? "").includes(item.expectError.messageIncludes);
          if (response.error && matchesClass && matchesMessage) {
            report.passed += 1;
            report.cases.push({ caseId: item.caseId, file, ok: true, errorClass: response.error.class });
            console.log(`✓ ${item.caseId} (error esperado)`);
            continue;
          }
          report.failed += 1;
          report.cases.push({ caseId: item.caseId, file, ok: false, expectedError: item.expectError, actual: response });
          console.error(`✗ ${item.caseId}: se esperaba error ${JSON.stringify(item.expectError)} y llegó ${JSON.stringify(response)}`);
          continue;
        }
        if (response.error) {
          report.failed += 1;
          report.cases.push({ caseId: item.caseId, file, ok: false, error: response.error });
          console.error(`✗ ${item.caseId}: ${response.error.class}: ${response.error.message}`);
          continue;
        }
        const differences = diffValues(item.expect, response.result);
        if (differences.length) {
          report.failed += 1;
          report.cases.push({ caseId: item.caseId, file, ok: false, differences });
          console.error(`✗ ${item.caseId} (${file})`);
          for (const difference of differences.slice(0, 5)) {
            console.error(`   ${difference.path}: esperado ${JSON.stringify(difference.expected)} · real ${JSON.stringify(difference.actual)}`);
          }
          continue;
        }
        report.passed += 1;
        report.cases.push({ caseId: item.caseId, file, ok: true, hash: canonicalHash(response.result) });
        console.log(`✓ ${item.caseId}`);
      }
    }
  } finally {
    sut.close();
  }

  const reportHash = canonicalHash(report);
  const output = JSON.stringify({ ...report, reportHash }, null, 2);
  if (args.report) writeFileSync(resolve(args.report), `${output}\n`);
  console.log(`\n${report.passed}/${report.total} casos en verde${report.failed ? ` · ${report.failed} fallos` : ""}.`);
  process.exit(report.failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exit(2);
});
