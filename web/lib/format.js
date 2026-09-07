export const money = (value, digits = 2) =>
  Number(value || 0).toLocaleString("es-CU", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
