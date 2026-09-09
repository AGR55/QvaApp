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

function roundDecimal(value: number): number {
  return Math.round(value * 100_000_000) / 100_000_000;
}
