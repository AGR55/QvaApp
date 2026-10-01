import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PaymentSmsService, validPaymentReceipt } from "../src/payment-sms.js";
import { QvaApiError, QvaConnectionError } from "../src/qvapay.js";
import { Store } from "../src/store.js";

function setup(remoteOverrides: Record<string, unknown> = {}, markPaidError?: Error, getOffer?: () => Promise<unknown>, remotePages?: (page: number) => Promise<unknown>) {
  const store = new Store(mkdtempSync(join(tmpdir(), "qvaapply-payment-sms-")));
  const callLog: string[] = [];
  const remote = {
    uuid: "op-1", type: "sell", coin: "BANK_CUP", amount: 10, receive: 10_200,
    status: "processing", details: { "Cuenta BPA": "1234567890123456" },
    User: { uuid: "counterparty" }, Peer: { uuid: "our-account" }, ...remoteOverrides,
  };
  const service = new PaymentSmsService(
    store,
    {
      getOffer: getOffer ?? (async () => remote as never),
      profile: async () => ({ uuid: "our-account" }),
      listOffersPage: async (params: Record<string, unknown>) => remotePages
        ? await remotePages(Number(params.page ?? 1)) as never
        : ({ offers: [remote], total: 1, currentPage: Number(params.page ?? 1), perPage: 100 } as never),
    } as never,
    { markPaid: async (uuid, tx) => { callLog.push(`${uuid}:${tx}`); if (markPaidError) throw markPaidError; } },
    () => "CUP",
  );
  const operation = (uuid: string, amount = 10_200, coin = "BANK_CUP", createdAt = Date.now() - 10_000) => {
    const result = store.createOperation({
      uuid, offerType: "sell", coin, amount: 10, receive: amount, rate: 1_020,
      state: "applied", autoApplied: false, cancelAt: null, createdAt, counterpartyId: "counterparty",
    });
    store.enqueueMarketFeedEvent({
      key: `local-${uuid}-${createdAt}`, event: "p2p.applied",
      payload: { event: "p2p.applied", sent_at: new Date(createdAt).toISOString(), data: { uuid } },
      state: "ignored", receivedAt: createdAt,
    });
    return result;
  };
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

test("una operación local sincronizada puede conciliarse aunque aún no llegue su evento applied", async () => {
  const ctx = setup();
  const createdAt = Date.now() - 10_000;
  ctx.store.createOperation({
    uuid: "op-1", offerType: "sell", coin: "BANK_CUP", amount: 10, receive: 10_200, rate: 1_020,
    state: "applied", autoApplied: false, cancelAt: null, createdAt, counterpartyId: "counterparty",
  });
  const receipt = await ctx.receipt("local-without-feed-event");
  await ctx.service.processPending();
  assert.equal(ctx.store.paymentReceipt(receipt.receipt.id)?.state, "matched");
  assert.deepEqual(ctx.callLog, ["op-1:local-without-feed-event"]);
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

test("ETECSA saliente genera una referencia interna estable y exige teléfono y oferta remota exactos", async () => {
  const ctx = setup({ uuid: "et-1", coin: "ETECSA", amount: 10, receive: 50, details: { "Teléfono del destinatario": "+53 5 123 4567" } });
  ctx.operation("et-1", 50, "ETECSA", Date.now() - 10_000);
  const first = await ctx.receipt(undefined as never, {
    bank: "ETECSA", sender: "ETECSA", currency: "CUP", amount: 50,
    beneficiaryMasked: "", recipientPhone: "51234567", market: "ETECSA",
    transactionId: undefined,
  });
  await ctx.service.processPending();
  assert.equal(ctx.store.paymentReceipt(first.receipt.id)?.state, "matched");
  assert.match(ctx.callLog[0]!, /^et-1:SMS-ETECSA-[a-f0-9]{16}$/);
  const duplicate = await ctx.receipt(undefined as never, {
    bank: "ETECSA", sender: "ETECSA", currency: "CUP", amount: 50,
    beneficiaryMasked: "", recipientPhone: "+53 5 123 4567", market: "ETECSA",
    transactionId: undefined, receivedAt: first.receipt.receivedAt,
  });
  assert.equal(duplicate.duplicate, true);
  ctx.store.close();

  const mismatch = setup({ uuid: "et-2", coin: "ETECSA", amount: 10, receive: 50, details: { "Teléfono del destinatario": "+5357654321" } });
  mismatch.operation("et-2", 50, "ETECSA", Date.now() - 10_000);
  const bad = await mismatch.receipt(undefined as never, {
    bank: "ETECSA", sender: "ETECSA", currency: "CUP", amount: 50,
    beneficiaryMasked: "", recipientPhone: "+5351234567", market: "ETECSA", transactionId: undefined,
  });
  await mismatch.service.processPending();
  assert.equal(mismatch.store.paymentReceipt(bad.receipt.id)?.state, "review");
  assert.deepEqual(mismatch.callLog, []);
  mismatch.store.close();
});

test("ETECSA entrante nunca marca una operación pagada y ETECSA ambiguo queda en revisión", async () => {
  const incoming = setup();
  incoming.operation("et-in", 50, "ETECSA", Date.now() - 10_000);
  const event = await incoming.receipt(undefined as never, {
    bank: "ETECSA", sender: "ETECSA", currency: "CUP", amount: 50,
    beneficiaryMasked: "", recipientPhone: "+5351234567", market: "ETECSA", receiptKind: "incoming", transactionId: undefined,
  });
  await incoming.service.processPending();
  assert.equal(incoming.store.paymentReceipt(event.receipt.id)?.state, "review");
  assert.deepEqual(incoming.callLog, []);
  incoming.store.close();

  const unknown = setup();
  unknown.operation("et-unknown", 50, "ETECSA", Date.now() - 10_000);
  const unknownEvent = await unknown.receipt(undefined as never, {
    bank: "ETECSA", sender: "ETECSA", currency: "CUP", amount: 50,
    beneficiaryMasked: "", recipientPhone: "+5351234567", market: "ETECSA", receiptKind: "unknown", transactionId: undefined,
  });
  await unknown.service.processPending();
  assert.equal(unknown.store.paymentReceipt(unknownEvent.receipt.id)?.state, "review");
  assert.deepEqual(unknown.callLog, []);
  unknown.store.close();

  const ambiguous = setup({ coin: "ETECSA", amount: 10, receive: 50, details: { "Teléfono del destinatario": "+5351234567" } });
  ambiguous.operation("et-a", 50, "ETECSA", Date.now() - 10_000);
  ambiguous.operation("et-b", 50, "ETECSA", Date.now() - 10_000);
  const receipt = await ambiguous.receipt(undefined as never, {
    bank: "ETECSA", sender: "ETECSA", currency: "CUP", amount: 50,
    beneficiaryMasked: "", recipientPhone: "+5351234567", market: "ETECSA", transactionId: undefined,
  });
  await ambiguous.service.processPending();
  assert.equal(ambiguous.store.paymentReceipt(receipt.receipt.id)?.state, "review");
  assert.deepEqual(ambiguous.callLog, []);
  ambiguous.store.close();
});

test("ETECSA rechaza un transactionId aportado por el cliente", async () => {
  const ctx = setup();
  await assert.rejects(() => ctx.receipt("not-an-etecsa-id", {
    bank: "ETECSA", sender: "ETECSA", currency: "CUP", amount: 50,
    beneficiaryMasked: "", recipientPhone: "51234567", market: "ETECSA",
  }), /transactionId/i);
  assert.equal(validPaymentReceipt({
    bank: "ETECSA", sender: "ETECSA", currency: "CUP", amount: 50,
    beneficiaryMasked: "", recipientPhone: "51234567", market: "ETECSA",
    transactionId: "claimed-id", receivedAt: Date.now(),
  }), false);
  ctx.store.close();
});

test("importa una operación remota reciente donde el usuario es el Peer pagador", async () => {
  let listCalls = 0;
  const appliedAt = Date.now() - 5_000;
  const remote = {
    uuid: "manual-qvapay-1", type: "sell", coin: "BANK_CUP", amount: 10, receive: 10_200,
    status: "processing", created_at: new Date(Date.now() - 60 * 60_000).toISOString(),
    updated_at: new Date(appliedAt).toISOString(),
    details: { "Cuenta BPA": "1234567890123456" },
    User: { uuid: "counterparty" }, Peer: { uuid: "our-account" },
  };
  const ctx = setup(remote, undefined, async () => remote, async (page) => {
    listCalls += 1;
    assert.equal(page, 1);
    return { offers: [remote], total: 1, currentPage: 1, perPage: 100 };
  });
  ctx.store.enqueueMarketFeedEvent({
    key: "manual-qvapay-1-applied", event: "p2p.applied",
    payload: { event: "p2p.applied", sent_at: new Date(appliedAt).toISOString(), data: { uuid: remote.uuid } },
    state: "ignored", receivedAt: appliedAt,
  });
  const receipt = await ctx.receipt("manual-bank-ref");
  await ctx.service.processPending();
  assert.equal(ctx.store.paymentReceipt(receipt.receipt.id)?.state, "matched");
  assert.deepEqual(ctx.callLog, ["manual-qvapay-1:manual-bank-ref"]);
  assert.equal(ctx.store.getOperation("manual-qvapay-1")?.counterpartyId, "counterparty");
  assert.equal(ctx.store.visibleOperations().some((item) => item.uuid === "manual-qvapay-1"), true);
  assert.equal(ctx.store.getOperation("manual-qvapay-1")?.cancelAt, null);
  assert.equal(ctx.store.getOperation("manual-qvapay-1")?.autoApplied, false);
  assert.equal(listCalls, 1);
  ctx.store.close();
});

test("reintenta la importación si la operación manual aparece durante la ventana de sincronización", async () => {
  const appliedAt = Date.now() - 10_000;
  const remote = {
    uuid: "manual-late-sync", type: "sell", coin: "BANK_CUP", amount: 10, receive: 10_200,
    status: "processing", updated_at: new Date(appliedAt).toISOString(),
    details: { "Cuenta BPA": "1234567890123456" }, User: { uuid: "counterparty" }, Peer: { uuid: "our-account" },
  };
  let visible = false;
  let listCalls = 0;
  const ctx = setup(remote, undefined, async () => remote, async () => {
    listCalls += 1;
    return { offers: visible ? [remote] : [], total: visible ? 1 : 0, currentPage: 1, perPage: 100 };
  });
  ctx.store.enqueueMarketFeedEvent({
    key: "manual-late-sync-applied", event: "p2p.applied",
    payload: { event: "p2p.applied", sent_at: new Date(appliedAt).toISOString(), data: { uuid: remote.uuid } },
    state: "ignored", receivedAt: appliedAt,
  });
  const receipt = await ctx.receipt("manual-arrives-after-first-sync");
  await ctx.service.processPending();
  assert.equal(ctx.store.paymentReceipt(receipt.receipt.id)?.state, "pending");
  visible = true;
  await ctx.service.processPending(Date.now() + 61_000);
  assert.equal(ctx.store.paymentReceipt(receipt.receipt.id)?.state, "matched");
  assert.deepEqual(ctx.callLog, ["manual-late-sync:manual-arrives-after-first-sync"]);
  assert.equal(listCalls, 2);
  ctx.store.close();
});

test("encuentra una operación en la segunda página solo cuando se leyó el snapshot completo", async () => {
  const appliedAt = Date.now() - 5_000;
  const target = {
    uuid: "manual-on-second-page", type: "sell", coin: "BANK_CUP", amount: 10, receive: 10_200,
    status: "processing", updated_at: new Date(appliedAt).toISOString(),
    details: { "Cuenta BPA": "1234567890123456" }, User: { uuid: "counterparty" }, Peer: { uuid: "our-account" },
  };
  const calls: number[] = [];
  const fillers = Array.from({ length: 100 }, (_, index) => ({
    uuid: `unrelated-${index}`, type: "sell", coin: "BANK_CUP", amount: 20, receive: 20_000,
    status: "processing", updated_at: new Date(appliedAt).toISOString(),
    User: { uuid: "other-seller" }, Peer: { uuid: "our-account" },
  }));
  const ctx = setup(target, undefined, async () => target, async (page) => {
    calls.push(page);
    return { offers: page === 1 ? fillers : [target], total: 101, currentPage: page, perPage: 100 };
  });
  ctx.store.enqueueMarketFeedEvent({
    key: "manual-second-page-applied", event: "p2p.applied",
    payload: { event: "p2p.applied", sent_at: new Date(appliedAt).toISOString(), data: { uuid: target.uuid } },
    state: "ignored", receivedAt: appliedAt,
  });
  const receipt = await ctx.receipt("second-page-ref");
  await ctx.service.processPending();
  assert.deepEqual(calls, [1, 2]);
  assert.equal(ctx.store.paymentReceipt(receipt.receipt.id)?.state, "matched");
  assert.deepEqual(ctx.callLog, [`${target.uuid}:second-page-ref`]);
  ctx.store.close();
});

test("dos operaciones manuales remotas candidatas permanecen visibles y nunca auto-marcan", async () => {
  const appliedAt = Date.now() - 5_000;
  const offers = ["manual-ambiguous-a", "manual-ambiguous-b"].map((uuid) => ({
    uuid, type: "sell", coin: "BANK_CUP", amount: 10, receive: 10_200,
    status: "processing", updated_at: new Date(appliedAt).toISOString(),
    User: { uuid: "counterparty" }, Peer: { uuid: "our-account" },
  }));
  const ctx = setup(offers[0], undefined, async () => offers[0], async () => ({ offers, total: 2, currentPage: 1, perPage: 100 }));
  for (const offer of offers) ctx.store.enqueueMarketFeedEvent({
    key: `${offer.uuid}-applied`, event: "p2p.applied",
    payload: { event: "p2p.applied", sent_at: new Date(appliedAt).toISOString(), data: { uuid: offer.uuid } },
    state: "ignored", receivedAt: appliedAt,
  });
  const receipt = await ctx.receipt("ambiguous-remote-ref");
  await ctx.service.processPending();
  assert.equal(ctx.store.paymentReceipt(receipt.receipt.id)?.state, "review");
  assert.deepEqual(ctx.callLog, []);
  assert.deepEqual(ctx.store.visibleOperations().map((operation) => operation.uuid).sort(), offers.map((offer) => offer.uuid).sort());
  ctx.store.close();
});

test("una operación local y otra manual remota coincidentes no se consideran únicas", async () => {
  const appliedAt = Date.now() - 5_000;
  const offers = ["op-1", "manual-duplicate"].map((uuid) => ({
    uuid, type: "sell", coin: "BANK_CUP", amount: 10, receive: 10_200,
    status: "processing", updated_at: new Date(appliedAt).toISOString(),
    details: { "Cuenta BPA": "1234567890123456" },
    User: { uuid: "counterparty" }, Peer: { uuid: "our-account" },
  }));
  const ctx = setup(offers[0], undefined, async () => offers[0], async () => ({ offers, total: 2, currentPage: 1, perPage: 100 }));
  ctx.operation("op-1", 10_200, "BANK_CUP", appliedAt);
  for (const offer of offers) ctx.store.enqueueMarketFeedEvent({
    key: `${offer.uuid}-applied`, event: "p2p.applied",
    payload: { event: "p2p.applied", sent_at: new Date(appliedAt).toISOString(), data: { uuid: offer.uuid } },
    state: "ignored", receivedAt: appliedAt,
  });
  const receipt = await ctx.receipt("local-plus-manual");
  await ctx.service.processPending();
  assert.equal(ctx.store.paymentReceipt(receipt.receipt.id)?.state, "review");
  assert.deepEqual(ctx.callLog, []);
  assert.deepEqual(ctx.store.visibleOperations().map((operation) => operation.uuid).sort(), ["manual-duplicate", "op-1"]);
  ctx.store.close();
});

test("una oferta manual potencial sin evento applied también impide la unicidad local", async () => {
  const appliedAt = Date.now() - 5_000;
  const offers = ["op-1", "manual-without-applied"].map((uuid) => ({
    uuid, type: "sell", coin: "BANK_CUP", amount: 10, receive: 10_200,
    status: "processing", updated_at: new Date(appliedAt).toISOString(),
    details: { "Cuenta BPA": "1234567890123456" },
    User: { uuid: "counterparty" }, Peer: { uuid: "our-account" },
  }));
  const ctx = setup(offers[0], undefined, async () => offers[0], async () => ({ offers, total: 2, currentPage: 1, perPage: 100 }));
  ctx.operation("op-1", 10_200, "BANK_CUP", appliedAt);
  ctx.store.enqueueMarketFeedEvent({
    key: "local-offer-applied", event: "p2p.applied",
    payload: { event: "p2p.applied", sent_at: new Date(appliedAt).toISOString(), data: { uuid: "op-1" } },
    state: "ignored", receivedAt: appliedAt,
  });
  const receipt = await ctx.receipt("local-plus-unproven-manual");
  await ctx.service.processPending();
  assert.equal(ctx.store.paymentReceipt(receipt.receipt.id)?.state, "review");
  assert.deepEqual(ctx.callLog, []);
  assert.equal(ctx.store.getOperation("manual-without-applied"), undefined);
  ctx.store.close();
});

test("ETECSA manual import compara teléfono exacto tras probar Peer pagador y evento applied", async () => {
  const appliedAt = Date.now() - 5_000;
  const remote = {
    uuid: "manual-etecsa", type: "sell", coin: "ETECSA", amount: 10, receive: 50,
    status: "processing", updated_at: new Date(appliedAt).toISOString(),
    details: { "Teléfono del destinatario": "+53 5 123 4567" },
    User: { uuid: "counterparty" }, Peer: { uuid: "our-account" },
  };
  const ctx = setup(remote, undefined, async () => remote, async () => ({ offers: [remote], total: 1, currentPage: 1, perPage: 100 }));
  ctx.store.enqueueMarketFeedEvent({
    key: "manual-etecsa-applied", event: "p2p.applied",
    payload: { event: "p2p.applied", sent_at: new Date(appliedAt).toISOString(), data: { uuid: remote.uuid } },
    state: "ignored", receivedAt: appliedAt,
  });
  const receipt = await ctx.receipt(undefined as never, {
    bank: "ETECSA", sender: "ETECSA", currency: "CUP", amount: 50,
    beneficiaryMasked: "", recipientPhone: "51234567", market: "ETECSA", transactionId: undefined,
  });
  await ctx.service.processPending();
  assert.equal(ctx.store.paymentReceipt(receipt.receipt.id)?.state, "matched");
  assert.match(ctx.callLog[0]!, /^manual-etecsa:SMS-ETECSA-[a-f0-9]{16}$/);
  ctx.store.close();

  const mismatched = setup({ ...remote, uuid: "manual-etecsa-wrong-phone", details: { "Teléfono del destinatario": "+5357654321" } }, undefined, async () => ({ ...remote, uuid: "manual-etecsa-wrong-phone", details: { "Teléfono del destinatario": "+5357654321" } }) as never, async () => ({ offers: [{ ...remote, uuid: "manual-etecsa-wrong-phone" }], total: 1, currentPage: 1, perPage: 100 }));
  const mismatchAt = Date.now() - 5_000;
  mismatched.store.enqueueMarketFeedEvent({
    key: "manual-etecsa-wrong-applied", event: "p2p.applied",
    payload: { event: "p2p.applied", sent_at: new Date(mismatchAt).toISOString(), data: { uuid: "manual-etecsa-wrong-phone" } },
    state: "ignored", receivedAt: mismatchAt,
  });
  const bad = await mismatched.receipt(undefined as never, {
    bank: "ETECSA", sender: "ETECSA", currency: "CUP", amount: 50,
    beneficiaryMasked: "", recipientPhone: "51234567", market: "ETECSA", transactionId: undefined,
  });
  await mismatched.service.processPending();
  assert.equal(mismatched.store.paymentReceipt(bad.receipt.id)?.state, "review");
  assert.deepEqual(mismatched.callLog, []);
  mismatched.store.close();
});

test("no importa ni marca una oferta remota si el rol pagador o la contraparte no son inequívocos", async () => {
  for (const roleCase of [
    { Peer: { uuid: "someone-else" } },
    { Peer: undefined },
    { User: undefined },
    { User: { uuid: "our-account" }, Peer: { uuid: "our-account" } },
  ]) {
    const remote = {
      uuid: "manual-role-ambiguous", type: "sell", coin: "BANK_CUP", amount: 10, receive: 10_200,
      status: "processing", updated_at: new Date(Date.now() - 5_000).toISOString(),
      User: { uuid: "counterparty" }, Peer: { uuid: "our-account" }, ...roleCase,
    };
    const ctx = setup(remote, undefined, async () => remote, async () => ({ offers: [remote], total: 1, currentPage: 1, perPage: 100 }));
    ctx.store.enqueueMarketFeedEvent({
      key: `manual-role-applied-${String(roleCase.Peer?.uuid ?? "missing")}`, event: "p2p.applied",
      payload: { event: "p2p.applied", sent_at: new Date(Date.now() - 5_000).toISOString(), data: { uuid: remote.uuid } },
      state: "ignored", receivedAt: Date.now() - 5_000,
    });
    const receipt = await ctx.receipt("ambiguous-role");
    await ctx.service.processPending();
    await ctx.service.processPending(Date.now() + 11 * 60_000);
    assert.equal(ctx.store.paymentReceipt(receipt.receipt.id)?.state, "review");
    assert.deepEqual(ctx.callLog, []);
    assert.equal(ctx.store.getOperation("manual-role-ambiguous"), undefined);
    ctx.store.close();
  }

  const listed = {
    uuid: "manual-role-changed", type: "sell", coin: "BANK_CUP", amount: 10, receive: 10_200,
    status: "processing", updated_at: new Date(Date.now() - 5_000).toISOString(),
    User: { uuid: "counterparty" }, Peer: { uuid: "our-account" },
  };
  const detail = { ...listed, Peer: { uuid: "different-payer" }, details: { "Cuenta BPA": "1234567890123456" } };
  const detailMismatch = setup(detail, undefined, async () => detail, async () => ({ offers: [listed], total: 1, currentPage: 1, perPage: 100 }));
  const appliedAt = Date.now() - 5_000;
  detailMismatch.store.enqueueMarketFeedEvent({
    key: "manual-detail-role-applied", event: "p2p.applied",
    payload: { event: "p2p.applied", sent_at: new Date(appliedAt).toISOString(), data: { uuid: listed.uuid } },
    state: "ignored", receivedAt: appliedAt,
  });
  const detailReceipt = await detailMismatch.receipt("detail-role-mismatch");
  await detailMismatch.service.processPending();
  assert.equal(detailMismatch.store.paymentReceipt(detailReceipt.receipt.id)?.state, "review");
  assert.deepEqual(detailMismatch.callLog, []);
  assert.equal(detailMismatch.store.getOperation(listed.uuid)?.counterpartyId, "counterparty");
  detailMismatch.store.close();
});

test("no usa updated_at como prueba del momento de aplicación si falta el evento p2p.applied", async () => {
  const remote = {
    uuid: "manual-no-applied-event", type: "sell", coin: "BANK_CUP", amount: 10, receive: 10_200,
    status: "processing", updated_at: new Date(Date.now() - 5_000).toISOString(),
    details: { "Cuenta BPA": "1234567890123456" },
    User: { uuid: "counterparty" }, Peer: { uuid: "our-account" },
  };
  const ctx = setup(remote, undefined, async () => remote, async () => ({ offers: [remote], total: 1, currentPage: 1, perPage: 100 }));
  const receipt = await ctx.receipt("no-time-proof");
  await ctx.service.processPending();
  await ctx.service.processPending(Date.now() + 11 * 60_000);
  assert.equal(ctx.store.paymentReceipt(receipt.receipt.id)?.state, "review");
  assert.deepEqual(ctx.callLog, []);
  assert.equal(ctx.store.getOperation(remote.uuid), undefined);
  ctx.store.close();
});

test("la sincronización remota pagina de forma acotada y no asocia si el snapshot queda truncado", async () => {
  const remote = {
    uuid: "manual-on-page-1", type: "sell", coin: "BANK_CUP", amount: 10, receive: 10_200,
    status: "processing", updated_at: new Date(Date.now() - 5_000).toISOString(),
    details: { "Cuenta BPA": "1234567890123456" },
    User: { uuid: "counterparty" }, Peer: { uuid: "our-account" },
  };
  const calls: number[] = [];
  const ctx = setup(remote, undefined, async () => remote, async (page) => {
    calls.push(page);
    return { offers: page === 1 ? [remote] : Array.from({ length: 100 }, (_, i) => ({ ...remote, uuid: `other-${i}` })), total: 250, currentPage: page, perPage: 100 };
  });
  const receipt = await ctx.receipt("truncated-snapshot");
  await ctx.service.processPending();
  assert.deepEqual(calls, [1, 2]);
  assert.notEqual(ctx.store.paymentReceipt(receipt.receipt.id)?.state, "matched");
  assert.deepEqual(ctx.callLog, []);
  assert.equal(ctx.store.getOperation("manual-on-page-1"), undefined);
  ctx.store.close();
});

test("el contrato conserva recibos legacy y rechaza formas inválidas sin lanzar", () => {
  const legacy = { bank: "BPA", sender: "PAGOxMOVIL", currency: "CUP", amount: 20, beneficiaryMasked: "1234****5678", transactionId: "tx", receivedAt: Date.now() };
  assert.equal(validPaymentReceipt(legacy), true);
  assert.equal(validPaymentReceipt({ ...legacy, bank: 42 }), false);
  assert.equal(validPaymentReceipt({ ...legacy, receiptKind: "incoming" }), false);
  assert.equal(validPaymentReceipt({ ...legacy, extra: "body" }), false);
});
