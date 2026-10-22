import { createHash } from "node:crypto";
import type {
  DurableNotification,
  NotificationKind,
  Store,
} from "./store.js";

interface NotificationEventPayload {
  kind: NotificationKind;
  uuid?: string;
  eventVersion?: string;
  intentId?: string;
  coin?: string;
  amount?: number;
  alert?: { uuid: string; rate?: number; reason?: string };
}

export interface NotificationInput {
  message: string;
  operationUuid?: string;
  event: NotificationEventPayload;
}

type NotificationStore = Pick<
  Store,
  | "audit"
  | "enqueueNotification"
  | "markNotificationDelivered"
  | "markNotificationFailed"
  | "pendingNotificationDeliveries"
  | "prepareNotificationSummaries"
>;

type DeliveryRuntime = {
  telegram(notification: DurableNotification): Promise<void>;
  webPush(notification: DurableNotification): Promise<void>;
};

const RETRY_DELAYS = [15_000, 60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000];
const ACTION_KINDS:ReadonlySet<NotificationKind>=new Set(['operation-applied','own-offer-applied','recovery-blocked','reconciliation-required','rebalance-attention']);

export class NotificationDispatcher {
  private delivering: Promise<void> | undefined;
  private urgentDelivery:Promise<void>|undefined;
  private readonly inFlight=new Map<string,Promise<void>>();

  constructor(
    private readonly store: NotificationStore,
    private readonly runtime: DeliveryRuntime,
    private readonly now: () => number = Date.now,
  ) {}

  async publish(input: NotificationInput, options: { waitForDelivery?: boolean } = {}): Promise<void> {
    this.store.enqueueNotification({
      id: notificationId(input.event),
      kind: input.event.kind,
      message: input.message,
      ...(input.operationUuid ?? input.event.uuid
        ? { operationUuid: input.operationUuid ?? input.event.uuid }
        : {}),
      payload: { ...input.event },
      createdAt: this.now(),
    });
    const delivery = this.delivering&&ACTION_KINDS.has(input.event.kind)?this.deliverUrgent():this.deliverDue();
    if (options.waitForDelivery !== false) await delivery;
    else void delivery.catch(error => {
      // The outbox was persisted above; the scheduler can retry a failed batch.
      this.store.audit("notification_warning", error instanceof Error ? error.message : String(error));
    });
  }

  async deliverDue(): Promise<void> {
    if (this.delivering) return this.delivering;
    this.delivering = this.deliverBatch();
    try {
      await this.delivering;
    } finally {
      this.delivering = undefined;
    }
  }

  private async deliverBatch(): Promise<void> {
    const now = this.now();
    this.store.prepareNotificationSummaries(now);
    for (let delivered = 0; delivered < 50; delivered++) {
      // Re-read priority between messages so race traces cannot bury an operation.
      const notification = this.store.pendingNotificationDeliveries(now, 1)[0];
      if (!notification) break;
      await Promise.all([
        notification.telegramDeliveredAt === null &&
        notification.telegramNextAttemptAt <= now
          ? this.deliver(notification, "telegram")
          : Promise.resolve(),
        notification.pushDeliveredAt === null &&
        notification.pushNextAttemptAt <= now
          ? this.deliver(notification, "push")
          : Promise.resolve(),
      ]);
    }
  }

  private async deliverUrgent():Promise<void>{
    if(this.urgentDelivery)return this.urgentDelivery;
    const run=async()=>{
      const now=this.now();
      for(let count=0;count<20;count++){
        const next=this.store.pendingNotificationDeliveries(now,50).find(item=>ACTION_KINDS.has(item.kind)&&
          !this.inFlight.has(`${item.id}:telegram`)&&!this.inFlight.has(`${item.id}:push`));
        if(!next)break;
        await Promise.all([
          next.telegramDeliveredAt===null&&next.telegramNextAttemptAt<=now?this.deliver(next,'telegram'):Promise.resolve(),
          next.pushDeliveredAt===null&&next.pushNextAttemptAt<=now?this.deliver(next,'push'):Promise.resolve(),
        ]);
      }
    };
    this.urgentDelivery=run();
    try{await this.urgentDelivery;}finally{this.urgentDelivery=undefined;}
  }

  private async deliver(notification:DurableNotification,channel:'telegram'|'push'):Promise<void>{
    const key=`${notification.id}:${channel}`,active=this.inFlight.get(key);
    if(active)return active;
    const work=this.deliverOnce(notification,channel);this.inFlight.set(key,work);
    try{await work;}finally{this.inFlight.delete(key);}
  }

  private async deliverOnce(
    notification: DurableNotification,
    channel: "telegram" | "push",
  ): Promise<void> {
    try {
      if (channel === "telegram") {
        if (notification.kind === "operation-applied" || notification.kind === "own-offer-applied" || notification.kind === "system-health")
          await this.runtime.telegram(notification);
      } else await this.runtime.webPush(notification);
      this.store.markNotificationDelivered(notification.id, channel, this.now());
    } catch (error) {
      const attempts = channel === "telegram"
        ? notification.telegramAttempts
        : notification.pushAttempts;
      const detail = error instanceof Error ? error.message : String(error);
      const delay = RETRY_DELAYS[Math.min(attempts, RETRY_DELAYS.length - 1)]!;
      this.store.markNotificationFailed(
        notification.id,
        channel,
        detail,
        this.now() + delay,
      );
      this.store.audit(
        "notification_warning",
        `${channel === "telegram" ? "Telegram" : "Web Push"}: ${detail}; se reintentará.`,
        notification.operationUuid,
      );
    }
  }
}

function notificationId(event: NotificationEventPayload): string {
  if (event.kind === "recovery-blocked" && event.intentId)
    return `recovery-blocked:${event.intentId}`;
  if (["own-offer-applied", "offer-taken", "offer-rejected"].includes(event.kind) && event.uuid && event.eventVersion)
    return `${event.kind}:${event.uuid}:${event.eventVersion}`;
  if (event.kind !== "blocked-offer" && event.uuid)
    return `${event.kind}:${event.uuid}`;
  const value = JSON.stringify(event);
  return `${event.kind}:${createHash("sha256").update(value).digest("hex").slice(0, 24)}`;
}
