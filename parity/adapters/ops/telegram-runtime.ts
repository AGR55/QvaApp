/**
 * Operaciones de conformidad para `src/telegram-runtime.ts`.
 *
 * - `telegram.answer-callback` → un callback expirado no derriba el proceso.
 * - `telegram.split-callback`  → conserva valores con dos puntos.
 * - `telegram.render-guard`    → una interacción nueva invalida las anteriores.
 * - `telegram.not-modified`    → reconoce "message is not modified".
 */
import {
  answerCallbackSafely,
  isMessageNotModified,
  splitCallbackData,
  TelegramRenderGuard,
} from "../../../src/telegram-runtime.js";

type Input = Record<string, unknown>;

function text(input: Input, key: string): string {
  const value = input[key];
  if (typeof value !== "string") throw new Error(`El campo ${key} debe ser texto.`);
  return value;
}

export const ops = {
  "telegram.answer-callback": async (input: Input) => {
    const scenario = text(input, "scenario");
    let calls = 0;
    const answered = await answerCallbackSafely(async () => {
      calls += 1;
      if (scenario === "expired") {
        throw new Error(
          "Call to 'answerCallbackQuery' failed! (400: Bad Request: query is too old and response timeout expired)",
        );
      }
      if (scenario === "invalid") {
        throw new Error("Bad Request: query ID is invalid");
      }
      if (scenario === "other") throw new Error("network error");
    });
    return { answered, calls };
  },

  "telegram.split-callback": (input: Input) => {
    const [action, value] = splitCallbackData(text(input, "data"));
    return { parts: [action, value] };
  },

  "telegram.render-guard": (input: Input) => {
    const steps = input.steps;
    if (!Array.isArray(steps)) throw new Error("El campo steps debe ser un array.");
    const guard = new TelegramRenderGuard();
    const revisions = new Map<string, number>();
    const results: unknown[] = [];
    for (const raw of steps) {
      const step = raw as Input;
      const op = text(step, "op");
      const key = text(step, "key");
      if (op === "begin") {
        const revision = guard.begin(key);
        revisions.set(text(step, "label"), revision);
        results.push({ revision });
      } else if (op === "isCurrent") {
        const revision = revisions.get(text(step, "label"));
        results.push({ current: revision !== undefined && guard.isCurrent(key, revision) });
      } else {
        throw new Error(`Operación de render desconocida: ${op}.`);
      }
    }
    return { results };
  },

  "telegram.not-modified": (input: Input) => {
    return { notModified: isMessageNotModified(new Error(text(input, "message"))) };
  },
};
