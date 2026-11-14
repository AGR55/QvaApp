/**
 * Operaciones de conformidad para `src/budget.ts`.
 *
 * Contrato `budget.proportionalPlan`:
 *   input  = { offers, coin, available, maximumRate, outgoingTransferFee?, currency? }
 *   output = BudgetPlan canónico: importes QUSD a escala 8, importes fiat a la
 *            escala de la moneda de trabajo (CUP sin decimales; resto escala 8),
 *            tasas a escala 8.
 *
 * `available`, `maximumRate` y `outgoingTransferFee` son parámetros de entrada
 * del dominio (no salidas): llegan como number porque el test original los pasa
 * como literales numéricos; la frontera de canonización está en la salida.
 */
import { proportionalBudgetPlan, type BudgetOffer } from "../../../src/budget.js";

type Input = Record<string, unknown>;

function text(input: Input, key: string): string {
  const value = input[key];
  if (typeof value !== "string") throw new Error(`El campo ${key} debe ser texto.`);
  return value;
}

function optionalText(input: Input, key: string): string | undefined {
  return input[key] === undefined ? undefined : text(input, key);
}

function num(input: Input, key: string): number {
  const value = input[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`El campo ${key} debe ser un número finito.`);
  }
  return value;
}

function optionalNum(input: Input, key: string): number | undefined {
  return input[key] === undefined ? undefined : num(input, key);
}

/** Fixed-scale decimal string without going through a locale float formatter. */
function dec(value: number, scale = 8): string {
  if (!Number.isFinite(value)) return String(value);
  if (scale < 0 || scale > 12) throw new Error("Escala no soportada.");
  return Number(value.toFixed(scale)).toFixed(scale);
}

function fiatScale(currency: string): number {
  return currency.trim().toUpperCase() === "CUP" ? 0 : 8;
}

function offerOf(raw: Input): BudgetOffer {
  const amount = raw.amount;
  const rate = raw.rate;
  if (typeof amount !== "number" || typeof rate !== "number") {
    throw new Error("La oferta debe tener amount y rate numéricos.");
  }
  return {
    uuid: text(raw, "uuid"),
    coin: text(raw, "coin") as BudgetOffer["coin"],
    type: text(raw, "type"),
    status: text(raw, "status"),
    amount,
    rate,
    ...(raw.receive === undefined ? {} : { receive: raw.receive as number }),
  };
}

export const ops = {
  "budget.proportionalPlan": (input: Input) => {
    const offers = input.offers;
    if (!Array.isArray(offers)) throw new Error("El campo offers debe ser un array.");
    const currency = optionalText(input, "currency") ?? "";
    const plan = proportionalBudgetPlan(
      (offers as Input[]).map(offerOf),
      text(input, "coin") as BudgetOffer["coin"],
      num(input, "available"),
      num(input, "maximumRate"),
      optionalNum(input, "outgoingTransferFee") ?? 0,
      currency,
    );
    const scale = fiatScale(currency);
    return {
      coin: plan.coin,
      available: dec(plan.available, scale),
      committed: dec(plan.committed, scale),
      deficit: dec(plan.deficit, scale),
      invalid: plan.invalid.slice(),
      adjustments: plan.adjustments.map((adjustment) => ({
        uuid: adjustment.uuid,
        coin: adjustment.coin,
        rate: dec(adjustment.rate),
        currentQusd: dec(adjustment.currentQusd),
        proposedQusd: dec(adjustment.proposedQusd),
        currentFiat: dec(adjustment.currentFiat, scale),
        proposedFiat: dec(adjustment.proposedFiat, scale),
        releasedFiat: dec(adjustment.releasedFiat, scale),
        action: adjustment.action,
      })),
    };
  },
};
