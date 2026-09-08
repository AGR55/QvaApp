/** @param {number[]} values @returns {[number, number]} */
export function chartDomain(values) {
  const finite = values.filter(Number.isFinite);
  if (!finite.length) return [0, 1];
  const minimum = Math.min(...finite);
  const maximum = Math.max(...finite);
  const spread = maximum - minimum;
  const padding = spread > 0
    ? spread * 0.08
    : Math.max(Math.abs(maximum || 1) * 0.002, 0.0001);
  return [minimum - padding, maximum + padding];
}
