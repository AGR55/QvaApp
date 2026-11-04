import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { ChatThread } from "./chat-catalog.js";
import { operationDisplayState } from "./operation-display-state.js";
import { assistedPaymentMarkets } from "./assisted-payment.js";

export type MobileOperatorScope = "read" | "actions";
type OperatorRecord = { id: string; label: string; tokenHash: string; scopes: MobileOperatorScope[]; createdAt: number; revokedAt: number | null; readRateWindowAt?: number; readRateCount?: number; writeRateWindowAt?: number; writeRateCount?: number };
export type MobileOperator = Omit<OperatorRecord, "tokenHash" | "readRateWindowAt" | "readRateCount" | "writeRateWindowAt" | "writeRateCount">;
type Storage = { get(key: string): string | undefined; set(key: string, value: string): void; audit(action: string, detail: string, uuid?: string): void };
type Operation = { uuid: string; orderUuid?: string | undefined; offerType: string; coin: string; amount: number; receive: number; rate: number; state: string; createdAt: number };

const KEY = "mobile_operators_v1";
const digest = (token: string) => createHash("sha256").update(token).digest("hex");

export class MobileOperatorService {
  constructor(
    private readonly storage: Storage,
    private readonly dependencies: {
      operations: () => Operation[];
      threads?: () => ChatThread[];
      alerts: () => { id: string; type: string; message: string; createdAt: number; operationUuid?: string }[];
      markets: () => { code: string; label: string; currency: string }[];
      markPaid: (uuid: string, reference: string) => Promise<void>;
      confirmReceived: (uuid: string) => Promise<void>;
      cancel: (uuid: string) => Promise<void>;
    },
    private readonly now: () => number = Date.now,
  ) {}

  private records(): OperatorRecord[] {
    try { const value: unknown = JSON.parse(this.storage.get(KEY) ?? "[]"); return Array.isArray(value) ? value as OperatorRecord[] : []; }
    catch { return []; }
  }
  private save(records: OperatorRecord[]) { this.storage.set(KEY, JSON.stringify(records)); }

  pair(label: string) {
    const clean = label.trim();
    if (!clean || clean.length > 80) throw new Error("Nombre de dispositivo inválido.");
    const token = randomBytes(36).toString("base64url");
    const operator: OperatorRecord = { id: randomUUID(), label: clean, tokenHash: digest(token), scopes: ["read", "actions"], createdAt: this.now(), revokedAt: null, readRateWindowAt: 0, readRateCount: 0, writeRateWindowAt: 0, writeRateCount: 0 };
    this.save([...this.records(), operator]);
    this.storage.audit("mobile_operator_created", `Operador móvil vinculado: ${clean}.`);
    return { operator: this.public(operator), token };
  }

  check(token: string, write = false): { ok: boolean; scopes?: MobileOperatorScope[]; operatorId?: string; rateLimited?: boolean } {
    const records = this.records();
    const index = records.findIndex((item) => item.tokenHash === digest(token) && item.revokedAt === null);
    if (index < 0) return { ok: false };
    const item = records[index]!;
    if (write && !item.scopes.includes("actions")) return { ok: false };
    if (!write && !item.scopes.includes("read")) return { ok: false };
    const now = this.now();
    const windowKey = write ? "writeRateWindowAt" : "readRateWindowAt";
    const countKey = write ? "writeRateCount" : "readRateCount";
    const windowAt = item[windowKey] ?? 0;
    const count = item[countKey] ?? 0;
    const limit = write ? 20 : 60;
    if (now - windowAt < 60_000 && count >= limit) return { ok: false, rateLimited: true };
    records[index] = {
      ...item,
      [windowKey]: now - windowAt >= 60_000 ? now : windowAt,
      [countKey]: now - windowAt >= 60_000 ? 1 : count + 1,
    };
    this.save(records);
    return { ok: true, scopes: item.scopes, operatorId: item.id };
  }

  revoke(id: string): boolean {
    let changed = false;
    const records = this.records().map((item) => {
      if (item.id !== id || item.revokedAt !== null) return item;
      changed = true;
      return { ...item, revokedAt: this.now() };
    });
    if (changed) { this.save(records); this.storage.audit("mobile_operator_revoked", `Operador móvil revocado: ${id}.`); }
    return changed;
  }
  list() { return this.records().map((item) => this.public(item)); }

  operations(limit: number) {
    const markets = new Map(this.dependencies.markets().map((market) => [market.code, market]));
    const local = this.dependencies.operations();
    const key = (op: { uuid: string; orderUuid?: string | undefined }) => `${op.uuid}:${op.orderUuid ?? "fixed"}`;
    const managed = new Map(local.map(operation => [key(operation), operation]));
    const merged = new Map<string, Operation & { role: "creator" | "taker"; chatAvailable: boolean }>();
    for (const thread of this.dependencies.threads?.() ?? []) {
      // The public side retains the existing mobile convention (side of the
      // offer taken). Creators have the opposite financial role to takers.
      merged.set(thread.id, { uuid: thread.uuid, orderUuid: thread.orderUuid,
        offerType: thread.role === "creator" ? thread.offerType === "buy" ? "sell" : "buy" : thread.offerType,
        coin: thread.coin, amount: thread.amount, receive: thread.receive,
        rate: thread.amount > 0 ? thread.receive / thread.amount : 0,
        state: thread.state, createdAt: thread.createdAt || thread.discoveredAt,
        role: thread.role, chatAvailable: true });
    }
    for (const operation of local) {
      const existing = merged.get(key(operation));
      merged.set(key(operation), { ...operation, state: operationDisplayState(operation.state, existing?.state), role: existing?.role ?? "taker", chatAvailable: true });
    }
    const active = new Set(["applied", "acknowledged", "processing", "paid", "revision"]);
    const operations = [...merged.values()].sort((a,b) => Number(active.has(b.state))-Number(active.has(a.state)) || b.createdAt-a.createdAt);
    // Retain the established ordering for callers without a remote catalog.
    const ordered = this.dependencies.threads ? operations : [...merged.values()];
    return ordered.slice(0, limit).map((operation) => {
      const market = markets.get(operation.coin);
      const actions = operation.offerType === "buy"
        ? ["applied", "acknowledged", "paid"].includes(operation.state) ? ["received", ...(operation.state === "applied" || operation.state === "acknowledged" ? ["cancel"] : [])] : []
        : operation.state === "applied" || operation.state === "acknowledged" ? ["paid", "cancel"] : [];
      const paymentAvailable = operation.offerType === "sell" && operation.role === "taker" &&
        ["applied", "acknowledged", "processing"].includes(operation.state) &&
        assistedPaymentMarkets[operation.coin]?.currency === market?.currency && Boolean(assistedPaymentMarkets[operation.coin]);
      return { id: key(operation), uuid: operation.uuid, orderUuid: operation.orderUuid, role: operation.role, chatAvailable: operation.chatAvailable, side: operation.offerType, market: operation.coin, marketLabel: market?.label ?? operation.coin, currency: market?.currency ?? "", amount: operation.amount, receive: operation.receive, rate: operation.rate, status: operation.state, createdAt: operation.createdAt, paymentAvailable, actions: managed.has(key(operation)) ? actions : [] };
    });
  }
  alerts() {
    return this.dependencies.alerts().slice(0, 100).map(({ id, type, message, createdAt, operationUuid }) => ({
      id, type, message, createdAt, ...(operationUuid ? { operationUuid } : {}),
    }));
  }
  markets() { return this.dependencies.markets().map(({ code, label, currency }) => ({ code, label, currency })); }

  async act(operatorId: string, uuid: string, action: "paid" | "received" | "cancel", reference?: string) {
    if (action === "paid" && !reference?.trim()) throw new Error("La referencia del pago es obligatoria.");
    this.storage.audit(`mobile_${action}_requested`, `Acción ${action} solicitada desde app móvil por operador ${operatorId}.`, uuid);
    const started = performance.now();
    let outcome = "not_confirmed";
    try {
      if (action === "paid") await this.dependencies.markPaid(uuid, reference!.trim());
      else if (action === "received") await this.dependencies.confirmReceived(uuid);
      else await this.dependencies.cancel(uuid);
      outcome = "confirmed";
    } catch (error) {
      this.storage.audit(`mobile_${action}_uncertain`, `Acción móvil ${action} no confirmada: ${error instanceof Error ? error.message : String(error)}. No se debe reintentar sin conciliar.`, uuid);
      throw error;
    } finally {
      try {
        this.storage.audit("mobile_action_timing", JSON.stringify({ action, outcome, totalMs: performance.now() - started }), uuid);
      } catch {}
    }
    try {
      this.storage.audit(`mobile_${action}_confirmed`, `Acción ${action} confirmada desde app móvil por operador ${operatorId}.`, uuid);
    } catch {}
  }
  private public(item: OperatorRecord): MobileOperator { return { id: item.id, label: item.label, scopes: item.scopes, createdAt: item.createdAt, revokedAt: item.revokedAt }; }
}
