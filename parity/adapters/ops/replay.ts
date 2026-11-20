/**
 * Operaciones del suite de replay stateful (`--suite replay`).
 *
 * Una sesión vive en el proceso del SUT entre peticiones; el runner la abre,
 * ejecuta los pasos del caso y la cierra. Cada sesión usa SQLite temporal,
 * reloj inyectado y gateway guionizado: sin red, sin reloj real y sin sleeps.
 */
import {
  ReplaySession,
  type ReplaySessionSpec,
  type ReplayStepInput,
} from "../../lib/replay/session.js";

const sessions = new Map<string, ReplaySession>();

function sessionId(input: Record<string, unknown>): string {
  const id = input.sessionId;
  if (typeof id !== "string" || !id) throw new Error("Falta sessionId.");
  return id;
}

export const ops = {
  "replay.start": async (input: Record<string, unknown>) => {
    const id = sessionId(input);
    if (sessions.has(id)) throw new Error(`La sesión ${id} ya existe.`);
    const spec = input.session as ReplaySessionSpec | undefined;
    if (!spec?.clock || !Number.isFinite(spec.clock.start)) {
      throw new Error("replay.start requiere session.clock.start.");
    }
    const session = ReplaySession.start(spec);
    sessions.set(id, session);
    const snapshot = await session.step("trading.state", {});
    return { sessionId: id, stateDigest: snapshot.stateDigest };
  },

  "replay.step": async (input: Record<string, unknown>) => {
    const id = sessionId(input);
    const session = sessions.get(id);
    if (!session) throw new Error(`Sesión desconocida: ${id}`);
    const op = input.op;
    if (typeof op !== "string") throw new Error("replay.step requiere op.");
    return session.step(op, (input.input ?? {}) as ReplayStepInput);
  },

  "replay.close": (input: Record<string, unknown>) => {
    const id = sessionId(input);
    const session = sessions.get(id);
    if (!session) throw new Error(`Sesión desconocida: ${id}`);
    sessions.delete(id);
    return { closed: true, ...session.close() };
  },
};
