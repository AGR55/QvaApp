import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { MarketConfigService } from "../src/market-config.js";
import { Store } from "../src/store.js";

const legacyRuntime = {
  qusdReserve: 2,
  maxOpenOwnOffers: 4,
  buyQusdMaxRate: 930,
  sellQusdMinRate: 980,
  buyQusdUsdMaxRate: 1.06,
  sellQusdUsdMinRate: 1.12,
  cupPurchaseMaxQusd: 35,
  initialUsdFiatBalance: 110,
  paymentDetails: { BANK_CUP: [], BANDECPREPAGO: [] },
};

test("versiona el esquema y cierra explícitamente SQLite", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "qvaapply-schema-version-"));
  const store = new Store(dataDir);
  assert.ok(store.schemaVersion() >= 2);
  store.close();
});

test("persiste la configuración nueva únicamente en SQLite", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "qvaapply-config-sqlite-"));
  const store = new Store(dataDir);
  const config = new MarketConfigService(
    dataDir,
    legacyRuntime as never,
    store,
  );
  const next = config.current();
  next.risk.minQusdReserve = 7;
  next.automation.scanIntervalSeconds = 33;
  next.automation.welcomeMessage = "Pago fiat manual; el bot solo aplica la oferta.";
  next.hunting.buyRunning = false;
  next.markets[0]!.huntSellEnabled = false;
  config.save(next);

  assert.equal(existsSync(join(dataDir, "trading-config.json")), false);
  assert.equal(store.loadTradingConfig()?.qusdReserve, 7);
  assert.equal(store.loadTradingConfig()?.automation.scanIntervalSeconds, 33);
  assert.match(store.loadTradingConfig()?.automation.welcomeMessage ?? "", /manual/);
  assert.equal(store.loadTradingConfig()?.hunting.buyRunning, false);
  assert.equal(store.loadTradingConfig()?.markets[0]?.huntSellEnabled, false);
  assert.ok(store.hasBotConfig());
  assert.equal(
    store.loadTradingConfig()?.risk.maxQusdPerOperation,
    25,
  );
  assert.ok(store.verifyConfigRevisionChain());
  store.close();
});

test("persiste la identidad visual de mercados añadidos desde Estrategia", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "qvaapply-market-identity-"));
  const store = new Store(dataDir);
  const config = new MarketConfigService(dataDir, legacyRuntime as never, store);
  const next = config.current();
  next.markets.push({
    code: "ETECSA",
    label: "Saldo Etecsa",
    currency: "CUP",
    iconUrl: "/market-icons/etecsa-identity.png",
    color: "#2f8fcb",
    active: true,
    huntBuyEnabled: true,
    huntSellEnabled: true,
    fiatBalance: 0,
    buyMaxRate: 900,
    sellMinRate: 950,
    purchaseMaxQusd: 0,
    sellFeePercent: 0,
    outgoingTransferFee: 0,
    paymentDetails: [],
  });
  config.save(next, "panel");

  const reopened = new MarketConfigService(dataDir, legacyRuntime as never, store);
  assert.equal(reopened.find("ETECSA")?.iconUrl, "/market-icons/etecsa-identity.png");
  assert.equal(reopened.find("ETECSA")?.color, "#2f8fcb");
  store.close();
});

test("guarda iconos de mercado administrados y rechaza contenido disfrazado", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "qvaapply-market-icon-"));
  const store = new Store(dataDir);
  const config = new MarketConfigService(dataDir, legacyRuntime as never, store);
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB", "base64");
  const icon = config.saveMarketIcon("etecsa.png", "image/png", png);

  assert.match(icon.url, /^\/market-icons\/[a-f0-9]{32}\.png$/);
  assert.equal(existsSync(icon.path), true);
  assert.throws(
    () => config.saveMarketIcon("falso.png", "image/png", Buffer.from("no es png")),
    /contenido no coincide/i,
  );
  store.close();
});

test("persiste el progreso de un reajuste para retomarlo después de reiniciar", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "qvaapply-rebalance-job-"));
  const store = new Store(dataDir);
  const adjustment = {
    uuid: "offer-etecsa",
    coin: "ETECSA",
    currentAmount: 20,
    targetAmount: 12,
    rate: 900,
    receive: 18_000,
    action: "edit" as const,
    state: "pending" as const,
  };
  store.createRebalanceJob("rebalance-1", [adjustment], 123);
  store.updateRebalanceJob("rebalance-1", "applying", [
    { ...adjustment, state: "applying" },
  ]);
  store.close();

  const reopened = new Store(dataDir);
  const pending = reopened.pendingRebalanceJobs();
  assert.equal(pending[0]?.id, "rebalance-1");
  assert.equal(pending[0]?.adjustments[0]?.state, "applying");
  reopened.close();
});

test("unifica la reserva e impide configuraciones financieras incoherentes", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "qvaapply-config-invariants-"));
  const store = new Store(dataDir);
  const config = new MarketConfigService(dataDir, legacyRuntime as never, store);
  const valid = config.current();
  valid.risk.minQusdReserve = 8;
  config.save(valid);
  assert.equal(config.current().qusdReserve, 8);

  const excessiveMarketLimit = config.current();
  excessiveMarketLimit.markets[0]!.purchaseMaxQusd = 30;
  assert.throws(() => config.save(excessiveMarketLimit), /máximo global/);

  const negativeSpread = config.current();
  negativeSpread.markets[0]!.sellMinRate = negativeSpread.markets[0]!.buyMaxRate;
  assert.throws(() => config.save(negativeSpread), /mínimo de venta neto/);
  store.close();
});

test("versiona los límites globales y encadena cada revisión", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "qvaapply-risk-revisions-"));
  const store = new Store(dataDir);
  const config = new MarketConfigService(
    dataDir,
    legacyRuntime as never,
    store,
  );
  const next = config.current();
  next.risk.maxQusdPerOperation = 40;
  next.risk.reviewedAt = Date.now();
  store.saveTradingConfig(next, "panel", "Ajuste aprobado por el propietario");

  const history = store.configRevisionHistory();
  assert.equal(history.length, 2);
  assert.equal(history[0]?.source, "panel");
  assert.equal(history[0]?.config.risk.maxQusdPerOperation, 40);
  assert.equal(history[0]?.previousHash, history[1]?.hash);
  assert.ok(store.verifyConfigRevisionChain());
  store.close();
});

test("importa una configuración JSON heredada una sola vez", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "qvaapply-config-import-"));
  const legacyPath = join(dataDir, "trading-config.json");
  writeFileSync(
    legacyPath,
    JSON.stringify({
      version: 1,
      qusdReserve: 9,
      maxOpenOffers: 3,
      markets: [
        {
          code: "BANK_CUP",
          label: "CUP heredado",
          currency: "CUP",
          active: true,
          fiatBalance: 1234,
          buyMaxRate: 900,
          sellMinRate: 990,
          purchaseMaxQusd: 20,
          sellFeePercent: 0,
          paymentDetails: [{ name: "cuenta", value: "123" }],
        },
      ],
    }),
  );
  const store = new Store(dataDir);
  const imported = new MarketConfigService(
    dataDir,
    legacyRuntime as never,
    store,
  );
  assert.equal(imported.current().qusdReserve, 9);
  assert.equal(imported.find("BANK_CUP")?.fiatBalance, 1234);

  renameSync(legacyPath, `${legacyPath}.legacy`);
  const reopened = new MarketConfigService(
    dataDir,
    legacyRuntime as never,
    store,
  );
  assert.equal(reopened.current().qusdReserve, 9);
  assert.equal(reopened.find("BANK_CUP")?.label, "CUP heredado");
  store.close();
});

test("crea un respaldo antes de migrar una base heredada", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "qvaapply-backup-"));
  const db = new DatabaseSync(join(dataDir, "qvaapply.sqlite"));
  db.exec("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  db.prepare("INSERT INTO settings(key, value) VALUES (?, ?)").run(
    "paused",
    "false",
  );
  db.close();

  const store = new Store(dataDir);
  const backups = readdirSync(join(dataDir, "backups"));
  assert.equal(backups.length, 1);
  assert.match(backups[0]!, /^qvaapply-before-v12-.*\.sqlite$/);
  assert.equal(store.get("paused"), "false");
  store.close();
});

test("mantiene ofertas bloqueadas accionables y respeta un descarte sin cambios", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "qvaapply-blocked-alert-"));
  const store = new Store(dataDir);
  const alert = {
    uuid: "blocked-1",
    coin: "BANK_CUP",
    offerType: "buy" as const,
    amount: 12,
    receive: 12_240,
    rate: 1_020,
    decision: "blocked" as const,
    reason: "3% por encima de la mediana",
    referenceRate: 990,
  };
  store.syncTradingAlerts([alert]);
  assert.equal(store.tradingAlert("blocked-1")?.referenceRate, 990);
  assert.equal(store.resolveTradingAlert("blocked-1", "dismissed"), true);
  store.syncTradingAlerts([alert]);
  assert.equal(store.tradingAlert("blocked-1")?.resolution, "dismissed");

  store.syncTradingAlerts([{ ...alert, rate: 1_021 }]);
  assert.equal(store.tradingAlert("blocked-1")?.resolvedAt, null);
  assert.equal(store.tradingAlert("blocked-1")?.resolution, undefined);
  store.close();
});

test("pagina eventos de decisión y descarta solamente una versión", () => {
  const store = new Store(mkdtempSync(join(tmpdir(), "qvaapply-decisions-")));
  const base = {
    uuid: "offer-versioned",
    coin: "BANK_CUP",
    offerType: "sell" as const,
    amount: 10,
    receive: 10_000,
    rate: 1_000,
    decision: "blocked" as const,
    reason: "Capital insuficiente",
    checks: [{ code: "fiat_capital", label: "Capital", status: "fail" as const, reason: "Capital insuficiente" }],
  };
  const first = store.recordDecisionEvent(base);
  assert.equal(store.resolveDecisionEvent(first.id, "dismissed"), true);
  const same = store.recordDecisionEvent(base);
  assert.equal(same.id, first.id);
  assert.equal(same.resolution, "dismissed");

  const changed = store.recordDecisionEvent({ ...base, rate: 999, receive: 9_990 });
  assert.notEqual(changed.id, first.id);
  store.recordDecisionEvent({
    ...base,
    uuid: "already-applied",
    decision: "applied",
    reason: "Aplicación confirmada",
  });
  const pending = store.decisionEvents({ decision: "blocked", status: "pending", pageSize: 1 });
  assert.equal(pending.total, 1);
  assert.equal(pending.pending, 1);
  assert.equal(pending.items[0]?.id, changed.id);
  assert.equal(pending.items[0]?.checks[0]?.code, "fiat_capital");
  store.close();
});

test("conserva estados terminales en el historial pero los excluye de la proyección operativa", () => {
  const store = new Store(mkdtempSync(join(tmpdir(), "qvaapply-visible-operations-")));
  const base = {
    offerType: "sell" as const,
    coin: "CLASICA",
    amount: 2,
    receive: 2.12,
    rate: 1.06,
    autoApplied: true,
    cancelAt: null,
    createdAt: Date.now(),
  };
  store.createOperation({ ...base, uuid: "active", state: "acknowledged" });
  store.createOperation({ ...base, uuid: "cancelled", state: "cancelled" });
  store.createOperation({ ...base, uuid: "completed", state: "completed" });

  assert.deepEqual(store.visibleOperations().map((item) => item.uuid), ["active"]);
  assert.deepEqual(new Set(store.operations().map((item) => item.uuid)), new Set(["active", "cancelled", "completed"]));
  store.close();
});

test("conserva recursos QvaPay independientes después de reiniciar", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "qvaapply-remote-cache-"));
  const first = new Store(dataDir);
  first.saveRemoteResource("balance", { balance: 17.25 }, 123456);
  first.close();

  const reopened = new Store(dataDir);
  assert.deepEqual(reopened.loadRemoteResource("balance"), {
    key: "balance",
    data: { balance: 17.25 },
    updatedAt: 123456,
  });
  assert.equal(reopened.loadRemoteResource("missing"), undefined);
  reopened.close();
});

test("persiste workflow, snapshots y una reserva QUSD exclusiva", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "qvaapply-workflow-"));
  const store = new Store(dataDir);
  const decision = {
    kind: "apply" as const,
    opportunityUuid: "external",
    evaluatedAt: Date.now(),
    requiredQusd: 20,
    requiredFiat: 0,
    projectedExposureQusd: 20,
    projectedDailyAppliedQusd: 20,
    checks: [],
    reasons: ["Aprobada"],
  };
  store.createTradeWorkflow(
    {
      id: "workflow-1",
      targetOffer: {
        uuid: "external",
        type: "buy",
        coin: "BANK_CUP",
        amount: 20,
        receive: 20_000,
        status: "open",
      },
      riskDecision: decision,
    },
    [
      {
        uuid: "own-1",
        coin: "BANK_CUP",
        amount: 20,
        receive: 19_000,
        rate: 950,
        details: [{ name: "cuenta", value: "123" }],
        tags: [],
        onlyKyc: false,
        onlyVip: false,
        private: false,
      },
    ],
  );

  assert.equal(store.getTradeWorkflow("workflow-1")?.state, "planned");
  assert.equal(store.workflowOwnOffers("workflow-1")[0]?.snapshot.uuid, "own-1");
  assert.equal(store.reserveQusd("workflow-1", "BANK_CUP", 20, 25), true);
  assert.equal(store.activeReservedQusd(), 20);

  store.createTradeWorkflow(
    {
      id: "workflow-2",
      targetOffer: {
        uuid: "external-2",
        type: "buy",
        coin: "BANK_CUP",
        amount: 10,
        receive: 10_000,
        status: "open",
      },
      riskDecision: { ...decision, opportunityUuid: "external-2" },
    },
    [],
  );
  assert.equal(store.reserveQusd("workflow-2", "BANK_CUP", 10, 25), false);
  store.releaseCapitalReservation("workflow-1");
  assert.equal(store.activeReservedQusd(), 0);
  store.close();
});
