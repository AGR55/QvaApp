/**
 * Operaciones de conformidad para las funciones puras de `src/dashboard.ts`.
 *
 * - `dashboard.margin`           → margen neto, punto de equilibrio y comisión.
 * - `dashboard.allocate`         → reparto de presupuesto por mejores tasas.
 * - `dashboard.compact-history`  → compactación determinista del histórico.
 *
 * Regla del arnés: importes y tasas viajan como string decimal de escala fija
 * (8 dp). `createdAt` y las medianas del histórico se conservan como number
 * porque el caso de origen mide estructura y orden, no aritmética monetaria.
 */
import { allocateBudget, compactMarketHistory, marginCalculation } from "../../../src/dashboard.js";

type Input = Record<string, unknown>;

function text(input: Input, key: string): string {
  const value = input[key];
  if (typeof value !== "string") throw new Error(`El campo ${key} debe ser texto.`);
  return value;
}

function num(input: Input, key: string): number {
  const value = input[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`El campo ${key} debe ser un número finito.`);
  }
  return value;
}

function optionalNum(input: Input, key: string): number | undefined {
  const value = input[key];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`El campo ${key} debe ser un número finito.`);
  }
  return value;
}

function decimal(value: number): string {
  if (!Number.isFinite(value)) throw new Error("Resultado monetario no finito.");
  return value.toFixed(8);
}

export const ops = {
  "dashboard.margin": (input: Input) => {
    const result = marginCalculation(
      num(input, "buyRate"),
      num(input, "sellRate"),
      num(input, "amount"),
      num(input, "sellFeePercent"),
      optionalNum(input, "outgoingTransferFee") ?? 0,
    );
    return {
      cost: decimal(result.cost),
      grossRevenue: decimal(result.grossRevenue),
      netRevenue: decimal(result.netRevenue),
      netProfit: decimal(result.netProfit),
      marginPercent: decimal(result.marginPercent),
      breakEvenRate: decimal(result.breakEvenRate),
    };
  },

  "dashboard.allocate": (input: Input) => {
    const opportunities = input.opportunities;
    if (!Array.isArray(opportunities)) throw new Error("El campo opportunities debe ser un array.");
    const allocation = allocateBudget(
      num(input, "budget"),
      num(input, "reserve"),
      num(input, "maximumPerOffer"),
      opportunities.map((raw) => {
        const item = raw as Input;
        return { rate: num(item, "rate"), amount: num(item, "amount") };
      }),
    );
    return allocation.map((item) => ({
      rate: decimal(item.rate),
      fiat: decimal(item.fiat),
      qusd: decimal(item.qusd),
    }));
  },

  "dashboard.compact-history": (input: Input) => {
    const history = input.history;
    if (!Array.isArray(history)) throw new Error("El campo history debe ser un array.");
    return compactMarketHistory(
      history.map((raw) => {
        const item = raw as Input;
        return {
          coin: text(item, "coin"),
          createdAt: num(item, "createdAt"),
          medianBuy: num(item, "medianBuy"),
        };
      }),
      num(input, "maxPerMarket"),
    );
  },
};
