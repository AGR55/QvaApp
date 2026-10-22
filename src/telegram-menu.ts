import { randomBytes } from "node:crypto";
import type { FiatMarket } from "./types.js";

export const TELEGRAM_COMMANDS = [
  { command: "panel", description: "Centro de operaciones" },
  { command: "balance", description: "Saldo disponible en QvaPay" },
  { command: "hunting", description: "Configurar las cacerías" },
  { command: "network", description: "Red cooperativa entre bots" },
  { command: "coop", description: "Gestionar mi aporte cooperativo" },
  { command: "markets", description: "Consultar mercados P2P" },
  { command: "offers", description: "Administrar mis ofertas" },
  { command: "recovery", description: "Conciliar, registrar evidencia y reconocer avisos" },
  { command: "operations", description: "Operaciones activas" },
  { command: "strategy", description: "Estrategia y límites actuales" },
  { command: "automation", description: "Activar o pausar automatización" },
  { command: "scan", description: "Escanear los mercados ahora" },
  { command: "logs", description: "Eventos recientes del bot" },
  { command: "diagnostico", description: "Por qué se toman o descartan ofertas" },
  { command: "historial", description: "Movimientos y saldos del fiat" },
  { command: "salud", description: "Estado del feed, medianas y latencia" },
  { command: "rentabilidad", description: "Resultado documentado y estimado por moneda" },
  { command: "simular", description: "Comparar precios sin cambiar las cacerías" },
  { command: "help", description: "Ayuda y comandos avanzados" },
] as const;

export const HUNTING_CALLBACK_PREFIX = "hunt:";

export type HuntingSide = "buy" | "sell";
export type HuntingAction =
  | { type: "home" }
  | { type: "global-toggle"; side: HuntingSide }
  | { type: "market"; coin: FiatMarket }
  | { type: "market-toggle"; side: HuntingSide; coin: FiatMarket }
  | { type: "rate-edit"; side: HuntingSide; coin: FiatMarket }
  | { type: "rate-confirm"; token: string }
  | { type: "rate-cancel"; token: string };

export function encodeHuntingAction(action: HuntingAction): string {
  const encoded = (() => {
    switch (action.type) {
      case "home":
        return "hunt:home";
      case "global-toggle":
        return `hunt:g:${action.side}`;
      case "market":
        return `hunt:m:${action.coin}`;
      case "market-toggle":
        return `hunt:t:${action.side}:${action.coin}`;
      case "rate-edit":
        return `hunt:e:${action.side}:${action.coin}`;
      case "rate-confirm":
        return `hunt:y:${action.token}`;
      case "rate-cancel":
        return `hunt:n:${action.token}`;
    }
  })();
  if (Buffer.byteLength(encoded) > 64)
    throw new Error("La acción de Telegram supera el límite permitido.");
  return encoded;
}

export function decodeHuntingAction(data: string): HuntingAction {
  const parts = data.split(":");
  if (parts[0] !== "hunt") throw new Error("Acción de cacería inválida.");
  if (parts[1] === "home" && parts.length === 2) return { type: "home" };
  if (parts[1] === "g" && parts.length === 3)
    return { type: "global-toggle", side: side(parts[2]) };
  if (parts[1] === "m" && parts.length === 3)
    return { type: "market", coin: market(parts[2]) };
  if (parts[1] === "t" && parts.length === 4)
    return {
      type: "market-toggle",
      side: side(parts[2]),
      coin: market(parts[3]),
    };
  if (parts[1] === "e" && parts.length === 4)
    return {
      type: "rate-edit",
      side: side(parts[2]),
      coin: market(parts[3]),
    };
  if (parts[1] === "y" && parts.length === 3)
    return { type: "rate-confirm", token: token(parts[2]) };
  if (parts[1] === "n" && parts.length === 3)
    return { type: "rate-cancel", token: token(parts[2]) };
  throw new Error("Acción de cacería inválida.");
}

export function parseExactRate(text: string): number {
  const normalized = text.trim().replace(",", ".");
  if (!/^\d+(?:\.\d+)?$/.test(normalized))
    throw new Error("Escribe una tasa positiva usando solo números.");
  const value = Number(normalized);
  if (!Number.isFinite(value) || value <= 0)
    throw new Error("La tasa debe ser mayor que cero.");
  return value;
}

type RateInput = {
  stage: "input";
  token: string;
  coin: FiatMarket;
  side: HuntingSide;
  previousRate: number;
};
type RateConfirmation = Omit<RateInput, "stage"> & {
  stage: "confirm";
  proposedRate: number;
};
export type PendingRateEdit = RateInput | RateConfirmation;

export class HuntingRateSessions {
  private readonly pending = new Map<string, PendingRateEdit>();

  constructor(
    private readonly createToken = () => randomBytes(6).toString("base64url"),
  ) {}

  begin(
    chatId: string,
    coin: FiatMarket,
    side: HuntingSide,
    previousRate: number,
  ): RateInput {
    const value: RateInput = {
      stage: "input",
      token: this.createToken(),
      coin: market(coin),
      side,
      previousRate,
    };
    this.pending.set(chatId, value);
    return value;
  }

  current(chatId: string): PendingRateEdit | undefined {
    return this.pending.get(chatId);
  }

  propose(chatId: string, text: string): RateConfirmation {
    const current = this.pending.get(chatId);
    if (!current) throw new Error("No hay una edición de tasa pendiente.");
    const value: RateConfirmation = {
      stage: "confirm",
      token: current.token,
      coin: current.coin,
      side: current.side,
      previousRate: current.previousRate,
      proposedRate: parseExactRate(text),
    };
    this.pending.set(chatId, value);
    return value;
  }

  confirm(chatId: string, confirmationToken: string): RateConfirmation {
    const current = this.pending.get(chatId);
    if (
      !current ||
      current.stage !== "confirm" ||
      current.token !== confirmationToken
    )
      throw new Error("Esta confirmación de tasa ya no está vigente.");
    this.pending.delete(chatId);
    return current;
  }

  cancel(chatId: string, confirmationToken?: string): PendingRateEdit | undefined {
    const current = this.pending.get(chatId);
    if (!current) return undefined;
    if (confirmationToken && current.token !== confirmationToken)
      throw new Error("Esta edición de tasa ya no está vigente.");
    this.pending.delete(chatId);
    return current;
  }
}

function side(value: string | undefined): HuntingSide {
  if (value === "buy" || value === "sell") return value;
  throw new Error("Lado de cacería inválido.");
}

function market(value: string | undefined): FiatMarket {
  if (value && /^[A-Z0-9_]{2,40}$/.test(value)) return value;
  throw new Error("Mercado de cacería inválido.");
}

function token(value: string | undefined): string {
  if (value && /^[A-Za-z0-9_-]{1,24}$/.test(value)) return value;
  throw new Error("Confirmación de tasa inválida.");
}
