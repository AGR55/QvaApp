import assert from "node:assert/strict";
import test from "node:test";
import {
  COOPERATIVE_CALLBACK_PREFIX,
  CooperativeContributionSessions,
  decodeCooperativeAction,
  encodeCooperativeAction,
} from "../src/cooperative-menu.js";

test("codifica todas las acciones cooperativas dentro del límite de Telegram", () => {
  const actions = [
    { type: "home" } as const,
    { type: "refresh" } as const,
    { type: "edit", coin: "BANK_CUP" } as const,
    { type: "withdraw", coin: "BANDECPREPAGO" } as const,
    { type: "withdraw-confirm", coin: "CLASICA" } as const,
    { type: "confirm", token: "token1" } as const,
    { type: "cancel", token: "token1" } as const,
  ];
  for (const action of actions) {
    const encoded = encodeCooperativeAction(action);
    assert.ok(encoded.startsWith(COOPERATIVE_CALLBACK_PREFIX));
    assert.ok(Buffer.byteLength(encoded) <= 64);
    assert.deepEqual(decodeCooperativeAction(encoded), action);
  }
  assert.throws(() => decodeCooperativeAction("coop:e:moneda inválida"));
});

test("el flujo cooperativo recopila precio, mínimo y fiat antes de confirmar", () => {
  const sessions = new CooperativeContributionSessions(() => "token1");
  assert.equal(sessions.begin("admin", "BANK_CUP").stage, "price");
  assert.equal(sessions.accept("admin", "390,5").stage, "minimal");
  assert.equal(sessions.accept("admin", "1000").stage, "fiat");
  assert.equal(sessions.accept("admin", "25000").stage, "confirm");
  assert.throws(() => sessions.confirm("admin", "otro-token"));
  assert.deepEqual(sessions.confirm("admin", "token1"), {
    coin: "BANK_CUP",
    price: 390.5,
    minimal: 1000,
    fiat: 25000,
  });
  assert.equal(sessions.current("admin"), undefined);
});

test("rechaza importes ambiguos y permite cancelar sin publicar", () => {
  const sessions = new CooperativeContributionSessions(() => "token1");
  sessions.begin("admin", "CLASICA");
  for (const value of ["", "0", "-1", "1e3", "1,2,3", "Infinity"])
    assert.throws(() => sessions.accept("admin", value), /importe/i);
  assert.equal(sessions.cancel("admin")?.coin, "CLASICA");
  assert.equal(sessions.current("admin"), undefined);
});
