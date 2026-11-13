/**
 * Operaciones de conformidad para `src/dashboard-auth.ts`.
 *
 * No se devuelven cookies ni tokens reales (aleatorios): los casos observan
 * propiedades estables (flags de cookie, aceptación CSRF, códigos de error y
 * expiración). El reloj y la duración se inyectan.
 */
import { DashboardAuth, DashboardAuthError } from "../../../src/dashboard-auth.js";

type Input = Record<string, unknown>;

function text(input: Input, key: string): string {
  const value = input[key];
  if (typeof value !== "string") throw new Error(`El campo ${key} debe ser texto.`);
  return value;
}

function num(input: Input, key: string, fallback?: number): number {
  const value = input[key];
  if (value === undefined && fallback !== undefined) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`El campo ${key} debe ser un número finito.`);
  }
  return value;
}

function statusOf(error: unknown): number | undefined {
  return error instanceof DashboardAuthError ? error.status : undefined;
}

function cookieFlags(cookie: string): { httpOnly: boolean; sameSiteStrict: boolean; maxAge: number } {
  const match = /Max-Age=(\d+)/.exec(cookie);
  return {
    httpOnly: /HttpOnly/.test(cookie),
    sameSiteStrict: /SameSite=Strict/.test(cookie),
    maxAge: match ? Number(match[1]) : -1,
  };
}

export const ops = {
  "auth.login": (input: Input) => {
    const auth = new DashboardAuth({
      password: text(input, "password"),
      trustedOrigin: text(input, "trustedOrigin"),
      now: () => num(input, "now", 1_000),
      ...(input.sessionDurationMs === undefined ? {} : { sessionDurationMs: num(input, "sessionDurationMs") }),
    });
    const login = auth.login(text(input, "loginPassword"), text(input, "clientId"));
    auth.assertCsrf(login.cookie, login.csrfToken);
    let wrongCsrfStatus: number | undefined;
    try {
      auth.assertCsrf(login.cookie, "otro");
    } catch (error) {
      wrongCsrfStatus = statusOf(error);
    }
    return {
      ...cookieFlags(login.cookie),
      expiresAt: login.expiresAt,
      csrfAccepted: true,
      wrongCsrfStatus,
    };
  },

  "auth.origins": (input: Input) => {
    const auth = new DashboardAuth({
      password: text(input, "password"),
      trustedOrigin: text(input, "trustedOrigin"),
      now: () => num(input, "now", 1_000),
    });
    const origins = input.origins;
    if (!Array.isArray(origins)) throw new Error("El campo origins debe ser un array.");
    return {
      results: origins.map((origin) => {
        try {
          auth.assertOrigin(origin === null ? undefined : (origin as string));
          return { ok: true };
        } catch (error) {
          return { ok: false, status: statusOf(error) };
        }
      }),
    };
  },

  "auth.origins-rate-limit": (input: Input) => {
    const auth = new DashboardAuth({
      password: text(input, "password"),
      trustedOrigin: text(input, "trustedOrigin"),
      now: () => num(input, "now", 0),
    });
    const origins = input.origins;
    if (!Array.isArray(origins)) throw new Error("El campo origins debe ser un array.");
    const originResults = origins.map((origin) => {
      try {
        auth.assertOrigin(origin === null ? undefined : (origin as string));
        return { ok: true };
      } catch (error) {
        return { ok: false, status: statusOf(error) };
      }
    });
    const clientId = text(input, "clientId");
    const failed = num(input, "failed");
    const failedStatuses: number[] = [];
    for (let attempt = 0; attempt < failed; attempt += 1) {
      try {
        auth.login("incorrecta", clientId);
      } catch (error) {
        const status = statusOf(error);
        if (status !== undefined) failedStatuses.push(status);
      }
    }
    let finalStatus: number | undefined;
    try {
      auth.login(text(input, "password"), clientId);
    } catch (error) {
      finalStatus = statusOf(error);
    }
    return { origins: originResults, failedStatuses, finalStatus };
  },

  "auth.rate-limit": (input: Input) => {
    let now = num(input, "now", 0);
    const auth = new DashboardAuth({
      password: text(input, "password"),
      trustedOrigin: text(input, "trustedOrigin"),
      now: () => now,
    });
    const clientId = text(input, "clientId");
    const failed = num(input, "failed");
    const statuses: number[] = [];
    for (let attempt = 0; attempt < failed; attempt += 1) {
      try {
        auth.login("incorrecta", clientId);
      } catch (error) {
        const status = statusOf(error);
        if (status !== undefined) statuses.push(status);
      }
    }
    let finalStatus: number | undefined;
    try {
      auth.login(text(input, "password"), clientId);
    } catch (error) {
      finalStatus = statusOf(error);
    }
    now += num(input, "advance", 0);
    return { failedStatuses: statuses, finalStatus };
  },

  "auth.session": (input: Input) => {
    let now = num(input, "now", 0);
    const auth = new DashboardAuth({
      password: text(input, "password"),
      trustedOrigin: text(input, "trustedOrigin"),
      now: () => now,
      sessionDurationMs: num(input, "sessionDurationMs"),
    });
    const login = auth.login(text(input, "password"), "local");
    const before = auth.session(login.cookie) !== undefined;
    now += num(input, "advance");
    const after = auth.session(login.cookie) !== undefined;
    return { before, after };
  },
};
