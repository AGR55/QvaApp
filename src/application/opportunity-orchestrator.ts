import { randomUUID } from "node:crypto";
import {
  hydratePlannedOwnOffer,
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
import { ownOfferFiatTotal } from "../market-math.js";

export interface OpportunityInput {
  target: P2pOffer;
  referenceRate: number;
  expectedMarginPercent: number;
  priceDecision: "eligible" | "manual_review" | "blocked" | "ignored";
  priceReason: string;
  canApply?: () => boolean;
}

export interface OpportunityResult {
  decision: RiskDecision;
  workflow?: TradeWorkflow;
  applicationConfirmed?: boolean;
}

export interface ReconciliationResult {
  workflowId: string;
  outcome: "applied" | "restored" | "unresolved";
  detail: string;
}

export interface OrchestratorRuntime {
  now?: () => number;
  notify?: (message: string, event?: {
    kind: "operation-applied" | "reconciliation-required";
    uuid: string;
    coin: string;
    amount: number;
  }) => Promise<void>;
}

/**
 * Owns the complete cancel/apply/restore use case. Entry adapters must never
 * reproduce this ordering themselves.
 */
export class OpportunityOrchestrator {
  private readonly now: () => number;
  private readonly notify: NonNullable<OrchestratorRuntime["notify"]>;
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
        this.store.releaseCapitalReservation(workflowId);
        this.store.reconcileWorkflowMutationIntents(workflowId);
        try {
          await this.restoreSurplusOffers(workflowId);
          this.store.updateWorkflowState(workflowId, "applied");
        } catch (error) {
          const detail = errorMessage(error);
          this.store.updateWorkflowState(workflowId, "surplus_restore_failed", detail);
          this.store.audit(
            "surplus_reconciliation_pending",
            detail,
            workflow.targetOffer.uuid,
          );
          return {
            workflowId,
            outcome: "unresolved",
            detail: `La aplicación está confirmada, pero falta reponer excedente: ${detail}`,
          };
        }
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
    if (existing) {
      const applicationConfirmed = Boolean(
        this.store.getOperation(input.target.uuid),
      );
      return {
        decision: applicationConfirmed
          ? existing.riskDecision
          : this.blockDecision(
              existing.riskDecision,
              existing.error
                ? `QvaPay rechazó la aplicación anterior: ${existing.error}`
                : `La aplicación anterior no fue confirmada por QvaPay (flujo ${existing.state}).`,
            ),
        workflow: existing,
        applicationConfirmed,
      };
    }
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
      marketEconomics: Object.fromEntries(
        current.markets.map((configured) => [
          configured.code,
          {
            buyMaxRate: configured.buyMaxRate,
            sellFeePercent: configured.sellFeePercent,
            outgoingTransferFee: configured.outgoingTransferFee,
          },
        ]),
      ),
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
        // La oferta acaba de ser observada en una lectura actual de /p2p. Las
        // fechas de creación/edición describen la oferta, no la frescura de la
        // cotización recibida por este escaneo.
        observedAt: now,
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
      qusdBalance:
        qusdBalance +
        (liquidity.feasible
          ? liquidity.plannedReleaseQusd
          : liquidity.potentialReleaseQusd),
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
    let outcomeDecision = decision;

    let cancellationPlan = liquidity.cancel;
    if (cancellationPlan.length) {
      try {
        const details = await Promise.all(
          cancellationPlan.map((offer) => this.qva.getOffer(offer.uuid)),
        );
        cancellationPlan = cancellationPlan.map((offer, index) =>
          hydratePlannedOwnOffer(offer, details[index]!),
        );
      } catch (error) {
        return {
          decision: this.blockDecision(
            decision,
            `No se liberó QUSD: ${errorMessage(error)}`,
          ),
        };
      }
    }

    const workflowId = randomUUID();
    this.store.createTradeWorkflow(
      { id: workflowId, targetOffer: input.target, riskDecision: decision },
      cancellationPlan,
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
      if (input.canApply && !input.canApply())
        throw new Error("La cacería de venta fue detenida antes de aplicar.");
      await this.cancelOwnOffers(workflowId);
      this.store.updateWorkflowState(workflowId, "own_offers_cancelled");
      this.store.updateWorkflowState(workflowId, "applying_external");
      if (input.canApply && !input.canApply())
        throw new Error("La cacería de venta fue detenida antes de aplicar.");
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
        referenceRate: input.referenceRate,
      });
      this.store.releaseCapitalReservation(workflowId);
      let surplusRestored = true;
      try {
        await this.restoreSurplusOffers(workflowId);
        this.store.updateWorkflowState(workflowId, "applied");
      } catch (error) {
        surplusRestored = false;
        const detail = errorMessage(error);
        this.store.updateWorkflowState(workflowId, "surplus_restore_failed", detail);
        this.store.audit("surplus_restore_failed", detail, input.target.uuid);
        await this.notifyBestEffort(
          `⚠️ La aplicación ${input.target.uuid} fue confirmada, pero el excedente de las ofertas canceladas requiere conciliación.`,
          { kind: "reconciliation-required", uuid: input.target.uuid, coin: input.target.coin, amount: input.target.amount },
        );
      }
      this.store.audit(
        "opportunity_applied",
        surplusRestored
          ? "Aplicación automática confirmada y excedente QUSD repuesto; el pago fiat permanece manual."
          : "Aplicación automática confirmada; la reposición del excedente requiere conciliación.",
        input.target.uuid,
      );
      await this.notifyBestEffort(
        `Aplicación confirmada para ${input.target.amount} QUSD. Verifica el pago fiat recibido antes de confirmar recepción.`,
        { kind: "operation-applied", uuid: input.target.uuid, coin: input.target.coin, amount: input.target.amount },
      );
    } catch (error) {
      const message = errorMessage(error);
      if (isUncertain(error)) {
        outcomeDecision = this.blockDecision(
          decision,
          `QvaPay no confirmó la aplicación: ${message}`,
        );
        const state =
          this.store.getTradeWorkflow(workflowId)?.state === "applying_external"
            ? "apply_uncertain"
            : "cancellation_uncertain";
        this.store.updateWorkflowState(workflowId, state, message);
        this.store.audit("workflow_reconciliation_required", message, input.target.uuid);
        await this.notifyBestEffort(
          `⚠️ La operación ${input.target.uuid} requiere conciliación manual con QvaPay.`,
          { kind: "reconciliation-required", uuid: input.target.uuid, coin: input.target.coin, amount: input.target.amount },
        );
      } else {
        outcomeDecision = this.blockDecision(
          decision,
          `QvaPay rechazó la aplicación: ${message}`,
        );
        this.store.updateWorkflowState(workflowId, "apply_rejected", message);
        await this.restoreCancelledOffers(workflowId);
        this.store.updateWorkflowState(workflowId, "restored", message);
        this.store.releaseCapitalReservation(workflowId);
      }
    }
    const persistedWorkflow = this.store.getTradeWorkflow(workflowId);
    if (!persistedWorkflow) throw new Error("No se pudo recuperar el flujo persistido.");
    return {
      decision: outcomeDecision,
      workflow: persistedWorkflow,
      applicationConfirmed: Boolean(this.store.getOperation(input.target.uuid)),
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

  private async notifyBestEffort(
    message: string,
    event?: Parameters<NonNullable<OrchestratorRuntime["notify"]>>[1],
  ): Promise<void> {
    try {
      await this.notify(message, event);
    } catch (error) {
      this.store.audit("notification_warning", errorMessage(error));
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

  private async restoreSurplusOffers(workflowId: string): Promise<void> {
    this.store.updateWorkflowState(workflowId, "restoring_surplus");
    for (const own of this.store.workflowOwnOffers(workflowId)) {
      if (own.state === "restored" || own.state === "consumed") continue;
      const restoreQusd = plannedRestoreQusd(own.snapshot);
      if (restoreQusd < 0.1 - 0.0000001) {
        this.store.updateWorkflowOwnOffer(workflowId, own.originalUuid, "consumed");
        if (restoreQusd > 0)
          this.store.audit(
            "surplus_below_minimum",
            `No se repusieron ${restoreQusd} QUSD porque el mínimo de creación es 0.1 QUSD.`,
            own.originalUuid,
          );
        continue;
      }
      this.store.updateWorkflowOwnOffer(workflowId, own.originalUuid, "restore_requested");
      try {
        const restored = await this.restoreOffer(workflowId, own, restoreQusd);
        this.store.updateWorkflowOwnOffer(workflowId, own.originalUuid, "restored", {
          restoredUuid: restored.uuid,
        });
        this.store.audit(
          "surplus_restored",
          `Se repusieron ${restoreQusd} QUSD de la oferta cancelada.`,
          restored.uuid,
        );
      } catch (error) {
        this.store.updateWorkflowOwnOffer(
          workflowId,
          own.originalUuid,
          isUncertain(error) ? "uncertain" : "restore_requested",
          { error: errorMessage(error) },
        );
        throw error;
      }
    }
  }

  private async restoreOffer(
    workflowId: string,
    own: ReturnType<Store["workflowOwnOffers"]>[number],
    amount = own.snapshot.amount,
  ): Promise<P2pOffer> {
    const request = restorationRequest(
      own.snapshot,
      own.restoreIdempotencyKey,
      amount,
      this.config.find(own.snapshot.coin)?.currency ?? "",
    );
    try {
      return await this.mutation(
        "restore_own_offer",
        own.originalUuid,
        { workflowId, snapshot: own.snapshot, amount },
        () => this.qva.createOffer(request),
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
          nearlyEqual(candidate.amount, request.amount) &&
          nearlyEqual(candidate.receive, request.receive),
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

function restorationRequest(
  offer: RestorableOwnOffer,
  idempotencyKey: string,
  amount = offer.amount,
  currency = "",
) {
  return {
    type: "sell" as const,
    coin: offer.coin,
    amount: roundQusd(amount),
    receive: ownOfferFiatTotal(amount, offer.rate, "sell", currency),
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

function plannedRestoreQusd(
  offer: RestorableOwnOffer & { restoreQusd?: number },
): number {
  return Number.isFinite(offer.restoreQusd)
    ? Math.max(0, offer.restoreQusd ?? 0)
    : 0;
}

function roundQusd(value: number): number {
  return Math.round(value * 100_000_000) / 100_000_000;
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
