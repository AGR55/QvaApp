import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { PaymentReceipt, Store } from "./store.js";
import type { QvaPayClient } from "./qvapay.js";
import { QvaApiError, QvaConnectionError } from "./qvapay.js";
import type { FiatMarket } from "./types.js";

export interface PaymentReceiptInput {
  bank: string;
  sender: string;
  currency: string;
  amount: number;
  beneficiaryMasked: string;
  transactionId: string;
  receivedAt: number;
}

const NO_MATCH_RETRY_WINDOW_MS = 10 * 60_000;
const NO_MATCH_RETRY_MAX_DELAY_MS = 60_000;

export class PaymentSmsError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

export class PaymentSmsService {
  private processing: Promise<void> | undefined;

  constructor(
    private readonly store: Store,
    private readonly qva: Pick<QvaPayClient, "getOffer">,
    private readonly operations: { markPaid(uuid: string, reference: string): Promise<void> },
    private readonly marketCurrency: (market: FiatMarket) => string | undefined,
  ) {}

  pairDevice(label: string): { device: ReturnType<Store["smsDevices"]>[number]; token: string } {
    const normalized = label.trim();
    if (!normalized || normalized.length > 80) throw new PaymentSmsError(400, "Nombre de dispositivo inválido.");
    const token = randomBytes(32).toString("base64url");
    const device = this.store.createSmsDevice({ id: randomUUID(), label: normalized, tokenHash: hashToken(token) });
    return { device, token };
  }

  revokeDevice(id: string): boolean { return this.store.revokeSmsDevice(id); }
  devices() { return this.store.smsDevices(); }
  receipts() { return this.store.paymentReceipts(); }

  checkDevice(token: string): { ok: true } {
    this.authenticateDevice(token);
    return { ok: true };
  }

  async receive(token: string, input: PaymentReceiptInput): Promise<{ receipt: PaymentReceipt; duplicate: boolean }> {
    validateReceipt(input);
    const deviceId = this.authenticateDevice(token);
    const inserted = this.store.insertPaymentReceipt({ ...input, id: randomUUID(), deviceId });
    if (inserted.duplicate) return inserted;
    void this.processPending();
    return inserted;
  }

  private authenticateDevice(token: string): string {
    const deviceId = this.store.authenticateSmsDevice(hashToken(token), Date.now());
    if (deviceId === "rate_limited") throw new PaymentSmsError(429, "Dispositivo limitado temporalmente; inténtalo más tarde.");
    if (!deviceId) throw new PaymentSmsError(401, "Credencial inválida o revocada.");
    return deviceId;
  }

  processPending(now = Date.now()): Promise<void> {
    if (this.processing) return this.processing;
    const run = this.runPending(now);
    this.processing = run;
    void run.finally(() => {
      if (this.processing === run) this.processing = undefined;
    }).catch(() => undefined);
    return run;
  }

  private async runPending(now: number): Promise<void> {
    const attempted = new Set<string>();
    while (true) {
      const batch = this.store.pendingPaymentReceipts(now).filter((receipt) => !attempted.has(receipt.id));
      if (!batch.length) return;
      for (const receipt of batch) {
        attempted.add(receipt.id);
        try {
          await this.process(receipt, now);
        } catch (error) {
          this.store.audit("sms_receipt_processing_deferred", `Comprobante permanece pendiente para reintento: ${safeError(error)}`);
        }
      }
    }
  }

  private async process(receipt: PaymentReceipt, now: number): Promise<void> {
    const candidates = this.store.activeOperations().filter((operation) =>
      operation.offerType === "sell" && ["applied", "acknowledged"].includes(operation.state) &&
      operation.createdAt < receipt.receivedAt && operation.receive === receipt.amount &&
      normalizeCurrency(this.marketCurrency(operation.coin)) === normalizeCurrency(receipt.currency),
    );
    if (candidates.length !== 1) {
      if (candidates.length > 1) {
        this.store.updatePaymentReceipt(receipt.id, "review", "Hay varias operaciones candidatas.", null);
        this.store.audit("sms_receipt_review", "Comprobante guardado para revisión: hay varias operaciones candidatas.");
        return;
      }
      if (now < receipt.createdAt + NO_MATCH_RETRY_WINDOW_MS) {
        const remaining = receipt.createdAt + NO_MATCH_RETRY_WINDOW_MS - now;
        const retry = this.store.deferPaymentReceipt(
          receipt.id,
          "Todavía no hay operación local sincronizada que coincida; se volverá a comprobar.",
          now,
          0,
          Math.min(NO_MATCH_RETRY_MAX_DELAY_MS, remaining),
        );
        if (retry) this.store.audit("sms_receipt_sync_retry_scheduled", `Aún sin operación sincronizada; reintento ${retry.attempts} a las ${new Date(retry.nextAttemptAt).toISOString()}.`);
        return;
      }
      this.store.updatePaymentReceipt(receipt.id, "review", "La ventana de sincronización terminó sin una operación exacta.", null);
      this.store.audit("sms_receipt_review", "Comprobante guardado para revisión tras vencer la ventana de sincronización.");
      return;
    }

    const operation = candidates[0]!;
    let remote;
    try { remote = await this.qva.getOffer(operation.uuid); }
    catch (error) {
      if (isTransientReadFailure(error)) {
        const retry = this.store.deferPaymentReceipt(
          receipt.id,
          `No se pudo leer la oferta remota: ${safeError(error)}`,
          Date.now(),
          error instanceof QvaApiError ? error.retryAfterMs ?? 0 : 0,
        );
        if (retry) this.store.audit("sms_receipt_read_retry_scheduled", `Lectura QvaPay temporalmente fallida; reintento ${retry.attempts} a las ${new Date(retry.nextAttemptAt).toISOString()}.`, operation.uuid);
        return;
      }
      this.store.updatePaymentReceipt(receipt.id, "review", `No se pudo verificar la oferta remota: ${safeError(error)}`, operation.uuid);
      this.store.audit("sms_receipt_review", "Comprobante en revisión; la consulta remota falló.", operation.uuid);
      return;
    }
    const accounts = remote.details
      ? Object.entries(remote.details)
        .filter(([name]) => /(cuenta|tarjeta|account|card|benefici)/i.test(name))
        .flatMap(([, value]) => extractAccounts(value))
      : [];
    const masked = maskParts(receipt.beneficiaryMasked);
    const matchingAccounts = accounts.filter((account) => account.startsWith(masked.first) && account.endsWith(masked.last));
    const uniqueAccounts = [...new Set(matchingAccounts)];
    const counterparties = [remote.User?.uuid, remote.Peer?.uuid].filter((value): value is string => Boolean(value));
    if (remote.type !== "sell" || remote.status !== "processing" ||
      remote.coin !== operation.coin || remote.amount !== operation.amount || remote.receive !== operation.receive ||
      (operation.counterpartyId && !counterparties.includes(operation.counterpartyId)) ||
      uniqueAccounts.length !== 1) {
      const reason = remote.type !== "sell" ? "La oferta remota ya no es de venta." :
        remote.status !== "processing" ? "El estado remoto no está en procesamiento." :
        remote.coin !== operation.coin || remote.amount !== operation.amount || remote.receive !== operation.receive ? "La oferta remota cambió respecto a la operación local." :
        operation.counterpartyId && !counterparties.includes(operation.counterpartyId) ? "La contraparte remota no coincide." :
        "Los detalles remotos no identifican una única cuenta beneficiaria.";
      this.store.updatePaymentReceipt(receipt.id, "review", reason, operation.uuid);
      this.store.audit("sms_receipt_review", `Comprobante en revisión: ${reason}`, operation.uuid);
      return;
    }

    if (!this.store.claimPaymentOperation(receipt.id, operation.uuid)) {
      this.store.updatePaymentReceipt(receipt.id, "review", "Otra entrega ya inició una mutación para esta operación.", operation.uuid);
      this.store.audit("sms_receipt_review", "Comprobante en revisión; la operación ya tiene un intento de pago iniciado.", operation.uuid);
      return;
    }

    try {
      await this.operations.markPaid(operation.uuid, receipt.transactionId);
      this.store.updatePaymentReceipt(receipt.id, "matched", null, operation.uuid);
      this.store.audit("sms_receipt_marked_paid", `Pago marcado mediante comprobante ${receipt.transactionId}.`, operation.uuid);
    } catch (error) {
      // markPaid uses the durable monetary intent. Any uncertainty remains reviewable and is never retried here.
      const reason = safeError(error);
      this.store.updatePaymentReceipt(receipt.id, "review", `Resultado de markPaid no confirmado: ${reason}`, operation.uuid);
      this.store.audit("sms_receipt_mark_paid_uncertain", `No se reintentará automáticamente: ${reason}`, operation.uuid);
    }
  }
}

export function validPaymentReceipt(value: unknown): value is PaymentReceiptInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const input = value as Record<string, unknown>;
  const keys = ["bank", "sender", "currency", "amount", "beneficiaryMasked", "transactionId", "receivedAt"];
  if (Object.keys(input).some((key) => !keys.includes(key)) || keys.some((key) => !(key in input))) return false;
  try { validateReceipt(input as unknown as PaymentReceiptInput); return true; } catch { return false; }
}

function validateReceipt(input: PaymentReceiptInput): void {
  for (const [name, value, max] of [["bank", input.bank, 80], ["sender", input.sender, 80], ["currency", input.currency, 12], ["beneficiaryMasked", input.beneficiaryMasked, 80], ["transactionId", input.transactionId, 120]] as const) {
    if (typeof value !== "string" || !value.trim() || value.length > max || /[\r\n\u0000-\u001f]/.test(value))
      throw new PaymentSmsError(400, `Campo ${name} inválido.`);
  }
  if (!/^[A-Z0-9_ -]+$/i.test(input.bank) || !/^[A-Z0-9_-]+$/i.test(input.currency) ||
      !Number.isFinite(input.amount) || input.amount <= 0 || input.amount > 1_000_000_000 ||
      !Number.isSafeInteger(input.receivedAt) || input.receivedAt < Date.now() - 7 * 24 * 60 * 60_000 || input.receivedAt > Date.now() + 5 * 60_000)
    throw new PaymentSmsError(400, "Comprobante inválido o fuera del período permitido.");
  maskParts(input.beneficiaryMasked);
}

function maskParts(masked: string): { first: string; last: string } {
  const parts = masked.split(/[*xX•#]+/);
  const first = parts[0]?.replace(/\D/g, "") ?? "";
  const last = parts.at(-1)?.replace(/\D/g, "") ?? "";
  if (first.length !== 4 || last.length !== 4 || !/[*xX•#]/.test(masked))
    throw new PaymentSmsError(400, "El beneficiario debe estar enmascarado y mostrar cuatro dígitos iniciales y finales.");
  return { first, last };
}

function extractAccounts(value: string): string[] {
  return (value.match(/\d[\d\s-]{10,}\d/g) ?? []).map((candidate) => candidate.replace(/\D/g, "")).filter((digits) => digits.length >= 12);
}
function normalizeCurrency(value: string | undefined): string { return (value ?? "").replace(/[^A-Z0-9]/gi, "").toUpperCase(); }
function hashToken(token: string): string { return createHash("sha256").update(token).digest("hex"); }
function safeError(error: unknown): string { return (error instanceof Error ? error.message : String(error)).slice(0, 300); }
function isTransientReadFailure(error: unknown): boolean {
  return error instanceof QvaConnectionError ||
    (error instanceof QvaApiError && (error.status === 429 || (error.status >= 500 && error.status < 600)));
}
