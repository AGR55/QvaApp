import type { FiatMarket } from "./types.js";

export interface BudgetOffer {
  uuid: string;
  coin: FiatMarket;
  type: string;
  status: string;
  amount: number;
  rate: number;
}
export interface BudgetAdjustment {
  uuid: string;
  coin: FiatMarket;
  rate: number;
  currentQusd: number;
  proposedQusd: number;
  currentFiat: number;
  proposedFiat: number;
  releasedFiat: number;
}
export interface BudgetPlan {
  coin: FiatMarket;
  available: number;
  committed: number;
  deficit: number;
  adjustments: BudgetAdjustment[];
  invalid: string[];
}

const precision = (value: number) =>
  Math.floor((value + Number.EPSILON) * 100) / 100;

export function proportionalBudgetPlan(
  offers: BudgetOffer[],
  coin: FiatMarket,
  available: number,
  maximumRate: number,
  outgoingTransferFee = 0,
): BudgetPlan {
  const invalid: string[] = [];
  const candidates = offers.filter((offer) => {
    const valid =
      offer.coin === coin &&
      offer.type === "buy" &&
      offer.status === "open" &&
      Number.isFinite(offer.amount) &&
      offer.amount > 0 &&
      Number.isFinite(offer.rate) &&
      offer.rate > 0 &&
      offer.rate <= maximumRate * 1.5;
    if (
      offer.coin === coin &&
      offer.type === "buy" &&
      offer.status === "open" &&
      !valid
    )
      invalid.push(offer.uuid);
    return valid;
  });
  const safeAvailable =
    Number.isFinite(available) && available > 0 ? available : 0;
  const safeFee = Number.isFinite(outgoingTransferFee) && outgoingTransferFee > 0
    ? outgoingTransferFee
    : 0;
  const committed = candidates.reduce(
    (sum, offer) => sum + offer.amount * offer.rate + safeFee,
    0,
  );
  if (committed <= safeAvailable)
    return {
      coin,
      available: safeAvailable,
      committed,
      deficit: 0,
      adjustments: [],
      invalid,
    };
  const variableCommitted = candidates.reduce(
    (sum, offer) => sum + offer.amount * offer.rate,
    0,
  );
  const factor = variableCommitted > 0
    ? Math.max(0, safeAvailable - candidates.length * safeFee) / variableCommitted
    : 0;
  return {
    coin,
    available: safeAvailable,
    committed,
    deficit: committed - safeAvailable,
    invalid,
    adjustments: candidates
      .map((offer) => {
        const proposedQusd = precision(offer.amount * factor);
        const currentFiat = offer.amount * offer.rate + safeFee;
        const proposedFiat = proposedQusd > 0
          ? proposedQusd * offer.rate + safeFee
          : 0;
        return {
          uuid: offer.uuid,
          coin,
          rate: offer.rate,
          currentQusd: offer.amount,
          proposedQusd,
          currentFiat,
          proposedFiat,
          releasedFiat: currentFiat - proposedFiat,
        };
      })
      .filter((adjustment) => adjustment.proposedQusd < adjustment.currentQusd),
  };
}
