import type { P2pOffer } from "../types.js";

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

export interface LiquidityPlan {
  feasible: boolean;
  targetQusd: number;
  immediatelyAvailableQusd: number;
  requiredReleaseQusd: number;
  plannedReleaseQusd: number;
  cancel: RestorableOwnOffer[];
  reason: string;
}

export interface LiquidityPlanInput {
  target: Pick<P2pOffer, "amount" | "coin" | "type" | "receive">;
  availableQusd: number;
  reserveQusd: number;
  ownOffers: P2pOffer[];
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
    target.amount - immediatelyAvailableQusd,
  );
  if (requiredReleaseQusd === 0)
    return {
      feasible: true,
      targetQusd: target.amount,
      immediatelyAvailableQusd,
      requiredReleaseQusd: 0,
      plannedReleaseQusd: 0,
      cancel: [],
      reason: "El saldo QUSD disponible cubre la oportunidad sin cancelar ofertas propias.",
    };

  const externalRate = offerRate(target);
  const candidates = input.ownOffers
    .filter(
      (offer) =>
        offer.type === "sell" &&
        offer.status === "open" &&
        offer.coin === target.coin &&
        offer.amount > 0 &&
        offer.receive > 0 &&
        offerRate(offer) < externalRate,
    )
    .sort(
      (left, right) =>
        offerRate(left) - offerRate(right) ||
        timestamp(left.created_at) - timestamp(right.created_at) ||
        left.uuid.localeCompare(right.uuid),
    );

  const selected: RestorableOwnOffer[] = [];
  let plannedReleaseQusd = 0;
  for (const offer of candidates) {
    selected.push(snapshot(offer));
    plannedReleaseQusd += offer.amount;
    if (plannedReleaseQusd + 0.0000001 >= requiredReleaseQusd) break;
  }

  if (plannedReleaseQusd + 0.0000001 < requiredReleaseQusd)
    return {
      feasible: false,
      targetQusd: target.amount,
      immediatelyAvailableQusd,
      requiredReleaseQusd,
      plannedReleaseQusd: 0,
      cancel: [],
      reason:
        "Las ofertas propias con peor precio no liberan suficiente QUSD; no se cancelará ninguna.",
    };

  return {
    feasible: true,
    targetQusd: target.amount,
    immediatelyAvailableQusd,
    requiredReleaseQusd,
    plannedReleaseQusd,
    cancel: selected,
    reason: `Se liberarán ${plannedReleaseQusd} QUSD de ${selected.length} oferta(s) propia(s) con una tasa inferior.`,
  };
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
