import type { Store, Operation } from "./store.js";
import type { P2pOffer } from "./types.js";
import { operationDisplayState } from "./operation-display-state.js";

export interface ChatThread {
  id: string;
  uuid: string;
  orderUuid?: string | undefined;
  coin: string;
  amount: number;
  receive: number;
  offerType: "buy" | "sell";
  role: "creator" | "taker";
  state: string;
  counterpartyId?: string | undefined;
  counterpartyLabel?: string | undefined;
  createdAt: number;
  discoveredAt: number;
  updatedAt: number;
}
const chatThreadId = (uuid: string, order?: string) => `${uuid}:${order ?? "fixed"}`;
const timestamp = (value?: string) => value ? Date.parse(value) || 0 : 0;
const ACTIVE = new Set(["applied", "acknowledged", "processing", "paid", "revision"]);

/** Read projection only. Discovery never creates a monetary operation or a fiat movement. */
export class ChatCatalog {
  constructor(private readonly store: Pick<Store, "saveChatThread" | "chatThread" | "chatThreads" | "visibleOperations" | "getOperation" | "get" | "set">, private readonly now = Date.now) {}
  discover(offers: Iterable<P2pOffer>, account: string): void {
    if (!account) return;
    for (const offer of offers) {
      const creatorId = offer.User?.uuid ?? offer.owner_uuid;
      const creator = creatorId === account;
      if (offer.offer_kind === "flexible") {
        for (const order of offer.Orders ?? []) {
          if (!order.Taker?.uuid && ["completed", "cancelled", "canceled"].includes(order.status)) {
            const old = this.store.chatThread<ChatThread>(chatThreadId(offer.uuid, order.uuid));
            if (old && creatorId && ((creator && old.role === "creator") ||
              (!creator && old.role === "taker" && old.counterpartyId === creatorId))) {
              this.save({ ...old, state: order.status,
                updatedAt: timestamp(order.updated_at) || timestamp(offer.updated_at) });
            }
            continue;
          }
          if (!creator && order.Taker?.uuid !== account) continue;
          // An untaken parent is not a conversation; each child has its own peer.
          if (!order.Taker?.uuid || !creatorId) continue;
          this.save({ uuid: offer.uuid, orderUuid: order.uuid, coin: offer.coin, amount: order.amount,
            receive: order.receive, offerType: offer.type, role: creator ? "creator" : "taker", state: order.status,
            counterpartyId: creator ? order.Taker.uuid : creatorId,
            counterpartyLabel: creator ? order.Taker.username ?? order.Taker.name : offer.User?.username ?? offer.User?.name,
            createdAt: timestamp(order.created_at), updatedAt: timestamp(order.updated_at) || timestamp(offer.updated_at) });
        }
      } else if ((creator || offer.Peer?.uuid === account) && offer.Peer?.uuid && creatorId) {
        this.save({ uuid: offer.uuid, coin: offer.coin, amount: offer.amount, receive: offer.receive, offerType: offer.type,
          role: creator ? "creator" : "taker", state: offer.status, counterpartyId: creator ? offer.Peer.uuid : creatorId,
          counterpartyLabel: creator ? offer.Peer.username ?? offer.Peer.name : offer.User?.username ?? offer.User?.name,
          createdAt: timestamp(offer.created_at), updatedAt: timestamp(offer.updated_at) });
      } else if (!offer.Peer?.uuid && ["cancelled", "canceled", "open", "completed"].includes(offer.status)) {
        // Cancellation/reopening may remove Peer. Only update a conversation
        // whose ownership and counterparty were established previously.
        const old = this.store.chatThread<ChatThread>(chatThreadId(offer.uuid));
        if (old && creatorId && ((creator && old.role === "creator") ||
          (!creator && old.role === "taker" && old.counterpartyId === creatorId))) {
          this.save({ ...old, state: offer.status === "open" ? "cancelled" : offer.status,
            updatedAt: timestamp(offer.updated_at) });
        }
      }
    }
  }
  private save(input: Omit<ChatThread, "id" | "discoveredAt">): ChatThread {
    const id = chatThreadId(input.uuid, input.orderUuid);
    const old = this.store.chatThread<ChatThread>(id);
    // Older listing snapshots must not resurrect a completed conversation.
    // A genuinely new application has a different counterparty or newer local
    // operation creation date and is handled separately by the local overlay.
    if (old && old.counterpartyId === input.counterpartyId &&
      ["completed", "cancelled", "canceled"].includes(old.state) && ACTIVE.has(input.state) &&
      (!input.updatedAt || input.updatedAt <= old.updatedAt)) return old;
    if (old && input.updatedAt && input.updatedAt < old.updatedAt) return old;
    const thread = { ...input, id, discoveredAt: old?.discoveredAt ?? this.now(), updatedAt: input.updatedAt || old?.updatedAt || this.now() };
    if (JSON.stringify(thread) !== JSON.stringify(old)) this.store.saveChatThread(id, thread, this.now());
    return thread;
  }
  private local(operation: Operation): ChatThread {
    const old = this.store.chatThread<ChatThread>(chatThreadId(operation.uuid, operation.orderUuid));
    // Verified remote discovery is authoritative about creator/taker identity.
    return { ...old, id: chatThreadId(operation.uuid, operation.orderUuid), uuid: operation.uuid, orderUuid: operation.orderUuid,
      coin: operation.coin, amount: operation.amount, receive: operation.receive, offerType: old?.offerType ?? operation.offerType,
      role: old?.role ?? "taker", state: operationDisplayState(operation.state,
        old && operation.createdAt <= old.discoveredAt ? old.state : undefined), counterpartyId: old?.counterpartyId ?? operation.counterpartyId,
      createdAt: operation.createdAt, discoveredAt: old?.discoveredAt ?? operation.createdAt, updatedAt: old?.updatedAt ?? operation.createdAt };
  }
  list(): ChatThread[] {
    const result = new Map(this.store.chatThreads<ChatThread>().map(thread => [thread.id, thread]));
    // Closed local operations leave visibleOperations(), but their terminal
    // evidence must still override the older catalog entries retained for chat.
    for (const thread of result.values()) {
      const operation = this.store.getOperation(thread.uuid);
      if (operation && operation.orderUuid === thread.orderUuid) result.set(thread.id, this.local(operation));
    }
    for (const operation of this.store.visibleOperations(300)) {
      const thread = this.local(operation);
      result.set(thread.id, thread);
    }
    return [...result.values()].sort((a,b) => Number(ACTIVE.has(b.state))-Number(ACTIVE.has(a.state)) || b.updatedAt-a.updatedAt).slice(0,300);
  }
  get(uuid: string, order?: string): ChatThread | undefined {
    const local = this.store.getOperation(uuid);
    const resolvedOrder = order ?? local?.orderUuid;
    if (local && local.orderUuid === resolvedOrder) return this.local(local);
    return this.store.chatThread<ChatThread>(chatThreadId(uuid, resolvedOrder));
  }
  syncable(): ChatThread[] {
    return this.list().filter(thread => ACTIVE.has(thread.state) || this.now()-thread.updatedAt < 24*60*60_000);
  }

  /** Recent-offer pages are not a full history. Recheck at most two missing
   * active parents per fiat-sync tick, fairly, without assuming absence = closed. */
  async refreshMissing(known: Set<string>, account: string, read: (uuid: string) => Promise<P2pOffer>): Promise<void> {
    if (!account) return;
    const polledAt = (uuid: string) => Number(this.store.get(`chat_status_polled_at:${uuid}`) ?? 0);
    const uuids = [...new Set(this.list().filter(thread => ACTIVE.has(thread.state) && !known.has(thread.uuid)).map(thread => thread.uuid))]
      .filter(uuid => this.now() - polledAt(uuid) >= 30_000)
      .sort((a, b) => polledAt(a) - polledAt(b)).slice(0, 2);
    for (const uuid of uuids) {
      this.store.set(`chat_status_polled_at:${uuid}`, String(this.now()));
      try {
        const offer = await read(uuid);
        if (offer.uuid === uuid) this.discover([offer], account);
      } catch { /* Keep last evidence; 404/timeouts do not prove cancellation. */ }
    }
  }
}
