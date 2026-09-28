import { createHash } from "node:crypto";
import {
  AckPolicy,
  DeliverPolicy,
  jetstream,
  jetstreamManager,
  type ConsumerMessages,
} from "@nats-io/jetstream";
import {
  connect,
  type NatsConnection,
} from "@nats-io/transport-node";
import type { Store } from "./store.js";
import type { Vault } from "./vault.js";

const NETWORK_RESOURCE = "cooperative-network";
const TOKEN_SETTING = "cooperative_sync_token";
const TOKEN_ISSUED_SETTING = "cooperative_sync_token_issued_at";
const MAX_PAYLOAD_BYTES = 1_000_000;
const TOKEN_REFRESH_MS = 4 * 24 * 60 * 60 * 1_000;

export interface CooperativeAggregate {
  coin: string;
  fiat: number;
  price: number;
  minimal: number;
  offersCount: number;
}

export interface CooperativeContribution {
  coin: string;
  fiat: number;
  minimal: number;
  price: number;
  state: "pending" | "confirmed";
  updatedAt: number;
}

export interface CooperativeNetworkState {
  enabled: boolean;
  httpConnected: boolean;
  natsConnected: boolean;
  snapshot: Record<string, CooperativeAggregate>;
  contributions: Record<string, CooperativeContribution>;
  lastHttpAt: number | null;
  lastNatsAt: number | null;
  lastError: string | null;
}

export type HuntingSyncConfig =
  | {
      enabled: false;
      baseUrl?: undefined;
      natsUrl?: undefined;
      email?: undefined;
      password?: undefined;
    }
  | {
      enabled: true;
      baseUrl: string;
      natsUrl: string;
      email: string;
      password: string;
    };

export class SyncCoreError extends Error {
  constructor(
    public readonly status: number | undefined,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

type FetchLike = typeof globalThis.fetch;

export class SyncCoreClient {
  constructor(
    private readonly baseUrl: string,
    private readonly fetchImpl: FetchLike = globalThis.fetch,
    private readonly timeoutMs = 8_000,
  ) {}

  async login(email: string, password: string): Promise<string> {
    const data = await this.request("/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    });
    if (typeof data.api_key !== "string" || !data.api_key.startsWith("csk_"))
      throw new SyncCoreError(undefined, "Sync Core no devolvió una API key válida.");
    return data.api_key;
  }

  async snapshot(token: string): Promise<Record<string, CooperativeAggregate>> {
    return parseCooperativeSnapshot(await this.request("/hunts/sync", {}, token));
  }

  async contributions(token: string): Promise<Record<string, CooperativeContribution>> {
    return parseCooperativeContributions(
      await this.request("/hunts?me=true&active=true&page_size=100", {}, token),
    );
  }

  async publish(token: string, input: Omit<CooperativeContribution, "state" | "updatedAt">): Promise<void> {
    await this.request("/hunts", {
      method: "POST",
      body: JSON.stringify({
        coin: input.coin,
        fiat: input.fiat,
        minimal: input.minimal,
        price: input.price,
      }),
    }, token);
  }

  async withdraw(token: string, coin: string): Promise<void> {
    await this.request(`/hunts/${encodeURIComponent(coin)}`, {
      method: "DELETE",
    }, token);
  }

  private async request(
    path: string,
    init: RequestInit = {},
    token?: string,
  ): Promise<Record<string, unknown>> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(new URL(path, this.baseUrl), {
        ...init,
        signal: controller.signal,
        headers: {
          accept: "application/json",
          ...(init.body ? { "content-type": "application/json" } : {}),
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...init.headers,
        },
      });
      const text = await response.text();
      if (text.length > MAX_PAYLOAD_BYTES)
        throw new SyncCoreError(response.status, "Sync Core devolvió una respuesta demasiado grande.");
      let data: unknown = {};
      try {
        data = text ? JSON.parse(text) : {};
      } catch (cause) {
        throw new SyncCoreError(response.status, "Sync Core devolvió JSON inválido.", { cause });
      }
      if (!response.ok) {
        const message = record(data) && typeof data.message === "string"
          ? data.message
          : record(data) && typeof data.error === "string"
            ? data.error
            : `Sync Core rechazó la solicitud (${response.status}).`;
        throw new SyncCoreError(response.status, message);
      }
      if (!record(data))
        throw new SyncCoreError(response.status, "Sync Core devolvió una respuesta inesperada.");
      return data;
    } catch (error) {
      if (error instanceof SyncCoreError) throw error;
      if (error instanceof Error && error.name === "AbortError")
        throw new SyncCoreError(undefined, "Sync Core no respondió a tiempo.", { cause: error });
      throw new SyncCoreError(undefined, "No se pudo conectar con Sync Core.", { cause: error });
    } finally {
      clearTimeout(timer);
    }
  }
}

export function parseCooperativeSnapshot(raw: unknown): Record<string, CooperativeAggregate> {
  if (!record(raw) || !record(raw.data))
    throw new Error("El snapshot cooperativo no contiene data.");
  const parsed: Record<string, CooperativeAggregate> = {};
  for (const [key, value] of Object.entries(raw.data)) {
    if (!record(value)) throw new Error(`El mercado ${key} no es válido.`);
    const coin = stringField(value.coin, "coin").toUpperCase();
    if (!/^[A-Z0-9_]{2,40}$/.test(coin) || coin !== key.toUpperCase())
      throw new Error(`El código de mercado ${key} no es válido.`);
    parsed[coin] = {
      coin,
      fiat: finiteNonNegative(value.fiat, `${coin}.fiat`),
      price: finiteNonNegative(value.price, `${coin}.price`),
      minimal: finiteNonNegative(value.minimal, `${coin}.minimal`),
      offersCount: integerNonNegative(value.offers_count, `${coin}.offers_count`),
    };
  }
  return parsed;
}

export function parseCooperativeContributions(raw: unknown): Record<string, CooperativeContribution> {
  if (!record(raw) || !Array.isArray(raw.data))
    throw new Error("La lista de aportes cooperativos no contiene data.");
  const parsed: Record<string, CooperativeContribution> = {};
  for (const item of raw.data) {
    if (!record(item)) throw new Error("Sync Core devolvió un aporte inválido.");
    const coin = normalizeCoin(stringField(item.coin, "coin"));
    const updatedAt = typeof item.updated_at === "string"
      ? Date.parse(item.updated_at)
      : Number.NaN;
    parsed[coin] = {
      coin,
      fiat: finitePositive(item.fiat, `${coin}.fiat`),
      minimal: finitePositive(item.minimal, `${coin}.minimal`),
      price: finitePositive(item.price, `${coin}.price`),
      state: "confirmed",
      updatedAt: Number.isFinite(updatedAt) ? updatedAt : Date.now(),
    };
  }
  return parsed;
}

export class HuntingSyncCoordinator {
  private readonly client: SyncCoreClient | undefined;
  private connection: NatsConnection | undefined;
  private connectionToken: string | undefined;
  private messages: ConsumerMessages | undefined;
  private token: string | undefined;
  private stopped = false;

  constructor(
    private readonly config: HuntingSyncConfig,
    private readonly store: Store,
    private readonly vault: Vault,
    fetchImpl: FetchLike = globalThis.fetch,
  ) {
    this.client = config.enabled && config.baseUrl
      ? new SyncCoreClient(config.baseUrl, fetchImpl)
      : undefined;
    const cached = store.loadRemoteResource<CooperativeNetworkState>(NETWORK_RESOURCE);
    if (cached)
      this.saveState({
        ...cached.data,
        enabled: config.enabled,
        httpConnected: false,
        natsConnected: false,
      });
    else
      this.saveState(emptyNetworkState(config.enabled));
  }

  state(): CooperativeNetworkState {
    return this.store.loadRemoteResource<CooperativeNetworkState>(NETWORK_RESOURCE)?.data ??
      emptyNetworkState(this.config.enabled);
  }

  async start(): Promise<void> {
    if (!this.config.enabled || this.stopped) return;
    try {
      await this.reconcile();
    } catch (error) {
      this.recordFailure(error);
    }
  }

  async reconcile(): Promise<void> {
    if (!this.config.enabled || this.stopped) return;
    try {
      let token = await this.ensureToken();
      try {
        await this.connectNats(token);
      } catch (error) {
        this.recordFailure(error);
      }
      try {
        await this.reconcileWithToken(token);
      } catch (error) {
        if (!(error instanceof SyncCoreError) || error.status !== 401) throw error;
        token = await this.ensureToken(true);
        try {
          await this.connectNats(token);
        } catch (natsError) {
          this.recordFailure(natsError);
        }
        await this.reconcileWithToken(token);
      }
    } catch (error) {
      this.recordFailure(error);
      throw error;
    }
  }

  async publish(input: Omit<CooperativeContribution, "state" | "updatedAt">): Promise<void> {
    if (!this.config.enabled)
      throw new Error("La red cooperativa no está habilitada.");
    validateContribution(input);
    const pending: CooperativeContribution = { ...input, state: "pending", updatedAt: Date.now() };
    this.updateContribution(pending);
    await this.authorized((token) => this.requiredClient().publish(token, input));
    await this.reconcile();
  }

  async withdraw(coin: string): Promise<void> {
    if (!this.config.enabled)
      throw new Error("La red cooperativa no está habilitada.");
    const normalized = normalizeCoin(coin);
    await this.authorized((token) => this.requiredClient().withdraw(token, normalized));
    const state = this.state();
    delete state.contributions[normalized];
    this.saveState(state);
    await this.reconcile();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await this.messages?.close();
    this.messages = undefined;
    if (this.connection) await this.connection.drain();
    this.connection = undefined;
    this.connectionToken = undefined;
    this.patchState({ natsConnected: false });
  }

  private async authorized<T>(action: (token: string) => Promise<T>): Promise<T> {
    let token = await this.ensureToken();
    try {
      return await action(token);
    } catch (error) {
      if (!(error instanceof SyncCoreError) || error.status !== 401) throw error;
      token = await this.ensureToken(true);
      await this.connectNats(token);
      return action(token);
    }
  }

  private async ensureToken(force = false): Promise<string> {
    if (!force && this.token) return this.token;
    if (!force) {
      const encrypted = this.store.get(TOKEN_SETTING);
      const issuedAt = Number(this.store.get(TOKEN_ISSUED_SETTING));
      if (encrypted && Number.isFinite(issuedAt) && Date.now() - issuedAt < TOKEN_REFRESH_MS) {
        try {
          this.token = this.vault.decrypt(encrypted);
          return this.token;
        } catch {
          // Se solicita un token nuevo si el material persistido no se puede descifrar.
        }
      }
    }
    const token = await this.requiredClient().login(
      this.config.email ?? "",
      this.config.password ?? "",
    );
    this.store.set(TOKEN_SETTING, this.vault.encrypt(token));
    this.store.set(TOKEN_ISSUED_SETTING, String(Date.now()));
    this.token = token;
    return token;
  }

  private async reconcileWithToken(token: string): Promise<void> {
    const [snapshot, contributions] = await Promise.all([
      this.requiredClient().snapshot(token),
      this.requiredClient().contributions(token),
    ]);
    const current = this.state();
    this.saveState({
      ...current,
      httpConnected: true,
      snapshot,
      contributions,
      lastHttpAt: Date.now(),
      lastError: null,
    });
  }

  private async connectNats(token: string): Promise<void> {
    if (
      this.connection &&
      this.messages &&
      this.connectionToken === token &&
      !this.connection.isClosed()
    ) return;
    if (this.messages) await this.messages.close();
    this.messages = undefined;
    if (this.connection && !this.connection.isClosed()) await this.connection.drain();
    this.connection = undefined;
    this.connectionToken = undefined;
    const natsUrl = this.config.natsUrl;
    if (!natsUrl) throw new Error("SYNC_NATS_URL no está configurada.");
    const connection = await connect({
      servers: natsUrl,
      token,
      name: durableName(this.config.email ?? "qvaapply"),
      reconnect: true,
      maxReconnectAttempts: -1,
    });
    try {
      const durable = durableName(this.config.email ?? "qvaapply");
      const manager = await jetstreamManager(connection);
      try {
        await manager.consumers.info("CACERIAS", durable);
      } catch {
        await manager.consumers.add("CACERIAS", {
          durable_name: durable,
          ack_policy: AckPolicy.Explicit,
          deliver_policy: DeliverPolicy.Last,
          filter_subject: "cacerias.sync",
        });
      }
      const consumer = await jetstream(connection).consumers.get("CACERIAS", durable);
      const messages = await consumer.consume({ max_messages: 1 });
      this.connection = connection;
      this.connectionToken = token;
      this.messages = messages;
      this.patchState({ natsConnected: true, lastError: null });
      void this.watchConnection(connection);
      void this.consume(messages);
    } catch (error) {
      if (!connection.isClosed()) await connection.drain();
      throw error;
    }
  }

  private async consume(messages: ConsumerMessages): Promise<void> {
    try {
      for await (const message of messages) {
        if (message.data.byteLength > MAX_PAYLOAD_BYTES) {
          message.term("payload too large");
          continue;
        }
        try {
          const snapshot = parseCooperativeSnapshot(JSON.parse(new TextDecoder().decode(message.data)));
          const current = this.state();
          this.saveState({
            ...current,
            snapshot,
            natsConnected: true,
            lastNatsAt: Date.now(),
            lastError: null,
          });
          message.ack();
        } catch (error) {
          this.recordFailure(error);
          message.term("invalid cooperative snapshot");
        }
      }
    } catch (error) {
      if (!this.stopped && this.messages === messages) this.recordFailure(error);
    }
  }

  private async watchConnection(connection: NatsConnection): Promise<void> {
    try {
      for await (const status of connection.status()) {
        if (this.connection !== connection) continue;
        if (status.type === "disconnect") this.patchState({ natsConnected: false });
        if (status.type === "reconnect") this.patchState({ natsConnected: true, lastError: null });
        if (status.type === "error") this.recordFailure(status);
      }
    } catch (error) {
      if (!this.stopped) this.recordFailure(error);
    }
  }

  private updateContribution(contribution: CooperativeContribution): void {
    const state = this.state();
    state.contributions[contribution.coin] = contribution;
    this.saveState(state);
  }

  private patchState(patch: Partial<CooperativeNetworkState>): void {
    this.saveState({ ...this.state(), ...patch });
  }

  private saveState(state: CooperativeNetworkState): void {
    this.store.saveRemoteResource(NETWORK_RESOURCE, state);
  }

  private recordFailure(error: unknown): void {
    this.patchState({
      httpConnected: error instanceof SyncCoreError ? false : this.state().httpConnected,
      lastError: safeError(error),
    });
  }

  private requiredClient(): SyncCoreClient {
    if (!this.client) throw new Error("La sincronización cooperativa no está configurada.");
    return this.client;
  }
}

function emptyNetworkState(enabled: boolean): CooperativeNetworkState {
  return {
    enabled,
    httpConnected: false,
    natsConnected: false,
    snapshot: {},
    contributions: {},
    lastHttpAt: null,
    lastNatsAt: null,
    lastError: null,
  };
}

function validateContribution(input: Omit<CooperativeContribution, "state" | "updatedAt">): void {
  input.coin = normalizeCoin(input.coin);
  for (const [name, value] of Object.entries({ fiat: input.fiat, minimal: input.minimal, price: input.price }))
    if (!Number.isFinite(value) || value <= 0)
      throw new Error(`${name} debe ser un número positivo.`);
}

function normalizeCoin(value: string): string {
  const coin = value.trim().toUpperCase();
  if (!/^[A-Z0-9_]{2,40}$/.test(coin)) throw new Error("Mercado cooperativo inválido.");
  return coin;
}

function durableName(email: string): string {
  return `qvaapply-${createHash("sha256").update(email).digest("hex").slice(0, 16)}`;
}

function safeError(error: unknown): string {
  if (error instanceof SyncCoreError) return error.message.slice(0, 300);
  return error instanceof Error
    ? error.message.replace(/csk_[a-f0-9]+/gi, "[token]").slice(0, 300)
    : "Error desconocido de sincronización.";
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} no es válido.`);
  return value.trim();
}

function finiteNonNegative(value: unknown, field: string): number {
  const parsed = typeof value === "number" || typeof value === "string" ? Number(value) : Number.NaN;
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`${field} no es válido.`);
  return parsed;
}

function finitePositive(value: unknown, field: string): number {
  const parsed = finiteNonNegative(value, field);
  if (parsed <= 0) throw new Error(`${field} debe ser positivo.`);
  return parsed;
}

function integerNonNegative(value: unknown, field: string): number {
  const parsed = finiteNonNegative(value, field);
  if (!Number.isInteger(parsed)) throw new Error(`${field} no es entero.`);
  return parsed;
}
