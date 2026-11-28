/**
 * Sesión de replay stateful v1.
 *
 * Ejecuta escenarios de extremo a extremo contra el oráculo TypeScript usando
 * componentes reales, sin red y con reloj inyectado:
 *
 *   - `Store` real sobre un SQLite temporal (misma migración v31),
 *   - `MarketConfigService` real (configuración revisada y guardada),
 *   - `OpportunityOrchestrator` real (riesgo, liquidez, reserva, intención,
 *     mutación y conciliación),
 *   - gateway QvaPay **guionizado** en proceso: cada paso declara qué responde
 *     cada método; una llamada no declarada es un fallo explícito.
 *
 * El estado final se resume en un `stateDigest` canónico. Los identificadores
 * generados por el oráculo (UUID de workflow e intent) se normalizan por orden
 * de aparición para que la traza sea reproducible byte a byte.
 */
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { OpportunityOrchestrator } from "../../../src/application/opportunity-orchestrator.js";
import { MarketConfigService, type TradingConfig } from "../../../src/market-config.js";
import { QvaApiError, QvaMutationUncertainError } from "../../../src/qvapay.js";
import { Store } from "../../../src/store.js";
import type { P2pOffer } from "../../../src/types.js";
import { canonicalHash } from "../canonical.js";

export type Money = string | number;

const SCALE = 8;

export function fixed(value: number, scale = SCALE): string {
  if (!Number.isFinite(value)) return "NaN";
  const rounded = Number(value.toFixed(scale));
  return rounded.toFixed(scale);
}

function numeric(value: unknown, path: string): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && /^-?\d+(\.\d+)?$/.test(value)) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  throw new Error(`${path}: se esperaba un decimal, llegó ${JSON.stringify(value)}.`);
}

function optionalNumeric(value: unknown, path: string): number | undefined {
  return value === undefined || value === null ? undefined : numeric(value, path);
}

function parseOffer(value: unknown, path: string): P2pOffer {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${path}: se esperaba una oferta.`);
  }
  const source = value as Record<string, unknown>;
  const offer: Record<string, unknown> = { ...source };
  for (const field of ["amount", "receive", "available_amount", "order_min", "order_max"]) {
    if (source[field] !== undefined) offer[field] = numeric(source[field], `${path}.${field}`);
  }
  return offer as unknown as P2pOffer;
}

interface GatewayOutcome {
  ok?: unknown;
  error?: {
    kind?: "api" | "uncertain" | "generic";
    status?: number;
    message?: string;
  };
}

export interface GatewayScript {
  qusdBalance?: unknown[];
  listOffers?: unknown[][];
  getOffer?: Record<string, GatewayOutcome>;
  apply?: GatewayOutcome[];
  cancel?: GatewayOutcome[];
  createOffer?: GatewayOutcome[];
  editOffer?: GatewayOutcome[];
  markPaid?: GatewayOutcome[];
  confirmReceived?: GatewayOutcome[];
  profile?: GatewayOutcome[];
}

export interface ReplaySessionSpec {
  clock: { start: number; stepMs?: number };
  config?: {
    qusdReserve?: number;
    maxOpenOffers?: number;
    risk?: Partial<TradingConfig["risk"]>;
    markets?: Array<Partial<TradingConfig["markets"][number]> & { code: string }>;
  };
  settings?: Record<string, string>;
}

export interface ReplayStepInput {
  target?: unknown;
  referenceRate?: unknown;
  expectedMarginPercent?: unknown;
  priceDecision?: string;
  priceReason?: string;
  gateway?: GatewayScript;
  automatic?: boolean;
  workflow?: string;
  events?: Array<{
    key?: string;
    event: string;
    payload: unknown;
    state?: "pending" | "ignored";
    receivedAt?: number;
  }>;
  observation?: {
    coin: string;
    averageBuy?: number;
    averageSell?: number;
    medianBuy?: number;
    medianSell?: number;
    bestBuy?: number;
    bestSell?: number;
    openOffers: number;
    eligible: number;
  };
}

export interface ReplayStepResult {
  result: unknown;
  upstream: Array<Record<string, unknown>>;
  stateDigest: string;
}

interface PendingCall {
  method: string;
  queue: GatewayOutcome[];
  index: number;
}

const UUID_PATTERN = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;

function normalizeText(value: string, ids: Map<string, string>): string {
  return value.replace(UUID_PATTERN, (uuid) => {
    const existing = ids.get(uuid.toLowerCase());
    if (existing) return existing;
    const token = `id-${ids.size + 1}`;
    ids.set(uuid.toLowerCase(), token);
    return token;
  });
}

/**
 * `acceptPayload` del oráculo construye la clave de dedupe en
 * `src/market-feed.ts:355-362`; se reproduce aquí porque el método vive en una
 * clase que exige Vault y fuentes de red. La persistencia y el `INSERT OR
 * IGNORE` son los reales de `Store.enqueueMarketFeedEvent`.
 */
function feedKey(event: {
  event: string;
  payload: { data: { uuid: string; updated_at?: string; available_amount?: number }; sent_at: string };
}, explicit?: string): string {
  if (explicit) return explicit;
  const version = typeof event.payload.data.updated_at === "string" && event.payload.data.updated_at
    ? event.payload.data.updated_at
    : event.payload.sent_at;
  if (event.event.startsWith("p2p.range_")) {
    return `${event.event}:${event.payload.data.uuid}:${version}:${event.payload.sent_at}:${event.payload.data.available_amount ?? ""}`;
  }
  if (event.event === "p2p.paused" || event.event === "p2p.resumed") {
    return `${event.event}:${event.payload.data.uuid}:${version}:${event.payload.sent_at}`;
  }
  return `${event.event}:${event.payload.data.uuid}:${version}`;
}

export class ReplaySession {
  private readonly dir: string;
  private readonly store: Store;
  private readonly markets: MarketConfigService;
  private readonly orchestrator: OpportunityOrchestrator;
  private readonly clock: { start: number; stepMs: number };
  private stepIndex = 0;
  private currentGateway: GatewayScript = {};
  private pending = new Map<string, PendingCall>();
  private upstream: Array<Record<string, unknown>> = [];
  private readonly workflowRefs: string[] = [];
  private readonly workflowIds = new Map<string, string>();
  private readonly workflowByRef = new Map<string, string>();
  private readonly intentRefs = new Map<string, string>();
  private readonly ids = new Map<string, string>();
  private readonly acceptedFeed: Array<{ key: string; event: string; state: string; receivedAt: number }> = [];
  private readonly observations: Array<Record<string, unknown>> = [];
  private closed = false;

  private constructor(dir: string, spec: ReplaySessionSpec) {
    this.dir = dir;
    this.clock = { start: spec.clock.start, stepMs: spec.clock.stepMs ?? 1 };
    this.store = new Store(dir);
    this.store.set("paused", "false");
    this.store.set("emergency_stop", "false");
    for (const [key, value] of Object.entries(spec.settings ?? {})) this.store.set(key, value);

    const legacy = {
      dataDir: dir,
      qusdReserve: spec.config?.qusdReserve ?? 0,
      maxOpenOwnOffers: spec.config?.maxOpenOffers ?? 10,
      buyQusdMaxRate: 970,
      sellQusdMinRate: 1_010,
      cupPurchaseMaxQusd: 25,
      initialUsdFiatBalance: 0,
      paymentDetails: { BANK_CUP: [], BANDECPREPAGO: [] },
    };
    this.markets = new MarketConfigService(dir, legacy as never, this.store);
    const config = this.markets.current();
    config.risk.reviewedAt = spec.clock.start;
    if (spec.config?.qusdReserve !== undefined) config.qusdReserve = spec.config.qusdReserve;
    if (spec.config?.maxOpenOffers !== undefined) config.maxOpenOffers = spec.config.maxOpenOffers;
    Object.assign(config.risk, spec.config?.risk ?? {});
    for (const override of spec.config?.markets ?? []) {
      const market = config.markets.find((candidate) => candidate.code === override.code);
      if (!market) throw new Error(`Mercado no configurado en replay: ${override.code}`);
      Object.assign(market, override);
    }
    this.markets.save(config);

    this.orchestrator = new OpportunityOrchestrator(
      this.store,
      this.gateway() as never,
      this.markets,
      { now: () => this.now() },
    );
  }

  static start(spec: ReplaySessionSpec): ReplaySession {
    const dir = mkdtempSync(join(tmpdir(), "qvaapply-replay-"));
    try {
      return new ReplaySession(dir, spec);
    } catch (error) {
      rmSync(dir, { recursive: true, force: true });
      throw error;
    }
  }

  private now(): number {
    return this.clock.start + this.stepIndex * this.clock.stepMs;
  }

  private gateway(): Record<string, (...args: unknown[]) => Promise<unknown>> {
    const handlers = [
      "apply",
      "cancel",
      "confirmReceived",
      "createOffer",
      "editOffer",
      "getOffer",
      "listOffers",
      "listOffersPage",
      "listTransactions",
      "listChat",
      "markPaid",
      "p2pAverages",
      "profile",
      "qusdBalance",
      "sendChat",
    ];
    const gateway: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
    for (const method of handlers) {
      gateway[method] = (...args: unknown[]) => this.call(method, args);
    }
    return gateway;
  }

  private queue(method: string, values: unknown[] | undefined): PendingCall {
    let pending = this.pending.get(method);
    if (!pending) {
      pending = { method, queue: (values ?? []) as GatewayOutcome[], index: 0 };
      this.pending.set(method, pending);
    }
    return pending;
  }

  private async call(method: string, args: unknown[]): Promise<unknown> {
    let outcome: GatewayOutcome | undefined;
    if (method === "getOffer") {
      const uuid = String(args[0] ?? "");
      outcome = this.currentGateway.getOffer?.[uuid];
      if (!outcome) {
        throw new Error(`Gateway exhausto: getOffer(${uuid}) no está declarado en el paso.`);
      }
    } else {
      const values = (this.currentGateway as unknown as Record<string, unknown[] | undefined>)[method];
      const pending = this.queue(method, values);
      if (pending.index >= pending.queue.length) {
        throw new Error(`Gateway exhausto: ${method} fue llamado más veces de las declaradas en el paso.`);
      }
      const value = pending.queue[pending.index];
      pending.index += 1;
      outcome = method === "qusdBalance" || method === "listOffers"
        ? { ok: value }
        : (value as GatewayOutcome);
    }
    this.upstream.push(this.describeCall(method, args, outcome.ok));
    const scripted = outcome;
    if (scripted.error) {
      const message = scripted.error.message ?? `Fallo guionizado de ${method}.`;
      if (scripted.error.kind === "uncertain") throw new QvaMutationUncertainError(method, new Error(message));
      if (scripted.error.kind === "api") throw new QvaApiError(scripted.error.status ?? 400, message);
      throw new Error(message);
    }
    if (!Object.hasOwn(scripted, "ok")) {
      throw new Error(`Gateway ${method}: el guion debe declarar "ok" o "error".`);
    }
    return this.materialize(method, scripted.ok);
  }

  private materialize(method: string, value: unknown): unknown {
    if (method === "listOffers" && Array.isArray(value)) {
      return value.map((offer, index) => parseOffer(offer, `gateway.listOffers[${index}]`));
    }
    if (method === "getOffer") return parseOffer(value, "gateway.getOffer");
    if (method === "createOffer" || method === "editOffer") {
      return value && typeof value === "object" ? parseOffer(value, `gateway.${method}`) : value;
    }
    if (method === "qusdBalance") return numeric(value, "gateway.qusdBalance");
    return value;
  }

  private describeCall(method: string, args: unknown[], ok: unknown): Record<string, unknown> {
    const call: Record<string, unknown> = { method };
    if (method === "qusdBalance") {
      call.options = { priority: Boolean((args[0] as { priority?: boolean } | undefined)?.priority) };
      return call;
    }
    if (method === "listOffers") {
      const options = (args[0] ?? {}) as Record<string, unknown>;
      call.query = {
        my: Boolean(options.my),
        take: options.take ?? null,
        page: options.page ?? null,
        status: options.status ?? null,
      };
      return call;
    }
    if (method === "getOffer") {
      call.uuid = String(args[0] ?? "");
      return call;
    }
    if (method === "apply") {
      const options = (args[1] ?? {}) as Record<string, unknown>;
      call.uuid = String(args[0] ?? "");
      if (options.amount !== undefined) call.amount = fixed(numeric(options.amount, "apply.amount"));
      call.optionsHash = canonicalHash({ amount: options.amount ?? null });
    } else if (["cancel", "markPaid", "confirmReceived", "editOffer"].includes(method)) {
      call.uuid = String(args[0] ?? "");
    } else if (method === "createOffer") {
      const body = (args[0] ?? {}) as Record<string, unknown>;
      call.requestHash = canonicalHash(this.normalizeBody(body));
      if (body.amount !== undefined) call.amount = fixed(numeric(body.amount, "createOffer.amount"));
      if (body.receive !== undefined) call.receive = fixed(numeric(body.receive, "createOffer.receive"));
    } else {
      call.argsHash = canonicalHash(args);
    }
    call.responseHash = canonicalHash(ok ?? null);
    return call;
  }

  /**
   * La clave de idempotencia de reposición es `sha256("restore:<workflowId>:
   * <offerUuid>")`: contiene un UUID generado por el oráculo y se calcula
   * antes de que el workflow tenga referencia normalizada. Se sustituye por un
   * marcador estable para que la traza no dependa del UUID; la forma de la
   * clave (SHA-256 hex) se valida aparte y el estado del intent se compara en
   * el `stateDigest`.
   */
  private normalizeBody(body: Record<string, unknown>): Record<string, unknown> {
    if (typeof body.idempotencyKey !== "string") return body;
    const valid = /^[0-9a-f]{64}$/.test(body.idempotencyKey);
    return {
      ...body,
      idempotencyKey: valid ? "<sha256>" : "<invalid>",
    };
  }

  private resetStep(gateway: GatewayScript | undefined) {    this.currentGateway = gateway ?? {};
    this.pending = new Map();
    this.upstream = [];
  }

  async step(op: string, input: ReplayStepInput): Promise<ReplayStepResult> {
    if (this.closed) throw new Error("La sesión de replay está cerrada.");
    if (op !== "market.ingest") this.stepIndex += 1;
    this.resetStep(input.gateway);
    let result: unknown;
    switch (op) {
      case "market.ingest":
        result = this.ingest(input);
        break;
      case "trading.decide":
        result = await this.decide(input);
        break;
      case "trading.reconcile":
        result = await this.reconcile(input);
        break;
      case "trading.state":
        result = this.snapshot();
        break;
      default:
        throw new Error(`Operación de replay desconocida: ${op}`);
    }
    return { result, upstream: this.upstream, stateDigest: this.digest() };
  }

  private ingest(input: ReplayStepInput): unknown {
    if (!input.events?.length) throw new Error("market.ingest requiere events[].");
    let accepted = 0;
    let duplicates = 0;
    for (const event of input.events) {
      const payload = event.payload as {
        event?: string;
        sent_at?: string;
        data?: { uuid?: string; updated_at?: string; available_amount?: number };
      };
      if (!payload?.data?.uuid || typeof payload.sent_at !== "string") {
        throw new Error("Evento de feed inválido: falta payload.data.uuid o payload.sent_at.");
      }
      const normalized = {
        event: event.event,
        payload: { ...payload, event: payload.event ?? event.event, data: payload.data },
      };
      const key = feedKey(normalized, event.key);
      const receivedAt = event.receivedAt ?? this.now();
      const inserted = this.store.enqueueMarketFeedEvent({
        key,
        event: event.event,
        payload: normalized.payload,
        state: event.state ?? "pending",
        receivedAt,
      });
      if (inserted) {
        accepted += 1;
        this.acceptedFeed.push({ key, event: event.event, state: event.state ?? "pending", receivedAt });
      } else {
        duplicates += 1;
      }
    }
    if (input.observation) {
      this.observations.push(this.normalizeObservation(input.observation));
    }
    return {
      accepted,
      duplicates,
      pending: this.acceptedFeed.filter((event) => event.state === "pending").length,
      observations: this.observations.length,
    };
  }

  private normalizeObservation(observation: ReplayStepInput["observation"]): Record<string, unknown> {
    if (!observation) throw new Error("Observación vacía.");
    const output: Record<string, unknown> = { coin: observation.coin, openOffers: observation.openOffers, eligible: observation.eligible };
    for (const field of ["averageBuy", "averageSell", "medianBuy", "medianSell", "bestBuy", "bestSell"] as const) {
      const value = optionalNumeric(observation[field], `observation.${field}`);
      if (value !== undefined) output[field] = fixed(value);
    }
    return output;
  }

  private async decide(input: ReplayStepInput): Promise<unknown> {
    if (input.target === undefined) throw new Error("trading.decide requiere target.");
    const target = parseOffer(input.target, "target");
    const resolved = await this.orchestrator.execute({
      target,
      referenceRate: numeric(input.referenceRate, "referenceRate"),
      expectedMarginPercent: numeric(input.expectedMarginPercent, "expectedMarginPercent"),
      priceDecision: (input.priceDecision ?? "eligible") as never,
      priceReason: input.priceReason ?? "",
      automatic: input.automatic ?? true,
    });
    const workflow = resolved.workflow;
    const ref = workflow ? this.workflowRef(workflow.id) : null;
    return {
      decision: this.decision(resolved.decision),
      workflow: workflow
        ? {
            state: workflow.state,
            error: workflow.error ? normalizeText(workflow.error, this.ids) : null,
          }
        : null,
      applicationConfirmed: Boolean(resolved.applicationConfirmed),
      ...(ref ? { workflowRef: ref } : {}),
    };
  }

  private reconcile(input: ReplayStepInput): Promise<unknown> {
    const ref = input.workflow;
    if (!ref) throw new Error("trading.reconcile requiere workflow (referencia normalizada).");
    const workflowId = this.workflowByRef.get(ref);
    if (!workflowId) throw new Error(`Workflow desconocido en la sesión: ${ref}`);
    return this.orchestrator.reconcile(workflowId).then((resolved) => ({
      outcome: resolved.outcome,
      detail: normalizeText(resolved.detail, this.ids),
    }));
  }

  private workflowRef(id: string): string {
    const existing = this.workflowIds.get(id);
    if (existing) return existing;
    const ref = `wf-${this.workflowRefs.length + 1}`;
    this.workflowRefs.push(id);
    this.workflowIds.set(id, ref);
    this.workflowByRef.set(ref, id);
    this.ids.set(id.toLowerCase(), ref);
    return ref;
  }

  private intentRef(intentId: string): string {
    const existing = this.intentRefs.get(intentId);
    if (existing) return existing;
    const ref = `intent-${this.intentRefs.size + 1}`;
    this.intentRefs.set(intentId, ref);
    this.ids.set(intentId.toLowerCase(), ref);
    return ref;
  }

  private decision(decision: {
    kind: string;
    opportunityUuid: string;
    evaluatedAt: number;
    requiredQusd: number;
    requiredFiat: number;
    projectedExposureQusd: number;
    projectedDailyAppliedQusd: number;
    checks: Array<{ code: string; status: string; actual?: unknown; limit?: unknown; reason: string }>;
    reasons: string[];
  }): Record<string, unknown> {
    return {
      kind: decision.kind,
      opportunityUuid: decision.opportunityUuid,
      evaluatedAt: decision.evaluatedAt,
      requiredQusd: fixed(decision.requiredQusd),
      requiredFiat: fixed(decision.requiredFiat),
      projectedExposureQusd: fixed(decision.projectedExposureQusd),
      projectedDailyAppliedQusd: fixed(decision.projectedDailyAppliedQusd),
      checks: decision.checks.map((check) => ({
        code: check.code,
        status: check.status,
        ...(check.actual !== undefined ? { actual: this.scalar(check.actual) } : {}),
        ...(check.limit !== undefined ? { limit: this.scalar(check.limit) } : {}),
        reason: normalizeText(check.reason, this.ids),
      })),
      reasons: decision.reasons.map((reason) => normalizeText(reason, this.ids)),
    };
  }

  private scalar(value: unknown): unknown {
    if (typeof value === "number") return Number.isInteger(value) ? value : fixed(value, 4);
    if (typeof value === "string") return normalizeText(value, this.ids);
    return value;
  }

  private snapshot(): Record<string, unknown> {
    const operations = this.store.operations(100)
      .map((operation) => ({
        uuid: operation.uuid,
        offerType: operation.offerType,
        coin: operation.coin,
        amount: fixed(operation.amount),
        receive: fixed(operation.receive),
        rate: fixed(operation.rate),
        state: operation.state,
        autoApplied: Boolean(operation.autoApplied),
        orderUuid: operation.orderUuid ?? null,
      }))
      .sort((left, right) => left.uuid.localeCompare(right.uuid));

    const workflows = this.workflowRefs
      .map((id) => {
        const workflow = this.store.getTradeWorkflow(id);
        if (!workflow) return null;
        return {
          ref: this.workflowIds.get(id)!,
          state: workflow.state,
          error: workflow.error ? normalizeText(workflow.error, this.ids) : null,
        };
      })
      .filter((entry): entry is NonNullable<typeof entry> => entry !== null)
      .sort((left, right) => left.ref.localeCompare(right.ref));

    const ownOffers = this.workflowRefs
      .flatMap((id) => this.store.workflowOwnOffers(id))
      .map((own) => ({
        workflow: this.workflowIds.get(own.workflowId)!,
        originalUuid: own.originalUuid,
        state: own.state,
        restoredUuid: own.restoredUuid,
        error: own.error ? normalizeText(own.error, this.ids) : null,
      }))
      .sort((left, right) => `${left.workflow}:${left.originalUuid}`.localeCompare(`${right.workflow}:${right.originalUuid}`));

    const intents = this.store.recentMutationIntents(100)
      .map((intent) => ({
        intent,
        kind: intent.kind,
        state: intent.state,
        operationUuid: intent.operationUuid ?? null,
        workflow: intent.workflowId ? this.workflowIds.get(intent.workflowId) ?? "external" : null,
        error: intent.error ? normalizeText(intent.error, this.ids) : null,
      }))
      .sort((left, right) =>
        `${left.kind}:${left.state}:${left.operationUuid ?? ""}:${left.workflow ?? ""}:${left.error ?? ""}`
          .localeCompare(`${right.kind}:${right.state}:${right.operationUuid ?? ""}:${right.workflow ?? ""}:${right.error ?? ""}`))
      .map((entry) => ({
        ref: this.intentRef(entry.intent.intentId),
        kind: entry.kind,
        state: entry.state,
        operationUuid: entry.operationUuid,
        workflow: entry.workflow,
        error: entry.error,
      }));

    return {
      operations,
      reservedQusd: fixed(this.store.activeReservedQusd()),
      workflows,
      ownOffers,
      intents,
      feed: [...this.acceptedFeed]
        .sort((left, right) => left.key.localeCompare(right.key))
        .map((event) => ({ ...event })),
      observations: this.observations.map((observation) => ({ ...observation })),
    };
  }

  private digest(): string {
    const digest = createHash("sha256").update(JSON.stringify(this.snapshot())).digest("hex");
    return `sha256:${digest}`;
  }

  close(): { stateDigest: string } {
    if (this.closed) return { stateDigest: this.digest() };
    const stateDigest = this.digest();
    this.closed = true;
    try {
      this.store.close();
    } finally {
      rmSync(this.dir, { recursive: true, force: true });
    }
    return { stateDigest };
  }
}

export interface ReplayScenario {
  session: ReplaySessionSpec;
  steps: Array<{ op: string; input: ReplayStepInput }>;
}

export interface ReplayRun {
  startStateDigest: string;
  steps: Array<{ result: unknown; upstream: Array<Record<string, unknown>>; stateDigest: string }>;
  finalStateDigest: string;
}

/** Ejecuta un escenario completo; el generador usa el mismo motor que el SUT. */
export async function runScenario(scenario: ReplayScenario): Promise<ReplayRun> {
  const session = ReplaySession.start(scenario.session);
  try {
    const startStateDigest = (await session.step("trading.state", {})).stateDigest;
    const steps: ReplayRun["steps"] = [];
    for (const step of scenario.steps) steps.push(await session.step(step.op, step.input));
    const finalStateDigest = (await session.step("trading.state", {})).stateDigest;
    return { startStateDigest, steps, finalStateDigest };
  } finally {
    session.close();
  }
}
