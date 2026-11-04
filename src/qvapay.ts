import { consumeChatStream } from "./chat-stream.js";
import { createHash } from "node:crypto";
import { chatImageUrl, CHAT_IMAGE_MAX_BYTES, validateChatImage, type ChatImage } from "./chat-images.js";
import { recordHuntingEligibility, recordMissingRequirements } from "./hunting-requirements.js";
import type {
  P2pAverage,
  ListTiming,
  P2pListPage,
  QusdReadTiming,
  P2pOffer,
  QvaTransaction,
  QvaTransactionPage,
} from "./types.js";
import { APPLY_WINDOW_KEY, APPLY_WINDOW_MS, applyAttempts, applyReadyAt } from "./core/apply-budget.js";
import { beginOperationRequest, type OperationRequestTimer } from "./operation-trace.js";

const API = "https://api.qvapay.com";

export class QvaApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly retryAfterMs?: number,
    public readonly code?: string,
  ) {
    super(message);
  }
}

export class QvaConnectionError extends Error {
  constructor(
    public readonly reason: "timeout" | "network",
    cause: unknown,
  ) {
    super(
      reason === "timeout"
        ? "QvaPay no respondió dentro del tiempo esperado. Comprueba tu conexión e inténtalo de nuevo."
        : "No se pudo conectar con QvaPay. Comprueba tu conexión e inténtalo de nuevo.",
      { cause },
    );
  }
}

export class QvaMutationUncertainError extends Error {
  constructor(
    public readonly kind: string,
    cause: unknown,
  ) {
    super(
      `No se recibió confirmación de QvaPay para ${kind}; se requiere conciliación.`,
      { cause },
    );
  }
}

type TokenProvider = () => string | undefined;
export interface LoginResult {
  requiresTwoFactor: boolean;
  token?: string;
  pinRequested?: boolean;
  hasOtp?: boolean;
}
export interface QvaChatMessage {
  id: string;
  peerId: string;
  message: string;
  image?: string;
  createdAt?: number;
  isModerator?: boolean;
}
export interface QvaPayRuntime {
  onApplyTiming?: (timing: ApplyTiming) => void;
  onListTiming?: (timing: ListTiming) => void;
  onQusdReadTiming?: (timing: QusdReadTiming) => void;
  monotonicNow?: () => number;
  listBudget?: {
    waitForDispatch(token: string): Promise<string | undefined>;
    noteRateLimit(owner: string | undefined, retryAfterMs?: number): void;
  };
  fetch?: typeof globalThis.fetch;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
  authTimeoutMs?: number;
  requestTimeoutMs?: number;
  mutationTimeoutMs?: number;
  throttleState?: {
    get(key: string): string | undefined;
    set(key: string, value: string): void;
  };
}

export interface ApplyTiming {
  uuid: string;
  queuedAt: number;
  dispatchedAt: number | null;
  finishedAt: number;
  budgetWaitMs: number;
  outcome: string;
}

type RequestPolicy =
  | "read"
  | "urgent_read"
  | "chat_read"
  | "list"
  | "create"
  | "apply"
  | "edit"
  | "cancel"
  | "paid"
  | "received"
  | "chat";

const POLICY_INTERVAL_MS: Record<RequestPolicy, number> = {
  read: 1_667,
  urgent_read: 1_667,
  chat_read: 1_667,
  list: 2_401,
  create: 5_000,
  apply: 0, // Governed by the durable rolling window, independently of reads.
  edit: 20_000,
  cancel: 20_000,
  paid: 10_000,
  received: 5_000,
  chat: 1_667,
};

export class QvaPayClient {
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly now: () => number;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly authTimeoutMs: number;
  private readonly requestTimeoutMs: number;
  private readonly mutationTimeoutMs: number;
  private readonly throttleState?: QvaPayRuntime["throttleState"];
  private readonly onApplyTiming?: QvaPayRuntime["onApplyTiming"];
  private readonly onListTiming?: QvaPayRuntime["onListTiming"];
  private readonly onQusdReadTiming?: QvaPayRuntime["onQusdReadTiming"];
  private readonly monotonicNow: () => number;
  private readonly listBudget: QvaPayRuntime["listBudget"];
  private queue = Promise.resolve();
  private listQueue = Promise.resolve();
  private applyQueue = Promise.resolve();
  private primaryApplyPending = 0;
  private urgentReadQueue = Promise.resolve();
  private chatQueue = Promise.resolve();
  private readonly applyState = new Map<string, string>();
  private lastRequestAt = 0;
  private readonly lastPolicyAt = new Map<RequestPolicy, number>();

  constructor(
    private readonly tokenProvider: TokenProvider,
    runtime: QvaPayRuntime = {},
  ) {
    this.fetchImpl = runtime.fetch ?? globalThis.fetch;
    this.now = runtime.now ?? Date.now;
    this.sleep = runtime.sleep ?? sleep;
    this.authTimeoutMs = runtime.authTimeoutMs ?? 20_000;
    this.requestTimeoutMs = runtime.requestTimeoutMs ?? 5_000;
    this.mutationTimeoutMs = runtime.mutationTimeoutMs ?? 25_000;
    this.throttleState = runtime.throttleState;
    this.onApplyTiming = runtime.onApplyTiming;
    this.onListTiming = runtime.onListTiming;
    this.onQusdReadTiming = runtime.onQusdReadTiming;
    this.monotonicNow = runtime.monotonicNow ?? (() => performance.now());
    this.listBudget = runtime.listBudget;
  }

  async login(
    email: string,
    password: string,
    twoFactorCode?: string,
  ): Promise<LoginResult> {
    const body: Record<string, unknown> = { email, password, remember: true };
    if (twoFactorCode) body.two_factor_code = twoFactorCode;
    const response = await this.fetchAuthentication(`${API}/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await this.json(response);
    if (response.status === 202) {
      const hasOtp = data.has_otp === true;
      if (hasOtp) return { requiresTwoFactor: true, hasOtp };
      // QvaPay puede devolver `notified: false`; en ese caso el PIN se solicita explícitamente.
      if (data.notified !== true) await this.requestPin(email, password);
      return { requiresTwoFactor: true, pinRequested: true, hasOtp: false };
    }
    const token =
      typeof data.accessToken === "string" ? data.accessToken : undefined;
    if (!token)
      throw new QvaApiError(
        response.status,
        "QvaPay no devolvió un token de sesión",
      );
    return { requiresTwoFactor: false, token };
  }

  async requestPin(email: string, password: string): Promise<void> {
    const response = await this.fetchAuthentication(`${API}/auth/request-pin`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password }),
    }, 1);
    await this.json(response);
  }

  async listOffers(
    params: Record<string, string | number | boolean | undefined>,
  ): Promise<P2pOffer[]> {
    return (await this.listOffersPage(params)).offers;
  }

  async listOffersPage(
    params: Record<string, string | number | boolean | undefined>,
    options: { analyticsOnly?: boolean } = {},
  ): Promise<P2pListPage> {
    const started = this.monotonicNow();
    const timing: ListTiming = { queueMs: null, responseMs: null, totalMs: 0, attempts: 0, outcome: "failed" };
    let dispatched: number | undefined;
    try {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params))
      if (value !== undefined) query.set(key, String(value));
    const data = await this.request(`/p2p?${query}`, {
      policy: "list",
      retryRead: true,
      listTrace: {
        dispatch: () => { dispatched = this.monotonicNow(); timing.queueMs = Math.max(0, dispatched - started); },
        attempt: () => { timing.attempts++; },
        response: (response) => {
          timing.status = response.status;
          const cache = response.headers.get("x-cache")?.trim().toLowerCase();
          if (cache === "hit" || cache === "miss") timing.cacheStatus = cache === "hit" ? "HIT" : "MISS";
        },
        finish: () => { if (dispatched !== undefined) timing.responseMs = Math.max(0, this.monotonicNow() - dispatched); },
      },
    });
    // La API actual usa `data` para la lista paginada. `offers` se conserva por compatibilidad.
    const rawOffers = Array.isArray(data.data)
      ? data.data
      : Array.isArray(data.offers)
        ? data.offers
        : [];
    const account = this.throttleState?.get("analytics_account_uuid");
    if (account) for (const raw of rawOffers) {
      if (!raw || typeof raw !== "object") continue;
      const entry = raw as Record<string, unknown>;
      for (const party of [entry.User, entry.Peer])
        if (party && typeof party === "object" && (party as Record<string,unknown>).uuid === account)
          recordHuntingEligibility(this.throttleState, party, this.now());
    }
    const offers = rawOffers.map((offer, index) =>
      parseOffer(offer, `lista P2P, posición ${index + 1}`, options.analyticsOnly),
    );
    timing.outcome = "success";
    return {
      offers,
      total: numberField(data.total, offers.length),
      currentPage: numberField(data.current_page, numberField(data.page, 1)),
      perPage: numberField(
        data.per_page,
        numberField(data.take, offers.length),
      ),
      timing,
      ...(timing.cacheStatus ? { cacheStatus: timing.cacheStatus } : {}),
    };
    } finally {
      timing.totalMs = Math.max(0, this.monotonicNow() - started);
      try { this.onListTiming?.({ ...timing }); } catch { /* Observability must not affect listing. */ }
    }
  }

  async getOffer(uuid: string, options: { priority?: boolean; analyticsOnly?: boolean } = {}): Promise<P2pOffer> {
    const data = (await this.request(`/p2p/${uuid}`, {
      policy: options.priority ? "urgent_read" : "read",
      retryRead: true,
    })) as { p2p?: P2pOffer };
    if (!data.p2p) throw new Error("QvaPay no devolvió la oferta solicitada");
    return parseOffer(data.p2p, "oferta solicitada", options.analyticsOnly);
  }

  async qusdBalance(options: { priority?: boolean } = {}): Promise<number> {
    const started = this.monotonicNow();
    const timing: QusdReadTiming = { priority: options.priority ? "urgent" : "normal", outcome: "failed", queueMs: null, responseMs: null, totalMs: 0 };
    let dispatched: number | undefined;
    try {
    const identityToken = this.tokenProvider();
    const data = await this.request("/user", {
      policy: options.priority ? "urgent_read" : "read",
      retryRead: true,
      readTrace: {
        dispatch: () => { dispatched = this.monotonicNow(); timing.queueMs = Math.max(0, dispatched - started); },
        finish: () => { if (dispatched !== undefined) timing.responseMs = Math.max(0, this.monotonicNow() - dispatched); },
      },
    });
    if (typeof data.uuid === "string") this.throttleState?.set("analytics_account_uuid", data.uuid);
    this.recordListingOwner(identityToken, data.uuid);
    const candidates = [
      data.balance,
      (data.data as Record<string, unknown> | undefined)?.balance,
      data.available,
      (data.data as Record<string, unknown> | undefined)?.available,
    ];
    for (const candidate of candidates) {
      const value =
        typeof candidate === "string" || typeof candidate === "number"
          ? Number(candidate)
          : Number.NaN;
      if (Number.isFinite(value) && value >= 0) { timing.outcome = "success"; return value; }
    }
    throw new Error(
      "La respuesta de balance de QvaPay no contiene un saldo QUSD reconocible; se bloqueó la venta por seguridad.",
    );
    } finally {
      timing.totalMs = Math.max(0, this.monotonicNow() - started);
      try { this.onQusdReadTiming?.({ ...timing }); } catch { /* Observability must not affect balance reads. */ }
    }
  }

  async profile(): Promise<{ uuid: string; balance?: number }> {
    const identityToken = this.tokenProvider();
    const data = await this.request("/user", {
      policy: "read",
      retryRead: true,
    });
    if (typeof data.uuid !== "string")
      throw new Error("QvaPay no devolvió el UUID del usuario.");
    this.throttleState?.set("analytics_account_uuid", data.uuid);
    this.recordListingOwner(identityToken, data.uuid);
    recordHuntingEligibility(this.throttleState, data, this.now());
    return {
      uuid: data.uuid,
      ...(typeof data.balance === "number" ? { balance: data.balance } : {}),
    };
  }

  verifiedListingOwner(token: string): string | undefined {
    return this.throttleState?.get(`qva_listing_identity:${createHash("sha256").update(token).digest("hex")}`);
  }

  private recordListingOwner(token: string | undefined, owner: unknown): void {
    if (token && typeof owner === "string" && owner.trim() && owner.length <= 128)
      this.throttleState?.set(`qva_listing_identity:${createHash("sha256").update(token).digest("hex")}`, owner.trim().toLowerCase());
  }

  async p2pAverages(): Promise<Record<string, P2pAverage>> {
    return this.enqueue("read", async () => {
      const response = await this.fetchRead(`${API}/p2p/averages`);
      const data = await this.json(response);
      return parseAverages(data);
    });
  }

  async listTransactions(): Promise<QvaTransaction[]> {
    return (await this.listTransactionsPage({ take: 20 })).transactions;
  }

  async listTransactionsPage(params: { page?: number; take?: number; dateFrom?: string; dateTo?: string } = {}): Promise<QvaTransactionPage> {
    const page = params.page ?? 1;
    const take = params.take ?? 30;
    if (!Number.isSafeInteger(page) || page < 1 || !Number.isSafeInteger(take) || take < 1 || take > 30)
      throw new RangeError("Paginación de transacciones inválida.");
    const query = new URLSearchParams({ take: String(take), page: String(page), status: "paid", order: "desc", include_total: "true" });
    if (params.dateFrom) query.set("date_from", params.dateFrom);
    if (params.dateTo) query.set("date_to", params.dateTo);
    const data = (await this.request(
      `/transaction?${query}`,
      { policy: "read", retryRead: true },
    )) as unknown;
    const envelope = data as { transactions?: unknown; total?: unknown } | null;
    const rows = Array.isArray(data) ? data : envelope?.transactions;
    if (!Array.isArray(rows)) throw new Error("QvaPay devolvió un listado de transacciones inválido.");
    const total = envelope?.total == null || envelope.total === "" ? NaN : Number(envelope.total);
    return { transactions: rows.map(parseTransaction), ...(Number.isSafeInteger(total) && total >= 0 ? { total } : {}) };
  }

  async apply(uuid: string, options: { amount?: number; beforeDispatch?: (queuedForMs: number) => boolean | Promise<boolean> } = {}): Promise<{ order: string; amount: number; receive: number } | void> {
    const data = await this.request(`/p2p/${uuid}/apply`, {
      method: "POST",
      policy: "apply",
      ...(options.amount === undefined ? {} : { body: { amount: options.amount } }),
      ...(options.beforeDispatch ? { beforeDispatch: options.beforeDispatch } : {}),
    });
    if (options.amount !== undefined) {
      if (typeof data.order !== "string" || !data.order)
        throw new QvaMutationUncertainError("aplicar orden flexible", new Error("Respuesta sin ID de orden"));
      return { order: data.order, amount: positiveNumber(data.amount, "orden, amount"), receive: positiveNumber(data.receive, "orden, receive") };
    }
  }

  secondaryApplyAvailable(): boolean {
    const state = { get: (key: string) => this.throttleState?.get(key) ?? this.applyState.get(key) };
    const now = this.now();
    return this.primaryApplyPending === 0 && applyReadyAt(state, now) <= now &&
      applyAttempts(state).filter(at => at + APPLY_WINDOW_MS > now).length === 0;
  }

  async applySecondary(uuid: string, beforeDispatch: () => boolean | Promise<boolean>): Promise<void> {
    await this.request(`/p2p/${uuid}/apply`, { method: "POST", policy: "apply", secondary: true, beforeDispatch });
  }
  async cancel(uuid: string, order?: string, options: { beforeDispatch?: () => boolean } = {}): Promise<{ status?: string } | void> {
    const result = await this.request(orderPath(uuid, "cancel", order), {
      method: "POST",
      policy: "cancel",
      ...(options.beforeDispatch ? { beforeDispatch: options.beforeDispatch } : {}),
    });
    if (order) return { ...(typeof result.status === "string" ? { status: result.status } : {}) };
  }
  async markPaid(uuid: string, txId: string, order?: string): Promise<void> {
    await this.request(orderPath(uuid, "paid", order), {
      method: "POST",
      body: { tx_id: txId },
      policy: "paid",
    });
  }
  async confirmReceived(uuid: string, order?: string): Promise<void> {
    await this.request(orderPath(uuid, "received", order), {
      method: "POST",
      policy: "received",
    });
  }
  async sendChat(uuid: string, message: string, order?: string, image?: ChatImage): Promise<{ id?: string; createdAt?: number }> {
    let form: FormData | undefined;
    if (image) {
      validateChatImage(image.bytes, image.mimeType);
      form = new FormData();
      form.set("file", new Blob([new Uint8Array(image.bytes)], { type: image.mimeType }), image.mimeType === "image/png" ? "chat.png" : "chat.jpg");
      if (message) form.set("message", message);
    }
    const data = await this.request(orderPath(uuid, "chat", order), {
      method: "POST",
      body: form ?? { message },
      policy: "chat",
    });
    const raw = isObject(data.message) ? data.message : isObject(data.data) ? data.data : data;
    if (!stringValue(raw.id ?? raw.uuid ?? (typeof data.message === "string" ? data.message : undefined)))
      throw new QvaMutationUncertainError("chat", new Error("QvaPay no devolvió el identificador del mensaje."));
    return {
      ...(stringValue(raw.id ?? raw.uuid ?? (typeof data.message === "string" ? data.message : undefined))
        ? { id: stringValue(raw.id ?? raw.uuid ?? data.message)! } : {}),
      ...(timestampValue(raw.created_at) ? { createdAt: timestampValue(raw.created_at)! } : {}),
    };
  }

  async downloadChatImage(reference: string): Promise<ChatImage> {
    const url = chatImageUrl(reference);
    const response = await this.fetchImpl(url.href, { redirect: "error", signal: AbortSignal.timeout(12_000) });
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      throw new Error("No se pudo descargar la imagen.");
    }
    const reader = response.body.getReader();
    const parts: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.length;
        if (size > CHAT_IMAGE_MAX_BYTES) throw new Error("Imagen remota demasiado grande.");
        parts.push(chunk.value);
      }
    } finally { await reader.cancel(); reader.releaseLock(); }
    return validateChatImage(Buffer.concat(parts), response.headers.get("content-type")?.split(";")[0]?.trim() ?? "");
  }

  async watchChat(uuid:string,order:string|undefined,signal:AbortSignal,changed:()=>void):Promise<void> {
    const token=this.tokenProvider();
    if(!token) throw new QvaApiError(401,"No hay sesión para el chat.");
    const response=await this.fetchImpl(`${API}${orderPath(uuid,"chat/stream",order)}`,{
      headers:{authorization:`Bearer ${token}`,accept:"text/event-stream"},
      signal:AbortSignal.any([signal,AbortSignal.timeout(90_000)]),redirect:"error",
    });
    if(!response.ok || !response.body || !response.headers.get("content-type")?.includes("text/event-stream")) {
      await response.body?.cancel();throw new Error(`Stream de chat no disponible (${response.status}).`);
    }
    await consumeChatStream(response.body,changed);
  }

  async listChat(uuid: string, order?: string): Promise<QvaChatMessage[]> {
    const data = await this.request(orderPath(uuid, "chat", order), { policy: "chat_read", retryRead: true });
    const source = Array.isArray(data)
      ? data
      : Array.isArray(data.chat)
        ? data.chat
        : Array.isArray(data.messages)
        ? data.messages
        : isObject(data.data) && Array.isArray(data.data.messages)
          ? data.data.messages
          : [];
    return source.flatMap((entry) => {
      if (!isObject(entry)) return [];
      const peerId = stringValue(entry.peer_id ?? entry.peerId ?? (isObject(entry.Peer) ? entry.Peer.uuid : undefined));
      const image = stringValue(entry.image);
      const message = stringValue(entry.message) ?? (image ? "📎 Imagen adjunta" : undefined);
      if (!peerId || message === undefined) return [];
      return [{
        id: stringValue(entry.id ?? entry.uuid) ?? createHash("sha256").update(`${peerId}:${String(entry.created_at ?? "")}:${message}${image ? `:${image}` : ""}`).digest("hex"),
        peerId,
        message,
        ...(image ? { image } : {}),
        ...(timestampValue(entry.created_at) ? { createdAt: timestampValue(entry.created_at)! } : {}),
        ...(entry.is_moderator === true ? { isModerator: true } : {}),
      }];
    });
  }

  async createOffer(body: {
    type: "buy" | "sell";
    coin: string;
    amount: number;
    receive: number;
    details: { name: string; value: string }[];
    message?: string;
    onlyKyc?: boolean;
    onlyVip?: boolean;
    private?: boolean;
    webhook?: string;
    tags?: string[];
    idempotencyKey?: string;
  }): Promise<P2pOffer> {
    if (body.message && body.message.length > 79)
      throw new Error(
        "El mensaje público de una oferta no puede superar 79 caracteres.",
      );
    const {
      idempotencyKey,
      onlyKyc,
      onlyVip,
      ...rest
    } = body;
    const offer = {
      ...rest,
      ...(onlyKyc !== undefined ? { only_kyc: Number(onlyKyc) } : {}),
      ...(onlyVip !== undefined ? { only_vip: Number(onlyVip) } : {}),
    };
    const payload = {
      ...offer,
      ...(idempotencyKey ? { idempotency_key: idempotencyKey } : {}),
    };
    const data = (await this.request("/p2p/create", {
      method: "POST",
      body: payload,
      policy: "create",
    })) as { p2p?: P2pOffer };
    try {
      if (!data.p2p) throw new Error("QvaPay no devolvió la oferta creada");
      return parseOffer(data.p2p, "oferta creada");
    } catch (error) {
      throw new QvaMutationUncertainError("create", error);
    }
  }

  async editOffer(
    uuid: string,
    body: Record<string, unknown>,
    options: { beforeDispatch?: () => boolean } = {},
  ): Promise<P2pOffer> {
    const data = await this.request(`/p2p/${uuid}/edit`, {
      method: "POST",
      body,
      policy: "edit",
      ...(options.beforeDispatch ? { beforeDispatch: options.beforeDispatch } : {}),
    });
    try {
      if (data.p2p === undefined)
        throw new Error("QvaPay no devolvió la oferta editada");
      return parseOffer(data.p2p, "oferta editada");
    } catch (error) {
      throw new QvaMutationUncertainError("edit", error);
    }
  }

  private async request(
    path: string,
    options: {
      method?: "GET" | "POST";
      body?: unknown;
      policy?: RequestPolicy;
      retryRead?: boolean;
      beforeDispatch?: (queuedForMs: number) => boolean | Promise<boolean>;
      secondary?: boolean;
      listTrace?: { dispatch(): void; attempt(): void; response(response: Response): void; finish(): void };
      readTrace?: { dispatch(): void; finish(): void };
    } = {},
  ): Promise<Record<string, unknown>> {
    const token = this.tokenProvider();
    if (!token)
      throw new QvaApiError(
        401,
        "No hay sesión de QvaPay. Ejecuta pnpm login en la terminal.",
      );
    const policy = options.policy ?? "read";
    const timer = policy === "apply" ? undefined : beginOperationRequest(policy, options.method ?? "GET");
    try {
      const result = await this.enqueue(policy, async () => {
        const init: RequestInit = {
          method: options.method ?? "GET",
          headers: {
            authorization: `Bearer ${token}`,
            ...(options.body && !(options.body instanceof FormData) ? { "content-type": "application/json" } : {}),
          },
          ...(options.body ? { body: options.body instanceof FormData ? options.body : JSON.stringify(options.body) } : {}),
          ...(policy === "chat" ? { redirect: "error" as const } : {}),
        };
        let response: Response;
        try {
          if (policy !== "list") { timer?.dispatched(); options.readTrace?.dispatch(); }
          response = policy === "list"
            ? await this.fetchListRead(`${API}${path}`, init, token, () => {
                timer?.dispatched();
                options.listTrace?.dispatch();
              }, options.listTrace?.attempt)
            : options.retryRead
            ? await this.fetchRead(
                `${API}${path}`,
                init,
                true,
              )
            : await this.fetchImpl(`${API}${path}`, {
                ...init,
                signal: AbortSignal.timeout(this.mutationTimeoutMs),
              });
        } catch (error) {
          options.listTrace?.finish();
          options.readTrace?.finish();
          if (policy !== "read" && policy !== "urgent_read" && policy !== "chat_read" && policy !== "list")
            throw new QvaMutationUncertainError(policy, error);
          throw error;
        }
        options.listTrace?.response(response);
        try { return await this.json(response); }
        finally { options.listTrace?.finish(); options.readTrace?.finish(); }
      }, options.beforeDispatch, options.secondary, policy === "apply" ? path.split("/")[2] : undefined, timer);
      timer?.finish("success");
      return result;
    } catch (error) {
      timer?.finish("failed");
      throw error;
    }
  }

  private async fetchListRead(input: string, init: RequestInit, token: string, onDispatch: () => void, onAttempt?: () => void): Promise<Response> {
    let lastError: unknown;
    let dispatched = false;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      // The budget failure is not a network error and must never trigger a retry.
      const owner = await this.listBudget?.waitForDispatch(token);
      const dispatchedAt = this.now();
      this.lastRequestAt = dispatchedAt;
      this.lastPolicyAt.set("list", dispatchedAt);
      if (!dispatched) { dispatched = true; onDispatch(); }
      onAttempt?.();
      let response: Response;
      try {
        response = await this.fetchImpl(input, { ...init, signal: AbortSignal.timeout(this.requestTimeoutMs) });
      } catch (error) {
        lastError = error;
        if (attempt < 2) await this.sleep(800 * (attempt + 1));
        continue;
      }
      // Preserve the server's 429; do not turn a quota response into a retry.
      if (response.status === 429) this.listBudget?.noteRateLimit(owner, retryAfterMilliseconds(response.headers.get("retry-after")));
      return response;
    }
    throw new QvaConnectionError(isTimeoutFailure(lastError) ? "timeout" : "network", lastError);
  }

  private async fetchRead(
    input: string,
    init?: RequestInit,
    retryRateLimit = true,
  ): Promise<Response> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const response = await this.fetchImpl(input, {
          ...init,
          signal: AbortSignal.timeout(this.requestTimeoutMs),
        });
        if (
          response.status !== 429 ||
          !retryRateLimit ||
          attempt === 2
        ) return response;
        await this.sleep(800 * 2 ** attempt);
      } catch (error) {
        lastError = error;
        if (attempt < 2) await this.sleep(800 * (attempt + 1));
      }
    }
    throw new QvaConnectionError(
      isTimeoutFailure(lastError) ? "timeout" : "network",
      lastError,
    );
  }

  private async fetchAuthentication(
    input: string,
    init: RequestInit,
    maxAttempts = 3,
  ): Promise<Response> {
    let lastError: unknown;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      try {
        return await this.fetchImpl(input, {
          ...init,
          signal: AbortSignal.timeout(this.authTimeoutMs),
        });
      } catch (error) {
        lastError = error;
        if (attempt + 1 < maxAttempts) await this.sleep(750 * 2 ** attempt);
      }
    }
    throw new QvaConnectionError(
      isTimeoutFailure(lastError) ? "timeout" : "network",
      lastError,
    );
  }

  private async json(response: Response): Promise<Record<string, unknown>> {
    const data = (await response.json().catch(() => ({}))) as Record<
      string,
      unknown
    >;
    if (!response.ok) {
      const message =
        typeof data.error === "string"
          ? data.error
          : typeof data.message === "string"
            ? data.message
            : `Error de QvaPay (${response.status})`;
      if (data.code === "PEER_REQUIREMENTS_NOT_MET") recordMissingRequirements(this.throttleState, data.missing, this.now());
      throw new QvaApiError(
        response.status,
        message,
        retryAfterMilliseconds(response.headers.get("retry-after")),
        typeof data.code === "string" ? data.code : undefined,
      );
    }
    return data;
  }

  private enqueue<T>(
    policy: RequestPolicy,
    task: () => Promise<T>,
    beforeDispatch?: (queuedForMs: number) => boolean | Promise<boolean>,
    secondary = false,
    applyUuid?: string,
    timer?: OperationRequestTimer,
  ): Promise<T> {
    if (policy === "apply" && secondary) return this.enqueueSecondaryApplication(task, beforeDispatch);
    if (policy === "apply") return this.enqueueApplication(task, beforeDispatch, applyUuid);
    const priorityRead = policy === "urgent_read";
    const list = policy === "list";
    const chat = policy === "chat" || policy === "chat_read";
    const run = (chat ? this.chatQueue : priorityRead ? this.urgentReadQueue : list ? this.listQueue : this.queue)
      .catch(() => undefined)
      .then(async () => {
        timer?.dequeued();
        const current = this.now();
        const persistedAt = this.persistedPolicyAt(policy);
        const generalDelay = !priorityRead && this.lastRequestAt
          ? this.lastRequestAt + POLICY_INTERVAL_MS.read - current
          : 0;
        const policyAt = Math.max(
          this.lastPolicyAt.get(policy) ?? 0,
          persistedAt,
        );
        const policyDelay = policyAt
          ? policyAt + POLICY_INTERVAL_MS[policy] - current
          : 0;
        const delay = Math.max(0, generalDelay, policyDelay);
        if (delay) await this.sleep(delay);
        if (beforeDispatch && !await beforeDispatch(Math.max(0, this.now() - current)))
          throw new QvaApiError(409, "Las condiciones cambiaron antes de la mutación; no se envió.", undefined, "LOCAL_CONDITIONS_CHANGED");
        const startedAt = this.now();
        if (!list) {
          this.lastRequestAt = startedAt;
          this.lastPolicyAt.set(policy, startedAt);
        }
        if (isPersistentThrottle(policy))
          this.throttleState?.set(
            `qva_throttle:${policy}`,
            String(startedAt),
          );
        return task();
      });
    const settled = run.then(
      () => undefined,
      () => undefined,
    );
    if (chat) this.chatQueue = settled;
    else if (priorityRead) this.urgentReadQueue = settled;
    else if (list) this.listQueue = settled;
    else this.queue = settled;
    return run;
  }

  private enqueueApplication<T>(task: () => Promise<T>, beforeDispatch?: (queuedForMs: number) => boolean | Promise<boolean>, uuid?: string): Promise<T> {
    this.primaryApplyPending++;
    const queuedAt = this.now();
    let dispatchedAt: number | null = null;
    let budgetWaitMs = 0;
    let outcome = "confirmed";
    const state = { get: (key: string) => this.throttleState?.get(key) ?? this.applyState.get(key) };
    const save = (key: string, value: string) => {
      this.applyState.set(key, value);
      this.throttleState?.set(key, value);
    };
    const dispatch = this.applyQueue.catch(() => undefined).then(async () => {
      const delay = Math.max(0, applyReadyAt(state, this.now()) - this.now());
      if (delay && beforeDispatch)
        throw new QvaApiError(409, `Sin cupo de aplicación durante ${Math.ceil(delay / 1000)} s; la oferta no se envió ni mantiene ocupada la cola.`, delay, "LOCAL_APPLY_QUOTA");
      if (delay) {
        await this.sleep(delay);
        budgetWaitMs = delay;
      }
      if (beforeDispatch) {
        let eligible: boolean;
        try {
          eligible = await beforeDispatch(Math.max(0, this.now() - queuedAt));
        } catch {
          throw new QvaApiError(409, "No se pudo revalidar la oferta antes del envío; no se envió la aplicación.", undefined, "LOCAL_PREFLIGHT_FAILED");
        }
        if (!eligible)
          throw new QvaApiError(409, "Las condiciones de la oferta cambiaron antes del envío; no se aplicó.", undefined, "LOCAL_CONDITIONS_CHANGED");
      }
      // An async guard can yield to a secondary request. Recheck before charging
      // the durable account budget, without awaiting the HTTP response in this gate.
      const remainingDelay = Math.max(0, applyReadyAt(state, this.now()) - this.now());
      if (remainingDelay) throw new QvaApiError(409, "El cupo cambió antes del envío.", remainingDelay, "LOCAL_APPLY_QUOTA");
      const dispatchTime = this.now();
      dispatchedAt = dispatchTime;
      const attempts = applyAttempts(state).filter(at => at + APPLY_WINDOW_MS > dispatchTime);
      save(APPLY_WINDOW_KEY, JSON.stringify([...attempts, dispatchedAt].slice(-2)));
      save("qva_throttle:apply", String(dispatchedAt));
      save("qva_apply_last_queue_ms", String(Math.max(0, dispatchedAt - queuedAt)));
      save("qva_apply_last_budget_wait_ms", String(delay));
      const response = task().catch(error => {
        if (error instanceof QvaApiError && error.status === 429)
          save("qva_throttle:apply_retry_at", String(this.now() + (error.retryAfterMs ?? APPLY_WINDOW_MS)));
        throw error;
      }).finally(() => save("qva_apply_last_response_ms", String(Math.max(0, this.now() - dispatchTime))));
      return { response };
    });
    this.applyQueue = dispatch.then(() => undefined, () => undefined);
    const run = dispatch.then(({ response }) => response);
    return run.catch(error => {
      outcome = error instanceof QvaApiError ? error.code ?? `HTTP_${error.status}` : "uncertain";
      throw error;
    }).finally(() => {
      this.primaryApplyPending--;
      if (uuid && this.onApplyTiming) {
        try { this.onApplyTiming({ uuid, queuedAt, dispatchedAt, finishedAt: this.now(), budgetWaitMs, outcome }); }
        catch { /* Telemetry must never turn a confirmed mutation into a retry. */ }
      }
    });
  }

  private async enqueueSecondaryApplication<T>(task: () => Promise<T>, guard?: (queuedForMs: number) => boolean | Promise<boolean>): Promise<T> {
    const yieldError = () => new QvaApiError(409, "La cacería cooperativa cedió el cupo a las operaciones propias.", undefined, "LOCAL_SECONDARY_YIELD");
    if (!this.secondaryApplyAvailable()) throw yieldError();
    if (guard) {
      let eligible: boolean;
      try { eligible = await guard(0); }
      catch { throw new QvaApiError(409,"No se pudo revalidar la cacería cooperativa; no se envió la aplicación.",undefined,"LOCAL_SECONDARY_PREFLIGHT_FAILED"); }
      if (!eligible) throw yieldError();
    }
    // Recheck after the async guard: a primary application may have arrived.
    if (!this.secondaryApplyAvailable()) throw yieldError();
    const at = this.now();
    this.applyState.set(APPLY_WINDOW_KEY, JSON.stringify([at]));
    this.throttleState?.set(APPLY_WINDOW_KEY, JSON.stringify([at]));
    this.applyState.set("qva_throttle:apply", String(at));
    this.throttleState?.set("qva_throttle:apply", String(at));
    try { return await task(); }
    catch (error) {
      if (error instanceof QvaApiError && error.status === 429) {
        const until = String(this.now() + (error.retryAfterMs ?? APPLY_WINDOW_MS));
        this.applyState.set("qva_throttle:apply_retry_at", until);
        this.throttleState?.set("qva_throttle:apply_retry_at", until);
      }
      throw error;
    }
  }

  private persistedPolicyAt(policy: RequestPolicy): number {
    if (!isPersistentThrottle(policy)) return 0;
    const value = Number(
      this.throttleState?.get(`qva_throttle:${policy}`) ?? 0,
    );
    return Number.isFinite(value) && value > 0 ? value : 0;
  }
}

const isPersistentThrottle = (policy: RequestPolicy): boolean =>
  ["create", "apply", "edit", "cancel", "paid", "received"].includes(policy);

const sleep = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

function retryAfterMilliseconds(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return undefined;
  return Math.max(0, timestamp - Date.now());
}

function isTimeoutFailure(error: unknown): boolean {
  let current = error;
  for (let depth = 0; depth < 5; depth += 1) {
    if (!current || typeof current !== "object") return false;
    const candidate = current as { name?: unknown; code?: unknown; cause?: unknown };
    if (
      candidate.name === "TimeoutError" ||
      candidate.name === "AbortError" ||
      (typeof candidate.code === "string" && candidate.code.includes("TIMEOUT"))
    ) return true;
    current = candidate.cause;
  }
  return false;
}
const numberField = (value: unknown, fallback: number): number =>
  typeof value === "number" && Number.isFinite(value)
    ? value
    : typeof value === "string" && Number.isFinite(Number(value))
      ? Number(value)
      : fallback;

function parseOffer(value: unknown, context: string, analyticsOnly = false): P2pOffer {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`Respuesta inválida de QvaPay (${context}): se esperaba una oferta.`);
  const raw = value as Record<string, unknown>;
  if (typeof raw.uuid !== "string" || !raw.uuid)
    throw new Error(`Respuesta inválida de QvaPay (${context}): UUID ausente.`);
  if (raw.type !== "buy" && raw.type !== "sell")
    throw new Error(`Respuesta inválida de QvaPay (${context}): tipo desconocido.`);
  if (typeof raw.coin !== "string" || !raw.coin)
    throw new Error(`Respuesta inválida de QvaPay (${context}): mercado ausente.`);
  const amount = positiveNumber(raw.amount, `${context}, amount`);
  const receive = positiveNumber(raw.receive, `${context}, receive`);
  if (typeof raw.status !== "string" || !raw.status)
    throw new Error(`Respuesta inválida de QvaPay (${context}): estado ausente.`);
  if (raw.User !== undefined && raw.User !== null) validateParty(raw.User, `${context}, User`);
  const peer = (raw.status === "open" || raw.offer_kind === "flexible") && isEmptyParty(raw.Peer) ? null : raw.Peer;
  if (peer !== undefined && peer !== null) validateParty(peer, `${context}, Peer`);
  if (raw.tags !== undefined && (!Array.isArray(raw.tags) || !raw.tags.every((tag) => typeof tag === "string")))
    throw new Error(`Respuesta inválida de QvaPay (${context}): etiquetas inválidas.`);
  const details = analyticsOnly ? undefined : normalizePaymentDetails(raw.details, context);
  const orders = Array.isArray(raw.Orders) ? raw.Orders.map((item: unknown) => {
    if (!isObject(item) || typeof item.uuid !== "string" || typeof item.status !== "string")
      throw new Error("QvaPay devolvió una orden inválida.");
    return { ...item, amount: positiveNumber(item.amount, "orden, amount"), receive: positiveNumber(item.receive, "orden, receive") };
  }) : undefined;
  return { ...raw, uuid: raw.uuid, type: raw.type, coin: raw.coin, amount, receive, status: raw.status, Peer: peer, details,
    ...(orders ? { Orders: orders } : {}) } as P2pOffer;
}

function orderPath(uuid: string, action: string, order?: string): string {
  return `/p2p/${encodeURIComponent(uuid)}/${action}${order ? `?order=${encodeURIComponent(order)}` : ""}`;
}

function normalizePaymentDetails(
  value: unknown,
  context: string,
): Record<string, string> | undefined {
  if (value === undefined || value === null) return undefined;
  if (Array.isArray(value)) {
    if (value.length === 0) return undefined;
    const entries: Array<[string, string]> = [];
    const names = new Set<string>();
    for (const item of value) {
      if (
        !item ||
        typeof item !== "object" ||
        Array.isArray(item) ||
        typeof (item as Record<string, unknown>).name !== "string" ||
        !(item as Record<string, unknown>).name ||
        typeof (item as Record<string, unknown>).value !== "string"
      )
        throw new Error(`Respuesta inválida de QvaPay (${context}): datos de pago inválidos.`);
      const { name, value: detailValue } = item as { name: string; value: string };
      if (names.has(name))
        throw new Error(`Respuesta inválida de QvaPay (${context}): datos de pago duplicados.`);
      names.add(name);
      entries.push([name, detailValue]);
    }
    return Object.fromEntries(entries);
  }
  if (stringRecord(value)) return value;
  throw new Error(`Respuesta inválida de QvaPay (${context}): datos de pago inválidos.`);
}

function parseAverages(value: Record<string, unknown>): Record<string, P2pAverage> {
  return Object.fromEntries(
    Object.entries(value).map(([market, raw]) => {
      if (!raw || typeof raw !== "object" || Array.isArray(raw))
        throw new Error(`Respuesta inválida de QvaPay (promedio ${market}).`);
      const source = raw as Record<string, unknown>;
      const average: P2pAverage = {};
      for (const [key, target] of [
        ["average", "average"],
        ["average_buy", "average_buy"],
        ["average_sell", "average_sell"],
        ["count", "count"],
      ] as const) {
        if (source[key] === undefined || source[key] === null) continue;
        const number = Number(source[key]);
        if (!Number.isFinite(number) || number < 0)
          throw new Error(`Respuesta inválida de QvaPay (promedio ${market}.${key}).`);
        average[target] = number;
      }
      if (typeof source.updated_at === "string") average.updated_at = source.updated_at;
      return [market, average];
    }),
  );
}

function positiveNumber(value: unknown, context: string): number {
  const decimalString =
    typeof value === "string" && /^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value);
  const number =
    typeof value === "number"
      ? value
      : decimalString
        ? Number(value)
        : Number.NaN;
  if (!Number.isFinite(number) || number <= 0)
    throw new Error(`Respuesta inválida de QvaPay (${context}): debe ser positivo.`);
  return number;
}

function validateParty(value: unknown, context: string): void {
  if (!value || typeof value !== "object" || typeof (value as Record<string, unknown>).uuid !== "string")
    throw new Error(`Respuesta inválida de QvaPay (${context}): identidad inválida.`);
}

function isEmptyParty(value: unknown): boolean {
  if (value === undefined || value === null || value === "") return true;
  if (Array.isArray(value)) return value.length === 0;
  return typeof value === "object" && Object.keys(value).length === 0;
}

function parseTransaction(value: unknown): QvaTransaction {
  if (!isObject(value)) throw new Error("Transacción de QvaPay inválida.");
  const raw = value;
  const amount = raw.amount == null || raw.amount === "" ? NaN : Number(raw.amount);
  if (typeof raw.uuid !== "string" || !raw.uuid || !Number.isFinite(amount) || amount < 0)
    throw new Error("Importe o identificador de transacción de QvaPay inválido.");
  const identity = (value: unknown) => isObject(value) && typeof value.uuid === "string" ? { uuid: value.uuid } : null;
  const p2p = isObject(raw.P2P ?? raw.p2p) ? (raw.P2P ?? raw.p2p) as Record<string, unknown> : undefined;
  const tick = typeof p2p?.coin === "string" ? p2p.coin : isObject(p2p?.coin) ? p2p.coin.tick : undefined;
  const wallet = isObject(raw.Wallet ?? raw.wallet) ? (raw.Wallet ?? raw.wallet) as Record<string, unknown> : undefined;
  const walletCoin = wallet?.Coin ?? wallet?.coin;
  const positive = (value: unknown) => value != null && value !== "" && Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : undefined;
  const p2pAmount = positive(p2p?.amount), receive = positive(p2p?.receive);
  return {
    uuid: raw.uuid, amount, status: typeof raw.status === "string" ? raw.status : "unknown",
    ...(typeof raw.description === "string" ? { description: raw.description.slice(0, 500) } : {}),
    ...(typeof raw.created_at === "string" ? { created_at: raw.created_at } : {}),
    ...(typeof raw.updated_at === "string" ? { updated_at: raw.updated_at } : {}),
    User: identity(raw.User ?? raw.user), PaidBy: identity(raw.PaidBy ?? raw.paid_by),
    ...(p2p ? { P2P: {
      ...(typeof p2p.uuid === "string" ? { uuid: p2p.uuid } : {}),
      ...(typeof tick === "string" ? { coin: tick } : {}),
      ...(p2pAmount === undefined ? {} : { amount: p2pAmount }),
      ...(receive === undefined ? {} : { receive }),
      ...(typeof p2p.status === "string" ? { status: p2p.status } : {}),
    } } : {}),
    ...(isObject(walletCoin) && typeof walletCoin.tick === "string" ? { Wallet: { Coin: { tick: walletCoin.tick } } } : {}),
  };
}

function stringRecord(value: unknown): value is Record<string, string> {
  return Boolean(
    value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.values(value).every((item) => typeof item === "string"),
  );
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length ? value : undefined;
}

function timestampValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}
