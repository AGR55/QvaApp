/**
 * Operaciones de conformidad para `src/telegram-menu.ts`.
 *
 * - `telegram.commands`      → menú nativo declarado (orden, unicidad, textos).
 * - `telegram.encode`        → acción de cacería codificada y bytes (límite 64).
 * - `telegram.decode`        → acción decodificada; entrada inválida produce error.
 * - `telegram.parse-rate`    → tasa exacta con punto o coma decimal.
 * - `telegram.rate-sessions` → flujo de edición de tasa con tokens `tokenN`.
 */
import {
  HUNTING_CALLBACK_PREFIX,
  HuntingRateSessions,
  TELEGRAM_COMMANDS,
  decodeHuntingAction,
  encodeHuntingAction,
  parseExactRate,
} from "../../../src/telegram-menu.js";

type Input = Record<string, unknown>;

function text(input: Input, key: string): string {
  const value = input[key];
  if (typeof value !== "string") throw new Error(`El campo ${key} debe ser texto.`);
  return value;
}

function optionalText(input: Input, key: string): string | undefined {
  const value = input[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(`El campo ${key} debe ser texto.`);
  return value;
}

function rateView(session: unknown): unknown {
  if (session === undefined) return undefined;
  const item = session as Record<string, unknown>;
  return {
    stage: item.stage,
    token: item.token,
    coin: item.coin,
    side: item.side,
    previousRate: item.previousRate,
    proposedRate: item.proposedRate,
  };
}

export const ops = {
  "telegram.commands": () => {
    const commands = TELEGRAM_COMMANDS.map((item) => item.command);
    return {
      commands,
      descriptions: TELEGRAM_COMMANDS.map((item) => item.description),
      unique: new Set(commands).size === commands.length,
      allDescribed: TELEGRAM_COMMANDS.every((item) => item.description.length > 0),
    };
  },

  "telegram.encode": (input: Input) => {
    const action = input.action;
    if (!action || typeof action !== "object" || Array.isArray(action)) {
      throw new Error("El campo action debe ser un objeto.");
    }
    const encoded = encodeHuntingAction(action as never);
    return { encoded, bytes: Buffer.byteLength(encoded), prefix: HUNTING_CALLBACK_PREFIX };
  },

  "telegram.decode": (input: Input) => {
    return { action: decodeHuntingAction(text(input, "data")) };
  },

  "telegram.roundtrip": (input: Input) => {
    const actions = input.actions;
    if (!Array.isArray(actions)) throw new Error("El campo actions debe ser un array.");
    return {
      results: actions.map((action) => {
        const encoded = encodeHuntingAction(action as never);
        return {
          encoded,
          bytes: Buffer.byteLength(encoded),
          decoded: decodeHuntingAction(encoded),
        };
      }),
    };
  },

  "telegram.parse-rates": (input: Input) => {
    const texts = input.texts;
    if (!Array.isArray(texts)) throw new Error("El campo texts debe ser un array.");
    return {
      results: texts.map((value) => {
        try {
          return { value: parseExactRate(text({ text: value }, "text")) };
        } catch (error) {
          return { error: error instanceof Error ? error.message : String(error) };
        }
      }),
    };
  },

  "telegram.parse-rate": (input: Input) => {
    return { value: parseExactRate(text(input, "text")) };
  },

  "telegram.rate-sessions": (input: Input) => {
    const steps = input.steps;
    if (!Array.isArray(steps)) throw new Error("El campo steps debe ser un array.");
    let serial = 0;
    const sessions = new HuntingRateSessions(() => `token${++serial}`);
    const results: unknown[] = [];
    for (const raw of steps) {
      const step = raw as Input;
      const op = text(step, "op");
      try {
        switch (op) {
          case "begin":
            results.push(rateView(sessions.begin(
              text(step, "chatId"),
              text(step, "coin") as never,
              text(step, "side") as never,
              step.previousRate as number,
            )));
            break;
          case "propose":
            results.push(rateView(sessions.propose(text(step, "chatId"), text(step, "text"))));
            break;
          case "confirm":
            results.push(rateView(sessions.confirm(text(step, "chatId"), text(step, "token"))));
            break;
          case "cancel":
            results.push(rateView(sessions.cancel(text(step, "chatId"), optionalText(step, "token"))));
            break;
          case "current":
            results.push(rateView(sessions.current(text(step, "chatId"))));
            break;
          default:
            throw new Error(`Operación de tasa desconocida: ${op}.`);
        }
      } catch (error) {
        results.push({ error: error instanceof Error ? error.message : String(error) });
      }
    }
    return { results };
  },
};
