import { randomBytes } from "node:crypto";
import type { FiatMarket } from "./types.js";

export const COOPERATIVE_CALLBACK_PREFIX = "coop:";

export type CooperativeAction =
  | { type: "home" }
  | { type: "refresh" }
  | { type: "edit"; coin: FiatMarket }
  | { type: "withdraw"; coin: FiatMarket }
  | { type: "withdraw-confirm"; coin: FiatMarket }
  | { type: "confirm"; token: string }
  | { type: "cancel"; token: string };

export function encodeCooperativeAction(action: CooperativeAction): string {
  const encoded = (() => {
    switch (action.type) {
      case "home":
        return "coop:home";
      case "refresh":
        return "coop:refresh";
      case "edit":
        return `coop:e:${action.coin}`;
      case "withdraw":
        return `coop:w:${action.coin}`;
      case "withdraw-confirm":
        return `coop:x:${action.coin}`;
      case "confirm":
        return `coop:y:${action.token}`;
      case "cancel":
        return `coop:n:${action.token}`;
    }
  })();
  if (Buffer.byteLength(encoded) > 64)
    throw new Error("La acción cooperativa supera el límite permitido.");
  return encoded;
}

export function decodeCooperativeAction(data: string): CooperativeAction {
  const parts = data.split(":");
  if (parts[0] !== "coop") throw new Error("Acción cooperativa inválida.");
  if (parts[1] === "home" && parts.length === 2) return { type: "home" };
  if (parts[1] === "refresh" && parts.length === 2) return { type: "refresh" };
  if (parts[1] === "e" && parts.length === 3)
    return { type: "edit", coin: market(parts[2]) };
  if (parts[1] === "w" && parts.length === 3)
    return { type: "withdraw", coin: market(parts[2]) };
  if (parts[1] === "x" && parts.length === 3)
    return { type: "withdraw-confirm", coin: market(parts[2]) };
  if (parts[1] === "y" && parts.length === 3)
    return { type: "confirm", token: token(parts[2]) };
  if (parts[1] === "n" && parts.length === 3)
    return { type: "cancel", token: token(parts[2]) };
  throw new Error("Acción cooperativa inválida.");
}

export type CooperativeDraft = {
  coin: FiatMarket;
  price: number;
  minimal: number;
  fiat: number;
};

type CooperativeSession = {
  stage: "price" | "minimal" | "fiat" | "confirm";
  token: string;
  coin: FiatMarket;
  price?: number;
  minimal?: number;
  fiat?: number;
};

export class CooperativeContributionSessions {
  private readonly pending = new Map<string, CooperativeSession>();

  constructor(
    private readonly createToken = () => randomBytes(6).toString("base64url"),
  ) {}

  begin(chatId: string, coin: FiatMarket): CooperativeSession {
    const session: CooperativeSession = {
      stage: "price",
      token: this.createToken(),
      coin: market(coin),
    };
    this.pending.set(chatId, session);
    return session;
  }

  current(chatId: string): CooperativeSession | undefined {
    return this.pending.get(chatId);
  }

  accept(chatId: string, text: string): CooperativeSession {
    const current = this.pending.get(chatId);
    if (!current || current.stage === "confirm")
      throw new Error("No hay una aportación esperando datos.");
    const value = positiveNumber(text);
    const next: CooperativeSession = { ...current };
    if (current.stage === "price") {
      next.price = value;
      next.stage = "minimal";
    } else if (current.stage === "minimal") {
      next.minimal = value;
      next.stage = "fiat";
    } else {
      next.fiat = value;
      next.stage = "confirm";
    }
    this.pending.set(chatId, next);
    return next;
  }

  confirm(chatId: string, confirmationToken: string): CooperativeDraft {
    const current = this.pending.get(chatId);
    if (
      !current ||
      current.stage !== "confirm" ||
      current.token !== confirmationToken ||
      current.price === undefined ||
      current.minimal === undefined ||
      current.fiat === undefined
    )
      throw new Error("Esta confirmación cooperativa ya no está vigente.");
    this.pending.delete(chatId);
    return {
      coin: current.coin,
      price: current.price,
      minimal: current.minimal,
      fiat: current.fiat,
    };
  }

  cancel(chatId: string, confirmationToken?: string): CooperativeSession | undefined {
    const current = this.pending.get(chatId);
    if (!current) return undefined;
    if (confirmationToken && current.token !== confirmationToken)
      throw new Error("Esta edición cooperativa ya no está vigente.");
    this.pending.delete(chatId);
    return current;
  }
}

function positiveNumber(text: string): number {
  const normalized = text.trim().replace(",", ".");
  if (!/^\d+(?:\.\d+)?$/.test(normalized))
    throw new Error("Escribe un importe positivo usando solo números.");
  const value = Number(normalized);
  if (!Number.isFinite(value) || value <= 0)
    throw new Error("El importe debe ser mayor que cero.");
  return value;
}

function market(value: string | undefined): FiatMarket {
  if (value && /^[A-Z0-9_]{2,40}$/.test(value)) return value;
  throw new Error("Mercado cooperativo inválido.");
}

function token(value: string | undefined): string {
  if (value && /^[A-Za-z0-9_-]{1,24}$/.test(value)) return value;
  throw new Error("Confirmación cooperativa inválida.");
}
