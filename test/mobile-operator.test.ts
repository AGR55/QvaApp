import assert from "node:assert/strict";
import test from "node:test";
import { MobileOperatorService } from "../src/mobile-operator.js";

test("credencial de operador se persiste solo hasheada, limita solicitudes y revoca acceso", async () => {
  let saved = "";
  let now = 100_000;
  const audit: string[] = [];
  const service = new MobileOperatorService({
    get: () => saved || undefined,
    set: (_key, value) => { saved = value; },
    audit: (action) => audit.push(action),
  }, {
    operations: () => [], alerts: () => [], markets: () => [],
    markPaid: async () => undefined, confirmReceived: async () => undefined, cancel: async () => undefined,
  }, () => now);
  const { operator, token } = service.pair("Pixel");
  assert.equal(token.length, 48);
  assert.equal(saved.includes(token), false);
  assert.equal(service.check(token).ok, true);
  for (let count = 1; count < 60; count++) service.check(token);
  assert.equal(service.check(token).rateLimited, true);
  assert.equal(service.check(token, true).ok, true, "lecturas frecuentes no consumen el cupo de mutaciones");
  for (let count = 1; count < 20; count++) service.check(token, true);
  assert.equal(service.check(token, true).rateLimited, true);
  assert.equal(service.check(token).ok, false, "el contador de lecturas sigue agotado de forma independiente");
  now += 60_001;
  assert.equal(service.check(token).ok, true);
  assert.equal(service.revoke(operator.id), true);
  assert.equal(service.check(token).ok, false);
  assert.deepEqual(audit, ["mobile_operator_created", "mobile_operator_revoked"]);
});

test("acción móvil registra solicitud y resultado incierto sin ocultar el fallo", async () => {
  const audit: string[] = [];
  const service = new MobileOperatorService({
    get: () => undefined, set: () => undefined,
    audit: (action) => audit.push(action),
  }, {
    operations: () => [], alerts: () => [], markets: () => [],
    markPaid: async () => { throw new Error("QvaPay timeout"); }, confirmReceived: async () => undefined, cancel: async () => undefined,
  });
  await assert.rejects(service.act("operator-1", "operation-1", "paid", "REF-1"), /timeout/);
  assert.deepEqual(audit, ["mobile_paid_requested", "mobile_paid_uncertain"]);
});

test("operaciones móviles anuncian acciones según la dirección real del trading y compactan avisos", () => {
  const service = new MobileOperatorService({ get: () => undefined, set: () => undefined, audit: () => undefined }, {
    operations: () => [
      { uuid: "sell-1", offerType: "sell", coin: "BPA", amount: 10, receive: 100, rate: 10, state: "applied", createdAt: 1 },
      { uuid: "buy-1", offerType: "buy", coin: "BAND", amount: 10, receive: 100, rate: 10, state: "acknowledged", createdAt: 2 },
      { uuid: "buy-paid", offerType: "buy", coin: "BAND", amount: 10, receive: 100, rate: 10, state: "paid", createdAt: 3 },
      { uuid: "buy-revision", offerType: "buy", coin: "BAND", amount: 10, receive: 100, rate: 10, state: "revision", createdAt: 4 },
    ],
    alerts: () => [{ id: "a1", type: "operation-applied", message: "Aviso", createdAt: 3, operationUuid: "sell-1", url: "/?view=ops" } as never],
    markets: () => [{ code: "BPA", label: "BPA", currency: "CUP" }, { code: "BAND", label: "Bandec", currency: "CUP" }],
    markPaid: async () => undefined, confirmReceived: async () => undefined, cancel: async () => undefined,
  });
  const operations = service.operations(10);
  assert.deepEqual(operations[0]?.actions, ["paid", "cancel"]);
  assert.deepEqual(operations[1]?.actions, ["received", "cancel"]);
  assert.deepEqual(operations[2]?.actions, ["received"]);
  assert.deepEqual(operations[3]?.actions, []);
  assert.deepEqual(service.alerts(), [{ id: "a1", type: "operation-applied", message: "Aviso", createdAt: 3, operationUuid: "sell-1" }]);
});
