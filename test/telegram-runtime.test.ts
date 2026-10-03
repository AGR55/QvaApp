import assert from "node:assert/strict";
import test from "node:test";
import {
  answerCallbackSafely,
  isMessageNotModified,
  splitCallbackData,
  TelegramRenderGuard,
} from "../src/telegram-runtime.js";

test("un callback expirado no derriba el proceso", async () => {
  await assert.doesNotReject(() =>
    answerCallbackSafely(async () => {
      throw new Error(
        "Call to 'answerCallbackQuery' failed! (400: Bad Request: query is too old and response timeout expired)",
      );
    }),
  );
});

test("un callback válido se responde una única vez", async () => {
  let calls = 0;
  const answered = await answerCallbackSafely(async () => {
    calls += 1;
  });
  assert.equal(answered, true);
  assert.equal(calls, 1);
});

test("conserva valores de callback que contienen dos puntos", () => {
  assert.deepEqual(splitCallbackData("panel:market:BANDECPREPAGO"), [
    "panel",
    "market:BANDECPREPAGO",
  ]);
});

test("una interacción posterior invalida las ediciones progresivas anteriores", () => {
  const guard = new TelegramRenderGuard();
  const first = guard.begin("admin-chat");
  assert.equal(guard.isCurrent("admin-chat", first), true);
  guard.begin("admin-chat");
  assert.equal(guard.isCurrent("admin-chat", first), false);
});

test("reconoce la respuesta Telegram de texto sin cambios para no duplicar el mensaje", () => {
  assert.equal(isMessageNotModified(new Error("Bad Request: message is not modified")), true);
  assert.equal(isMessageNotModified(new Error("network error")), false);
});
