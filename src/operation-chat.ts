import type { QvaChatMessage, QvaPayClient } from "./qvapay.js";
import { QvaMutationUncertainError } from "./qvapay.js";
import type { Store } from "./store.js";

const MAX_MESSAGES = 100;
const CHAT_MAX_AGE_MS = 30_000;
const CACHE_RETENTION_MS = 30 * 24 * 60 * 60_000;
const CACHE_KEY = (uuid: string) => `operation-chat:${uuid}`;
const READ_KEY = (uuid: string) => `operation-chat-read:${uuid}`;
const ERROR_KEY = (uuid: string) => `operation-chat-error:${uuid}`;

type ChatGateway = Pick<QvaPayClient, "listChat" | "sendChat">;

export class OperationChatError extends Error {
  constructor(public readonly status: 400 | 404 | 409, message: string) { super(message); }
}

export interface OperationChatView {
  uuid: string;
  messages: (QvaChatMessage & { sender: "own" | "counterparty" | "moderator" })[];
  updatedAt: number | null;
  stale: boolean;
  unreadCount: number;
}

export class OperationChatService {
  private cursor = 0;
  private syncInFlight = false;

  constructor(private readonly store: Store, private readonly qva: ChatGateway, private readonly now = Date.now) {}

  read(uuid: string): OperationChatView {
    const operation = this.requireOperation(uuid);
    const cached = this.store.loadRemoteResource<QvaChatMessage[]>(CACHE_KEY(uuid));
    const messages = Array.isArray(cached?.data) ? cached.data : [];
    const readIds = new Set(this.readIds(uuid));
    const self = this.store.get("analytics_account_uuid");
    const unreadCount = messages.filter(message =>
      !readIds.has(message.id) && (message.isModerator || (operation.counterpartyId
        ? message.peerId === operation.counterpartyId
        : Boolean(self && message.peerId !== self)))).length;
    return { uuid, messages: messages.map(message => ({ ...message, sender: message.isModerator ? "moderator" as const
      : self && message.peerId === self ? "own" as const : "counterparty" as const })), updatedAt: cached?.updatedAt ?? null,
      stale: !cached || this.now() - cached.updatedAt > CHAT_MAX_AGE_MS || Boolean(this.store.get(ERROR_KEY(uuid))), unreadCount };
  }

  async refresh(uuid: string): Promise<OperationChatView> {
    this.requireOperation(uuid);
    try {
      const remote = await this.qva.listChat(uuid);
      const previous = this.store.loadRemoteResource<QvaChatMessage[]>(CACHE_KEY(uuid))?.data ?? [];
      const byId = new Map([...previous, ...remote].map(message => [message.id, message]));
      const messages = [...byId.values()]
        .sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0) || a.id.localeCompare(b.id))
        .slice(-MAX_MESSAGES);
      this.store.saveRemoteResource(CACHE_KEY(uuid), messages, this.now());
      this.store.set(ERROR_KEY(uuid), "");
      return this.read(uuid);
    } catch (error) {
      if (!this.store.get(ERROR_KEY(uuid))) this.store.audit("operation_chat_refresh_failed", "No se pudo sincronizar el chat; se conserva la última copia.", uuid);
      this.store.set(ERROR_KEY(uuid), "true");
      throw error;
    }
  }

  async send(uuid: string, text: string): Promise<{ id?: string; chat: OperationChatView }> {
    this.requireOperation(uuid);
    const message = text.trim();
    if (!message) throw new OperationChatError(400, "El mensaje no puede estar vacío.");
    if (message.length > 599) throw new OperationChatError(400, "El mensaje no puede superar 599 caracteres.");
    let result: Awaited<ReturnType<ChatGateway["sendChat"]>>;
    try { result = await this.qva.sendChat(uuid, message); }
    catch (error) {
      if (error instanceof QvaMutationUncertainError)
        throw new OperationChatError(409, "El envío quedó incierto. Comprueba el chat antes de intentar enviarlo de nuevo.");
      throw error;
    }
    // El POST ya fue confirmado; un fallo posterior de lectura no lo convierte
    // en un fallo de envío ni provoca un segundo POST.
    try { await this.refresh(uuid); } catch { /* Se conserva la copia local. */ }
    return { ...result, chat: this.read(uuid) };
  }

  markRead(uuid: string): OperationChatView {
    this.requireOperation(uuid);
    const ids = this.read(uuid).messages.map(message => message.id).slice(-MAX_MESSAGES);
    this.store.set(READ_KEY(uuid), JSON.stringify(ids));
    return this.read(uuid);
  }

  unreadCounts(): Record<string, number> {
    return Object.fromEntries(this.store.activeOperations().map(operation => [operation.uuid, this.read(operation.uuid).unreadCount]));
  }

  async syncActive(): Promise<void> {
    if (this.syncInFlight) return;
    this.syncInFlight = true;
    try {
      const lastPrune = Number(this.store.get("operation_chat_last_prune") ?? 0);
      if (this.now() - lastPrune >= 24 * 60 * 60_000) {
        this.store.pruneOperationChatCache(this.now() - CACHE_RETENTION_MS);
        this.store.set("operation_chat_last_prune", String(this.now()));
      }
      const operations = this.store.activeOperations();
      if (!operations.length) return;
      const count = Math.min(2, operations.length);
      for (let index = 0; index < count; index += 1) {
        const operation = operations[(this.cursor + index) % operations.length]!;
        try { await this.refresh(operation.uuid); } catch { /* La copia se conserva. */ }
      }
      this.cursor = (this.cursor + count) % operations.length;
    } finally { this.syncInFlight = false; }
  }

  private requireOperation(uuid: string) {
    const operation = this.store.getOperation(uuid);
    if (!operation) throw new OperationChatError(404, "No existe una operación propia con ese identificador.");
    return operation;
  }

  private readIds(uuid: string): string[] {
    try {
      const value: unknown = JSON.parse(this.store.get(READ_KEY(uuid)) ?? "[]");
      return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string").slice(-MAX_MESSAGES) : [];
    } catch { return []; }
  }
}
