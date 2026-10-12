import assert from "node:assert/strict";
import test from "node:test";
import { Bot } from "grammy";
import { installTelegramRecovery } from "../src/telegram-recovery.js";

test("Telegram registra evidencia, reconoce avisos y exige la confirmación de la edición vigente", async () => {
  const calls: unknown[] = [];
  const sent: string[] = [];
  const item = { intentId: "intent", operationUuid: "offer", kind: "apply", updatedAt: 123,
    acknowledged: false, evidence: [], manualEligible: true, manualOutcomes: ["not_applied"] };
  const bot = new Bot("123:test", { botInfo: { id: 123, is_bot: true, first_name: "Test", username: "test_bot",
    can_join_groups: false, can_read_all_group_messages: false, supports_inline_queries: false, can_connect_to_business: false, has_main_web_app: false, has_topics_enabled: false, allows_users_to_create_topics: false, can_manage_bots: false, supports_join_request_queries: false } });
  bot.api.config.use(async (_prev, method, payload) => {
    sent.push(JSON.stringify(payload));
    return { ok: true, result: method === "answerCallbackQuery" ? true : { message_id: 1, date: 1, chat: { id: 1, type: "private" } } } as never;
  });
  installTelegramRecovery(bot, {
    list: () => ({ items: [item] }),
    recordEvidence: (id: string, evidence: string) => calls.push({ id, evidence }),
    acknowledge: (id: string) => calls.push({ acknowledge: id }),
    resolveManual: (input: unknown) => calls.push(input),
  } as never);
  let update = 0;
  const chat = { id: 1, first_name: "Operator", type: "private" as const };
  const from = { id: 1, is_bot: false, first_name: "Operator" };
  const callback = (data: string) => bot.handleUpdate({ update_id: ++update, callback_query: { id: String(update), from,
    chat_instance: "test", data, message: { message_id: 1, date: 1, chat } } });
  const message = (text: string) => bot.handleUpdate({ update_id: ++update, message: { message_id: update, date: 1, chat, from, text } });
  await callback("recovery:evidence:intent");
  await message("Comprobé la orden en QvaPay.");
  await callback("recovery:ack:intent");
  assert.deepEqual(calls, [{ id: "intent", evidence: "Comprobé la orden en QvaPay." }, { acknowledge: "intent" }]);
  await callback("recovery:resolve:intent");
  await callback("recovery:outcome:0");
  await message("Revisé las operaciones de mi cuenta.");
  await message("No existe aplicación para la oferta.");
  const confirmation = sent.join("\n").match(/recovery:confirm:([a-f0-9]+)/)?.[1];
  assert.ok(confirmation);
  await callback("recovery:confirm:obsolete");
  assert.equal(calls.length, 2);
  await callback(`recovery:confirm:${confirmation}`);
  assert.equal(calls.length, 3);
  assert.equal((calls[2] as unknown as { expectedUpdatedAt: number }).expectedUpdatedAt, 123);
});
