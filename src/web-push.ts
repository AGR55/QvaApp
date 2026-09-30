import webpush from "web-push";
import { createHash } from "node:crypto";
import type { TradingAlert } from "./store.js";

const KEYS_SETTING = "web_push:vapid_keys";
const SUBSCRIPTIONS_SETTING = "web_push:subscriptions";

export type StoredPushSubscription = webpush.PushSubscription;
export type BlockedOfferPush = Pick<
  TradingAlert,
  "uuid" | "coin" | "offerType" | "amount" | "receive" | "rate" | "reason" | "referenceRate" | "updatedAt"
>;

type SettingsStore = {
  get(key: string): string | undefined;
  set(key: string, value: string): void;
};

type PushRuntime = {
  generateVAPIDKeys(): webpush.VapidKeys;
  setVapidDetails(subject: string, publicKey: string, privateKey: string): void;
  sendNotification(subscription: webpush.PushSubscription, payload: string): Promise<unknown>;
};

export class WebPushService {
  private readonly keys: webpush.VapidKeys;

  constructor(
    private readonly store: SettingsStore,
    private readonly runtime: PushRuntime = webpush,
  ) {
    this.keys = this.loadKeys();
    this.runtime.setVapidDetails(
      "mailto:notifications@qvaapply.local",
      this.keys.publicKey,
      this.keys.privateKey,
    );
  }

  publicKey(): string {
    return this.keys.publicKey;
  }

  subscriptions(): StoredPushSubscription[] {
    return parseSubscriptions(this.store.get(SUBSCRIPTIONS_SETTING));
  }

  subscribe(value: unknown): StoredPushSubscription {
    const subscription = validateSubscription(value);
    const current = this.subscriptions().filter((item) => item.endpoint !== subscription.endpoint);
    current.push(subscription);
    this.saveSubscriptions(current);
    return subscription;
  }

  unsubscribe(endpoint: string): boolean {
    const current = this.subscriptions();
    const remaining = current.filter((item) => item.endpoint !== endpoint);
    if (remaining.length === current.length) return false;
    this.saveSubscriptions(remaining);
    return true;
  }

  async notifyBlocked(alert: BlockedOfferPush): Promise<void> {
    const version = `${alert.uuid}:${alert.rate}:${alert.reason}`;
    await this.notify({ id: version, type: "blocked-offer", alert, version, url: `/?view=auditoria&offer=${encodeURIComponent(alert.uuid)}` });
  }

  async notifyOperation(input: { uuid: string; coin: string; amount: number; kind: "operation-applied" | "own-offer-applied" | "reconciliation-required"; eventVersion?: string }): Promise<void> {
    const version = input.kind === "own-offer-applied" && input.eventVersion
      ? `${input.kind}:${input.uuid}:${input.eventVersion}`
      : `${input.kind}:${input.uuid}`;
    await this.notify({
      id: version,
      type: input.kind,
      version,
      alert: { uuid: input.uuid, coin: input.coin, amount: input.amount },
      url: `/?view=${input.kind === "operation-applied" || input.kind === "own-offer-applied" ? "operaciones" : "auditoria"}&operation=${encodeURIComponent(input.uuid)}`,
    });
  }

  async notifyRebalance(input: { uuid: string; kind: "rebalance-completed" | "rebalance-attention"; reason: string }): Promise<void> {
    const version = `${input.kind}:${input.uuid}`;
    await this.notify({
      id: version,
      type: input.kind,
      version,
      alert: { uuid: input.uuid, reason: input.reason },
      url: `/?view=ofertas&rebalance=${encodeURIComponent(input.uuid)}`,
    });
  }

  private async notify(payloadValue: Record<string, unknown> & { version: string }): Promise<void> {
    const payload = JSON.stringify(payloadValue);
    const expired = new Set<string>();
    const failures: unknown[] = [];
    await Promise.all(this.subscriptions().map(async (subscription) => {
      const endpointHash = createHash("sha256").update(subscription.endpoint).digest("hex").slice(0, 20);
      const dedupeKey = `web_push:sent:${payloadValue.version}:${endpointHash}`;
      if (this.store.get(dedupeKey) === "true") return;
      try {
        await this.runtime.sendNotification(subscription, payload);
        this.store.set(dedupeKey, "true");
      } catch (error) {
        const status = pushStatus(error);
        if (status === 404 || status === 410) expired.add(subscription.endpoint);
        else failures.push(error);
      }
    }));
    if (expired.size)
      this.saveSubscriptions(this.subscriptions().filter((item) => !expired.has(item.endpoint)));
    if (failures.length)
      throw new AggregateError(failures, "No se pudo entregar Web Push.");
  }

  private loadKeys(): webpush.VapidKeys {
    const saved = this.store.get(KEYS_SETTING);
    if (saved) {
      const parsed = JSON.parse(saved) as Partial<webpush.VapidKeys>;
      if (typeof parsed.publicKey === "string" && typeof parsed.privateKey === "string")
        return { publicKey: parsed.publicKey, privateKey: parsed.privateKey };
    }
    const generated = this.runtime.generateVAPIDKeys();
    this.store.set(KEYS_SETTING, JSON.stringify(generated));
    return generated;
  }

  private saveSubscriptions(subscriptions: StoredPushSubscription[]): void {
    this.store.set(SUBSCRIPTIONS_SETTING, JSON.stringify(subscriptions));
  }
}

function validateSubscription(value: unknown): StoredPushSubscription {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Suscripción Push inválida.");
  const candidate = value as Record<string, unknown>;
  const keys = candidate.keys as Record<string, unknown> | undefined;
  if (
    typeof candidate.endpoint !== "string" ||
    !candidate.endpoint.startsWith("https://") ||
    !keys ||
    typeof keys.p256dh !== "string" || !keys.p256dh ||
    typeof keys.auth !== "string" || !keys.auth
  ) throw new Error("Suscripción Push inválida.");
  return {
    endpoint: candidate.endpoint,
    expirationTime: typeof candidate.expirationTime === "number" ? candidate.expirationTime : null,
    keys: { p256dh: keys.p256dh, auth: keys.auth },
  };
}

function parseSubscriptions(value: string | undefined): StoredPushSubscription[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((item) => {
      try { return [validateSubscription(item)]; } catch { return []; }
    });
  } catch {
    return [];
  }
}

function pushStatus(error: unknown): number | undefined {
  return error && typeof error === "object" && typeof (error as { statusCode?: unknown }).statusCode === "number"
    ? (error as { statusCode: number }).statusCode
    : undefined;
}
