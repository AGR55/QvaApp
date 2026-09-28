import assert from "node:assert/strict";
import test from "node:test";
import {
  HUNTING_CALLBACK_PREFIX,
  HuntingRateSessions,
  TELEGRAM_COMMANDS,
  decodeHuntingAction,
  encodeHuntingAction,
  parseExactRate,
} from "../src/telegram-menu.js";

test("el menú nativo expone todas las áreas operativas sin comandos repetidos", () => {
  const commands = TELEGRAM_COMMANDS.map((item) => item.command);
  assert.deepEqual(commands, [
    "panel",
    "balance",
    "hunting",
    "network",
    "coop",
    "markets",
    "offers",
    "operations",
    "strategy",
    "automation",
    "scan",
    "logs",
    "help",
  ]);
  assert.equal(new Set(commands).size, commands.length);
  assert.ok(TELEGRAM_COMMANDS.every((item) => item.description.length > 0));
});

test("codifica y valida acciones de cacería dentro del límite de Telegram", () => {
  const actions = [
    { type: "home" } as const,
    { type: "global-toggle", side: "buy" } as const,
    { type: "market", coin: "BANDECPREPAGO" } as const,
    { type: "market-toggle", side: "sell", coin: "BANK_CUP" } as const,
    { type: "rate-edit", side: "buy", coin: "CLASICA" } as const,
    { type: "rate-confirm", token: "ab12cd34" } as const,
    { type: "rate-cancel", token: "ab12cd34" } as const,
  ];
  for (const action of actions) {
    const encoded = encodeHuntingAction(action);
    assert.ok(encoded.startsWith(HUNTING_CALLBACK_PREFIX));
    assert.ok(Buffer.byteLength(encoded) <= 64);
    assert.deepEqual(decodeHuntingAction(encoded), action);
  }
  assert.throws(() => decodeHuntingAction("hunt:market:codigo inválido"));
  assert.throws(() => decodeHuntingAction("otra:accion"));
});

test("acepta tasas exactas positivas con punto o coma decimal", () => {
  assert.equal(parseExactRate("930"), 930);
  assert.equal(parseExactRate(" 1.125 "), 1.125);
  assert.equal(parseExactRate("1,125"), 1.125);
  for (const value of ["", "0", "-1", "1,2,3", "1e3", "Infinity"])
    assert.throws(() => parseExactRate(value), /tasa/i);
});

test("una tasa solo se consume tras confirmar el token vigente", () => {
  let serial = 0;
  const sessions = new HuntingRateSessions(() => `token${++serial}`);
  const waiting = sessions.begin("admin", "BANK_CUP", "buy", 925);
  assert.equal(waiting.stage, "input");

  const confirmation = sessions.propose("admin", "930,5");
  assert.equal(confirmation.stage, "confirm");
  assert.equal(confirmation.proposedRate, 930.5);
  assert.throws(() => sessions.confirm("admin", "token-equivocado"));
  assert.equal(sessions.current("admin")?.stage, "confirm");

  const confirmed = sessions.confirm("admin", waiting.token);
  assert.equal(confirmed.proposedRate, 930.5);
  assert.equal(sessions.current("admin"), undefined);
});

test("cancelar o reiniciar el flujo nunca devuelve una tasa aplicable", () => {
  const sessions = new HuntingRateSessions(() => "token1");
  sessions.begin("admin", "CLASICA", "sell", 1.12);
  assert.equal(sessions.cancel("admin")?.previousRate, 1.12);
  assert.equal(sessions.current("admin"), undefined);
  assert.throws(() => sessions.confirm("admin", "token1"));
});
