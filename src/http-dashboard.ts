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
import type { MarketAccountService } from "./market-accounts.js";
import type { MarketDataSource } from "./market-source.js";
import { MarketFeedRequestError, type MarketSourceCoordinator, type MarketSourceMode } from "./market-feed.js";
import { PaymentSmsError, validPaymentReceipt } from "./payment-sms.js";
import { RecoveryConflictError, RecoveryInputError } from "./self-service-recovery.js";

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
  host: "127.0.0.1" | "0.0.0.0" = "127.0.0.1",
  marketAccounts?: MarketAccountService,
  marketSource?: Pick<MarketSourceCoordinator, "status" | "setMode" | "saveWebhookSecret" | "saveStreamCredentials" | "acceptWebhook">,
): Promise<FastifyInstance> {
  const app = buildDashboard(
    readModel,
    authOptions,
    pushService,
    marketAccounts,
    marketSource,
  );
  await app.listen({ port, host });
  console.log(`Panel web: http://${host}:${port}`);
  return app;
}

export function buildDashboard(
  readModel: DashboardReadModel,
  authOptions: AuthOptions,
  pushService?: PushService,
  marketAccounts?: MarketAccountService,
  marketSource?: Pick<MarketSourceCoordinator, "status" | "setMode" | "saveWebhookSecret" | "saveStreamCredentials" | "acceptWebhook"> | Pick<MarketDataSource, "status">,
): FastifyInstance {
  const app = Fastify({
    logger: false,
    bodyLimit: 10_000,
    requestTimeout: 15_000,
    connectionTimeout: 10_000,
    maxRequestsPerSocket: 100,
  });
  app.removeContentTypeParser("application/json");
  app.addContentTypeParser(
    "application/json",
    { parseAs: "buffer" },
    (request, body, done) => {
      const rawBody = Buffer.isBuffer(body) ? body : Buffer.from(body);
      (request as FastifyRequest & { rawJsonBody?: Buffer }).rawJsonBody = rawBody;
      try {
        done(null, JSON.parse(rawBody.toString("utf8")) as unknown);
      } catch (error) {
        done(error as Error, undefined);
      }
    },
  );
  const auth = new DashboardAuth(authOptions);
  const publicRoot = resolve("public/dashboard");
  const iconsRoot = resolve("public/icons");
  const logoRoot = resolve("public/logo");
  const imagesRoot = resolve("public/images");

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
    if (path === "/api/mobile/device-check" && request.method === "GET") return;
    if (path === "/api/mobile/payment-receipts" && request.method === "POST") return;
    if (isMobileOperatorApi(path, request.method)) {
      // Native Bearer clients have no browser cookie. If a web session is also
      // present, preserve the dashboard's Origin/CSRF checks for mutations.
      if (auth.session(request.headers.cookie) && !["GET", "HEAD"].includes(request.method)) {
        auth.assertOrigin(request.headers.origin);
        requireJson(request);
        auth.assertCsrf(request.headers.cookie, headerValue(request, "x-csrf-token"));
      }
      return;
    }
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
    const status = normalized instanceof PaymentSmsError ? normalized.status : httpStatus(normalized, 500);
    if (status >= 500) console.error("Error HTTP local:", normalized);
    void reply.status(status).send({
      error: status >= 500 ? "No se pudo completar la solicitud." : normalized.message,
    });
  });

  app.get("/", async (request, reply) => {
    const session = auth.session(request.headers.cookie);
    const bootstrap = session
      ? {
          session: {
            authenticated: true,
            csrfToken: session.csrfToken,
            expiresAt: session.expiresAt,
          },
          dashboard: readModel.localSnapshot(),
          config: readModel.config(),
          configRevisions: readModel.configRevisions(),
        }
      : { session: { authenticated: false } };
    return reply
      .type("text/html; charset=utf-8")
      .header("vary", "Cookie")
      .send(reactPage(bootstrap));
  });
  app.get("/service-worker.js", async (_request, reply) =>
    reply.type("text/javascript; charset=utf-8").send(serviceWorkerScript()),
  );
  app.get<{ Params: { name: string } }>("/icons/:name", async (request, reply) => {
    const name = request.params.name;
    if (!/^[a-zA-Z0-9._-]+\.(?:svg|png)$/.test(name))
      return reply.status(404).type("text/plain").send("Icono no encontrado.");
    const file = resolve(iconsRoot, name);
    if (!file.startsWith(`${iconsRoot}/`) || !existsSync(file))
      return reply.status(404).type("text/plain").send("Icono no encontrado.");
    return reply.type(name.endsWith(".svg") ? "image/svg+xml" : "image/png")
      .header("cache-control", "public, max-age=86400")
      .send(readFileSync(file));
  });
  app.get<{ Params: { name: string } }>("/logo/:name", async (request, reply) => {
    const name = request.params.name;
    if (!/^[a-zA-Z0-9._-]+\.webp$/.test(name))
      return reply.status(404).type("text/plain").send("Logotipo no encontrado.");
    const file = resolve(logoRoot, name);
    if (!file.startsWith(`${logoRoot}/`) || !existsSync(file))
      return reply.status(404).type("text/plain").send("Logotipo no encontrado.");
    return reply.type("image/webp")
      .header("cache-control", "public, max-age=86400")
      .send(readFileSync(file));
  });
  app.get<{ Params: { name: string } }>("/images/:name", async (request, reply) => {
    const name = request.params.name;
    if (!/^[a-zA-Z0-9._-]+\.webp$/.test(name))
      return reply.status(404).type("text/plain").send("Imagen no encontrada.");
    const file = resolve(imagesRoot, name);
    if (!file.startsWith(`${imagesRoot}/`) || !existsSync(file))
      return reply.status(404).type("text/plain").send("Imagen no encontrada.");
    return reply.type("image/webp")
      .header("cache-control", "public, max-age=86400")
      .send(readFileSync(file));
  });
  app.get<{ Params: { name: string } }>("/market-icons/:name", async (request, reply) => {
    const icon = typeof readModel.marketIcon === "function"
      ? readModel.marketIcon(request.params.name)
      : undefined;
    if (!icon)
      return reply.status(404).type("text/plain").send("Icono no encontrado.");
    return reply.type(icon.mimeType)
      .header("cache-control", "public, max-age=31536000, immutable")
      .send(readFileSync(icon.path));
  });
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
  app.post("/webhooks/qvapay/p2p-feed", async (request, reply) => {
    if (!marketSource || !("acceptWebhook" in marketSource))
      return reply.status(503).send({ error: "El feed de mercado no está disponible." });
    try {
      const result = marketSource.acceptWebhook(
        (request as FastifyRequest & { rawJsonBody?: Buffer }).rawJsonBody ?? Buffer.alloc(0),
        {
          ...(headerValue(request, "x-qvapay-signature")
            ? { signature: headerValue(request, "x-qvapay-signature")! }
            : {}),
          ...(headerValue(request, "x-qvapay-timestamp")
            ? { timestamp: headerValue(request, "x-qvapay-timestamp")! }
            : {}),
        },
      );
      return reply.status(202).send({ ok: true, ...result });
    } catch (error) {
      if (error instanceof MarketFeedRequestError)
        return reply.status(error.status).send({ error: error.message });
      throw error;
    }
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

  app.post<{ Body: { label: string } }>("/api/mobile/devices", {
    schema: { body: { type: "object", additionalProperties: false, required: ["label"], properties: { label: { type: "string", minLength: 1, maxLength: 80 } } } },
  }, async (request, reply) => {
    const result = readModel.pairSmsDevice(request.body.label);
    return reply.status(201).send({ data: result });
  });
  app.get("/api/mobile/device-check", async (request, reply) => {
    const authorization = headerValue(request, "authorization") ?? "";
    const match = /^Bearer ([A-Za-z0-9_-]{40,100})$/.exec(authorization);
    if (!match) return reply.status(401).send({ error: "Credencial de dispositivo requerida." });
    return readModel.checkSmsDevice(match[1]!);
  });
  app.get("/api/mobile/devices", async () => ({ data: readModel.smsDevices() }));
  app.delete<{ Params: { id: string } }>("/api/mobile/devices/:id", async (request, reply) => {
    if (!readModel.revokeSmsDevice(request.params.id)) return reply.status(404).send({ error: "Dispositivo no encontrado o ya revocado." });
    return reply.status(204).send();
  });
  app.post<{ Body: { label: string } }>("/api/mobile/operators", {
    schema: { body: { type: "object", additionalProperties: false, required: ["label"], properties: { label: { type: "string", minLength: 1, maxLength: 80 } } } },
  }, async (request, reply) => {
    if (typeof readModel.pairMobileOperator !== "function") return reply.status(503).send({ error: "Operadores móviles no disponibles." });
    return reply.status(201).send({ data: readModel.pairMobileOperator(request.body.label) });
  });
  app.get("/api/mobile/operators", async () => ({ data: typeof readModel.mobileOperators === "function" ? readModel.mobileOperators() : [] }));
  app.delete<{ Params: { id: string } }>("/api/mobile/operators/:id", async (request, reply) => {
    if (typeof readModel.revokeMobileOperator !== "function" || !readModel.revokeMobileOperator(request.params.id))
      return reply.status(404).send({ error: "Operador no encontrado o ya revocado." });
    return reply.status(204).send();
  });
  app.get("/api/mobile/operator-check", async (request, reply) => {
    const operator = mobileAuth(readModel, request, false);
    if (!operator.ok) return reply.status(operator.rateLimited ? 429 : 401).send({ error: operator.rateLimited ? "Límite de solicitudes alcanzado." : "Credencial de operador requerida o revocada." });
    return { ok: true, scopes: operator.scopes };
  });
  app.get<{ Querystring: { limit?: string } }>("/api/mobile/operations", async (request, reply) => {
    const operator = mobileAuth(readModel, request, false);
    if (!operator.ok) return reply.status(operator.rateLimited ? 429 : 401).send({ error: operator.rateLimited ? "Límite de solicitudes alcanzado." : "Credencial de operador requerida o revocada." });
    const limit = Math.min(100, Math.max(1, Number(request.query.limit ?? 100) || 100));
    return { data: typeof readModel.mobileOperations === "function" ? readModel.mobileOperations(limit) : [] };
  });
  app.get("/api/mobile/alerts", async (request, reply) => {
    const operator = mobileAuth(readModel, request, false);
    if (!operator.ok) return reply.status(operator.rateLimited ? 429 : 401).send({ error: operator.rateLimited ? "Límite de solicitudes alcanzado." : "Credencial de operador requerida o revocada." });
    return { data: typeof readModel.mobileAlerts === "function" ? readModel.mobileAlerts() : [] };
  });
  app.get("/api/mobile/markets", async (request, reply) => {
    const operator = mobileAuth(readModel, request, false);
    if (!operator.ok) return reply.status(operator.rateLimited ? 429 : 401).send({ error: operator.rateLimited ? "Límite de solicitudes alcanzado." : "Credencial de operador requerida o revocada." });
    return { data: typeof readModel.mobileMarkets === "function" ? readModel.mobileMarkets() : [] };
  });
  app.get("/api/mobile/receipt-outcomes", async (request, reply) => {
    const operator = mobileAuth(readModel, request, false);
    if (!operator.ok) return reply.status(operator.rateLimited ? 429 : 401).send({ error: operator.rateLimited ? "Límite de solicitudes alcanzado." : "Credencial de operador requerida o revocada." });
    return { data: typeof readModel.mobileReceiptOutcomes === "function" ? readModel.mobileReceiptOutcomes() : [] };
  });
  app.post<{ Params: { uuid: string; action: string }; Body: { reference?: string } }>("/api/mobile/operations/:uuid/:action", {
    schema: {
      params: { type: "object", required: ["uuid", "action"], properties: { uuid: { type: "string", minLength: 1, maxLength: 100 }, action: { type: "string", enum: ["paid", "received", "cancel"] } } },
      body: { type: "object", additionalProperties: false, properties: { reference: { type: "string", minLength: 1, maxLength: 200 } } },
    },
  }, async (request, reply) => {
    requireJson(request);
    const operator = mobileAuth(readModel, request, true);
    if (!operator.ok) return reply.status(operator.rateLimited ? 429 : 401).send({ error: operator.rateLimited ? "Límite de solicitudes alcanzado." : "Credencial de operador requerida o revocada." });
    const { uuid, action } = request.params;
    const reference = request.body.reference?.trim();
    if (action === "paid" && !reference) throw new ClientInputError("La referencia del pago es obligatoria.");
    if (action !== "paid" && reference !== undefined) throw new ClientInputError("La referencia solo se admite al marcar pagado.");
    if (typeof readModel.mobileOperationAction !== "function") return reply.status(503).send({ error: "Acciones móviles no disponibles." });
    await readModel.mobileOperationAction(operator.operatorId!, uuid, action as "paid" | "received" | "cancel", reference);
    return reply.status(204).send();
  });
  app.get("/api/mobile/payment-receipts", async () => ({ data: readModel.paymentReceipts() }));
  app.post<{ Body: unknown }>("/api/mobile/payment-receipts", async (request, reply) => {
    const authorization = headerValue(request, "authorization") ?? "";
    const match = /^Bearer ([A-Za-z0-9_-]{40,100})$/.exec(authorization);
    if (!match) return reply.status(401).send({ error: "Credencial de dispositivo requerida." });
    if (!validPaymentReceipt(request.body)) return reply.status(400).send({ error: "Comprobante estructurado inválido." });
    const result = await readModel.receivePaymentReceipt(match[1]!, request.body);
    return reply.status(result.duplicate ? 200 : 202).send({ ok: true, duplicate: result.duplicate, receiptId: result.receipt.id, status: result.receipt.state });
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
  app.get("/api/live/operations", async () =>
    resilientResource(
      () => readModel.refreshOperations(),
      () => ({
        data: readModel.localSnapshot().operations,
        updatedAt: null,
      }),
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
  app.get("/api/market-source", async () => ({
    data: {
      ...(marketSource?.status() ?? {
        mode: "polling",
        accounts: [],
        healthyAccounts: 0,
        effectiveCadenceSeconds: null,
        estimatedRequestsPerMinute: 0,
      }),
      readers: marketAccounts?.list() ?? [],
    },
  }));
  app.put<{ Body: { mode: MarketSourceMode } }>("/api/market-source", {
    schema: {
      body: {
        type: "object",
        additionalProperties: false,
        required: ["mode"],
        properties: { mode: { type: "string", enum: ["polling", "hybrid"] } },
      },
    },
  }, async (request) => {
    if (!marketSource || !("setMode" in marketSource))
      throw new ClientInputError("La conmutación de fuente no está disponible.");
    await clientAction(() => marketSource.setMode(request.body.mode));
    return { data: marketSource.status() };
  });
  app.put<{ Body: { secret: string } }>("/api/market-source/webhook-secret", {
    schema: {
      body: {
        type: "object",
        additionalProperties: false,
        required: ["secret"],
        properties: { secret: { type: "string", minLength: 16, maxLength: 512 } },
      },
    },
  }, async (request) => {
    if (!marketSource || !("saveWebhookSecret" in marketSource))
      throw new ClientInputError("La configuración del webhook no está disponible.");
    await clientAction(() => marketSource.saveWebhookSecret(request.body.secret));
    return { data: marketSource.status() };
  });
  app.put<{ Body: { appId: string; appSecret: string } }>("/api/market-source/stream-credentials", {
    schema: {
      body: {
        type: "object",
        additionalProperties: false,
        required: ["appId", "appSecret"],
        properties: {
          appId: { type: "string", minLength: 4, maxLength: 256 },
          appSecret: { type: "string", minLength: 16, maxLength: 512 },
        },
      },
    },
  }, async (request) => {
    if (!marketSource || !("saveStreamCredentials" in marketSource))
      throw new ClientInputError("La configuración del stream no está disponible.");
    await clientAction(() => marketSource.saveStreamCredentials(request.body.appId, request.body.appSecret));
    return { data: marketSource.status() };
  });
  app.post<{
    Body: { label: string; token: string; intervalSeconds: number };
  }>("/api/market-readers", {
    schema: {
      body: {
        type: "object",
        additionalProperties: false,
        required: ["label", "token", "intervalSeconds"],
        properties: {
          label: { type: "string", minLength: 1, maxLength: 60 },
          token: { type: "string", minLength: 12, maxLength: 2_048 },
          intervalSeconds: { type: "number", minimum: 3, maximum: 3_600 },
        },
      },
    },
  }, async (request, reply) => {
    if (!marketAccounts) throw new ClientInputError("La fuente multicuentas no está disponible.");
    const account = await clientAction(() => marketAccounts.add(request.body));
    reply.status(201);
    return { data: account };
  });
  app.put<{
    Params: { id: string };
    Body: { label?: string; intervalSeconds?: number; enabled?: boolean };
  }>("/api/market-readers/:id", {
    schema: {
      params: readerIdParamsSchema(),
      body: {
        type: "object",
        additionalProperties: false,
        minProperties: 1,
        properties: {
          label: { type: "string", minLength: 1, maxLength: 60 },
          intervalSeconds: { type: "number", minimum: 3, maximum: 3_600 },
          enabled: { type: "boolean" },
        },
      },
    },
  }, async (request) => {
    if (!marketAccounts) throw new ClientInputError("La fuente multicuentas no está disponible.");
    return { data: await clientAction(() => marketAccounts.update(request.params.id, request.body)) };
  });
  app.put<{
    Params: { id: string };
    Body: { token: string };
  }>("/api/market-readers/:id/token", {
    schema: {
      params: readerIdParamsSchema(),
      body: {
        type: "object",
        additionalProperties: false,
        required: ["token"],
        properties: { token: { type: "string", minLength: 12, maxLength: 2_048 } },
      },
    },
  }, async (request) => {
    if (!marketAccounts) throw new ClientInputError("La fuente multicuentas no está disponible.");
    return { data: await clientAction(() => marketAccounts.rotate(request.params.id, request.body.token)) };
  });
  app.delete<{ Params: { id: string } }>("/api/market-readers/:id", {
    schema: { params: readerIdParamsSchema() },
  }, async (request, reply) => {
    if (!marketAccounts) throw new ClientInputError("La fuente multicuentas no está disponible.");
    await clientAction(() => marketAccounts.remove(request.params.id));
    reply.status(204);
  });
  app.get("/api/config-revisions", async () => ({ data: readModel.configRevisions() }));
  app.post<{
    Body: { name: string; mimeType: string; base64: string };
  }>("/api/market-icons", {
    bodyLimit: 750_000,
    schema: {
      body: {
        type: "object",
        additionalProperties: false,
        required: ["name", "mimeType", "base64"],
        properties: {
          name: { type: "string", minLength: 1, maxLength: 120 },
          mimeType: { type: "string", enum: ["image/png", "image/jpeg", "image/webp", "image/svg+xml"] },
          base64: { type: "string", minLength: 1, maxLength: 700_000 },
        },
      },
    },
  }, async (request, reply) => {
    const saved = await clientAction(() => readModel.saveMarketIcon(request.body));
    reply.status(201);
    return { data: saved };
  });
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
  app.put<{
    Body: { coin: string; fiat: number; minimal: number; price: number };
  }>("/api/cooperative-network/contributions", {
    schema: {
      body: {
        type: "object",
        additionalProperties: false,
        required: ["coin", "fiat", "minimal", "price"],
        properties: {
          coin: { type: "string", pattern: "^[A-Z0-9_]{2,40}$" },
          fiat: { type: "number", exclusiveMinimum: 0 },
          minimal: { type: "number", exclusiveMinimum: 0 },
          price: { type: "number", exclusiveMinimum: 0 },
        },
      },
    },
  }, async (request, reply) => {
    await clientAction(() => readModel.publishCooperativeContribution(request.body));
    reply.status(204);
  });
  app.delete<{ Params: { coin: string } }>(
    "/api/cooperative-network/contributions/:coin",
    {
      schema: {
        params: {
          type: "object",
          additionalProperties: false,
          required: ["coin"],
          properties: {
            coin: { type: "string", pattern: "^[A-Z0-9_]{2,40}$" },
          },
        },
      },
    },
    async (request, reply) => {
      await clientAction(() => readModel.withdrawCooperativeContribution(request.params.coin));
      reply.status(204);
    },
  );
  app.post("/api/cooperative-network/reconcile", async (_request, reply) => {
    await clientAction(() => readModel.reconcileCooperativeNetwork());
    reply.status(204);
  });
  app.put<{ Body: { paused?: boolean; refresh?: boolean; emergencyStop?: boolean; mode?: string } }>("/api/control", {
    schema: {
      body: {
        type: "object",
        additionalProperties: false,
        properties: {
          paused: { type: "boolean" },
          mode: { not: {} },
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
  app.post<{ Body: { refresh?: boolean } }>("/api/offers/rebalance/preview", {
    schema: {
      body: {
        type: "object",
        additionalProperties: false,
        properties: { refresh: { type: "boolean" } },
      },
    },
  }, async (request) => ({
    data: await clientAction(() =>
      request.body.refresh
        ? readModel.refreshBudgetRebalancePreview()
        : readModel.budgetRebalancePreview()),
  }));
  app.post<{
    Body: { adjustments: { uuid: string; amount: number }[] };
  }>("/api/offers/rebalance/apply", {
    schema: {
      body: {
        type: "object",
        additionalProperties: false,
        required: ["adjustments"],
        properties: {
          adjustments: {
            type: "array",
            minItems: 1,
            maxItems: 100,
            items: {
              type: "object",
              additionalProperties: false,
              required: ["uuid", "amount"],
              properties: {
                uuid: { type: "string", minLength: 1, maxLength: 100 },
                amount: { type: "number", minimum: 0 },
              },
            },
          },
        },
      },
    },
  }, async (request, reply) => {
    const job = await clientAction(() =>
      readModel.startBudgetRebalance(request.body.adjustments));
    reply.status(202);
    return { data: job };
  });
  app.get<{ Params: { id: string } }>("/api/offers/rebalance/:id", {
    schema: {
      params: {
        type: "object",
        required: ["id"],
        properties: { id: { type: "string", minLength: 1, maxLength: 100 } },
      },
    },
  }, async (request) => {
    const job = readModel.rebalanceJob(request.params.id);
    if (!job) throw new ClientInputError("Reajuste no encontrado.");
    return { data: job, source: "sqlite" };
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
  app.get("/api/recovery", async (_request, reply) => {
    if (typeof readModel.recoveryItems !== "function")
      return reply.status(503).send({ error: "La recuperación local no está disponible." });
    return { data: readModel.recoveryItems() };
  });
  app.post<{ Params: { intentId: string }; Body: Record<string, never> }>("/api/recovery/:intentId/check", {
    schema: {
      params: {
        type: "object", required: ["intentId"],
        properties: { intentId: { type: "string", minLength: 1, maxLength: 200 } },
      },
      body: { type: "object", additionalProperties: false, properties: {} },
    },
  }, async (request, reply) => {
    if (typeof readModel.checkRecoveryIntent !== "function")
      return reply.status(503).send({ error: "La conciliación local no está disponible." });
    return { data: await readModel.checkRecoveryIntent(request.params.intentId) };
  });
  app.post<{
    Params: { intentId: string };
    Body: {
      expectedUpdatedAt: number;
      outcome: "not_applied" | "cancelled";
      reason: string;
      evidence: string;
      confirmed: true;
    };
  }>("/api/recovery/:intentId/resolve", {
    schema: {
      params: {
        type: "object", required: ["intentId"],
        properties: { intentId: { type: "string", minLength: 1, maxLength: 200 } },
      },
      body: {
        type: "object", additionalProperties: false,
        required: ["expectedUpdatedAt", "outcome", "reason", "evidence", "confirmed"],
        properties: {
          expectedUpdatedAt: { type: "integer", minimum: 0 },
          outcome: { type: "string", enum: ["not_applied", "cancelled"] },
          reason: { type: "string", minLength: 12, maxLength: 500 },
          evidence: { type: "string", minLength: 12, maxLength: 1_000 },
          confirmed: { const: true },
        },
      },
    },
  }, async (request, reply) => {
    if (typeof readModel.resolveRecoveryIntent !== "function")
      return reply.status(503).send({ error: "La resolución local no está disponible." });
    return {
      data: readModel.resolveRecoveryIntent({
        intentId: request.params.intentId,
        ...request.body,
      }),
    };
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
  app.get<{
    Querystring: {
      after?: string;
      limit?: string;
      level?: string;
      component?: string;
      query?: string;
      since?: string;
    };
  }>("/api/logs", {
    schema: {
      querystring: {
        type: "object",
        additionalProperties: false,
        properties: {
          after: { type: "integer", minimum: 0 },
          limit: { type: "integer", minimum: 1, maximum: 200 },
          level: { type: "string", enum: ["info", "success", "warning", "error"] },
          component: { type: "string", enum: ["trading", "qvapay", "notifications", "network", "system"] },
          query: { type: "string", maxLength: 120 },
          since: { type: "integer", minimum: 1_000, maximum: 604_800_000 },
        },
      },
    },
  }, async (request) => {
    const after = nonNegativeInteger(request.query.after);
    const limit = boundedPositiveInteger(request.query.limit, 100, 200);
    const since = optionalPositiveInteger(request.query.since);
    const query = request.query.query?.trim();
    return {
      data: readModel.operationalLogs({
        ...(after === undefined ? {} : { after }),
        limit,
        ...(request.query.level
          ? { level: request.query.level as "info" | "success" | "warning" | "error" }
          : {}),
        ...(request.query.component
          ? { component: request.query.component as "trading" | "qvapay" | "notifications" | "network" | "system" }
          : {}),
        ...(query ? { query } : {}),
        ...(since === undefined ? {} : { since }),
      }),
      source: "sqlite",
    };
  });
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
  app.post<{ Body: { throughId: number } }>("/api/decision-events/dismiss-all", {
    schema: { body: { type: "object", required: ["throughId"], additionalProperties: false,
      properties: { throughId: { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER } } } },
  }, async (request) => ({ data: await clientAction(() => readModel.dismissAllDecisionEvents(request.body.throughId)) }));

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
  app.get("/api/notifications", async () => ({ data: readModel.notifications() }));
  app.post<{ Params: { id: string } }>("/api/notifications/:id/ack", {
    schema: {
      params: {
        type: "object",
        required: ["id"],
        properties: { id: { type: "string", minLength: 1, maxLength: 200 } },
      },
      body: { type: "object", additionalProperties: false },
    },
  }, async (request, reply) => {
    readModel.acknowledgeNotification(request.params.id);
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

function readerIdParamsSchema() {
  return {
    type: "object",
    required: ["id"],
    properties: { id: { type: "string", minLength: 1, maxLength: 100 } },
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
    if (isInternalFailure(error)) throw error;
    throw new ClientInputError(message(error));
  }
}

function isInternalFailure(error: unknown): boolean {
  if (
    error instanceof TypeError ||
    error instanceof RangeError ||
    error instanceof ReferenceError ||
    error instanceof SyntaxError
  ) return true;
  if (!isRecord(error) || typeof error.code !== "string") return false;
  return /^(?:ERR_|SQLITE_|E[A-Z_]+$)/.test(error.code);
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

function boundedPositiveInteger(
  value: string | undefined,
  fallback: number,
  maximum: number,
): number {
  const parsed = positiveInteger(value, fallback);
  return Math.min(maximum, parsed);
}

function optionalPositiveInteger(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function nonNegativeInteger(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function serviceWorkerScript(): string {
  return `self.addEventListener("push", (event) => {
    let payload = {};
    try { payload = event.data ? event.data.json() : {}; } catch {}
    const alert = payload.alert || {};
    const title = payload.type === "blocked-offer"
      ? "Oferta requiere revisión"
      : payload.type === "operation-applied"
        ? "Aplicación confirmada"
        : payload.type === "rebalance-completed"
          ? "Reajuste completado"
          : payload.type === "rebalance-attention"
            ? "Reajuste requiere atención"
        : "Actividad de QvaApply";
    const body = [alert.coin, alert.amount ? alert.amount + " QUSD" : "", alert.reason || ""].filter(Boolean).join(" · ");
    const url = payload.url || "/?view=auditoria";
    event.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      const visible = clients.find((client) => client.visibilityState === "visible");
      if (visible) { visible.postMessage({ type: "qvaapply-notification", payload }); return; }
      return self.registration.showNotification(title, {
        body,
        tag: payload.version || payload.type,
        data: { url },
        icon: "/logo/isotipo.webp",
        badge: "/logo/isotipo.webp",
        requireInteraction: payload.type === "operation-applied" || payload.type === "rebalance-attention"
      });
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

function isMobileOperatorApi(path: string, method: string): boolean {
  return (method === "GET" && ["/api/mobile/operator-check", "/api/mobile/operations", "/api/mobile/alerts", "/api/mobile/markets", "/api/mobile/receipt-outcomes"].includes(path)) ||
    (method === "POST" && /^\/api\/mobile\/operations\/[^/]+\/(?:paid|received|cancel)$/.test(path));
}

function mobileAuth(readModel: DashboardReadModel, request: FastifyRequest, write: boolean) {
  const authorization = headerValue(request, "authorization") ?? "";
  const match = /^Bearer ([A-Za-z0-9_-]{40,100})$/.exec(authorization);
  if (!match || typeof readModel.checkMobileOperator !== "function") return { ok: false as const };
  return readModel.checkMobileOperator(match[1]!, write);
}

function headerValue(request: FastifyRequest, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function httpStatus(error: Error, fallback: number): number {
  if (error instanceof DashboardAuthError) return error.status;
  if (error instanceof RecoveryConflictError) return error.status;
  if (error instanceof RecoveryInputError) return error.status;
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

function reactPage(bootstrap: unknown): string {
  const encoded = JSON.stringify(bootstrap)
    .replaceAll("&", "\\u0026")
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><meta name="description" content="QvaApply · Mesa privada de operaciones P2P"><meta name="theme-color" content="#123b70"><link rel="icon" href="/logo/isotipo.webp" type="image/webp"><link rel="apple-touch-icon" href="/logo/isotipo.webp"><title>QvaApply · Mesa de trading</title><link rel="stylesheet" href="/dashboard/app.css"></head><body><template id="qvaapply-bootstrap">${encoded}</template><div id="root"></div><script type="module" src="/dashboard/app.js"></script></body></html>`;
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
      "/api/live/operations": { get: { summary: "Conciliar operaciones activas con QvaPay" } },
      "/api/live/markets/{coin}": { get: { summary: "Actualizar un mercado" } },
      "/api/config": { get: { summary: "Configuración activa" }, put: { summary: "Activar una revisión de configuración" } },
      "/api/control": { put: { summary: "Pausa, refresco y emergencia" } },
      "/api/offers": { post: { summary: "Crear oferta propia" } },
      "/api/offers/rebalance/preview": { post: { summary: "Previsualizar un reajuste del capital fiat" } },
      "/api/offers/rebalance/apply": { post: { summary: "Iniciar un reajuste persistente de ofertas propias" } },
      "/api/offers/rebalance/{id}": { get: { summary: "Consultar el progreso de un reajuste" } },
      "/api/market-icons": { post: { summary: "Cargar un icono administrado para un mercado" } },
      "/api/market-source": {
        get: { summary: "Consultar la fuente de mercado y su cadencia" },
        put: { summary: "Alternar entre sondeo y feed híbrido" },
      },
      "/api/market-source/webhook-secret": { put: { summary: "Guardar el secreto cifrado del webhook" } },
      "/api/market-source/stream-credentials": { put: { summary: "Guardar las credenciales cifradas del stream" } },
      "/webhooks/qvapay/p2p-feed": {
        post: { summary: "Recibir un evento P2P firmado", security: [] },
      },
      "/api/market-readers": { post: { summary: "Añadir y validar una cuenta de solo lectura" } },
      "/api/market-readers/{id}": { put: { summary: "Actualizar una cuenta lectora" }, delete: { summary: "Eliminar una cuenta lectora" } },
      "/api/market-readers/{id}/token": { put: { summary: "Rotar el token cifrado de una cuenta lectora" } },
      "/api/offers/{uuid}": { put: { summary: "Editar oferta propia" }, delete: { summary: "Cancelar oferta propia" } },
      "/api/workflows/{workflowId}/reconcile": { post: { summary: "Conciliar un resultado remoto ambiguo" } },
      "/api/recovery": { get: { summary: "Consultar intenciones monetarias pendientes de conciliación" } },
      "/api/recovery/{intentId}/check": { post: { summary: "Conciliar una sola intención sin repetir la mutación" } },
      "/api/recovery/{intentId}/resolve": { post: { summary: "Registrar una declaración manual revisada por el propietario" } },
      "/api/operations/{uuid}/{action}": { post: { summary: "Registrar una acción humana de la operación" } },
      "/api/hunting": { put: { summary: "Controlar cacerías y precios por mercado" } },
      "/api/audit": { get: { summary: "Exportar auditoría" } },
      "/api/logs": { get: { summary: "Consultar logs operativos filtrados por cursor" } },
      "/api/decision-events": { get: { summary: "Consultar decisiones operativas paginadas" } },
      "/api/decision-events/{id}/dismiss": { post: { summary: "Descartar una versión de decisión" } },
      "/api/decision-events/dismiss-all": { post: { summary: "Descartar las decisiones bloqueadas pendientes hasta una versión" } },
      "/api/push/public-key": { get: { summary: "Obtener la clave pública Web Push" } },
      "/api/push/subscriptions": { post: { summary: "Registrar el navegador para avisos" }, delete: { summary: "Eliminar la suscripción del navegador" } },
      "/api/notifications": { get: { summary: "Consultar avisos persistentes pendientes" } },
      "/api/notifications/{id}/ack": { post: { summary: "Confirmar la lectura de un aviso persistente" } },
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
