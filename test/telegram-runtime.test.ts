import assert from "node:assert/strict";
import test from "node:test";
import {
  answerCallbackSafely,
  splitCallbackData,
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
