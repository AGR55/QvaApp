import type { FiatMarket } from "./types.js";
import { MIN_OFFER_QUSD, ownOfferFiatTotal } from "./market-math.js";

export interface BudgetOffer {
  uuid: string;
  coin: FiatMarket;
  type: string;
  status: string;
  amount: number;
  rate: number;
  receive?: number;
}
interface BudgetAdjustment {
  uuid: string;
  coin: FiatMarket;
  rate: number;
  currentQusd: number;
  proposedQusd: number;
  currentFiat: number;
  proposedFiat: number;
  releasedFiat: number;
  action: "edit" | "cancel";
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
  currency = "",
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
    (sum, offer) => sum + currentFiatTotal(offer, currency) + safeFee,
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
    (sum, offer) => sum + currentFiatTotal(offer, currency),
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
        const proposedQusd = fitAmount(
          offer.amount * factor,
          offer.rate,
          currency,
          Math.max(0, currentFiatTotal(offer, currency) * factor),
        );
        const currentFiat = currentFiatTotal(offer, currency) + safeFee;
        const proposedFiat = proposedQusd > 0
          ? ownOfferFiatTotal(proposedQusd, offer.rate, "buy", currency) + safeFee
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
          action: proposedQusd > 0 ? "edit" as const : "cancel" as const,
        };
      })
      .filter((adjustment) => adjustment.proposedQusd < adjustment.currentQusd),
  };
}

function currentFiatTotal(offer: BudgetOffer, currency: string): number {
  return Number.isFinite(offer.receive) && Number(offer.receive) >= 0
    ? Number(offer.receive)
    : ownOfferFiatTotal(offer.amount, offer.rate, "buy", currency);
}

function fitAmount(
  desired: number,
  rate: number,
  currency: string,
  fiatLimit: number,
): number {
  let amount = precision(desired);
  while (amount > 0) {
    // QvaPay rejects edits below 0.1 QUSD. A proportional remainder below
    // that threshold must become a cancellation instead of a doomed edit.
    if (amount < MIN_OFFER_QUSD) return 0;
    // A CUP purchase must produce at least one transferable ten-peso unit.
    // During budget fitting, falling below it means cancelling, not aborting
    // the complete dashboard snapshot with a domain validation error.
    if (
      currency.trim().toUpperCase() === "CUP" &&
      amount * rate < 10 - 0.00000001
    ) return 0;
    if (
      ownOfferFiatTotal(amount, rate, "buy", currency) <=
        fiatLimit + 0.000001
    ) return amount;
    amount = precision(amount - 0.01);
  }
  return 0;
}
