export function median(values: readonly number[]): number | undefined {
  const sorted = values
    .filter((value) => Number.isFinite(value) && value > 0)
    .toSorted((left, right) => left - right);
  if (!sorted.length) return undefined;
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2) return sorted[middle];
  return (sorted[middle - 1]! + sorted[middle]!) / 2;
}

export interface OutgoingFiatCost {
  nominal: number;
  fee: number;
  total: number;
  effectiveRate: number;
}

/** Minimum QUSD amount accepted by QvaPay for creating or editing an offer. */
export const MIN_OFFER_QUSD = 0.1;

export function outgoingFiatCost(
  qusdAmount: number,
  fiatPerQusd: number,
  fixedFee: number,
): OutgoingFiatCost {
  const nominal = qusdAmount * fiatPerQusd;
  const fee = Number.isFinite(fixedFee) && fixedFee > 0 ? fixedFee : 0;
  const total = nominal + fee;
  return {
    nominal,
    fee,
    total,
    effectiveRate: qusdAmount > 0 ? total / qusdAmount : 0,
  };
}

/**
 * Calculates the fiat total sent to QvaPay for an own offer. CUP totals are
 * kept transfer-friendly without crossing the configured rate against the
 * owner: buyers round down and sellers round up.
 */
export function ownOfferFiatTotal(
  qusdAmount: number,
  fiatPerQusd: number,
  type: "buy" | "sell",
  currency: string,
): number {
  if (
    !Number.isFinite(qusdAmount) ||
    !Number.isFinite(fiatPerQusd) ||
    qusdAmount <= 0 ||
    fiatPerQusd <= 0
  )
    throw new Error("El importe y la tasa deben ser positivos.");

  const nominal = qusdAmount * fiatPerQusd;
  if (!Number.isFinite(nominal))
    throw new Error("El total fiat calculado está fuera del rango permitido.");
  if (currency.trim().toUpperCase() !== "CUP") return roundDecimal(nominal);

  const tens = nominal / 10;
  const nearestInteger = Math.round(tens);
  const stableTens =
    Math.abs(tens - nearestInteger) <= 1e-9 ? nearestInteger : tens;
  const rounded =
    (type === "buy" ? Math.floor(stableTens) : Math.ceil(stableTens)) * 10;
  if (rounded < 0.1)
    throw new Error(
      "La tasa no permite obtener un total fiat válido terminado en cero.",
    );
  return rounded;
}

/**
 * Presents an effective rate conservatively using the precision already
 * chosen for the market index. Purchases round up; sales round down.
 */
export function roundRateForIndex(
  effectiveRate: number,
  type: "buy" | "sell",
  configuredIndex: number,
): number {
  if (!Number.isFinite(effectiveRate) || effectiveRate < 0)
    throw new Error("La tasa efectiva debe ser un número positivo.");
  if (!Number.isFinite(configuredIndex) || configuredIndex <= 0)
    throw new Error("El índice configurado debe ser positivo.");
  const factor = 10 ** decimalPlaces(configuredIndex);
  const scaled = effectiveRate * factor;
  const tolerance = Number.EPSILON * Math.max(1, Math.abs(scaled)) * 8;
  const rounded = type === "buy"
    ? Math.ceil(scaled - tolerance)
    : Math.floor(scaled + tolerance);
  return rounded / factor;
}

export function indexDecimalPlaces(configuredIndex: number): number {
  if (!Number.isFinite(configuredIndex) || configuredIndex <= 0) return 0;
  return decimalPlaces(configuredIndex);
}

function decimalPlaces(value: number): number {
  const text = value.toString().toLowerCase();
  if (!text.includes("e")) return text.includes(".") ? text.split(".")[1]!.length : 0;
  const [coefficient, exponentText] = text.split("e");
  const exponent = Number(exponentText);
  const coefficientDecimals = coefficient!.includes(".")
    ? coefficient!.split(".")[1]!.length
    : 0;
  return Math.max(0, coefficientDecimals - exponent);
}

function roundDecimal(value: number): number {
  return Math.round(value * 100_000_000) / 100_000_000;
}
