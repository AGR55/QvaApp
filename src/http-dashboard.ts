import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import Fastify, {
  type FastifyInstance,
  type FastifyRequest,
} from "fastify";
import { DashboardReadModel, offerView } from "./dashboard.js";
import { DashboardAuth, DashboardAuthError } from "./dashboard-auth.js";
import type { TradingConfig } from "./market-config.js";
import { QvaApiError } from "./qvapay.js";
import type { TradingEngine } from "./trading.js";
import type { FiatMarket } from "./types.js";
import type { StoredPushSubscription, WebPushService } from "./web-push.js";

type AuthOptions = {
  password: string;
  trustedOrigin: string;
  secureCookies?: boolean;
};
type PushService = Pick<WebPushService, "publicKey" | "subscribe" | "unsubscribe">;

export async function startDashboard(
  readModel: DashboardReadModel,
  port = 3000,
  authOptions: AuthOptions,
  pushService?: PushService,
): Promise<FastifyInstance> {
  const app = buildDashboard(readModel, authOptions, pushService);
  await app.listen({ port, host: "127.0.0.1" });
  console.log(`Panel web: http://127.0.0.1:${port}`);
  return app;
}

export function buildDashboard(
  readModel: DashboardReadModel,
  authOptions: AuthOptions,
  pushService?: PushService,
): FastifyInstance {
  const app = Fastify({
    logger: false,
    bodyLimit: 10_000,
    requestTimeout: 15_000,
    connectionTimeout: 10_000,
    maxRequestsPerSocket: 100,
  });
  const auth = new DashboardAuth(authOptions);
  const publicRoot = resolve("public/dashboard");

  app.addHook("onSend", async (_request, reply, payload) => {
    reply
      .header("cache-control", "no-store")
      .header(
        "content-security-policy",
        "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
      )
      .header("referrer-policy", "no-referrer")
      .header("x-content-type-options", "nosniff")
      .header("x-frame-options", "DENY")
      .header("permissions-policy", "camera=(), microphone=(), geolocation=(), payment=()")
      .header("cross-origin-opener-policy", "same-origin");
    return payload;
  });

  app.addHook("preHandler", async (request) => {
    const path = request.url.split("?", 1)[0]!;
    const publicSession = path === "/api/session" && request.method !== "DELETE";
    if (!path.startsWith("/api/") || publicSession) return;
    if (!auth.session(request.headers.cookie))
      throw new DashboardAuthError(401, "Autenticación requerida.");
    if (!["GET", "HEAD"].includes(request.method)) {
      auth.assertOrigin(request.headers.origin);
      requireJson(request);
      auth.assertCsrf(request.headers.cookie, headerValue(request, "x-csrf-token"));
    }
  });

  app.setErrorHandler((error, _request, reply) => {
    const normalized = error instanceof Error ? error : new Error(String(error));
    const status = httpStatus(normalized, 500);
    if (status >= 500) console.error("Error HTTP local:", normalized);
    void reply.status(status).send({
      error: status >= 500 ? "No se pudo completar la solicitud." : normalized.message,
    });
  });

  app.get("/", async (_request, reply) =>
    reply.type("text/html; charset=utf-8").send(reactPage()),
  );
  app.get("/service-worker.js", async (_request, reply) =>
    reply.type("text/javascript; charset=utf-8").send(serviceWorkerScript()),
  );
  app.get<{ Params: { "*": string } }>("/dashboard/*", async (request, reply) => {
    const relative = request.params["*"];
    const file = resolve(publicRoot, relative);
    if (!file.startsWith(`${publicRoot}/`) || !existsSync(file))
      return reply.status(404).type("text/plain").send("Panel no compilado. Ejecuta pnpm build.");
    return reply
      .type(relative.endsWith(".css") ? "text/css; charset=utf-8" : "text/javascript; charset=utf-8")
      .send(readFileSync(file));
  });

  app.get("/api/session", async (request) => {
    const session = auth.session(request.headers.cookie);
    return {
      data: session
        ? { authenticated: true, csrfToken: session.csrfToken, expiresAt: session.expiresAt }
        : { authenticated: false },
    };
  });
  app.post<{ Body: { password: string } }>("/api/session", {
    schema: {
      body: {
        type: "object",
        additionalProperties: false,
        required: ["password"],
        properties: { password: { type: "string", minLength: 1, maxLength: 256 } },
      },
    },
  }, async (request, reply) => {
    auth.assertOrigin(request.headers.origin);
    const session = auth.login(request.body.password, request.ip);
    reply.header("set-cookie", session.cookie).status(201);
    return { data: { authenticated: true, csrfToken: session.csrfToken, expiresAt: session.expiresAt } };
  });
  app.delete("/api/session", async (request, reply) => {
    reply.header("set-cookie", auth.logout(request.headers.cookie)).status(204);
  });

  // Esta ruta es deliberadamente local: debe responder aunque QvaPay esté caído.
  app.get("/api/dashboard", async () => ({
    data: readModel.localSnapshot(),
    source: "sqlite",
  }));
  app.get("/api/live/balance", async () =>
    resilientResource(
      () => readModel.refreshBalance(),
      () => {
        const local = readModel.localSnapshot();
        return {
          data: local.balance,
          updatedAt: local.freshness.balance,
        };
      },
    ),
  );
  app.get("/api/live/own-offers", async () =>
    resilientResource(
      () => readModel.refreshOwnOffers(),
      () => {
        const local = readModel.localSnapshot();
        return {
          data: local.ownOffers,
          updatedAt: local.freshness.ownOffers,
        };
      },
    ),
  );
  app.get("/api/live/transactions", async () =>
    resilientResource(
      () => readModel.refreshTransactions(),
      () => {
        const local = readModel.localSnapshot();
        return {
          data: local.transactions,
          updatedAt: local.freshness.transactions,
        };
      },
    ),
  );
  app.get<{ Params: { coin: string } }>(
    "/api/live/markets/:coin",
    async (request) => {
      const coin = request.params.coin.trim();
      if (!/^[A-Z0-9_]{2,40}$/.test(coin) || !readModel.config().markets.some((item) => item.code === coin))
        throw new ClientInputError("Mercado inválido.");
      return resilientResource(
        () => readModel.refreshMarket(coin),
        () => {
          const local = readModel.localSnapshot();
          return {
            data: local.market[coin],
            updatedAt: local.freshness.markets[coin] ?? null,
          };
        },
      );
    },
  );
  app.get("/api/config", async () => ({ data: readModel.config() }));
  app.get("/api/config-revisions", async () => ({ data: readModel.configRevisions() }));
  app.put<{ Body: TradingConfig | { config: TradingConfig; reason?: string } }>("/api/config", async (request, reply) => {
    await clientAction(async () => {
      const payload = request.body;
      if (!isRecord(payload)) throw new ClientInputError("Configuración inválida.");
      const wrapped = "config" in payload;
      const next = wrapped ? payload.config as TradingConfig : payload as TradingConfig;
      if (!isRecord(next) || !isRecord(next.risk))
        throw new ClientInputError("Configuración inválida.");
      next.risk.reviewedAt = Date.now();
      readModel.saveConfig(next, wrapped && typeof payload.reason === "string" ? payload.reason : undefined);
    });
    reply.status(204);
  });
  app.put<{ Body: Parameters<TradingEngine["updateStrategy"]>[0] }>("/api/strategy", async (request, reply) => {
    await clientAction(() => readModel.updateStrategy(request.body));
    reply.status(204);
  });
  app.put<{ Body: Parameters<TradingEngine["updateHunting"]>[0] }>("/api/hunting", {
    schema: {
      body: {
        type: "object",
        additionalProperties: false,
        minProperties: 1,
        properties: {
          buyRunning: { type: "boolean" },
          sellRunning: { type: "boolean" },
          market: {
            type: "object",
            additionalProperties: false,
            required: ["code"],
            properties: {
              code: { type: "string", pattern: "^[A-Z0-9_]{2,40}$" },
              huntBuyEnabled: { type: "boolean" },
              huntSellEnabled: { type: "boolean" },
              buyMaxRate: { type: "number", exclusiveMinimum: 0 },
              sellMinRate: { type: "number", exclusiveMinimum: 0 },
            },
          },
        },
      },
    },
  }, async (request, reply) => {
    await clientAction(() => readModel.updateHunting(request.body));
    reply.status(204);
  });
  app.put<{ Body: { paused?: boolean; mode?: "simulation" | "real"; refresh?: boolean; emergencyStop?: boolean } }>("/api/control", {
    schema: {
      body: {
        type: "object",
        additionalProperties: false,
        properties: {
          paused: { type: "boolean" },
          mode: { type: "string", enum: ["simulation", "real"] },
          refresh: { type: "boolean" },
          emergencyStop: { type: "boolean" },
        },
      },
    },
  }, async (request, reply) => {
    const body = request.body;
    const supplied = Object.values(body).filter((value) => value !== undefined).length;
    if (body.emergencyStop !== undefined && supplied > 1)
      throw new ClientInputError("La parada de emergencia debe enviarse como una acción independiente.");
    await clientAction(async () => {
      if (body.emergencyStop !== undefined) readModel.setEmergencyStop(body.emergencyStop);
      if (body.mode !== undefined) readModel.setMode(body.mode);
      if (body.refresh !== undefined) readModel.setRefresh(body.refresh);
      if (body.paused !== undefined) await readModel.setPaused(body.paused);
    });
    reply.status(204);
  });
  app.get<{ Querystring: { coin?: string } }>("/api/market-analytics", async (request) => {
    const coin = request.query.coin?.trim();
    if (!coin || !/^[A-Z0-9_]{2,40}$/.test(coin))
      throw new ClientInputError("Mercado inválido.");
    return { data: await readModel.marketAnalytics(coin), source: "sqlite" };
  });
  app.post<{ Body: { coin: FiatMarket; type: "buy" | "sell"; amount: number; rate: number } }>("/api/offers", {
    schema: {
      body: {
        type: "object",
        additionalProperties: false,
        required: ["coin", "type", "amount", "rate"],
        properties: {
          coin: { type: "string", pattern: "^[A-Z0-9_]{2,40}$" },
          type: { type: "string", enum: ["buy", "sell"] },
          amount: { type: "number", exclusiveMinimum: 0 },
          rate: { type: "number", exclusiveMinimum: 0 },
        },
      },
    },
  }, async (request, reply) => {
    const body = request.body;
    if (!readModel.config().markets.some((market) => market.code === body.coin))
      throw new ClientInputError("Mercado inválido.");
    const offer = await clientAction(() =>
      readModel.createOwnOffer(body.coin, body.type, body.amount, body.rate));
    reply.status(201);
    return { data: offerView(offer) };
  });
  app.put<{ Params: { uuid: string }; Body: { amount: number; rate: number } }>("/api/offers/:uuid", {
    schema: {
      body: {
        type: "object",
        additionalProperties: false,
        required: ["amount", "rate"],
        properties: {
          amount: { type: "number", exclusiveMinimum: 0 },
          rate: { type: "number", exclusiveMinimum: 0 },
        },
      },
    },
  }, async (request, reply) => {
    await clientAction(() =>
      readModel.editOwnOffer(request.params.uuid, request.body.amount, request.body.rate));
    reply.status(204);
  });
  app.delete<{ Params: { uuid: string } }>("/api/offers/:uuid", async (request, reply) => {
    await clientAction(() => readModel.cancelOwnOffer(request.params.uuid));
    reply.status(204);
  });
  app.post<{ Params: { workflowId: string } }>("/api/workflows/:workflowId/reconcile", async (request) => ({
    data: await clientAction(() => readModel.reconcileWorkflow(request.params.workflowId)),
  }));
  app.post<{ Params: { uuid: string; action: string }; Body: { reference?: string } }>("/api/operations/:uuid/:action", {
    schema: {
      params: {
        type: "object",
        required: ["uuid", "action"],
        properties: {
          uuid: { type: "string", minLength: 1, maxLength: 100 },
          action: { type: "string", enum: ["ack", "paid", "received", "cancel"] },
        },
      },
      body: {
        type: "object",
        additionalProperties: false,
        properties: { reference: { type: "string", minLength: 1, maxLength: 200 } },
      },
    },
  }, async (request, reply) => {
    const { uuid, action } = request.params;
    if (action === "ack") await clientAction(() => readModel.acknowledge(uuid));
    else if (action === "paid") {
      const reference = request.body.reference?.trim();
      if (!reference) throw new ClientInputError("La referencia del pago es obligatoria.");
      await clientAction(() => readModel.markPaid(uuid, reference));
    } else if (action === "received") await clientAction(() => readModel.confirmReceived(uuid));
    else if (action === "cancel") await clientAction(() => readModel.cancelOperation(uuid));
    else throw new ClientInputError("Acción de operación inválida.");
    reply.status(204);
  });
  app.get("/api/audit", async () => ({ data: readModel.auditLog() }));
  app.get<{ Querystring: { decision?: string; status?: string; page?: string; pageSize?: string } }>(
    "/api/decision-events",
    async (request) => {
      const decision = request.query.decision;
      const status = request.query.status;
      if (decision && !["applied", "blocked", "manual_review"].includes(decision))
        throw new ClientInputError("Filtro de decisión inválido.");
      if (status && !["pending", "resolved", "all"].includes(status))
        throw new ClientInputError("Filtro de estado inválido.");
      return { data: readModel.decisionEvents({
        ...(decision ? { decision: decision as "applied" | "blocked" | "manual_review" } : {}),
        ...(status ? { status: status as "pending" | "resolved" | "all" } : {}),
        page: positiveInteger(request.query.page, 1),
        pageSize: positiveInteger(request.query.pageSize, 20),
      }), source: "sqlite" };
    },
  );
  app.post<{ Params: { id: string } }>("/api/decision-events/:id/dismiss", async (request, reply) => {
    const id = positiveInteger(request.params.id, 0);
    if (!id) throw new ClientInputError("Evento inválido.");
    readModel.dismissDecisionEvent(id);
    reply.status(204);
  });

  if (pushService) {
    app.get("/api/push/public-key", async () => ({ data: { publicKey: pushService.publicKey() } }));
    app.post<{ Body: StoredPushSubscription }>("/api/push/subscriptions", async (request, reply) => {
      const subscription = pushService.subscribe(request.body);
      reply.status(201);
      return { data: { endpoint: subscription.endpoint } };
    });
    app.delete<{ Body: { endpoint: string } }>("/api/push/subscriptions", async (request, reply) => {
      if (!request.body || typeof request.body.endpoint !== "string")
        throw new ClientInputError("Suscripción Push inválida.");
      pushService.unsubscribe(request.body.endpoint);
      reply.status(204);
    });
  }
  app.post<{ Params: { uuid: string } }>("/api/blocked-offers/:uuid/preview", {
    schema: { params: uuidParamsSchema() },
  }, async (request) => ({
    data: await clientAction(() => readModel.previewBlockedOffer(request.params.uuid)),
  }));
  app.post<{ Params: { uuid: string }; Body: { overridePriceGuard: boolean } }>(
    "/api/blocked-offers/:uuid/apply",
    {
      schema: {
        params: uuidParamsSchema(),
        body: {
          type: "object",
          additionalProperties: false,
          required: ["overridePriceGuard"],
          properties: { overridePriceGuard: { const: true } },
        },
      },
    },
    async (request) => ({
      data: { message: await clientAction(() => readModel.applyBlockedOffer(request.params.uuid)) },
    }),
  );
  app.post<{ Params: { uuid: string } }>("/api/blocked-offers/:uuid/dismiss", {
    schema: { params: uuidParamsSchema() },
  }, async (request, reply) => {
    await clientAction(() => readModel.dismissBlockedOffer(request.params.uuid));
    reply.status(204);
  });
  app.get("/api/openapi.json", async () => openApiDocument());
  return app;
}

function uuidParamsSchema() {
  return {
    type: "object",
    required: ["uuid"],
    properties: { uuid: { type: "string", minLength: 1, maxLength: 100 } },
  } as const;
}

class ClientInputError extends Error {}

async function clientAction<T>(action: () => T | Promise<T>): Promise<T> {
  try {
    return await action();
  } catch (error) {
    if (
      error instanceof ClientInputError ||
      error instanceof DashboardAuthError ||
      error instanceof QvaApiError
    ) throw error;
    throw new ClientInputError(message(error));
  }
}

async function resilientResource<T>(
  refresh: () => Promise<{ data: T; updatedAt: number }>,
  fallback: () => { data: T; updatedAt: number | null },
) {
  try {
    const current = await refresh();
    return { ...current, stale: false };
  } catch (error) {
    const cached = fallback();
    if (cached.updatedAt === null) throw error;
    return { ...cached, stale: true, error: message(error) };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function positiveInteger(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function serviceWorkerScript(): string {
  return `self.addEventListener("push", (event) => {
    let payload = {};
    try { payload = event.data ? event.data.json() : {}; } catch {}
    const alert = payload.alert || {};
    const title = payload.type === "blocked-offer" ? "Oferta requiere revisión" : "Actividad de QvaApply";
    const body = [alert.coin, alert.amount ? alert.amount + " QUSD" : "", alert.reason || ""].filter(Boolean).join(" · ");
    const url = payload.url || "/?view=auditoria";
    event.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      const visible = clients.find((client) => client.visibilityState === "visible");
      if (visible) { visible.postMessage({ type: "qvaapply-notification", payload }); return; }
      return self.registration.showNotification(title, { body, tag: payload.version || payload.type, data: { url } });
    }));
  });
  self.addEventListener("notificationclick", (event) => {
    event.notification.close();
    const target = new URL(event.notification.data?.url || "/", self.location.origin).href;
    event.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(async (clients) => {
      const existing = clients[0];
      if (existing) { await existing.navigate(target); return existing.focus(); }
      return self.clients.openWindow(target);
    }));
  });`;
}

function requireJson(request: FastifyRequest): void {
  if (!request.headers["content-type"]?.toLowerCase().startsWith("application/json"))
    throw new DashboardAuthError(403, "Se requiere contenido JSON.");
}

function headerValue(request: FastifyRequest, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function httpStatus(error: Error, fallback: number): number {
  if (error instanceof DashboardAuthError) return error.status;
  if (error instanceof ClientInputError) return 400;
  if (error instanceof QvaApiError)
    return [400, 401, 403, 404, 409, 429].includes(error.status) ? error.status : 502;
  const validation = error as Error & { validation?: unknown };
  if (validation.validation) return 400;
  return fallback;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : "No se pudo actualizar QvaPay.";
}

function reactPage(): string {
  return "<!doctype html><html lang=\"es\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><meta name=\"color-scheme\" content=\"light dark\"><title>QvaApply · Mesa de trading</title><link rel=\"stylesheet\" href=\"/dashboard/app.css\"></head><body><div id=\"root\"></div><script type=\"module\" src=\"/dashboard/app.js\"></script></body></html>";
}

function openApiDocument() {
  return {
    openapi: "3.1.0",
    info: { title: "QvaApply Local Operations API", version: "1.0.0" },
    servers: [{ url: "/" }],
    security: [{ sessionCookie: [], csrfToken: [] }],
    paths: {
      "/api/dashboard": { get: { summary: "Estado local y última caché persistida" } },
      "/api/live/balance": { get: { summary: "Actualizar saldo QUSD" } },
      "/api/live/own-offers": { get: { summary: "Actualizar ofertas propias" } },
      "/api/live/transactions": { get: { summary: "Actualizar transacciones" } },
      "/api/live/markets/{coin}": { get: { summary: "Actualizar un mercado" } },
      "/api/config": { get: { summary: "Configuración activa" }, put: { summary: "Activar una revisión de configuración" } },
      "/api/control": { put: { summary: "Pausa, modo, refresco y emergencia" } },
      "/api/offers": { post: { summary: "Crear oferta propia" } },
      "/api/offers/{uuid}": { put: { summary: "Editar oferta propia" }, delete: { summary: "Cancelar oferta propia" } },
      "/api/workflows/{workflowId}/reconcile": { post: { summary: "Conciliar un resultado remoto ambiguo" } },
      "/api/operations/{uuid}/{action}": { post: { summary: "Registrar una acción humana de la operación" } },
      "/api/hunting": { put: { summary: "Controlar cacerías y precios por mercado" } },
      "/api/audit": { get: { summary: "Exportar auditoría" } },
      "/api/decision-events": { get: { summary: "Consultar decisiones operativas paginadas" } },
      "/api/decision-events/{id}/dismiss": { post: { summary: "Descartar una versión de decisión" } },
      "/api/push/public-key": { get: { summary: "Obtener la clave pública Web Push" } },
      "/api/push/subscriptions": { post: { summary: "Registrar el navegador para avisos" }, delete: { summary: "Eliminar la suscripción del navegador" } },
      "/api/blocked-offers/{uuid}/preview": { post: { summary: "Previsualizar una oferta bloqueada sin mutaciones" } },
      "/api/blocked-offers/{uuid}/apply": { post: { summary: "Aplicar tras omitir solo el bloqueo de precio" } },
      "/api/blocked-offers/{uuid}/dismiss": { post: { summary: "Descartar una oferta bloqueada" } },
    },
    components: {
      securitySchemes: {
        sessionCookie: { type: "apiKey", in: "cookie", name: "qvaapply_session" },
        csrfToken: { type: "apiKey", in: "header", name: "x-csrf-token" },
      },
    },
  };
}
