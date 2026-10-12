import type { MutationIntent, Operation, Store } from "./store.js";
import type { TradingService } from "./trading.js";
import { ReconciliationScheduler } from "./reconciliation-scheduler.js";

export type RecoveryActor = "admin_web" | "admin_telegram";

export type ManualRecoveryOutcome = "not_applied" | "cancelled" | "terminal_reviewed";

interface RecoveryFeedEvidence {
  event: string;
  status: string;
  sentAt: number;
  receivedAt: number;
}

export interface RecoveryRetryView {
  attempts: number;
  nextAttemptAt: number | null;
  eligible: boolean;
}

export interface RecoveryLastCheck {
  checkedAt: number;
  error?: string;
}

export interface RecoveryItem {
  intentId: string;
  kind: string;
  state: MutationIntent["state"];
  operationUuid?: string;
  workflowId?: string;
  createdAt: number;
  updatedAt: number;
  error?: string;
  lastCheck?: RecoveryLastCheck;
  operation?: Pick<Operation, "uuid" | "state" | "coin" | "offerType" | "amount" | "receive">;
  feed?: RecoveryFeedEvidence;
  retry: RecoveryRetryView;
  acknowledged: boolean;
  evidence: Array<{ text: string; actor: RecoveryActor; at: number }>;
  manualEligible: boolean;
  manualOutcomes: ManualRecoveryOutcome[];
  manualBlockedReason?: string;
}

export interface RecoveryList {
  items: RecoveryItem[];
  blocked: boolean;
}

export interface RecoveryCheckReport {
  intentId: string;
  checkedAt: number;
  outcome: "reconciled" | "pending" | "workflow_review_required" | "not_pending";
  state: MutationIntent["state"];
  updatedAt: number;
  message: string;
  error?: string;
  retry: RecoveryRetryView;
}

export interface RecoveryResolveReport {
  intentId: string;
  outcome: ManualRecoveryOutcome;
  state: MutationIntent["state"];
  updatedAt: number;
  actor: RecoveryActor;
  verifiedAt: number;
}

export class RecoveryConflictError extends Error {
  constructor(message: string, readonly status = 409) {
    super(message);
  }
}

export class RecoveryInputError extends Error {
  readonly status = 400;
}

interface RecoveryStore extends Store {
  getMutationIntent(intentId: string): MutationIntent | undefined;
  hasFiatMovement(uuid: string): boolean;
  hasMarketFeedHistory(uuid: string): boolean;
  resolveMutationIntentCAS(
    intentId: string,
    expectedUpdatedAt: number,
    response: Record<string, unknown>,
  ): boolean;
}

export class SelfServiceRecovery {
  private readonly retry: ReconciliationScheduler;

  constructor(
    private readonly store: RecoveryStore,
    private readonly trading: Pick<TradingService, "reconcilePendingStandaloneMutations"> & Partial<Pick<TradingService, "isReconciliationInFlight">>,
    private readonly now: () => number = Date.now,
    private readonly actor: RecoveryActor = "admin_web",
  ) {
    this.retry = new ReconciliationScheduler(store);
  }

  list(): RecoveryList {
    const items = this.store.unresolvedMutationIntents()
      .map((intent) => this.item(intent));
    return { items, blocked: this.store.hasUnresolvedMutation() };
  }

  recordEvidence(intentId: string, text: string): RecoveryItem {
    const intent = this.requireIntent(intentId);
    text = text.trim();
    if (text.length < 12 || text.length > 1000) throw new RecoveryInputError("La evidencia debe tener entre 12 y 1.000 caracteres.");
    const entries = [...this.evidence(intentId), { text, actor: this.actor, at: this.now() }];
    this.store.set(`recovery_evidence:${intentId}`, JSON.stringify(entries));
    this.store.audit("recovery_evidence_recorded", `${this.actor}: ${text}`, intent.operationUuid);
    return this.item(intent);
  }

  acknowledge(intentId: string): RecoveryItem {
    const intent = this.requireIntent(intentId);
    this.store.set(`recovery_ack:${intentId}`, String(intent.updatedAt));
    this.store.acknowledgeNotification(`recovery-blocked:${intentId}`);
    this.store.audit("recovery_notice_acknowledged", `${this.actor} reconoció el aviso ${intentId}; la comprobación continúa.`, intent.operationUuid);
    return this.item(intent);
  }

  private evidence(intentId: string): Array<{ text: string; actor: RecoveryActor; at: number }> {
    try { return JSON.parse(this.store.get(`recovery_evidence:${intentId}`) ?? "[]"); }
    catch { return []; }
  }

  async check(intentId: string): Promise<RecoveryCheckReport> {
    const intent = this.requireIntent(intentId);
    const checkedAt = this.now();
    if (intent.workflowId) {
      const workflow = this.store.getTradeWorkflow(intent.workflowId);
      this.store.audit(
        "self_service_recovery_checked",
        `${this.actor} consultó intención ${intentId}; workflow ${workflow?.id ?? intent.workflowId} requiere revisión; no se ejecutaron compensaciones.`,
        intent.operationUuid,
      );
      return {
        intentId,
        checkedAt,
        outcome: "workflow_review_required",
        state: intent.state,
        updatedAt: intent.updatedAt,
        message: workflow
          ? `Workflow ${workflow.id} en estado ${workflow.state}; esta comprobación no ejecuta compensaciones.`
          : "La intención pertenece a un workflow; no se ejecutó ninguna compensación.",
        retry: this.retryView(intentId, checkedAt),
      };
    }
    if (intent.state !== "submitted" && intent.state !== "uncertain") {
      this.store.audit(
        "self_service_recovery_checked",
        `${this.actor} consultó intención ${intentId}, que ya estaba en estado ${intent.state}.`,
        intent.operationUuid,
      );
      return {
        intentId,
        checkedAt,
        outcome: "not_pending",
        state: intent.state,
        updatedAt: intent.updatedAt,
        message: "La intención ya no está pendiente de conciliación.",
        retry: this.retryView(intentId, checkedAt),
      };
    }

    const nextManualCheck = Number(this.store.get("recovery_manual_check_next_at") ?? 0);
    if (Number.isFinite(nextManualCheck) && nextManualCheck > checkedAt)
      throw new RecoveryConflictError("Espera unos segundos antes de solicitar otra comprobación remota.", 429);
    this.store.set("recovery_manual_check_next_at", String(checkedAt + 10_000));
    await this.trading.reconcilePendingStandaloneMutations({ intentId, force: true });
    const current = this.store.getMutationIntent(intentId) ?? intent;
    const reconciled = current.state === "reconciled";
    if (reconciled)
      this.store.set(`reconciliation_last_check:${intentId}`, JSON.stringify({ checkedAt }));
    const lastCheck = this.lastCheck(intentId);
    this.store.audit(
      "self_service_recovery_checked",
      `${this.actor} comprobó la intención ${intentId}: ${reconciled ? "reconciliada" : "pendiente"}. No se repitió la mutación.`,
      current.operationUuid,
    );
    return {
      intentId,
      checkedAt,
      outcome: reconciled ? "reconciled" : "pending",
      state: current.state,
      updatedAt: current.updatedAt,
      message: reconciled
        ? "QvaPay o la evidencia persistida confirmó el resultado; no se repitió la mutación."
        : "No se obtuvo evidencia concluyente. Esta oferta sigue excluida de nuevas aplicaciones mientras continúan las demás cacerías.",
      ...(lastCheck?.error || current.error ? { error: lastCheck?.error ?? current.error } : {}),
      ...(lastCheck ? { lastCheck } : {}),
      retry: this.retryView(intentId, checkedAt),
    };
  }

  resolveManual(input: {
    intentId: string;
    expectedUpdatedAt: number;
    outcome: ManualRecoveryOutcome;
    reason: string;
    evidence: string;
    confirmed: true;
  }): RecoveryResolveReport {
    const intent = this.requireIntent(input.intentId);
    const reason = input.reason.trim();
    const evidence = input.evidence.trim();
    if (!["not_applied", "cancelled", "terminal_reviewed"].includes(input.outcome))
      throw new RecoveryInputError("El resultado manual no es válido.");
    if (input.confirmed !== true)
      throw new RecoveryInputError("Debes confirmar la revisión realizada en QvaPay.");
    if (!Number.isSafeInteger(input.expectedUpdatedAt) || input.expectedUpdatedAt !== intent.updatedAt)
      throw new RecoveryConflictError("La intención cambió; actualiza la lista antes de resolverla.");
    if (reason.length < 12 || reason.length > 500)
      throw new RecoveryInputError("La explicación debe tener entre 12 y 500 caracteres.");
    if (evidence.length < 12 || evidence.length > 1_000)
      throw new RecoveryInputError("La evidencia consultada en QvaPay debe tener entre 12 y 1.000 caracteres.");
    const manualBlockedReason = this.manualBlockedReason(intent);
    if (manualBlockedReason)
      throw new RecoveryConflictError(manualBlockedReason);
    const feed = this.store.latestMarketFeedState(intent.operationUuid!);
    if (feed?.status === "completed" && input.outcome !== "terminal_reviewed")
      throw new RecoveryConflictError("La oferta terminó: declara únicamente la revisión de una obligación ya cerrada en tu cuenta.");
    if (feed?.status !== "completed" && input.outcome === "terminal_reviewed")
      throw new RecoveryConflictError("Solo se puede revisar como terminal una oferta completada con evidencia del feed.");
    if (input.outcome === "cancelled" && feed?.status === "open")
      throw new RecoveryConflictError("El feed muestra la oferta abierta: no se puede declarar cancelada. Comprueba si la aplicación no se realizó.");

    const verifiedAt = this.now();
    const response = {
      source: "operator_attestation",
      actor: this.actor,
      outcome: input.outcome,
      reason,
      evidence,
      verifiedAt,
      operatorConfirmed: true,
    };
    if (!this.store.resolveMutationIntentCAS(intent.intentId, input.expectedUpdatedAt, response))
      throw new RecoveryConflictError("La intención cambió durante la resolución; actualiza la lista.");
    this.retry.clear(intent.intentId);
    this.store.set(`reconciliation_last_check:${intent.intentId}`, "");

    const current = this.store.getMutationIntent(intent.intentId);
    if (!current) throw new Error("La intención ya no está disponible después de resolverla.");
    return {
      intentId: current.intentId,
      outcome: input.outcome,
      state: current.state,
      updatedAt: current.updatedAt,
      actor: this.actor,
      verifiedAt,
    };
  }

  private item(intent: MutationIntent): RecoveryItem {
    const uuid = intent.operationUuid;
    const operation = uuid ? this.store.getOperation(uuid) : undefined;
    const feed = uuid && !(intent.request && typeof intent.request === "object" && "offerKind" in intent.request && intent.request.offerKind === "flexible") ? this.store.latestMarketFeedState(uuid) : undefined;
    const lastCheck = this.lastCheck(intent.intentId);
    const manualBlockedReason = this.manualBlockedReason(intent, operation, feed);
    return {
      intentId: intent.intentId,
      kind: intent.kind,
      state: intent.state,
      ...(uuid ? { operationUuid: uuid } : {}),
      ...(intent.workflowId ? { workflowId: intent.workflowId } : {}),
      createdAt: intent.createdAt,
      updatedAt: intent.updatedAt,
      ...(lastCheck?.error || intent.error ? { error: lastCheck?.error ?? intent.error } : {}),
      ...(lastCheck ? { lastCheck } : {}),
      ...(operation ? { operation: safeOperation(operation) } : {}),
      ...(feed ? { feed } : {}),
      retry: this.retryView(intent.intentId, this.now()),
      acknowledged: this.store.get(`recovery_ack:${intent.intentId}`) === String(intent.updatedAt),
      evidence: this.evidence(intent.intentId),
      manualEligible: !manualBlockedReason,
      manualOutcomes: feed?.status === "completed" ? ["terminal_reviewed"] : feed?.status === "open" ? ["not_applied"] : ["not_applied", "cancelled"],
      ...(manualBlockedReason ? { manualBlockedReason } : {}),
    };
  }

  private manualBlockedReason(
    intent: MutationIntent,
    operation = intent.operationUuid ? this.store.getOperation(intent.operationUuid) : undefined,
    feed = intent.operationUuid ? this.store.latestMarketFeedState(intent.operationUuid) : undefined,
  ): string | undefined {
    if (this.trading.isReconciliationInFlight?.(intent.intentId))
      return "Hay una comprobación remota en curso; espera su resultado antes de revisar manualmente.";
    if (intent.state !== "uncertain") return "Solo se puede declarar una intención incierta.";
    if (intent.kind !== "apply") return "La resolución manual solo admite una aplicación independiente.";
    if (intent.request && typeof intent.request === "object" && "offerKind" in intent.request && intent.request.offerKind === "flexible")
      return "La orden flexible requiere comprobar su estado en QvaPay. Puedes registrar evidencia y reconocer el aviso mientras se verifica.";
    if (!intent.operationUuid) return "La intención no tiene UUID de oferta para verificar.";
    if (intent.workflowId || this.store.findWorkflowByTarget(intent.operationUuid))
      return "La intención pertenece a un workflow compensable; requiere conciliación del workflow.";
    if (operation && operation.state !== "cancelled")
      return `Existe una operación local en estado ${operation.state}; la declaración manual no puede resolverla.`;
    if (this.store.hasFiatMovement(intent.operationUuid))
      return "Existe un movimiento fiat asociado; requiere conciliación financiera.";
    if (!feed && this.store.hasMarketFeedHistory(intent.operationUuid))
      return "El historial del feed es ambiguo y no permite una declaración manual segura.";
    if (feed) {
      if (feed.sentAt > this.now() || feed.receivedAt > this.now())
        return "La evidencia del feed tiene fecha futura y no es confiable.";
      if (feed.status === "completed" && (feed.event !== "p2p.completed" || feed.sentAt < intent.createdAt || feed.receivedAt < intent.createdAt))
        return "La finalización del feed no es posterior a esta intención; requiere conciliación remota.";
      if (!["open", "cancelled", "completed"].includes(feed.status) || feed.event === "p2p.applied")
        return `El feed más reciente muestra estado ${feed.status}; existe evidencia remota que impide una declaración manual.`;
    }
    return undefined;
  }

  private retryView(intentId: string, now: number): RecoveryRetryView {
    const status = this.retry.getStatus(intentId);
    if (status) {
      return {
        attempts: status.attempts,
        nextAttemptAt: status.nextAttemptAt,
        eligible: status.nextAttemptAt <= now,
      };
    }
    return { attempts: 0, nextAttemptAt: null, eligible: true };
  }

  private lastCheck(intentId: string): RecoveryLastCheck | undefined {
    const raw = this.store.get(`reconciliation_last_check:${intentId}`);
    if (!raw) return undefined;
    try {
      const value = JSON.parse(raw) as { checkedAt?: unknown; error?: unknown };
      if (!Number.isSafeInteger(value.checkedAt)) return undefined;
      return {
        checkedAt: Number(value.checkedAt),
        ...(typeof value.error === "string" && value.error ? { error: value.error.slice(0, 400) } : {}),
      };
    } catch {
      return undefined;
    }
  }

  private requireIntent(intentId: string): MutationIntent {
    if (!intentId || intentId.length > 200)
      throw new RecoveryInputError("El identificador de intención no es válido.");
    const intent = this.store.getMutationIntent(intentId);
    if (!intent) throw new RecoveryConflictError("No se encontró la intención solicitada.", 404);
    return intent;
  }
}

function safeOperation(operation: Operation): NonNullable<RecoveryItem["operation"]> {
  return {
    uuid: operation.uuid,
    state: operation.state,
    coin: operation.coin,
    offerType: operation.offerType,
    amount: operation.amount,
    receive: operation.receive,
  };
}
