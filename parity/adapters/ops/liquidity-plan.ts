/**
 * Operaciones de conformidad para `src/core/liquidity-plan.ts`.
 *
 * Contrato `liquidity.plan`:
 *   input  = LiquidityPlanInput serializado (target, availableQusd, reserveQusd,
 *            ownOffers[], marketEconomics?).
 *   output = LiquidityPlan canónico: importes QUSD, importes fiat y
 *            rentabilidades como string decimal de escala fija 8. El `receive`
 *            es el valor crudo de la oferta (no el total transferible), así que
 *            se conserva a escala 8 para no redondear evidencia.
 *
 * El adaptador es la única frontera de formateo: `planLiquidity` devuelve
 * `number` y aquí se convierte a string decimal de escala fija.
 */
import { planLiquidity } from "../../../src/core/liquidity-plan.js";
import type { P2pOffer } from "../../../src/types.js";

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

function obj(input: Input, key: string): Input {
  const value = input[key];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`El campo ${key} debe ser un objeto.`);
  }
  return value as Input;
}

/** Fixed-scale decimal string without going through a locale float formatter. */
function dec(value: number, scale = 8): string {
  if (!Number.isFinite(value)) return String(value);
  if (scale < 0 || scale > 12) throw new Error("Escala no soportada.");
  return Number(value.toFixed(scale)).toFixed(scale);
}

function offerOf(raw: Input): P2pOffer {
  const offer: P2pOffer = {
    uuid: text(raw, "uuid"),
    type: text(raw, "type") as P2pOffer["type"],
    coin: text(raw, "coin"),
    amount: num(raw, "amount"),
    receive: num(raw, "receive"),
    status: text(raw, "status") as P2pOffer["status"],
  };
  const optionalFields = [
    "offer_kind",
    "available_amount",
    "order_min",
    "order_max",
    "only_kyc",
    "only_vip",
    "private",
    "message",
    "webhook",
    "created_at",
  ] as const;
  for (const key of optionalFields) {
    if (raw[key] !== undefined) (offer as Record<string, unknown>)[key] = raw[key];
  }
  if (raw.details !== undefined) offer.details = raw.details as Record<string, string>;
  if (raw.tags !== undefined) offer.tags = raw.tags as string[];
  return offer;
}

function snapshotOffer(planned: ReturnType<typeof planLiquidity>["cancel"][number]) {
  return {
    uuid: planned.uuid,
    coin: planned.coin,
    amount: dec(planned.amount),
    receive: dec(planned.receive),
    rate: dec(planned.rate),
    details: planned.details.map((detail) => ({ name: detail.name, value: detail.value })),
    ...(planned.message === undefined ? {} : { message: planned.message }),
    tags: planned.tags.slice(),
    onlyKyc: planned.onlyKyc,
    onlyVip: planned.onlyVip,
    private: planned.private,
    ...(planned.webhook === undefined ? {} : { webhook: planned.webhook }),
    ...(planned.createdAt === undefined ? {} : { createdAt: planned.createdAt }),
    profitabilityPercent: dec(planned.profitabilityPercent),
    consumeQusd: dec(planned.consumeQusd),
    restoreQusd: dec(planned.restoreQusd),
  };
}

export const ops = {
  "liquidity.plan": (input: Input) => {
    const targetRaw = obj(input, "target");
    const ownOffers = input.ownOffers;
    if (!Array.isArray(ownOffers)) throw new Error("El campo ownOffers debe ser un array.");
    const plan = planLiquidity({
      target: {
        amount: num(targetRaw, "amount"),
        coin: text(targetRaw, "coin"),
        type: text(targetRaw, "type") as P2pOffer["type"],
        receive: num(targetRaw, "receive"),
      },
      availableQusd: num(input, "availableQusd"),
      reserveQusd: num(input, "reserveQusd"),
      ownOffers: (ownOffers as Input[]).map(offerOf),
      ...(input.marketEconomics === undefined
        ? {}
        : { marketEconomics: input.marketEconomics as Parameters<typeof planLiquidity>[0]["marketEconomics"] }),
    });
    return {
      feasible: plan.feasible,
      targetQusd: dec(plan.targetQusd),
      immediatelyAvailableQusd: dec(plan.immediatelyAvailableQusd),
      requiredReleaseQusd: dec(plan.requiredReleaseQusd),
      plannedReleaseQusd: dec(plan.plannedReleaseQusd),
      potentialReleaseQusd: dec(plan.potentialReleaseQusd),
      cancel: plan.cancel.map(snapshotOffer),
      reason: plan.reason,
    };
  },
};
