import { createHash } from "node:crypto";
import { ChatCatalog, type ChatThread } from "./chat-catalog.js";
import type { QvaChatMessage, QvaPayClient } from "./qvapay.js";
import { QvaMutationUncertainError } from "./qvapay.js";
import type { Store } from "./store.js";

const MAX_MESSAGES = 100;
const CHAT_MAX_AGE_MS = 30_000;
const CACHE_RETENTION_MS = 30 * 24 * 60 * 60_000;
const CACHE_KEY = (uuid: string) => `operation-chat:${uuid}`;
const READ_KEY = (uuid: string) => `operation-chat-read:${uuid}`;
const UNREAD_KEY = (id: string) => `operation-chat-unread:${id}`;
const ERROR_KEY = (uuid: string) => `operation-chat-error:${uuid}`;

type ChatGateway = Pick<QvaPayClient, "listChat" | "sendChat"> & Partial<Pick<QvaPayClient,"watchChat">>;

export class OperationChatError extends Error {
  constructor(public readonly status: 400 | 404 | 409, message: string) { super(message); }
}

export interface OperationChatView {
  uuid: string;
  threadId: string;
  orderUuid?: string | undefined;
  messages: (QvaChatMessage & { sender: "own" | "counterparty" | "moderator" })[];
  updatedAt: number | null;
  stale: boolean;
  unreadCount: number;
}

export class OperationChatService {
  private cursor = 0;
  private syncInFlight = false;
  private readonly refreshes = new Map<string, Promise<OperationChatView>>();
  private readonly catalog: ChatCatalog;
  private readonly notificationsStartedAt: number;
  private readonly streams = new Map<string,{abort:AbortController;retryAt:number;lastRefresh:number;running:boolean}>();
  close() { for(const stream of this.streams.values()) stream.abort.abort(); this.streams.clear(); }

  constructor(private readonly store: Store, private readonly qva: ChatGateway, private readonly now = Date.now) {
    this.catalog = new ChatCatalog(store, now);
    this.notificationsStartedAt = now();
  }

  threads() { return this.catalog.list().map(thread => ({ ...thread,
    unreadCount: Math.max(0,Number(this.store.get(UNREAD_KEY(thread.id))) || 0) })); }

  read(uuid: string, order?: string): OperationChatView {
    const operation = this.requireOperation(uuid, order);
    const key = operation.id;
    const cached = this.cached(operation);
    const messages = Array.isArray(cached?.data) ? cached.data : [];
    const readIds = new Set(this.readIds(key));
    const self = this.store.get("analytics_account_uuid");
    const unreadCount = messages.filter(message =>
      !readIds.has(message.id) && (message.isModerator || (operation.counterpartyId
        ? message.peerId === operation.counterpartyId
        : Boolean(self && message.peerId !== self)))).length;
    return { uuid, threadId: key, orderUuid: operation.orderUuid, messages: messages.map(message => ({ ...message, sender: message.isModerator ? "moderator" as const
      : self && message.peerId === self ? "own" as const : "counterparty" as const })), updatedAt: cached?.updatedAt ?? null,
      stale: !cached || this.now() - cached.updatedAt > CHAT_MAX_AGE_MS || Boolean(this.store.get(ERROR_KEY(key))), unreadCount };
  }

  refresh(uuid: string, order?: string): Promise<OperationChatView> {
    const operation = this.requireOperation(uuid, order);
    const running = this.refreshes.get(operation.id);
    if (running) return running;
    const promise = this.refreshThread(operation).finally(() => this.refreshes.delete(operation.id));
    this.refreshes.set(operation.id, promise);
    return promise;
  }

  private async refreshThread(operation: ChatThread): Promise<OperationChatView> {
    const { uuid, orderUuid: order, id: key } = operation;
    try {
      this.notificationStart();
      const remote = await this.qva.listChat(uuid, order);
      const cached = this.cached(operation);
      const previous = cached?.data ?? [];
      const known = new Set(previous.map(message => message.id));
      const byId = new Map([...previous, ...remote].map(message => [message.id, message]));
      const messages = [...byId.values()]
        .sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0) || a.id.localeCompare(b.id))
        .slice(-MAX_MESSAGES);
      // Cache and outbox commit together: a restart cannot lose a newly discovered message.
      this.store.chatTransaction(() => {
        this.store.saveRemoteResource(CACHE_KEY(key), messages, this.now());
        this.store.set(ERROR_KEY(key), "");
        const readIds = new Set(this.readIds(key));
        const account = this.store.get("analytics_account_uuid");
        this.store.set(UNREAD_KEY(key),String(messages.filter(message=>!readIds.has(message.id) &&
          (message.isModerator || (operation.counterpartyId ? message.peerId===operation.counterpartyId : Boolean(account && message.peerId!==account)))).length));
        const self = this.store.get("analytics_account_uuid");
        for (const message of messages) {
          const incoming = message.isModerator || (self ? message.peerId !== self : Boolean(operation.counterpartyId && message.peerId === operation.counterpartyId));
          if (!incoming || known.has(message.id)) continue;
          // First observation is a baseline; messages since notification activation may notify, even before order discovery.
          if (!cached && (!message.createdAt || message.createdAt < this.notificationStart())) continue;
          const id = createHash("sha256").update(`${key}\0${message.id}`).digest("hex");
          this.store.enqueueChatPush(id, key, { id, uuid, orderUuid: order, threadId: key, messageId: message.id,
            title: message.isModerator ? "Moderación · QvaApply" : `${operation.counterpartyLabel || "Contraparte"} · ${operation.coin}`,
            body: message.message.slice(0, 1800), sender: message.isModerator ? "Moderación" : operation.counterpartyLabel || "Contraparte",
            createdAt: message.createdAt ?? this.now() }, this.now());
        }
      });
      return this.read(uuid, order);
    } catch (error) {
      if (!this.store.get(ERROR_KEY(key))) this.store.audit("operation_chat_refresh_failed", "No se pudo sincronizar el chat; se conserva la última copia.", uuid);
      this.store.set(ERROR_KEY(key), "true");
      throw error;
    }
  }

  async send(uuid: string, text: string, order?: string): Promise<{ id?: string; chat: OperationChatView }> {
    const operation = this.requireOperation(uuid, order);
    const message = text.trim();
    if (!message) throw new OperationChatError(400, "El mensaje no puede estar vacío.");
    if (message.length > 599) throw new OperationChatError(400, "El mensaje no puede superar 599 caracteres.");
    let result: Awaited<ReturnType<ChatGateway["sendChat"]>>;
    try { result = await this.qva.sendChat(uuid, message, operation.orderUuid); }
    catch (error) {
      if (error instanceof QvaMutationUncertainError)
        throw new OperationChatError(409, "El envío quedó incierto. Comprueba el chat antes de intentar enviarlo de nuevo.");
      throw error;
    }
    // El POST ya fue confirmado; un fallo posterior de lectura no lo convierte
    // en un fallo de envío ni provoca un segundo POST.
    try { await this.refresh(uuid, operation.orderUuid); } catch { /* Se conserva la copia local. */ }
    return { ...result, chat: this.read(uuid, operation.orderUuid) };
  }

  markRead(uuid: string, order?: string, visibleIds?: string[]): OperationChatView {
    const operation = this.requireOperation(uuid, order);
    const visible = visibleIds ? new Set(visibleIds.slice(-MAX_MESSAGES)) : undefined;
    const ids = new Set(this.readIds(operation.id));
    for (const message of this.read(uuid, operation.orderUuid).messages) {
      if (!visible || visible.has(message.id)) ids.add(message.id);
    }
    this.store.set(READ_KEY(operation.id), JSON.stringify([...ids].slice(-MAX_MESSAGES)));
    const result=this.read(uuid, operation.orderUuid);
    this.store.set(UNREAD_KEY(operation.id),String(result.unreadCount));
    return result;
  }

  unreadCounts(): Record<string, number> {
    const threads = this.threads();
    return Object.fromEntries(threads.flatMap(thread => [
      [thread.id, thread.unreadCount],
      // Existing clients address the single local operation by its parent UUID.
      ...(this.store.getOperation(thread.uuid)?.orderUuid === thread.orderUuid ? [[thread.uuid, thread.unreadCount]] : []),
    ]));
  }

  async syncActive(): Promise<void> {
    if (this.syncInFlight) return;
    this.syncInFlight = true;
    try {
      const lastPrune = Number(this.store.get("operation_chat_last_prune") ?? 0);
      if (this.now() - lastPrune >= 24 * 60 * 60_000) {
        this.store.pruneOperationChatCache(this.now() - CACHE_RETENTION_MS);
        this.store.pruneChatData(this.now() - CACHE_RETENTION_MS);
        this.store.set("operation_chat_last_prune", String(this.now()));
      }
      const operations = this.catalog.syncable();
      this.manageStreams(operations);
      if (!operations.length) return;
      const count = Math.min(2, operations.length);
      for (let index = 0; index < count; index += 1) {
        const operation = operations[(this.cursor + index) % operations.length]!;
        try { await this.refresh(operation.uuid, operation.orderUuid); } catch { /* La copia se conserva. */ }
      }
      this.cursor = (this.cursor + count) % operations.length;
    } finally { this.syncInFlight = false; }
  }

  private notificationStart(): number {
    const saved = Number(this.store.get("operation_chat_notifications_started_at"));
    if(saved) return saved;
    this.store.set("operation_chat_notifications_started_at",String(this.notificationsStartedAt));
    return this.notificationsStartedAt;
  }

  private manageStreams(threads: ChatThread[]) {
    if(!this.qva.watchChat) return;
    const active = threads.filter(thread=>["applied","acknowledged","processing","paid","revision"].includes(thread.state)).slice(0,8);
    const wanted = new Set(active.map(thread=>thread.id));
    for(const [id,stream] of this.streams) if(!wanted.has(id)) {stream.abort.abort();this.streams.delete(id);}
    for(const thread of active) {
      let stream=this.streams.get(thread.id);
      if(stream?.running || (stream && stream.retryAt>this.now())) continue;
      stream={abort:new AbortController(),retryAt:0,lastRefresh:0,running:true};
      this.streams.set(thread.id,stream);
      const current=stream;
      void this.qva.watchChat(thread.uuid,thread.orderUuid,current.abort.signal,()=>{
        if(current.abort.signal.aborted || this.now()-current.lastRefresh<2000) return;
        current.lastRefresh=this.now();
        void this.refresh(thread.uuid,thread.orderUuid).catch(()=>{});
      }).catch(()=>{}).finally(()=>{
        current.running=false;current.retryAt=this.now()+30_000;
      });
    }
  }

  private cached(thread: ChatThread) {
    const key = CACHE_KEY(thread.id);
    const current = this.store.loadRemoteResource<QvaChatMessage[]>(key);
    if(current) return current;
    const local = this.store.getOperation(thread.uuid);
    if(!local || local.orderUuid !== thread.orderUuid) return undefined;
    const legacy = this.store.loadRemoteResource<QvaChatMessage[]>(CACHE_KEY(thread.uuid));
    if(legacy) {
      this.store.saveRemoteResource(key,legacy.data,legacy.updatedAt);
      const read = this.store.get(READ_KEY(thread.uuid));
      if(read) this.store.set(READ_KEY(thread.id),read);
    }
    return legacy;
  }

  private requireOperation(uuid: string, order?: string): ChatThread {
    const operation = this.catalog.get(uuid, order);
    if (!operation) throw new OperationChatError(404, "No existe una operación o conversación propia con esa oferta y orden.");
    return operation;
  }

  private readIds(uuid: string): string[] {
    try {
      const value: unknown = JSON.parse(this.store.get(READ_KEY(uuid)) ?? "[]");
      return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string").slice(-MAX_MESSAGES) : [];
    } catch { return []; }
  }
}
