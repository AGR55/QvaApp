import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Store } from "../src/store.js";
import { TradingEngine } from "../src/trading.js";
import { QvaMutationUncertainError } from "../src/qvapay.js";
import type { P2pOffer, OperationState, P2pType } from "../src/types.js";

const delay = (milliseconds: number) => new Promise<void>(resolve => setTimeout(resolve, milliseconds));
const offer: P2pOffer = { uuid: "operation", type: "buy", coin: "BANK_CUP", amount: 10, receive: 9200, status: "processing" };

function setup(cleanup: (callback: () => void) => void) {
  const dataDir = mkdtempSync(join(tmpdir(), "qva-action-test-"));
  const store = new Store(dataDir);
  cleanup(() => { store.close(); rmSync(dataDir, { recursive: true, force: true }); });
  const cfg = { dataDir, initialUsdFiatBalance: 0, realTradingAllowed: true, paymentDetails: { BANK_CUP: [], BANDECPREPAGO: [] } };
  store.set("mode", "real");
  const create = (uuid = "operation", side: P2pType = "buy", state: OperationState = "paid", orderUuid?: string) => {
    store.createOperation({ uuid, offerType: side, coin: "BANK_CUP", amount: 10, receive: 9200, rate: 920,
      state, autoApplied: false, cancelAt: null, createdAt: Date.now(), ...(orderUuid ? { orderUuid } : {}) });
  };
  const gateway = {
    getOffer: async (_uuid: string): Promise<P2pOffer> => ({ ...offer }),
    markPaid: async (_uuid: string, _reference: string, _order?: string) => undefined,
    confirmReceived: async (_uuid: string, _order?: string) => undefined,
    cancel: async (_uuid: string) => undefined,
  };
  const engine = (repository = store) => new TradingEngine(repository, gateway as never, cfg as never, async () => undefined);
  return { dataDir, store, create, gateway, engine };
}

test("excluye duplicados antes del preflight entre motores del mismo repositorio y acciones incompatibles", async context => {
  for (const action of ["paid", "received"] as const) {
    const fixture = setup(callback => context.after(callback));
    fixture.create("operation", action === "paid" ? "sell" : "buy", "applied", "child");
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let reads = 0;
    let mutations = 0;
    fixture.gateway.getOffer = async () => {
      reads++;
      await gate;
      return { ...offer, offer_kind: "flexible", Orders: [{ uuid: "child", status: "processing", amount: 10, receive: 9200 }] };
    };
    fixture.gateway.markPaid = async (_uuid, _reference, order) => { assert.equal(order, "child"); mutations++; };
    fixture.gateway.confirmReceived = async (_uuid, order) => { assert.equal(order, "child"); mutations++; };
    const first = fixture.engine();
    const second = fixture.engine();
    const pending = action === "paid" ? first.markPaid("operation", "SECRET-REF") : first.confirmReceived("operation");
    await assert.rejects(second.markPaid("operation", "another"), /acción en curso/);
    await assert.rejects(second.confirmReceived("operation"), /acción en curso/);
    await assert.rejects(second.cancel("operation"), /acción en curso/);
    release();
    await pending;
    assert.equal(reads, 1);
    assert.equal(mutations, 1);
    assert.equal(fixture.store.recentMutationIntents().length, 1);
    assert.ok(!fixture.store.recentAudit(100).filter(row => row.action === "operation_action_timing").some(row => row.detail.includes("SECRET-REF")));
  }
});

test("recepción rechaza estados locales y remotos inválidos sin despachar", async context => {
  for (const state of ["completed", "cancelled", "revision"] as const) {
    const fixture = setup(callback => context.after(callback));
    fixture.create("operation", "buy", state);
    fixture.gateway.getOffer = async () => { throw new Error("unexpected read"); };
    await assert.rejects(fixture.engine().confirmReceived("operation"), /estado actual/);
    assert.equal(fixture.store.recentMutationIntents().length, 0);
  }
  for (const status of ["completed", "cancelled", "open", "revision"]) {
    const fixture = setup(callback => context.after(callback));
    fixture.create();
    fixture.gateway.getOffer = async () => ({ ...offer, status });
    await assert.rejects(fixture.engine().confirmReceived("operation"), /no se confirmó recepción/);
    assert.equal(fixture.store.recentMutationIntents().length, 0);
  }
});

test("mantiene exclusión durante el POST sin bloquear operaciones independientes", async context => {
  const fixture = setup(callback => context.after(callback));
  fixture.create();
  fixture.create("independent");
  let release!: () => void;
  let dispatched!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { dispatched = resolve; });
  fixture.gateway.confirmReceived = async uuid => {
    if (uuid === "operation") { dispatched(); await gate; }
  };
  const engine = fixture.engine();
  const pending = engine.confirmReceived("operation");
  await started;
  await assert.rejects(engine.confirmReceived("operation"), /acción en curso/);
  await engine.confirmReceived("independent");
  assert.equal(fixture.store.getOperation("independent")?.state, "completed");
  assert.equal(fixture.store.getOperation("operation")?.state, "paid");
  release();
  await pending;
});

test("revalida cambios locales y nuevas intenciones después del preflight", async context => {
  for (const change of ["state", "intent", "mode"]) {
    const fixture = setup(callback => context.after(callback));
    fixture.create();
    fixture.gateway.getOffer = async () => {
      if (change === "state") fixture.store.updateOperation("operation", "completed");
      if (change === "intent") fixture.store.createMutationIntent({ intentId: "external", operationUuid: "operation", kind: "paid", request: {} });
      if (change === "mode") fixture.store.set("mode", "paper");
      return { ...offer };
    };
    let sent = 0;
    fixture.gateway.confirmReceived = async () => { sent++; };
    await assert.rejects(fixture.engine().confirmReceived("operation"));
    assert.equal(sent, 0);
  }
});

test("preflight fallido libera exclusión y permite otra operación sin bloqueo global", async context => {
  const fixture = setup(callback => context.after(callback));
  fixture.create();
  fixture.create("independent");
  fixture.gateway.getOffer = async uuid => {
    if (uuid === "operation") throw new Error("read failed");
    return { ...offer, uuid };
  };
  const engine = fixture.engine();
  await assert.rejects(engine.confirmReceived("operation"), /read failed/);
  await engine.confirmReceived("independent");
  fixture.gateway.getOffer = async () => ({ ...offer });
  await engine.confirmReceived("operation");
  assert.equal(fixture.store.getOperation("operation")?.state, "completed");
});

test("incertidumbre sobrevive repositorio reabierto y solo se concilia con estado remoto concluyente", async context => {
  const fixture = setup(callback => context.after(callback));
  fixture.create();
  let sent = 0;
  fixture.gateway.confirmReceived = async () => { sent++; throw new QvaMutationUncertainError("received", new Error("lost response")); };
  await assert.rejects(fixture.engine().confirmReceived("operation"));
  const reopened = new Store(fixture.dataDir);
  try {
    const recovered = fixture.engine(reopened);
    await assert.rejects(recovered.confirmReceived("operation"), /pendiente de conciliación/);
    assert.equal(await recovered.reconcilePendingStandaloneMutations({ force: true }), 0);
    assert.equal(reopened.recentMutationIntents()[0]?.state, "uncertain");
    fixture.gateway.getOffer = async () => ({ ...offer, status: "completed" });
    assert.equal(await recovered.reconcilePendingStandaloneMutations({ force: true }), 1);
    assert.equal(reopened.recentMutationIntents()[0]?.state, "reconciled");
    assert.equal(sent, 1);
  } finally { reopened.close(); }
});

test("persistencia inicial fallida no envía y libera exclusión", async context => {
  const fixture = setup(callback => context.after(callback));
  fixture.create();
  const createIntent = fixture.store.createMutationIntent.bind(fixture.store);
  fixture.store.createMutationIntent = () => { throw new Error("disk unavailable"); };
  let sent = 0;
  fixture.gateway.confirmReceived = async () => { sent++; };
  const engine = fixture.engine();
  await assert.rejects(engine.confirmReceived("operation"), /disk unavailable/);
  assert.equal(sent, 0);
  fixture.store.createMutationIntent = createIntent;
  await engine.confirmReceived("operation");
  assert.equal(sent, 1);
});

test("fallo de telemetría no convierte una confirmación en error ni mantiene exclusión", async context => {
  const fixture = setup(callback => context.after(callback));
  fixture.create();
  const audit = fixture.store.audit.bind(fixture.store);
  fixture.store.audit = (action, detail, uuid) => {
    if (action === "operation_action_timing") throw new Error("telemetry unavailable");
    audit(action, detail, uuid);
  };
  const engine = fixture.engine();
  await engine.confirmReceived("operation");
  await assert.rejects(engine.confirmReceived("operation"), /estado actual/);
  assert.equal(fixture.store.getOperation("operation")?.state, "completed");
});

test("medición controlada: tiempos observados de preflight, gateway y persistencia sin red real", async context => {
  const fixture = setup(callback => context.after(callback));
  fixture.gateway.getOffer = async uuid => { await delay(8); return { ...offer, uuid }; };
  fixture.gateway.markPaid = async () => { await delay(12); };
  fixture.gateway.confirmReceived = async () => { await delay(12); };
  const engine = fixture.engine();
  for (const action of ["paid", "received"] as const) {
    for (let sample = 0; sample < 20; sample++) {
      const uuid = `${action}-${sample}`;
      fixture.create(uuid, action === "paid" ? "sell" : "buy", "applied");
      if (action === "paid") await engine.markPaid(uuid, "SIMULATED");
      else await engine.confirmReceived(uuid);
    }
    const rows = fixture.store.recentAudit(500).filter(row => row.action === "operation_action_timing")
      .map(row => JSON.parse(row.detail) as Record<string, number | string>).filter(row => row.action === action);
    assert.equal(rows.length, 20);
    const summary: Record<string, unknown> = { action, samples: rows.length, injectedPreflightMs: 8, injectedGatewayMs: 12 };
    for (const phase of ["preflightMs", "intentPersistMs", "mutationMs", "resultPersistMs", "operationPersistMs", "totalMs"]) {
      const values = rows.map(row => Number(row[phase])).sort((first, second) => first - second);
      assert.ok(values.every(value => Number.isFinite(value) && value >= 0));
      summary[phase] = { p50: Number(values[9]!.toFixed(3)), p95: Number(values[18]!.toFixed(3)) };
    }
    console.log("SIMULATED_OPERATION_TIMING", JSON.stringify(summary));
  }
});
