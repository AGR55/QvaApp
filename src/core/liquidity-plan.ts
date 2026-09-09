import type { P2pOffer } from "../types.js";
import { outgoingFiatCost } from "../market-math.js";

export interface RestorableOwnOffer {
  uuid: string;
  coin: string;
  amount: number;
  receive: number;
  rate: number;
  details: { name: string; value: string }[];
  message?: string;
  tags: string[];
  onlyKyc: boolean;
  onlyVip: boolean;
  private: boolean;
  webhook?: string;
  createdAt?: string;
}

export interface PlannedOwnOffer extends RestorableOwnOffer {
  profitabilityPercent: number;
  consumeQusd: number;
  restoreQusd: number;
}

export interface LiquidityMarketEconomics {
  buyMaxRate: number;
  sellFeePercent: number;
  outgoingTransferFee: number;
}

export interface LiquidityPlan {
  feasible: boolean;
  targetQusd: number;
  immediatelyAvailableQusd: number;
  requiredReleaseQusd: number;
  plannedReleaseQusd: number;
  potentialReleaseQusd: number;
  cancel: PlannedOwnOffer[];
  reason: string;
}

export interface LiquidityPlanInput {
  target: Pick<P2pOffer, "amount" | "coin" | "type" | "receive">;
  availableQusd: number;
  reserveQusd: number;
  ownOffers: P2pOffer[];
  marketEconomics?: Record<string, LiquidityMarketEconomics>;
}

export function hydratePlannedOwnOffer(
  planned: PlannedOwnOffer,
  detailed: P2pOffer,
): PlannedOwnOffer {
  if (
    detailed.uuid !== planned.uuid ||
    detailed.type !== "sell" ||
    detailed.status !== "open" ||
    detailed.coin !== planned.coin ||
    !nearlyEqual(detailed.amount, planned.amount) ||
    !nearlyEqual(detailed.receive, planned.receive)
  )
    throw new Error(
      `La oferta propia ${planned.uuid} cambió mientras se preparaba la liberación; no se cancelará ninguna.`,
    );
  const hydrated = snapshot(detailed);
  if (
    hydrated.details.length === 0 ||
    hydrated.details.some(
      ({ name, value }) => !name.trim() || !value.trim(),
    )
  )
    throw new Error(
      `QvaPay no devolvió los datos de pago completos de la oferta propia ${planned.uuid}; no se cancelará ninguna.`,
    );
  return {
    ...hydrated,
    profitabilityPercent: planned.profitabilityPercent,
    consumeQusd: planned.consumeQusd,
    restoreQusd: planned.restoreQusd,
  };
}

/**
 * Selects the least competitive own sell offers first. It never proposes a
 * partial cancellation plan: either the target can be funded or nothing is
 * cancelled.
 */
export function planLiquidity(input: LiquidityPlanInput): LiquidityPlan {
  const { target } = input;
  validate(input);
  if (target.type !== "buy")
    return infeasible(input, "Solo una oferta externa de compra requiere liberar QUSD.");

  const immediatelyAvailableQusd = Math.max(
    0,
    input.availableQusd - input.reserveQusd,
  );
  const requiredReleaseQusd = Math.max(
    0,
    target.amount + input.reserveQusd - input.availableQusd,
  );
  if (requiredReleaseQusd === 0)
    return {
      feasible: true,
      targetQusd: target.amount,
      immediatelyAvailableQusd,
      requiredReleaseQusd: 0,
      plannedReleaseQusd: 0,
      potentialReleaseQusd: 0,
      cancel: [],
      reason: "El saldo QUSD disponible cubre la oportunidad sin cancelar ofertas propias.",
    };

  const externalRate = offerRate(target);
  const targetProfitability = profitability(target, input.marketEconomics?.[target.coin]);
  const candidates = input.ownOffers
    .filter(
      (offer) =>
        offer.type === "sell" &&
        offer.status === "open" &&
        offer.amount > 0 &&
        offer.receive > 0 &&
        isInferiorLiquidity(
          offer,
          target.coin,
          externalRate,
          targetProfitability,
          input.marketEconomics,
        ),
    )
    .map((offer) => ({
      offer,
      profitabilityPercent:
        profitability(offer, input.marketEconomics?.[offer.coin]) ??
        offerRate(offer),
    }))
    .sort(
      (left, right) =>
        left.profitabilityPercent - right.profitabilityPercent ||
        right.offer.amount - left.offer.amount ||
        timestamp(left.offer.created_at) - timestamp(right.offer.created_at) ||
        left.offer.uuid.localeCompare(right.offer.uuid),
    );

  const selected: Array<{ offer: P2pOffer; profitabilityPercent: number }> = [];
  let plannedReleaseQusd = 0;
  for (const candidate of candidates) {
    selected.push(candidate);
    plannedReleaseQusd += candidate.offer.amount;
    if (plannedReleaseQusd + 0.0000001 >= requiredReleaseQusd) break;
  }

  if (plannedReleaseQusd + 0.0000001 < requiredReleaseQusd)
    return {
      feasible: false,
      targetQusd: target.amount,
      immediatelyAvailableQusd,
      requiredReleaseQusd,
      plannedReleaseQusd: 0,
      potentialReleaseQusd: plannedReleaseQusd,
      cancel: [],
      reason:
        `Las ventas propias menos rentables liberarían ${roundQusd(plannedReleaseQusd)} QUSD, pero se requieren ${roundQusd(requiredReleaseQusd)}; no se cancelará ninguna.`,
    };

  let remainingConsumption = requiredReleaseQusd;
  const cancel = selected.map(({ offer, profitabilityPercent }) => {
    const consumeQusd = Math.min(offer.amount, remainingConsumption);
    remainingConsumption = Math.max(0, remainingConsumption - consumeQusd);
    return {
      ...snapshot(offer),
      profitabilityPercent,
      consumeQusd: roundQusd(consumeQusd),
      restoreQusd: roundQusd(offer.amount - consumeQusd),
    };
  });

  return {
    feasible: true,
    targetQusd: target.amount,
    immediatelyAvailableQusd,
    requiredReleaseQusd,
    plannedReleaseQusd,
    potentialReleaseQusd: plannedReleaseQusd,
    cancel,
    reason: `Se liberarán ${roundQusd(plannedReleaseQusd)} QUSD de ${selected.length} oferta(s) propia(s); ${roundQusd(plannedReleaseQusd - requiredReleaseQusd)} QUSD se repondrán después de aplicar.`,
  };
}

function isInferiorLiquidity(
  offer: P2pOffer,
  targetCoin: string,
  targetRate: number,
  targetProfitability: number | undefined,
  economics: LiquidityPlanInput["marketEconomics"],
): boolean {
  const ownProfitability = profitability(offer, economics?.[offer.coin]);
  if (targetProfitability !== undefined && ownProfitability !== undefined)
    return ownProfitability + 0.0000001 < targetProfitability;
  return offer.coin === targetCoin && offerRate(offer) < targetRate;
}

function profitability(
  offer: Pick<P2pOffer, "amount" | "receive">,
  economics: LiquidityMarketEconomics | undefined,
): number | undefined {
  if (!economics || economics.buyMaxRate <= 0) return undefined;
  const acquisition = outgoingFiatCost(
    offer.amount,
    economics.buyMaxRate,
    economics.outgoingTransferFee,
  ).total;
  if (acquisition <= 0) return undefined;
  const netRevenue = offer.receive * (1 - economics.sellFeePercent / 100);
  return ((netRevenue - acquisition) / acquisition) * 100;
}

function snapshot(offer: P2pOffer): RestorableOwnOffer {
  return {
    uuid: offer.uuid,
    coin: offer.coin,
    amount: offer.amount,
    receive: offer.receive,
    rate: offerRate(offer),
    details: normalizeDetails(offer.details),
    ...(offer.message ? { message: offer.message } : {}),
    tags: offer.tags?.slice() ?? [],
    onlyKyc: Boolean(offer.only_kyc),
    onlyVip: Boolean(offer.only_vip),
    private: Boolean(offer.private),
    ...(offer.webhook ? { webhook: offer.webhook } : {}),
    ...(offer.created_at ? { createdAt: offer.created_at } : {}),
  };
}

function normalizeDetails(
  details: P2pOffer["details"],
): { name: string; value: string }[] {
  if (!details) return [];
  return Object.entries(details).map(([name, value]) => ({ name, value }));
}

function nearlyEqual(left: number, right: number): boolean {
  return Math.abs(left - right) <= 0.0000001;
}

function infeasible(input: LiquidityPlanInput, reason: string): LiquidityPlan {
  return {
    feasible: false,
    targetQusd: input.target.amount,
    immediatelyAvailableQusd: Math.max(
      0,
      input.availableQusd - input.reserveQusd,
    ),
    requiredReleaseQusd: 0,
    plannedReleaseQusd: 0,
    potentialReleaseQusd: 0,
    cancel: [],
    reason,
  };
}

function validate(input: LiquidityPlanInput): void {
  const values = [
    input.target.amount,
    input.target.receive,
    input.availableQusd,
    input.reserveQusd,
  ];
  if (values.some((value) => !Number.isFinite(value) || value < 0))
    throw new Error("Los importes del plan de liquidez deben ser finitos y no negativos.");
  if (input.target.amount === 0 || input.target.receive === 0)
    throw new Error("La oportunidad objetivo debe tener importe y recepción positivos.");
}

function timestamp(value?: string): number {
  const parsed = value ? Date.parse(value) : Number.POSITIVE_INFINITY;
  return Number.isFinite(parsed) ? parsed : Number.POSITIVE_INFINITY;
}

function offerRate(offer: Pick<P2pOffer, "amount" | "receive">): number {
  return offer.receive / offer.amount;
}

function roundQusd(value: number): number {
  return Math.round(value * 100_000_000) / 100_000_000;
}
