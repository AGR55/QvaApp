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
>;

type DeliveryRuntime = {
  telegram(notification: DurableNotification): Promise<void>;
  webPush(notification: DurableNotification): Promise<void>;
};

const RETRY_DELAYS = [15_000, 60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000];

export class NotificationDispatcher {
  private delivering: Promise<void> | undefined;

  constructor(
    private readonly store: NotificationStore,
    private readonly runtime: DeliveryRuntime,
    private readonly now: () => number = Date.now,
  ) {}

  async publish(input: NotificationInput): Promise<void> {
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
    await this.deliverDue();
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
    for (const notification of this.store.pendingNotificationDeliveries(now)) {
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

  private async deliver(
    notification: DurableNotification,
    channel: "telegram" | "push",
  ): Promise<void> {
    try {
      if (channel === "telegram") await this.runtime.telegram(notification);
      else await this.runtime.webPush(notification);
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
  if (event.kind === "own-offer-applied" && event.uuid && event.eventVersion)
    return `${event.kind}:${event.uuid}:${event.eventVersion}`;
  if (event.kind !== "blocked-offer" && event.uuid)
    return `${event.kind}:${event.uuid}`;
  const value = JSON.stringify(event);
  return `${event.kind}:${createHash("sha256").update(value).digest("hex").slice(0, 24)}`;
}
