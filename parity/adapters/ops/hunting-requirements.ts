/**
 * Operaciones de conformidad para `src/hunting-requirements.ts`.
 *
 * Contrato `hunt.requirements`:
 *   input  = { offer, now, actions[] }
 *            `actions` reproduce la secuencia de lecturas de la API que el test
 *            original hace sobre un shim `{get,set}`:
 *              {kind:"eligibility", value:<payload QvaPay>, at:<epoch ms>}
 *              {kind:"missing",     value:<requirements[]>,   at:<epoch ms>}
 *   output = { reason: string|null } — el motivo exacto que devuelve el oráculo
 *            (`null` cuando no hay bloqueo).
 *
 * Es determinista: no hay reloj real ni red; los hechos se inyectan con `at`.
 */
import {
  huntingRequirementReason,
  recordHuntingEligibility,
  recordMissingRequirements,
} from "../../../src/hunting-requirements.js";
import type { P2pOffer } from "../../../src/types.js";

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

function obj(input: Input, key: string): Input {
  const value = input[key];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`El campo ${key} debe ser un objeto.`);
  }
  return value as Input;
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
  if (raw.requirements !== undefined) {
    offer.requirements = raw.requirements as P2pOffer["requirements"];
  }
  if (raw.requirements_met !== undefined) offer.requirements_met = raw.requirements_met as boolean;
  if (raw.only_kyc !== undefined) offer.only_kyc = raw.only_kyc as boolean | number;
  return offer;
}

export const ops = {
  "hunt.requirements": (input: Input) => {
    const values = new Map<string, string>();
    const state = {
      get: (key: string) => values.get(key),
      set: (key: string, value: string) => void values.set(key, value),
    };
    const actions = input.actions ?? [];
    if (!Array.isArray(actions)) throw new Error("El campo actions debe ser un array.");
    for (const action of actions as Input[]) {
      const kind = text(action, "kind");
      const at = num(action, "at");
      if (kind === "eligibility") recordHuntingEligibility(state, action.value, at);
      else if (kind === "missing") recordMissingRequirements(state, action.value, at);
      else throw new Error(`Acción de requisitos desconocida: ${kind}.`);
    }
    const reason = huntingRequirementReason(state, offerOf(obj(input, "offer")), num(input, "now"));
    return { reason: reason ?? null };
  },
};
