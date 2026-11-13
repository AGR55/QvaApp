/**
 * Operaciones de conformidad para `src/cooperative-menu.ts`.
 *
 * - `coop.encode`   → acción cooperativa codificada y bytes (límite 64).
 * - `coop.decode`   → acción decodificada; entrada inválida produce error.
 * - `coop.sessions` → flujo precio → mínimo → confirmación con token fijo.
 *
 * El token se inyecta (`token1`) para que el escenario sea determinista.
 */
import {
  COOPERATIVE_CALLBACK_PREFIX,
  CooperativeContributionSessions,
  decodeCooperativeAction,
  encodeCooperativeAction,
} from "../../../src/cooperative-menu.js";

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

function sessionView(session: unknown): unknown {
  if (session === undefined) return undefined;
  const item = session as Record<string, unknown>;
  return {
    stage: item.stage,
    token: item.token,
    coin: item.coin,
    price: item.price,
    minimal: item.minimal,
  };
}

export const ops = {
  "coop.encode": (input: Input) => {
    const action = input.action;
    if (!action || typeof action !== "object" || Array.isArray(action)) {
      throw new Error("El campo action debe ser un objeto.");
    }
    const encoded = encodeCooperativeAction(action as never);
    return { encoded, bytes: Buffer.byteLength(encoded), prefix: COOPERATIVE_CALLBACK_PREFIX };
  },

  "coop.decode": (input: Input) => {
    return { action: decodeCooperativeAction(text(input, "data")) };
  },

  "coop.roundtrip": (input: Input) => {
    const actions = input.actions;
    if (!Array.isArray(actions)) throw new Error("El campo actions debe ser un array.");
    return {
      results: actions.map((action) => {
        const encoded = encodeCooperativeAction(action as never);
        return {
          encoded,
          bytes: Buffer.byteLength(encoded),
          decoded: decodeCooperativeAction(encoded),
        };
      }),
    };
  },

  "coop.sessions": (input: Input) => {
    const steps = input.steps;
    if (!Array.isArray(steps)) throw new Error("El campo steps debe ser un array.");
    const sessions = new CooperativeContributionSessions(() => "token1");
    const results: unknown[] = [];
    for (const raw of steps) {
      const step = raw as Input;
      const op = text(step, "op");
      try {
        switch (op) {
          case "begin":
            results.push(sessionView(sessions.begin(text(step, "chatId"), text(step, "coin") as never)));
            break;
          case "accept":
            results.push(sessionView(sessions.accept(text(step, "chatId"), text(step, "text"))));
            break;
          case "confirm":
            results.push(sessions.confirm(text(step, "chatId"), text(step, "token")));
            break;
          case "cancel":
            results.push(sessionView(sessions.cancel(text(step, "chatId"), optionalText(step, "token"))));
            break;
          case "current":
            results.push(sessionView(sessions.current(text(step, "chatId"))));
            break;
          default:
            throw new Error(`Operación cooperativa desconocida: ${op}.`);
        }
      } catch (error) {
        results.push({ error: error instanceof Error ? error.message : String(error) });
      }
    }
    return { results };
  },
};
