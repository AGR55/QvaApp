import type {
  P2pAverage,
  P2pListPage,
  P2pOffer,
  QvaTransaction,
} from "./types.js";

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
  createdAt?: number;
}
export interface QvaPayRuntime {
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

type RequestPolicy =
  | "read"
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
  list: 2_001,
  create: 5_000,
  apply: 30_001,
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
  private queue = Promise.resolve();
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
  ): Promise<P2pListPage> {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params))
      if (value !== undefined) query.set(key, String(value));
    const data = await this.request(`/p2p?${query}`, {
      policy: "list",
      retryRead: true,
    });
    // La API actual usa `data` para la lista paginada. `offers` se conserva por compatibilidad.
    const rawOffers = Array.isArray(data.data)
      ? data.data
      : Array.isArray(data.offers)
        ? data.offers
        : [];
    const offers = rawOffers.map((offer, index) =>
      parseOffer(offer, `lista P2P, posición ${index + 1}`),
    );
    return {
      offers,
      total: numberField(data.total, offers.length),
      currentPage: numberField(data.current_page, numberField(data.page, 1)),
      perPage: numberField(
        data.per_page,
        numberField(data.take, offers.length),
      ),
    };
  }

  async getOffer(uuid: string): Promise<P2pOffer> {
    const data = (await this.request(`/p2p/${uuid}`, {
      policy: "read",
      retryRead: true,
    })) as { p2p?: P2pOffer };
    if (!data.p2p) throw new Error("QvaPay no devolvió la oferta solicitada");
    return parseOffer(data.p2p, "oferta solicitada");
  }

  async qusdBalance(): Promise<number> {
    const data = await this.request("/user", {
      policy: "read",
      retryRead: true,
    });
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
      if (Number.isFinite(value) && value >= 0) return value;
    }
    throw new Error(
      "La respuesta de balance de QvaPay no contiene un saldo QUSD reconocible; se bloqueó la venta por seguridad.",
    );
  }

  async profile(): Promise<{ uuid: string; balance?: number }> {
    const data = await this.request("/user", {
      policy: "read",
      retryRead: true,
    });
    if (typeof data.uuid !== "string")
      throw new Error("QvaPay no devolvió el UUID del usuario.");
    return {
      uuid: data.uuid,
      ...(typeof data.balance === "number" ? { balance: data.balance } : {}),
    };
  }

  async p2pAverages(): Promise<Record<string, P2pAverage>> {
    return this.enqueue("read", async () => {
      const response = await this.fetchRead(`${API}/p2p/averages`);
      const data = await this.json(response);
      return parseAverages(data);
    });
  }

  async listTransactions(): Promise<QvaTransaction[]> {
    const data = (await this.request(
      "/transaction?take=20&page=1&status=paid",
      { policy: "read", retryRead: true },
    )) as unknown;
    if (Array.isArray(data)) return data as QvaTransaction[];
    if (
      data &&
      typeof data === "object" &&
      Array.isArray((data as { transactions?: unknown }).transactions)
    )
      return (data as { transactions: QvaTransaction[] }).transactions;
    return [];
  }

  async apply(uuid: string): Promise<void> {
    await this.request(`/p2p/${uuid}/apply`, {
      method: "POST",
      policy: "apply",
    });
  }
  async cancel(uuid: string): Promise<void> {
    await this.request(`/p2p/${uuid}/cancel`, {
      method: "POST",
      policy: "cancel",
    });
  }
  async markPaid(uuid: string, txId: string): Promise<void> {
    await this.request(`/p2p/${uuid}/paid`, {
      method: "POST",
      body: { tx_id: txId },
      policy: "paid",
    });
  }
  async confirmReceived(uuid: string): Promise<void> {
    await this.request(`/p2p/${uuid}/received`, {
      method: "POST",
      policy: "received",
    });
  }
  async sendChat(uuid: string, message: string): Promise<{ id?: string; createdAt?: number }> {
    const data = await this.request(`/p2p/${uuid}/chat`, {
      method: "POST",
      body: { message },
      policy: "chat",
    });
    const raw = isObject(data.message) ? data.message : isObject(data.data) ? data.data : data;
    return {
      ...(stringValue(raw.id ?? raw.uuid) ? { id: stringValue(raw.id ?? raw.uuid)! } : {}),
      ...(timestampValue(raw.created_at) ? { createdAt: timestampValue(raw.created_at)! } : {}),
    };
  }

  async listChat(uuid: string): Promise<QvaChatMessage[]> {
    const data = await this.request(`/p2p/${uuid}/chat`, { policy: "read", retryRead: true });
    const source = Array.isArray(data)
      ? data
      : Array.isArray(data.messages)
        ? data.messages
        : isObject(data.data) && Array.isArray(data.data.messages)
          ? data.data.messages
          : [];
    return source.flatMap((entry, index) => {
      if (!isObject(entry)) return [];
      const peerId = stringValue(entry.peer_id ?? entry.peerId ?? (isObject(entry.Peer) ? entry.Peer.uuid : undefined));
      const message = stringValue(entry.message);
      if (!peerId || message === undefined) return [];
      return [{
        id: stringValue(entry.id ?? entry.uuid) ?? `${index}:${peerId}:${String(entry.created_at ?? "")}`,
        peerId,
        message,
        ...(timestampValue(entry.created_at) ? { createdAt: timestampValue(entry.created_at)! } : {}),
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
  ): Promise<P2pOffer> {
    const data = await this.request(`/p2p/${uuid}/edit`, {
      method: "POST",
      body,
      policy: "edit",
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
    } = {},
  ): Promise<Record<string, unknown>> {
    const token = this.tokenProvider();
    if (!token)
      throw new QvaApiError(
        401,
        "No hay sesión de QvaPay. Ejecuta pnpm login en la terminal.",
      );
    const policy = options.policy ?? "read";
    return this.enqueue(policy, async () => {
      const init: RequestInit = {
        method: options.method ?? "GET",
        headers: {
          authorization: `Bearer ${token}`,
          ...(options.body ? { "content-type": "application/json" } : {}),
        },
        ...(options.body ? { body: JSON.stringify(options.body) } : {}),
      };
      let response: Response;
      try {
        response = options.retryRead
          ? await this.fetchRead(
              `${API}${path}`,
              init,
              policy !== "list",
            )
          : await this.fetchImpl(`${API}${path}`, {
              ...init,
              signal: AbortSignal.timeout(this.mutationTimeoutMs),
            });
      } catch (error) {
        if (policy !== "read" && policy !== "list")
          throw new QvaMutationUncertainError(policy, error);
        throw error;
      }
      return this.json(response);
    });
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
  ): Promise<T> {
    const run = this.queue
      .catch(() => undefined)
      .then(async () => {
        const current = this.now();
        const persistedAt = this.persistedPolicyAt(policy);
        const generalDelay = this.lastRequestAt
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
        const startedAt = this.now();
        this.lastRequestAt = startedAt;
        this.lastPolicyAt.set(policy, startedAt);
        if (isPersistentThrottle(policy))
          this.throttleState?.set(
            `qva_throttle:${policy}`,
            String(startedAt),
          );
        return task();
      });
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
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

function parseOffer(value: unknown, context: string): P2pOffer {
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
  const peer = raw.status === "open" && isEmptyParty(raw.Peer) ? null : raw.Peer;
  if (peer !== undefined && peer !== null) validateParty(peer, `${context}, Peer`);
  if (raw.tags !== undefined && (!Array.isArray(raw.tags) || !raw.tags.every((tag) => typeof tag === "string")))
    throw new Error(`Respuesta inválida de QvaPay (${context}): etiquetas inválidas.`);
  if (raw.details !== undefined && !stringRecord(raw.details))
    throw new Error(`Respuesta inválida de QvaPay (${context}): datos de pago inválidos.`);
  return { ...raw, uuid: raw.uuid, type: raw.type, coin: raw.coin, amount, receive, status: raw.status, Peer: peer } as P2pOffer;
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
