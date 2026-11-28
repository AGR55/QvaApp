/**
 * Operaciones de conformidad para `src/mobile-operator.ts`.
 *
 * Los casos observan el contrato móvil: token solo hasheado, cupos separados de
 * lectura/escritura, revocación, auditoría de acciones inciertas y composición
 * de la lista de operaciones (incluidas órdenes hermanas).
 */
import { MobileOperatorService } from "../../../src/mobile-operator.js";

type Input = Record<string, unknown>;

function num(input: Input, key: string, fallback: number): number {
  const value = input[key];
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`El campo ${key} debe ser un número finito.`);
  }
  return value;
}

function list(input: Input, key: string): Input[] {
  const value = input[key];
  if (!Array.isArray(value)) throw new Error(`El campo ${key} debe ser un array.`);
  return value as Input[];
}

function noopDependencies(overrides: Record<string, unknown> = {}) {
  return {
    operations: () => [],
    alerts: () => [],
    markets: () => [],
    markPaid: async () => undefined,
    confirmReceived: async () => undefined,
    cancel: async () => undefined,
    ...overrides,
  };
}

export const ops = {
  "mobile.operator.credentials": () => {
    let saved = "";
    let now = 100_000;
    const audit: string[] = [];
    const service = new MobileOperatorService(
      {
        get: () => saved || undefined,
        set: (_key, value) => {
          saved = value;
        },
        audit: (action) => audit.push(action),
      },
      noopDependencies() as never,
      () => now,
    );
    const { operator, token } = service.pair("Pixel");
    const tokenLength = token.length;
    const tokenStored = saved.includes(token);
    const first = service.check(token).ok;
    for (let count = 1; count < 60; count += 1) service.check(token);
    const rateLimitedAfter60 = service.check(token).rateLimited === true;
    const readOkAfterWriteLimit = service.check(token, true).ok === true;
    for (let count = 1; count < 20; count += 1) service.check(token, true);
    const readRateLimitedAfter20 = service.check(token, true).rateLimited === true;
    const writeStillLimited = service.check(token).ok === false;
    now += 60_001;
    const okAfterWindow = service.check(token).ok === true;
    const revoked = service.revoke(operator.id);
    const checkAfterRevoke = service.check(token).ok;
    return {
      tokenLength,
      tokenStored,
      first,
      rateLimitedAfter60,
      readOkAfterWriteLimit,
      readRateLimitedAfter20,
      writeStillLimited,
      okAfterWindow,
      revoked,
      checkAfterRevoke,
      audit,
    };
  },

  "mobile.operator.action-uncertain": async () => {
    const audit: string[] = [];
    const service = new MobileOperatorService(
      {
        get: () => undefined,
        set: () => undefined,
        audit: (action) => audit.push(action),
      },
      noopDependencies({
        markPaid: async () => {
          throw new Error("QvaPay timeout");
        },
      }) as never,
    );
    let message = "";
    try {
      await service.act("operator-1", "operation-1", "paid", "REF-1");
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    return { error: message, audit };
  },

  "mobile.operator.action-audit-failure": async () => {
    let mutations = 0;
    const timings: Record<string, unknown>[] = [];
    const service = new MobileOperatorService(
      {
        get: () => undefined,
        set: () => undefined,
        audit: (action, detail) => {
          if (action === "mobile_action_timing") timings.push(JSON.parse(detail));
          if (action === "mobile_paid_confirmed") throw new Error("audit unavailable");
        },
      },
      noopDependencies({
        markPaid: async () => {
          mutations += 1;
        },
      }) as never,
    );
    await service.act("operator", "operation", "paid", "SECRET");
    return {
      mutations,
      outcome: timings[0]?.outcome,
      totalMsAtLeastZero: Number(timings[0]?.totalMs) >= 0,
      secretLeaked: JSON.stringify(timings).includes("SECRET"),
    };
  },

  "mobile.operator.operations": (input: Input) => {
    const service = new MobileOperatorService(
      { get: () => undefined, set: () => undefined, audit: () => undefined },
      noopDependencies({
        operations: () => list(input, "operations"),
        alerts: () => list(input, "alerts"),
        markets: () => list(input, "markets"),
      }) as never,
    );
    const operations = service.operations(num(input, "limit", 10));
    return {
      operations: operations.map((operation) => ({
        uuid: operation.uuid,
        orderUuid: operation.orderUuid,
        actions: operation.actions,
      })),
      alerts: service.alerts(),
    };
  },

  "mobile.operator.threads": (input: Input) => {
    const service = new MobileOperatorService(
      { get: () => undefined, set: () => undefined, audit: () => undefined },
      noopDependencies({
        operations: () => list(input, "operations"),
        threads: () => list(input, "threads"),
        markets: () => list(input, "markets"),
      }) as never,
    );
    const operations = service.operations(num(input, "limit", 100));
    return {
      operations: operations.map((operation) => ({
        id: operation.id,
        uuid: operation.uuid,
        orderUuid: operation.orderUuid,
        side: operation.side,
        role: operation.role,
        chatAvailable: operation.chatAvailable,
        actions: operation.actions,
      })),
    };
  },
};
