import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PaymentSmsService } from "../src/payment-sms.js";
import { QvaApiError, QvaConnectionError } from "../src/qvapay.js";
import { Store } from "../src/store.js";

function setup(remoteOverrides: Record<string, unknown> = {}, markPaidError?: Error, getOffer?: () => Promise<unknown>) {
  const store = new Store(mkdtempSync(join(tmpdir(), "qvaapply-payment-sms-")));
  const callLog: string[] = [];
  const remote = {
    uuid: "op-1", type: "sell", coin: "BANK_CUP", amount: 10, receive: 10_200,
    status: "processing", details: { "Cuenta BPA": "1234567890123456" },
    User: { uuid: "counterparty" }, ...remoteOverrides,
  };
  const service = new PaymentSmsService(
    store,
    { getOffer: getOffer ?? (async () => remote as never) } as never,
    { markPaid: async (uuid, tx) => { callLog.push(`${uuid}:${tx}`); if (markPaidError) throw markPaidError; } },
    () => "CUP",
  );
  const operation = (uuid: string, amount = 10_200, coin = "BANK_CUP", createdAt = Date.now() - 10_000) => store.createOperation({
    uuid, offerType: "sell", coin, amount: 10, receive: amount, rate: 1_020,
    state: "applied", autoApplied: false, cancelAt: null, createdAt, counterpartyId: "counterparty",
  });
  const pair = service.pairDevice("Android personal");
  const receipt = (transactionId = "BPA-XYZ", overrides: Record<string, unknown> = {}) => service.receive(pair.token, {
    bank: "BPA", sender: "BPA", currency: "CUP", amount: 10_200,
    beneficiaryMasked: "1234****3456", transactionId, receivedAt: Date.now(), ...overrides,
  });
  return { store, service, pair, callLog, operation, receipt, remote };
}

test("recibe un comprobante estructurado, lo deduplica y marca solo una operación exacta", async () => {
  const ctx = setup();
  ctx.operation("op-1");
  const first = await ctx.receipt();
  assert.equal(first.receipt.state, "pending");
  await ctx.service.processPending();
  assert.equal(ctx.store.paymentReceipt(first.receipt.id)?.state, "matched");
  assert.deepEqual(ctx.callLog, ["op-1:BPA-XYZ"]);
  const duplicate = await ctx.receipt();
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.receipt.state, "duplicate");
  assert.deepEqual(ctx.callLog, ["op-1:BPA-XYZ"]);
  assert.equal(ctx.service.devices().length, 1);
  assert.equal("token" in ctx.service.devices()[0]!, false);
  ctx.store.close();
});

test("no auto marca con importe, moneda, hora o beneficiario distintos", async () => {
  const cases: Array<[string, Record<string, unknown>, Record<string, unknown>]> = [
    ["amount", {}, { amount: 10_199 }],
    ["currency", {}, { currency: "USD" }],
    ["beneficiary", { details: { "Cuenta BPA": "9999567890123456" } }, {}],
  ];
  for (const [name, remote, input] of cases) {
    const ctx = setup(remote);
    ctx.operation("op-1");
    const result = await ctx.receipt(`${name}-tx`, input);
    await ctx.service.processPending();
    await ctx.service.processPending(Date.now() + 11 * 60_000);
    assert.equal(ctx.store.paymentReceipt(result.receipt.id)?.state, "review", name);
    assert.deepEqual(ctx.callLog, [], name);
    ctx.store.close();
  }
  const old = setup();
  old.operation("op-1", 10_200, "BANK_CUP", Date.now() + 60_000);
  const result = await old.receipt("old-tx");
  await old.service.processPending();
  await old.service.processPending(Date.now() + 11 * 60_000);
  assert.equal(old.store.paymentReceipt(result.receipt.id)?.state, "review");
  assert.deepEqual(old.callLog, []);
  old.store.close();
});

test("ambigüedad, detalle ausente, contraparte o estado remoto dudoso deja revisión manual", async () => {
  const ambiguous = setup();
  ambiguous.operation("op-1");
  ambiguous.operation("op-2");
  const ambiguousReceipt = await ambiguous.receipt();
  await ambiguous.service.processPending();
  assert.equal(ambiguous.store.paymentReceipt(ambiguousReceipt.receipt.id)?.state, "review");
  assert.deepEqual(ambiguous.callLog, []);
  ambiguous.store.close();

  for (const overrides of [
    { details: undefined },
    { status: "paid" },
    { User: { uuid: "someone-else" }, Peer: null },
  ]) {
    const ctx = setup(overrides);
    ctx.operation("op-1");
    const received = await ctx.receipt();
    await ctx.service.processPending();
    assert.equal(ctx.store.paymentReceipt(received.receipt.id)?.state, "review");
    assert.deepEqual(ctx.callLog, []);
    ctx.store.close();
  }
});

test("revocar dispositivo bloquea entregas; un markPaid fallido queda en revisión sin reintento", async () => {
  const ctx = setup({}, new Error("resultado remoto incierto"));
  ctx.operation("op-1");
  const result = await ctx.receipt();
  await ctx.service.processPending();
  assert.equal(ctx.store.paymentReceipt(result.receipt.id)?.state, "review");
  assert.deepEqual(ctx.callLog, ["op-1:BPA-XYZ"]);
  await ctx.service.processPending(Date.now() + 24 * 60 * 60_000);
  assert.deepEqual(ctx.callLog, ["op-1:BPA-XYZ"]);
  ctx.service.revokeDevice(ctx.pair.device.id);
  await assert.rejects(() => ctx.receipt("after-revoke"), /credencial inválida/i);
  ctx.store.close();
});

test("dos comprobantes concurrentes no inician dos pagos para la misma operación", async () => {
  const ctx = setup();
  ctx.operation("op-1");
  const [first, second] = await Promise.all([
    ctx.receipt("parallel-1"),
    ctx.receipt("parallel-2"),
  ]);
  await ctx.service.processPending();
  assert.equal(ctx.callLog.length, 1);
  assert.equal([ctx.store.paymentReceipt(first.receipt.id)!.state, ctx.store.paymentReceipt(second.receipt.id)!.state].sort().join(","), "matched,review");
  ctx.store.close();
});

test("processPending recupera recibos durables pendientes y no reprocesa estados inciertos", async () => {
  const ctx = setup();
  ctx.operation("op-1");
  const persisted = ctx.store.insertPaymentReceipt({
    id: "persisted-receipt", deviceId: ctx.pair.device.id, bank: "BPA", sender: "BPA",
    currency: "CUP", amount: 10_200, beneficiaryMasked: "1234****3456",
    transactionId: "RECOVER-ME", receivedAt: Date.now(),
  });
  assert.equal(persisted.receipt.state, "pending");
  await ctx.service.processPending();
  assert.equal(ctx.store.paymentReceipt("persisted-receipt")?.state, "matched");

  const uncertain = ctx.store.insertPaymentReceipt({
    id: "uncertain-receipt", deviceId: ctx.pair.device.id, bank: "BPA", sender: "BPA",
    currency: "CUP", amount: 10_200, beneficiaryMasked: "1234****3456",
    transactionId: "UNCERTAIN", receivedAt: Date.now(),
  });
  assert.equal(ctx.store.claimPaymentOperation(uncertain.receipt.id, "op-1"), false);
  ctx.store.updatePaymentReceipt(uncertain.receipt.id, "review", "uncertain", "op-1");
  await ctx.service.processPending();
  assert.deepEqual(ctx.callLog, ["op-1:RECOVER-ME"]);
  ctx.store.close();
});

test("la entrega responde con estado pendiente sin esperar a QvaPay", async () => {
  let releaseRemote!: (value: unknown) => void;
  const delayedOffer = new Promise<unknown>((resolve) => { releaseRemote = resolve; });
  const ctx = setup({}, undefined, () => delayedOffer);
  ctx.operation("op-1");
  const response = await ctx.receipt("slow-remote");
  assert.equal(response.receipt.state, "pending");
  assert.equal(ctx.store.paymentReceipt(response.receipt.id)?.state, "pending");
  releaseRemote(ctx.remote);
  await ctx.service.processPending();
  assert.equal(ctx.store.paymentReceipt(response.receipt.id)?.state, "matched");
  ctx.store.close();
});

test("fallos transitorios de lectura conservan pending y reintentan con backoff durable", async () => {
  let reads = 0;
  const ctx = setup({}, undefined, async () => {
    reads += 1;
    if (reads === 1) throw new QvaConnectionError("timeout", new Error("timeout"));
    if (reads === 2) throw new QvaApiError(429, "rate limited", 5_000);
    return ctx.remote;
  });
  ctx.operation("op-1");
  const result = await ctx.receipt("transient-read");
  await ctx.service.processPending();
  const delayed = ctx.store.paymentReceipt(result.receipt.id)!;
  assert.equal(delayed.state, "pending");
  assert.equal(delayed.retryAttempts, 1);
  assert.ok(delayed.nextAttemptAt >= Date.now() + 14_000);
  assert.equal(reads, 1);

  await ctx.service.processPending(delayed.nextAttemptAt);
  const delayedAgain = ctx.store.paymentReceipt(result.receipt.id)!;
  assert.equal(delayedAgain.state, "pending");
  assert.equal(delayedAgain.retryAttempts, 2);
  assert.equal(reads, 2);
  await ctx.service.processPending(delayedAgain.nextAttemptAt);
  assert.equal(ctx.store.paymentReceipt(result.receipt.id)?.state, "matched");
  assert.equal(reads, 3);
  assert.deepEqual(ctx.callLog, ["op-1:transient-read"]);
  ctx.store.close();
});

test("un SMS anterior a la sincronización local espera y se recupera dentro de diez minutos", async () => {
  const ctx = setup();
  const early = await ctx.receipt("before-local-operation");
  await ctx.service.processPending();
  const waiting = ctx.store.paymentReceipt(early.receipt.id)!;
  assert.equal(waiting.state, "pending");
  assert.ok(waiting.nextAttemptAt > Date.now());

  ctx.operation("op-1", 10_200, "BANK_CUP", Date.now() - 10_000);
  await ctx.service.processPending(waiting.nextAttemptAt);
  assert.equal(ctx.store.paymentReceipt(early.receipt.id)?.state, "matched");
  assert.deepEqual(ctx.callLog, ["op-1:before-local-operation"]);

  const neverSynced = await ctx.receipt("no-operation-arrived", { amount: 7_000 });
  await ctx.service.processPending();
  await ctx.service.processPending(Date.now() + 11 * 60_000);
  assert.equal(ctx.store.paymentReceipt(neverSynced.receipt.id)?.state, "review");
  ctx.store.close();
});
