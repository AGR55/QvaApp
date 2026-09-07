import { randomUUID } from "node:crypto";
import {
  planLiquidity,
  type RestorableOwnOffer,
} from "../core/liquidity-plan.js";
import {
  evaluateRisk,
  type RiskDecision,
  type RiskDecisionKind,
} from "../core/risk-policy.js";
import type { QvaPayGateway } from "../core/ports.js";
import type { MarketConfigService } from "../market-config.js";
import { QvaApiError, QvaMutationUncertainError } from "../qvapay.js";
import type { Store, TradeWorkflow } from "../store.js";
import type { P2pOffer } from "../types.js";

export interface OpportunityInput {
  target: P2pOffer;
  referenceRate: number;
  expectedMarginPercent: number;
  priceDecision: "eligible" | "manual_review" | "blocked" | "ignored";
  priceReason: string;
}

export interface OpportunityResult {
  decision: RiskDecision;
  workflow?: TradeWorkflow;
}

export interface ReconciliationResult {
  workflowId: string;
  outcome: "applied" | "restored" | "unresolved";
  detail: string;
}

export interface OrchestratorRuntime {
  now?: () => number;
  notify?: (message: string) => Promise<void>;
}

/**
 * Owns the complete cancel/apply/restore use case. Entry adapters must never
 * reproduce this ordering themselves.
 */
export class OpportunityOrchestrator {
  private readonly now: () => number;
  private readonly notify: (message: string) => Promise<void>;
  private inFlight: Promise<OpportunityResult> | undefined;

  constructor(
    private readonly store: Store,
    private readonly qva: QvaPayGateway,
    private readonly config: MarketConfigService,
    runtime: OrchestratorRuntime = {},
  ) {
    this.now = runtime.now ?? Date.now;
    this.notify = runtime.notify ?? (async () => undefined);
  }

  execute(input: OpportunityInput): Promise<OpportunityResult> {
    if (this.inFlight) return this.inFlight;
    const execution = this.executeOnce(input);
    this.inFlight = execution;
    return execution.finally(() => {
      if (this.inFlight === execution) this.inFlight = undefined;
    });
  }

  async reconcilePending(): Promise<ReconciliationResult[]> {
    const results: ReconciliationResult[] = [];
    for (const workflow of this.store.recoverableWorkflows())
      results.push(await this.reconcile(workflow.id));
    return results;
  }

  async reconcile(workflowId: string): Promise<ReconciliationResult> {
    const workflow = this.store.getTradeWorkflow(workflowId);
    if (!workflow) throw new Error("El flujo de operación no existe.");
    if (["applied", "restored", "blocked"].includes(workflow.state)) {
      return {
        workflowId,
        outcome: workflow.state === "applied" ? "applied" : "restored",
        detail: "El flujo ya estaba cerrado.",
      };
    }

    this.store.updateWorkflowState(workflowId, "reconciling");
    try {
      const remoteTarget = await this.qva.getOffer(workflow.targetOffer.uuid);
      if (applicationIsConfirmed(remoteTarget.status)) {
        this.ensureAppliedOperation(workflow);
        this.store.updateWorkflowState(workflowId, "applied");
        this.store.releaseCapitalReservation(workflowId);
        this.store.reconcileWorkflowMutationIntents(workflowId);
        this.store.audit(
          "workflow_reconciled_applied",
          `QvaPay confirmó el estado remoto ${remoteTarget.status}.`,
          workflow.targetOffer.uuid,
        );
        return {
          workflowId,
          outcome: "applied",
          detail: `Aplicación confirmada en estado ${remoteTarget.status}.`,
        };
      }
      if (!applicationIsAbsent(remoteTarget.status))
        return this.keepUnresolved(
          workflow,
          `Estado remoto no concluyente: ${remoteTarget.status}.`,
        );

      const ownOffers = await this.qva.listOffers({
        my: true,
        take: 100,
        page: 1,
        status: "open",
      });
      const openOwnIds = new Set(ownOffers.map((offer) => offer.uuid));
      for (const own of this.store.workflowOwnOffers(workflowId)) {
        if (own.state === "restored" || openOwnIds.has(own.originalUuid))
          continue;
        if (own.state === "uncertain" || own.state === "cancel_requested") {
          const remoteOwn = await this.qva.getOffer(own.originalUuid);
          if (remoteOwn.status === "open") continue;
          if (remoteOwn.status !== "cancelled")
            return this.keepUnresolved(
              workflow,
              `La oferta propia ${own.originalUuid} está en estado ${remoteOwn.status}.`,
            );
          this.store.updateWorkflowOwnOffer(
            workflowId,
            own.originalUuid,
            "cancelled",
          );
        }
      }
      await this.restoreCancelledOffers(workflowId);
      this.store.releaseCapitalReservation(workflowId);
      this.store.reconcileWorkflowMutationIntents(workflowId);
      this.store.audit(
        "workflow_reconciled_restored",
        "QvaPay confirmó que no se aplicó; se repuso la liquidez propia.",
        workflow.targetOffer.uuid,
      );
      return {
        workflowId,
        outcome: "restored",
        detail: "Aplicación descartada y ofertas propias repuestas.",
      };
    } catch (error) {
      return this.keepUnresolved(workflow, errorMessage(error));
    }
  }

  private async executeOnce(input: OpportunityInput): Promise<OpportunityResult> {
    const existing = this.store.findWorkflowByTarget(input.target.uuid);
    if (existing) return { decision: existing.riskDecision, workflow: existing };
    if (input.target.type !== "buy" || input.target.status !== "open")
      return {
        decision: this.nonExecutableDecision(input, "ignored", "La oferta no es una compra externa abierta."),
      };
    const market = this.config.find(input.target.coin);
    if (!market || !market.active)
      return {
        decision: this.nonExecutableDecision(input, "blocked", "El mercado no está activo o configurado."),
      };

    const [qusdBalance, ownOffers] = await Promise.all([
      this.qva.qusdBalance(),
      this.qva.listOffers({ my: true, take: 100, page: 1, status: "open" }),
    ]);
    const current = this.config.current();
    const liquidity = planLiquidity({
      target: input.target,
      availableQusd: qusdBalance,
      reserveQusd: current.risk.minQusdReserve,
      ownOffers,
    });
    const priceDecision =
      current.risk.reviewedAt === null && input.priceDecision === "eligible"
        ? "manual_review"
        : input.priceDecision;
    const now = this.now();
    const decision = evaluateRisk({
      now,
      opportunity: {
        uuid: input.target.uuid,
        market: input.target.coin,
        side: "sell_qusd",
        qusdAmount: input.target.amount,
        requiredFiat: 0,
        quotedRate: input.target.receive / input.target.amount,
        referenceRate: input.referenceRate,
        observedAt: offerTimestamp(input.target, now),
        ...(input.target.User?.uuid
          ? { counterpartyId: input.target.User.uuid }
          : {}),
      },
      limits: current.risk,
      priceDecision: liquidity.feasible ? priceDecision : "blocked",
      priceReason: liquidity.feasible
        ? current.risk.reviewedAt === null && input.priceDecision === "eligible"
          ? "Los límites globales todavía no han sido revisados desde el panel."
          : input.priceReason
        : liquidity.reason,
      expectedMarginPercent: input.expectedMarginPercent,
      qusdBalance: qusdBalance + liquidity.plannedReleaseQusd,
      fiatAvailable: market.fiatBalance,
      concurrentQusdExposure:
        this.store.activeOperations().reduce((sum, operation) => sum + operation.amount, 0) +
        this.store.activeReservedQusd(),
      dailyAppliedQusd: this.store.dailyAppliedQusd(startOfDay(now)),
      activeOperations: this.store.activeOperations().length,
      consecutiveErrors: Number(this.store.get("consecutive_errors") ?? 0),
      paused: this.store.get("paused") !== "false",
      emergencyStop: this.store.get("emergency_stop") === "true",
      hasUnresolvedMutation: this.store.hasUnresolvedMutation(),
      ...riskCooldowns(
        this.store,
        input.target.coin,
        input.target.User?.uuid,
      ),
    });
    if (decision.kind !== "apply") return { decision };

    const workflowId = randomUUID();
    this.store.createTradeWorkflow(
      { id: workflowId, targetOffer: input.target, riskDecision: decision },
      liquidity.cancel,
    );
    if (
      !this.store.reserveQusd(
        workflowId,
        input.target.coin,
        input.target.amount,
        current.risk.maxConcurrentQusdExposure,
      )
    ) {
      this.store.updateWorkflowState(
        workflowId,
        "blocked",
        "El capital fue reservado por otra operación concurrente.",
      );
      const blockedWorkflow = this.store.getTradeWorkflow(workflowId);
      if (!blockedWorkflow)
        throw new Error("No se pudo persistir el flujo bloqueado.");
      return {
        decision: this.blockDecision(
          decision,
          "El capital fue reservado por otra operación concurrente.",
        ),
        workflow: blockedWorkflow,
      };
    }
    this.store.updateWorkflowState(workflowId, "capital_reserved");
    try {
      await this.cancelOwnOffers(workflowId);
      this.store.updateWorkflowState(workflowId, "own_offers_cancelled");
      this.store.updateWorkflowState(workflowId, "applying_external");
      await this.mutation("apply", input.target.uuid, { workflowId }, () =>
        this.qva.apply(input.target.uuid),
      );
      this.store.createOperation({
        uuid: input.target.uuid,
        offerType: "buy",
        coin: input.target.coin,
        amount: input.target.amount,
        receive: input.target.receive,
        rate: input.target.receive / input.target.amount,
        state: "applied",
        autoApplied: true,
        cancelAt: null,
        createdAt: this.now(),
        ...(input.target.User?.uuid
          ? { counterpartyId: input.target.User.uuid }
          : {}),
      });
      this.store.updateWorkflowState(workflowId, "applied");
      this.store.releaseCapitalReservation(workflowId);
      this.store.audit(
        "opportunity_applied",
        "Aplicación automática confirmada; el pago fiat permanece manual.",
        input.target.uuid,
      );
      await this.notify(
        `Aplicación confirmada para ${input.target.amount} QUSD. Verifica el pago fiat recibido antes de confirmar recepción.`,
      );
    } catch (error) {
      const message = errorMessage(error);
      if (isUncertain(error)) {
        const state =
          this.store.getTradeWorkflow(workflowId)?.state === "applying_external"
            ? "apply_uncertain"
            : "cancellation_uncertain";
        this.store.updateWorkflowState(workflowId, state, message);
        this.store.audit("workflow_reconciliation_required", message, input.target.uuid);
      } else {
        this.store.updateWorkflowState(workflowId, "apply_rejected", message);
        await this.restoreCancelledOffers(workflowId);
        this.store.releaseCapitalReservation(workflowId);
      }
    }
    const persistedWorkflow = this.store.getTradeWorkflow(workflowId);
    if (!persistedWorkflow) throw new Error("No se pudo recuperar el flujo persistido.");
    return {
      decision,
      workflow: persistedWorkflow,
    };
  }

  private async cancelOwnOffers(workflowId: string): Promise<void> {
    this.store.updateWorkflowState(workflowId, "cancelling_own_offers");
    for (const own of this.store.workflowOwnOffers(workflowId)) {
      this.store.updateWorkflowOwnOffer(workflowId, own.originalUuid, "cancel_requested");
      try {
        await this.mutation(
          "cancel_own_for_liquidity",
          own.originalUuid,
          { workflowId },
          () => this.qva.cancel(own.originalUuid),
        );
        this.store.updateWorkflowOwnOffer(workflowId, own.originalUuid, "cancelled");
      } catch (error) {
        if (isUncertain(error))
          this.store.updateWorkflowOwnOffer(workflowId, own.originalUuid, "uncertain", {
            error: errorMessage(error),
          });
        throw error;
      }
    }
  }

  private async restoreCancelledOffers(workflowId: string): Promise<void> {
    this.store.updateWorkflowState(workflowId, "restoring_own_offers");
    try {
      for (const own of this.store
        .workflowOwnOffers(workflowId)
        .filter((item) => item.state === "cancelled")) {
        this.store.updateWorkflowOwnOffer(workflowId, own.originalUuid, "restore_requested");
        const restored = await this.restoreOffer(workflowId, own);
        this.store.updateWorkflowOwnOffer(workflowId, own.originalUuid, "restored", {
          restoredUuid: restored.uuid,
        });
      }
      this.store.updateWorkflowState(workflowId, "restored");
    } catch (error) {
      this.store.updateWorkflowState(workflowId, "compensation_failed", errorMessage(error));
      throw error;
    }
  }

  private async restoreOffer(
    workflowId: string,
    own: ReturnType<Store["workflowOwnOffers"]>[number],
  ): Promise<P2pOffer> {
    try {
      return await this.mutation(
        "restore_own_offer",
        own.originalUuid,
        { workflowId, snapshot: own.snapshot },
        () => this.qva.createOffer(
          restorationRequest(own.snapshot, own.restoreIdempotencyKey),
        ),
        own.restoreIdempotencyKey,
      );
    } catch (error) {
      if (!(error instanceof QvaApiError) || error.status !== 409) throw error;
      const open = await this.qva.listOffers({
        my: true,
        take: 100,
        page: 1,
        status: "open",
      });
      const duplicate = open.find(
        (candidate) =>
          candidate.type === "sell" &&
          candidate.coin === own.snapshot.coin &&
          nearlyEqual(candidate.amount, own.snapshot.amount) &&
          nearlyEqual(candidate.receive, own.snapshot.receive),
      );
      if (!duplicate)
        throw new Error(
          `QvaPay rechazó la reposición duplicada de ${own.originalUuid}, pero no se encontró la oferta restaurada.`,
          { cause: error },
        );
      this.store.audit(
        "restore_offer_deduplicated",
        "La reposición ya existía en QvaPay y fue confirmada mediante lectura.",
        duplicate.uuid,
      );
      return duplicate;
    }
  }

  private ensureAppliedOperation(workflow: TradeWorkflow): void {
    const offer = workflow.targetOffer;
    this.store.createOperation({
      uuid: offer.uuid,
      offerType: "buy",
      coin: offer.coin,
      amount: offer.amount,
      receive: offer.receive,
      rate: offer.receive / offer.amount,
      state: "applied",
      autoApplied: true,
      cancelAt: null,
      createdAt: workflow.createdAt,
      ...(offer.User?.uuid ? { counterpartyId: offer.User.uuid } : {}),
    });
  }

  private keepUnresolved(
    workflow: TradeWorkflow,
    detail: string,
  ): ReconciliationResult {
    this.store.updateWorkflowState(workflow.id, "apply_uncertain", detail);
    this.store.audit(
      "workflow_reconciliation_pending",
      detail,
      workflow.targetOffer.uuid,
    );
    return { workflowId: workflow.id, outcome: "unresolved", detail };
  }

  private async mutation<T>(
    kind: string,
    operationUuid: string,
    request: unknown,
    action: () => Promise<T>,
    idempotencyKey?: string,
  ): Promise<T> {
    const intentId = randomUUID();
    this.store.createMutationIntent({
      intentId,
      operationUuid,
      kind,
      ...(idempotencyKey ? { idempotencyKey } : {}),
      request,
    });
    try {
      const response = await action();
      this.store.updateMutationIntent(intentId, "confirmed", response);
      return response;
    } catch (error) {
      this.store.updateMutationIntent(
        intentId,
        isUncertain(error) ? "uncertain" : "rejected",
        undefined,
        errorMessage(error),
      );
      throw error;
    }
  }

  private nonExecutableDecision(
    input: OpportunityInput,
    kind: Exclude<RiskDecisionKind, "apply">,
    reason: string,
  ): RiskDecision {
    return {
      kind,
      opportunityUuid: input.target.uuid,
      evaluatedAt: this.now(),
      requiredQusd: input.target.amount,
      requiredFiat: 0,
      projectedExposureQusd: input.target.amount,
      projectedDailyAppliedQusd: input.target.amount,
      checks: [],
      reasons: [reason],
    };
  }

  private blockDecision(decision: RiskDecision, reason: string): RiskDecision {
    return { ...decision, kind: "blocked", reasons: [...decision.reasons, reason] };
  }
}

function restorationRequest(offer: RestorableOwnOffer, idempotencyKey: string) {
  return {
    type: "sell" as const,
    coin: offer.coin,
    amount: offer.amount,
    receive: offer.receive,
    details: offer.details,
    ...(offer.message ? { message: offer.message } : {}),
    onlyKyc: offer.onlyKyc,
    onlyVip: offer.onlyVip,
    private: offer.private,
    ...(offer.webhook ? { webhook: offer.webhook } : {}),
    tags: offer.tags,
    idempotencyKey,
  };
}

function isUncertain(error: unknown): boolean {
  return (
    error instanceof QvaMutationUncertainError ||
    (error instanceof QvaApiError && error.status >= 500)
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function offerTimestamp(offer: P2pOffer, fallback: number): number {
  const parsed = Date.parse(offer.updated_at ?? offer.created_at ?? "");
  return Number.isFinite(parsed) ? parsed : fallback;
}

function startOfDay(now: number): number {
  const date = new Date(now);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

function nearlyEqual(left: number, right: number): boolean {
  return Math.abs(left - right) <= 0.0000001;
}

function riskCooldowns(
  store: Store,
  market: string,
  counterpartyId?: string,
) {
  const marketAt = store.lastOperationAt(market);
  const counterpartyAt = counterpartyId
    ? store.lastOperationAt(market, counterpartyId)
    : undefined;
  return {
    ...(marketAt === undefined ? {} : { lastMarketOperationAt: marketAt }),
    ...(counterpartyAt === undefined
      ? {}
      : { lastCounterpartyOperationAt: counterpartyAt }),
  };
}

function applicationIsConfirmed(status: string): boolean {
  return ["processing", "paid", "completed", "revision"].includes(status);
}

function applicationIsAbsent(status: string): boolean {
  return ["open", "cancelled"].includes(status);
}
