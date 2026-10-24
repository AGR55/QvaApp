import type { Store, Operation } from "./store.js";
import type { P2pOffer } from "./types.js";

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
  constructor(private readonly store: Pick<Store, "saveChatThread" | "chatThread" | "chatThreads" | "visibleOperations" | "getOperation">, private readonly now = Date.now) {}
  discover(offers: Iterable<P2pOffer>, account: string): void {
    if (!account) return;
    for (const offer of offers) {
      const creatorId = offer.User?.uuid ?? offer.owner_uuid;
      const creator = creatorId === account;
      if (offer.offer_kind === "flexible") {
        for (const order of offer.Orders ?? []) {
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
      }
    }
  }
  private save(input: Omit<ChatThread, "id" | "discoveredAt">): ChatThread {
    const id = chatThreadId(input.uuid, input.orderUuid);
    const old = this.store.chatThread<ChatThread>(id);
    const thread = { ...input, id, discoveredAt: old?.discoveredAt ?? this.now(), updatedAt: input.updatedAt || old?.updatedAt || this.now() };
    if (JSON.stringify(thread) !== JSON.stringify(old)) this.store.saveChatThread(id, thread, this.now());
    return thread;
  }
  private local(operation: Operation): ChatThread {
    const old = this.store.chatThread<ChatThread>(chatThreadId(operation.uuid, operation.orderUuid));
    // Verified remote discovery is authoritative about creator/taker identity.
    return { ...old, id: chatThreadId(operation.uuid, operation.orderUuid), uuid: operation.uuid, orderUuid: operation.orderUuid,
      coin: operation.coin, amount: operation.amount, receive: operation.receive, offerType: operation.offerType,
      role: old?.role ?? "taker", state: operation.state, counterpartyId: old?.counterpartyId ?? operation.counterpartyId,
      createdAt: operation.createdAt, discoveredAt: old?.discoveredAt ?? operation.createdAt, updatedAt: old?.updatedAt ?? operation.createdAt };
  }
  list(): ChatThread[] {
    const result = new Map(this.store.chatThreads<ChatThread>().map(thread => [thread.id, thread]));
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
}
