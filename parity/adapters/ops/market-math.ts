/**
 * Operaciones de conformidad para `src/market-math.ts`.
 *
 * Todos los importes/tasas salen como string decimal de escala fija: el
 * adaptador es la frontera de canonización. Nunca se devuelve un `number`
 * monetario al arnés.
 */
import {
  indexDecimalPlaces,
  median,
  outgoingFiatCost,
  ownOfferFiatTotal,
  roundRateForIndex,
} from "../../../src/market-math.js";

type Input = Record<string, unknown>;

function num(input: Input, key: string): number {
  const value = input[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`El campo ${key} debe ser un número finito.`);
  }
  return value;
}

function text(input: Input, key: string): string {
  const value = input[key];
  if (typeof value !== "string") throw new Error(`El campo ${key} debe ser texto.`);
  return value;
}

function type(input: Input): "buy" | "sell" {
  const value = text(input, "type");
  if (value !== "buy" && value !== "sell") throw new Error("El tipo debe ser buy o sell.");
  return value;
}

/** Fixed-scale decimal string without ever going through a float formatter. */
function dec(value: number, scale: number): string {
  if (!Number.isFinite(value)) throw new Error("El resultado no es un número finito.");
  if (scale < 0 || scale > 12) throw new Error("Escala no soportada.");
  const rounded = Number(value.toFixed(scale));
  return rounded.toFixed(scale);
}

function roundQusd(value: number): number {
  return Math.round(value * 100_000_000) / 100_000_000;
}

export const ops = {
  /** Math.round(v * 1e8) / 1e8, la escala canónica de QUSD. */
  "market.roundQusd": (input: Input) => ({ value: dec(roundQusd(num(input, "value")), 8) }),

  /** Mediana de seguridad; ignora no finitos y <= 0. `null` si no hay referencia. */
  "market.median": (input: Input) => {
    const values = input.values;
    if (!Array.isArray(values)) throw new Error("El campo values debe ser un array.");
    const result = median(values as number[]);
    return { value: result === undefined ? null : dec(result, 8) };
  },

  /** Coste fiat de salida con comisión fija y tasa efectiva. */
  "market.outgoingFiatCost": (input: Input) => {
    const cost = outgoingFiatCost(num(input, "qusdAmount"), num(input, "fiatPerQusd"), num(input, "fixedFee"));
    return {
      nominal: dec(cost.nominal, 8),
      fee: dec(cost.fee, 8),
      total: dec(cost.total, 8),
      effectiveRate: dec(cost.effectiveRate, 8),
    };
  },

  /** Total fiat de una oferta propia: CUP a múltiplos de 10, resto redondeo 1e-8. */
  "market.ownOfferFiatTotal": (input: Input) => {
    const currency = text(input, "currency");
    const value = ownOfferFiatTotal(num(input, "qusdAmount"), num(input, "fiatPerQusd"), type(input), currency);
    const scale = currency.trim().toUpperCase() === "CUP" ? 0 : 8;
    return { value: dec(value, scale) };
  },

  /** Tasa efectiva presentada con la precisión del índice configurado. */
  "market.roundRateForIndex": (input: Input) => {
    const configuredIndex = num(input, "configuredIndex");
    const value = roundRateForIndex(num(input, "effectiveRate"), type(input), configuredIndex);
    return { value: dec(value, indexDecimalPlaces(configuredIndex)) };
  },
};
