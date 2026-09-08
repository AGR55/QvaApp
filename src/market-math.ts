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
