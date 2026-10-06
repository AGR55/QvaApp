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
  transactionId?: string;
  receivedAt: number;
  market?: string;
  recipientPhone?: string;
  receiptKind?: "outgoing" | "incoming" | "unknown";
}

const NO_MATCH_RETRY_WINDOW_MS = 10 * 60_000;
const NO_MATCH_RETRY_MAX_DELAY_MS = 60_000;
const ETECSA_OPERATION_WINDOW_MS = 2 * 60 * 60_000;
const MANUAL_OPERATIONS_SYNC_INTERVAL_MS = 60_000;
const MANUAL_OPERATIONS_PAGE_SIZE = 100;
const MANUAL_OPERATIONS_MAX_PAGES = 2;
const MANUAL_OPERATIONS_MAX_IMPORTS_PER_RECEIPT = 2;

interface ManualOperationsSnapshot {
  checkedAt: number;
  profileUuid: string | null;
  offers: Awaited<ReturnType<QvaPayClient["listOffersPage"]>>["offers"];
  complete: boolean;
  error?: unknown;
}

interface ManualOperationsSyncResult {
  snapshot: ManualOperationsSnapshot;
  potentialOfferUuids: string[];
}

interface ManualReceiptCandidates {
  potentialOfferUuids: string[];
  importableOffers: Awaited<ReturnType<QvaPayClient["listOffersPage"]>>["offers"];
}

export class PaymentSmsError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

export class PaymentSmsService {
  private processing: Promise<void> | undefined;
  private manualOperationsSnapshot: ManualOperationsSnapshot | undefined;
  private manualOperationsSync: Promise<ManualOperationsSnapshot> | undefined;
  private profileCache: { uuid: string; expiresAt: number } | undefined;

  constructor(
    private readonly store: Store,
    private readonly qva: Pick<QvaPayClient, "getOffer" | "listOffersPage" | "profile">,
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
    const transactionId = input.transactionId?.trim() || internalEtecsaReference(input);
    const inserted = this.store.insertPaymentReceipt({
      ...input, transactionId, beneficiaryMasked: input.beneficiaryMasked ?? "",
      receiptKind: input.receiptKind ?? "outgoing", market: input.market ?? null,
      recipientPhone: input.recipientPhone ? normalizePhone(input.recipientPhone) : null,
      id: randomUUID(), deviceId,
    });
    if (inserted.duplicate) return inserted;
    void this.processPending();
    return inserted;
  }

  private async getProfileUuid(now: number): Promise<string> {
    if (this.profileCache && this.profileCache.expiresAt > now) return this.profileCache.uuid;
    const profile = await this.qva.profile();
    if (!profile || typeof profile.uuid !== "string" || !profile.uuid.trim())
      throw new Error("QvaPay no devolvió una identidad operadora verificable.");
    this.profileCache = { uuid: profile.uuid, expiresAt: now + 5 * 60_000 };
    return profile.uuid;
  }

  private async syncManualOperations(receipt: PaymentReceipt, now: number): Promise<ManualOperationsSyncResult> {
    const cached = this.manualOperationsSnapshot;
    if (cached && now - cached.checkedAt < MANUAL_OPERATIONS_SYNC_INTERVAL_MS) {
      const candidates = this.importManualReceiptCandidates(receipt, cached);
      return { snapshot: cached, potentialOfferUuids: candidates.potentialOfferUuids };
    }
    if (this.manualOperationsSync) {
      const snapshot = await this.manualOperationsSync;
      const candidates = this.importManualReceiptCandidates(receipt, snapshot);
      return { snapshot, potentialOfferUuids: candidates.potentialOfferUuids };
    }
    const sync = (async (): Promise<ManualOperationsSnapshot> => {
      try {
        const profileUuid = await this.getProfileUuid(now);
        const first = await this.qva.listOffersPage({
          my: true,
          status: "processing",
          take: MANUAL_OPERATIONS_PAGE_SIZE,
          page: 1,
          orderBy: "updated_at",
          orderType: "desc",
        });
        const offers = [...first.offers];
        const pageSize = Math.max(1, first.perPage || first.offers.length || MANUAL_OPERATIONS_PAGE_SIZE);
        const totalPages = Math.max(1, Math.ceil(first.total / pageSize));
        const pagesToRead = Math.min(totalPages, MANUAL_OPERATIONS_MAX_PAGES);
        for (let page = 2; page <= pagesToRead; page += 1) {
          const next = await this.qva.listOffersPage({
            my: true,
            status: "processing",
            take: MANUAL_OPERATIONS_PAGE_SIZE,
            page,
            orderBy: "updated_at",
            orderType: "desc",
          });
          offers.push(...next.offers);
        }
        const uniqueOffers = [...new Map(offers.map((offer) => [offer.uuid, offer])).values()];
        return {
          checkedAt: now,
          profileUuid,
          offers: uniqueOffers,
          complete: uniqueOffers.length >= first.total,
        };
      } catch (error) {
        return { checkedAt: now, profileUuid: null, offers: [], complete: false, error };
      }
    })();
    this.manualOperationsSync = sync;
    try {
      const snapshot = await sync;
      this.manualOperationsSnapshot = snapshot;
      const candidates = this.importManualReceiptCandidates(receipt, snapshot);
      return { snapshot, potentialOfferUuids: candidates.potentialOfferUuids };
    } finally {
      if (this.manualOperationsSync === sync) this.manualOperationsSync = undefined;
    }
  }

  private importManualReceiptCandidates(receipt: PaymentReceipt, snapshot: ManualOperationsSnapshot): ManualReceiptCandidates {
    if (!snapshot.complete || !snapshot.profileUuid || snapshot.error) return { potentialOfferUuids: [], importableOffers: [] };
    const isEtecsa = receipt.bank.toUpperCase() === "ETECSA";
    const potentialMatches = snapshot.offers.filter((offer) => {
      if (offer.type !== "sell" || offer.status !== "processing" ||
        offer.Peer?.uuid !== snapshot.profileUuid || !offer.User?.uuid || offer.User.uuid === snapshot.profileUuid ||
        !Number.isFinite(offer.amount) || !Number.isFinite(offer.receive) || offer.amount <= 0 || offer.receive !== receipt.amount)
        return false;
      if (isEtecsa ? offer.coin !== "ETECSA" || receipt.market !== "ETECSA" : receipt.market !== null && offer.coin !== receipt.market)
        return false;
      if (normalizeCurrency(isEtecsa ? "CUP" : this.marketCurrency(offer.coin)) !== normalizeCurrency(receipt.currency))
        return false;
      return true;
    });
    // Potential remote offers count toward ambiguity even without time proof. Only local createdAt
    // or an authenticated p2p.applied event makes an offer safe to import/match temporally.
    const importableOffers = potentialMatches.filter((offer) => {
      const localOperation = this.store.getOperation(offer.uuid);
      const operationAt = localOperation?.createdAt ?? this.store.marketFeedAppliedAt(offer.uuid, receipt.receivedAt) ?? Number.NaN;
      const windowMs = isEtecsa ? ETECSA_OPERATION_WINDOW_MS : 24 * 60 * 60_000;
      return Number.isSafeInteger(operationAt) && operationAt <= receipt.receivedAt && receipt.receivedAt - operationAt <= windowMs;
    });
    for (const offer of importableOffers.slice(0, MANUAL_OPERATIONS_MAX_IMPORTS_PER_RECEIPT)) {
      if (this.store.getOperation(offer.uuid)) continue;
      const operationAt = this.store.marketFeedAppliedAt(offer.uuid, receipt.receivedAt)!;
      this.store.createOperation({
        uuid: offer.uuid,
        offerType: "sell",
        coin: offer.coin,
        amount: offer.amount,
        receive: offer.receive,
        rate: offer.receive / offer.amount,
        state: "applied",
        autoApplied: false,
        cancelAt: null,
        createdAt: operationAt,
        counterpartyId: offer.User!.uuid,
      });
      this.store.audit("manual_qvapay_operation_imported", "Operación en curso importada de QvaPay para conciliación del recibo SMS.", offer.uuid);
    }
    return { potentialOfferUuids: potentialMatches.map((offer) => offer.uuid), importableOffers };
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
    const isEtecsa = receipt.bank.toUpperCase() === "ETECSA";
    if (isEtecsa && receipt.receiptKind !== "outgoing") {
      this.store.updatePaymentReceipt(receipt.id, "review", "Evento ETECSA entrante o desconocido; no acredita un pago saliente.", null);
      this.store.audit("sms_receipt_review", "Evento ETECSA guardado para revisión; no se marcó ninguna operación.");
      return;
    }
    // Always reconcile against a fresh-or-cached complete remote snapshot before declaring a local match unique.
    // Otherwise a second operation taken directly in QvaPay could be invisible to this decision.
    const { snapshot, potentialOfferUuids } = await this.syncManualOperations(receipt, now);
    if (snapshot.error) {
      if (isTransientReadFailure(snapshot.error) && now < receipt.createdAt + NO_MATCH_RETRY_WINDOW_MS) {
        const retry = this.store.deferPaymentReceipt(
          receipt.id,
          `No se pudo sincronizar operaciones manuales de QvaPay: ${safeError(snapshot.error)}`,
          now,
          snapshot.error instanceof QvaApiError ? snapshot.error.retryAfterMs ?? 0 : 0,
          Math.min(NO_MATCH_RETRY_MAX_DELAY_MS, receipt.createdAt + NO_MATCH_RETRY_WINDOW_MS - now),
        );
        if (retry) this.store.audit("sms_receipt_manual_sync_retry_scheduled", `Sincronización manual QvaPay diferida; reintento ${retry.attempts} a las ${new Date(retry.nextAttemptAt).toISOString()}.`);
        return;
      }
      this.store.updatePaymentReceipt(receipt.id, "review", `No se pudo verificar el listado de operaciones manuales: ${safeError(snapshot.error)}`, null);
      this.store.audit("sms_receipt_review", "Comprobante en revisión; la sincronización de operaciones manuales falló.");
      return;
    }
    if (!snapshot.complete) {
      if (now < receipt.createdAt + NO_MATCH_RETRY_WINDOW_MS) {
        const retry = this.store.deferPaymentReceipt(
          receipt.id,
          "El listado de operaciones manuales superó el límite de páginas; no se puede demostrar unicidad.",
          now,
          0,
          Math.min(NO_MATCH_RETRY_MAX_DELAY_MS, receipt.createdAt + NO_MATCH_RETRY_WINDOW_MS - now),
        );
        if (retry) this.store.audit("sms_receipt_manual_sync_truncated", `Snapshot de operaciones manuales incompleto; reintento ${retry.attempts}.`);
        return;
      }
      this.store.updatePaymentReceipt(receipt.id, "review", "El listado remoto excedió el límite de páginas; no se pudo demostrar una coincidencia única.", null);
      this.store.audit("sms_receipt_review", "Comprobante en revisión; listado manual remoto truncado.");
      return;
    }

    const candidates = this.store.activeOperations().filter((operation) =>
      !this.store.get(`cooperative_owner_fiat:${operation.uuid}`) &&
      operation.offerType === "sell" && ["applied", "acknowledged"].includes(operation.state) &&
      operation.createdAt <= receipt.receivedAt && receipt.receivedAt - operation.createdAt <= (isEtecsa ? ETECSA_OPERATION_WINDOW_MS : 24 * 60 * 60_000) &&
      operation.receive === receipt.amount &&
      (isEtecsa ? operation.coin === "ETECSA" && receipt.market === "ETECSA" : !receipt.market || operation.coin === receipt.market) &&
      normalizeCurrency(isEtecsa ? "CUP" : this.marketCurrency(operation.coin)) === normalizeCurrency(receipt.currency),
    );
    const candidateUuids = new Set(candidates.map((operation) => operation.uuid));
    const remoteMatches = potentialOfferUuids.filter((uuid) => candidateUuids.has(uuid));
    if (candidates.length > 1 || potentialOfferUuids.length > 1 ||
      (candidates.length === 1 && (potentialOfferUuids.length !== 1 || remoteMatches.length !== 1))) {
      this.store.updatePaymentReceipt(receipt.id, "review", "Hay varias operaciones candidatas o la instantánea local y remota no coincide.", null);
      this.store.audit("sms_receipt_review", "Comprobante guardado para revisión: la unicidad no pudo demostrarse entre operaciones locales y remotas.");
      return;
    }
    if (candidates.length === 0 || potentialOfferUuids.length === 0) {
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
    const uniqueAccounts = isEtecsa ? [] : [...new Set(accounts.filter((account) => {
      const masked = maskParts(receipt.beneficiaryMasked);
      return account.startsWith(masked.first) && account.endsWith(masked.last);
    }))];
    const remotePhones = remote.details
      ? Object.entries(remote.details).filter(([name]) => /(tel[eé]fono|phone|destinatario|recipient|m[oó]vil)/i.test(name))
        .flatMap(([, value]) => extractPhones(value))
      : [];
    const uniqueRemotePhones = [...new Set(remotePhones)];
    const exactPhone = isEtecsa && receipt.recipientPhone !== null && uniqueRemotePhones.length === 1 &&
      uniqueRemotePhones[0] === normalizePhone(receipt.recipientPhone);
    const counterparties = [remote.User?.uuid, remote.Peer?.uuid].filter((value): value is string => Boolean(value));
    let profileUuid: string | undefined;
    try { profileUuid = (await this.getProfileUuid(now)); }
    catch (error) {
      if (isTransientReadFailure(error)) {
        const retry = this.store.deferPaymentReceipt(receipt.id, `No se pudo verificar la cuenta operadora: ${safeError(error)}`, Date.now(), error instanceof QvaApiError ? error.retryAfterMs ?? 0 : 0);
        if (retry) this.store.audit("sms_receipt_profile_retry_scheduled", `Lectura del perfil temporalmente fallida; reintento ${retry.attempts}.`, operation.uuid);
        return;
      }
      this.store.updatePaymentReceipt(receipt.id, "review", `No se pudo verificar la cuenta operadora: ${safeError(error)}`, operation.uuid);
      this.store.audit("sms_receipt_review", "Comprobante en revisión; no se pudo confirmar el rol pagador.", operation.uuid);
      return;
    }
    if (remote.type !== "sell" || remote.status !== "processing" ||
      remote.coin !== operation.coin || remote.amount !== operation.amount || remote.receive !== operation.receive ||
      !profileUuid || remote.Peer?.uuid !== profileUuid || !remote.User?.uuid || remote.User.uuid === profileUuid ||
      !operation.counterpartyId || operation.counterpartyId !== remote.User.uuid || !counterparties.includes(operation.counterpartyId) ||
      (isEtecsa ? !exactPhone : uniqueAccounts.length !== 1)) {
      const reason = remote.type !== "sell" ? "La oferta remota ya no es de venta." :
        remote.status !== "processing" ? "El estado remoto no está en procesamiento." :
        remote.coin !== operation.coin || remote.amount !== operation.amount || remote.receive !== operation.receive ? "La oferta remota cambió respecto a la operación local." :
        !operation.counterpartyId || !counterparties.includes(operation.counterpartyId) ? "La contraparte remota no coincide o no está identificada." :
        isEtecsa ? "El teléfono destinatario remoto no coincide exactamente." :
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
  const required = ["bank", "sender", "currency", "amount", "beneficiaryMasked", "receivedAt"];
  const keys = [...required, "transactionId", "market", "recipientPhone", "receiptKind"];
  if (Object.keys(input).some((key) => !keys.includes(key)) || required.some((key) => !(key in input))) return false;
  if (typeof input.bank !== "string") return false;
  if (input.bank.toUpperCase() === "ETECSA"
    ? input.market !== "ETECSA" || typeof input.recipientPhone !== "string" || (input.transactionId !== undefined && input.transactionId !== "")
    : typeof input.transactionId !== "string") return false;
  try { validateReceipt(input as unknown as PaymentReceiptInput); return true; } catch { return false; }
}

function validateReceipt(input: PaymentReceiptInput): void {
  if (typeof input.bank !== "string" || typeof input.sender !== "string" || typeof input.currency !== "string" || typeof input.beneficiaryMasked !== "string")
    throw new PaymentSmsError(400, "Comprobante inválido.");
  const isEtecsa = input.bank.toUpperCase() === "ETECSA";
  for (const [name, value, max] of [["bank", input.bank, 80], ["sender", input.sender, 80], ["currency", input.currency, 12], ["beneficiaryMasked", input.beneficiaryMasked, 80], ["transactionId", input.transactionId, 120]] as const) {
    if (isEtecsa && (name === "beneficiaryMasked" || name === "transactionId") && (value === undefined || value === "")) continue;
    if (typeof value !== "string" || !value.trim() || value.length > max || /[\r\n\u0000-\u001f]/.test(value))
      throw new PaymentSmsError(400, `Campo ${name} inválido.`);
  }
  if (!/^[A-Z0-9_ -]+$/i.test(input.bank) || !/^[A-Z0-9_-]+$/i.test(input.currency) ||
      !Number.isFinite(input.amount) || input.amount <= 0 || input.amount > 1_000_000_000 ||
      !Number.isSafeInteger(input.receivedAt) || input.receivedAt < Date.now() - 7 * 24 * 60 * 60_000 || input.receivedAt > Date.now() + 5 * 60_000)
    throw new PaymentSmsError(400, "Comprobante inválido o fuera del período permitido.");
  if (isEtecsa) {
    if (input.sender.toUpperCase() !== "ETECSA" || normalizeCurrency(input.currency) !== "CUP" || input.market !== "ETECSA" ||
      typeof input.recipientPhone !== "string" || normalizePhone(input.recipientPhone).length < 8 || normalizePhone(input.recipientPhone).length > 15 ||
      (input.transactionId !== undefined && input.transactionId !== "") ||
      (input.receiptKind !== undefined && !["outgoing", "incoming", "unknown"].includes(input.receiptKind)))
      throw new PaymentSmsError(400, "Comprobante ETECSA inválido; transactionId debe omitirse.");
  } else {
    if (input.receiptKind !== undefined && input.receiptKind !== "outgoing") throw new PaymentSmsError(400, "Tipo de comprobante bancario inválido.");
    maskParts(input.beneficiaryMasked);
  }
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
function extractPhones(value: string): string[] {
  return (value.match(/(?:\+?53[\s-]?)?(?:\d[\s-]?){8,12}/g) ?? []).map(normalizePhone).filter((phone) => phone.length >= 8 && phone.length <= 15);
}
function normalizePhone(value: string): string {
  const digits = value.replace(/\D/g, "");
  return digits.length === 10 && digits.startsWith("53") ? digits.slice(2) : digits;
}
function internalEtecsaReference(input: PaymentReceiptInput): string {
  const identity = ["SMS-ETECSA", input.receiptKind ?? "outgoing", normalizePhone(input.recipientPhone ?? ""), input.amount, input.currency.toUpperCase(), input.receivedAt].join("|");
  return `SMS-ETECSA-${createHash("sha256").update(identity).digest("hex").slice(0, 16)}`;
}
function normalizeCurrency(value: string | undefined): string { return (value ?? "").replace(/[^A-Z0-9]/gi, "").toUpperCase(); }
function hashToken(token: string): string { return createHash("sha256").update(token).digest("hex"); }
function safeError(error: unknown): string { return (error instanceof Error ? error.message : String(error)).slice(0, 300); }
function isTransientReadFailure(error: unknown): boolean {
  return error instanceof QvaConnectionError ||
    (error instanceof QvaApiError && (error.status === 429 || (error.status >= 500 && error.status < 600)));
}
