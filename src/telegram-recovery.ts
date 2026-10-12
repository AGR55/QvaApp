import { randomUUID } from "node:crypto";
import { Bot, Context, InlineKeyboard } from "grammy";
import { SelfServiceRecovery, type ManualRecoveryOutcome } from "./self-service-recovery.js";
import { answerCallbackSafely } from "./telegram-runtime.js";

type Draft = { token: string; intentId: string; expectedUpdatedAt: number; stage: "outcome" | "reason" | "evidence" | "confirm";
  expiresAt: number; outcome?: ManualRecoveryOutcome; reason?: string; evidence?: string; evidenceOnly: boolean };
const labels: Record<ManualRecoveryOutcome, string> = {
  not_applied: "No se aplicó", cancelled: "Está cancelada", terminal_reviewed: "Terminó sin obligaciones pendientes",
};
const escape = (value: string) => value.replace(/[&<>]/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[char]!);

/** Uses the same recovery service and version checks as the web adapter. */
export function installTelegramRecovery(bot: Bot, recovery: SelfServiceRecovery): void {
  const drafts = new Map<number, Draft>();
  const render = async (ctx: Context, text: string, keyboard = new InlineKeyboard().text("‹ Conciliaciones", "recovery:list")) => {
    if (ctx.callbackQuery) {
      try { await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: keyboard }); return; }
      catch { /* Old or unchanged message: send the current view. */ }
    }
    await ctx.reply(text, { parse_mode: "HTML", reply_markup: keyboard });
  };
  const list = async (ctx: Context, page = 0) => {
    const all = recovery.list().items;
    const items = all.slice(page * 6, page * 6 + 6);
    const keyboard = new InlineKeyboard();
    for (const [index, item] of items.entries()) keyboard.text(`🔎 Ver #${page * 6 + index + 1}`, `recovery:view:${item.intentId}`).row();
    if (page > 0) keyboard.text("‹ Anterior", `recovery:list:${page - 1}`);
    if (all.length > (page + 1) * 6) keyboard.text("Siguiente ›", `recovery:list:${page + 1}`);
    keyboard.row().text("‹ Panel", "panel:home");
    await render(ctx, ["<b>🔎 Conciliaciones</b>", "Las demás cacerías continúan mientras se comprueban estas operaciones.",
      items.length ? items.map((item, i) => `<b>${page * 6 + i + 1}. ${escape(item.kind)}</b> · ${item.acknowledged ? "aviso reconocido" : "pendiente"}\n🆔 <code>${escape(item.operationUuid ?? item.intentId)}</code>`).join("\n\n") : "✅ No hay conciliaciones pendientes."].join("\n\n"), keyboard);
  };
  const view = async (ctx: Context, id: string, notice = "") => {
    const item = recovery.list().items.find(entry => entry.intentId === id);
    if (!item) { await render(ctx, "<b>✅ Conciliación cerrada</b>\n\nEsta intención ya no está pendiente."); return; }
    const keyboard = new InlineKeyboard().text("🔄 Comprobar", `recovery:check:${id}`).row()
      .text("📝 Registrar evidencia", `recovery:evidence:${id}`).row();
    if (item.manualEligible) keyboard.text("✅ Resolver con evidencia", `recovery:resolve:${id}`).row();
    if (!item.acknowledged) keyboard.text("🔕 Reconocer aviso", `recovery:ack:${id}`).row();
    keyboard.text("‹ Conciliaciones", "recovery:list");
    await render(ctx, ["<b>🔎 Conciliar operación</b>", `🆔 <code>${escape(item.operationUuid ?? id)}</code>\nAcción: <b>${escape(item.kind)}</b>`,
      item.error ? `⚠️ ${escape(item.error.slice(0, 500))}` : "",
      item.manualBlockedReason ? escape(item.manualBlockedReason) : "Puedes registrar el resultado de tu revisión en QvaPay.",
      item.evidence.length ? `<b>📝 Última evidencia</b>\n${escape(item.evidence.at(-1)!.text)}` : "",
      notice ? `📌 ${escape(notice)}` : ""].filter(Boolean).join("\n\n"), keyboard);
  };
  const prompt = (ctx: Context, text: string) => ctx.reply(`${text}\n\nUsa /cancel para salir.`, { parse_mode: "HTML", reply_markup: { force_reply: true } });
  bot.command("recovery", ctx => list(ctx));
  bot.use(async (ctx, next) => {
    if (!ctx.chat) return next();
    const draft = drafts.get(ctx.chat.id);
    if (!draft) return next();
    if (draft.expiresAt <= Date.now()) { drafts.delete(ctx.chat.id); return next(); }
    const text = ctx.msg?.text;
    if (text?.startsWith("/") || (ctx.callbackQuery?.data && !ctx.callbackQuery.data.startsWith("recovery:"))) {
      drafts.delete(ctx.chat.id);
      if (text?.trim() === "/cancel") { await ctx.reply("✖ Edición de conciliación cancelada."); return; }
      return next();
    }
    if (!text || !["reason", "evidence"].includes(draft.stage)) return next();
    try {
      const value = text.trim();
      if (value.length < 12 || value.length > (draft.stage === "reason" ? 500 : 1000))
        throw new Error(`Escribe entre 12 y ${draft.stage === "reason" ? 500 : 1000} caracteres.`);
      if (draft.stage === "reason") {
        draft.reason = value; draft.stage = "evidence";
        await prompt(ctx, "<b>📝 Evidencia revisada</b>\n\nDescribe el estado y los identificadores que comprobaste en QvaPay.");
      } else if (draft.evidenceOnly) {
        recovery.recordEvidence(draft.intentId, value); drafts.delete(ctx.chat.id);
        await view(ctx, draft.intentId, "Evidencia guardada. La comprobación sigue pendiente.");
      } else {
        draft.evidence = value; draft.stage = "confirm";
        await render(ctx, `<b>✅ Confirmar conciliación manual</b>\n\nResultado: <b>${escape(labels[draft.outcome!])}</b>\n\n${escape(draft.reason!)}\n\n📝 ${escape(value)}\n\nConfirma que verificaste QvaPay y que no tienes obligaciones pendientes.`,
          new InlineKeyboard().text("✅ Confirmo mi revisión", `recovery:confirm:${draft.token}`).row().text("✖ Cancelar", "recovery:list"));
      }
    } catch (error) { await prompt(ctx, `<b>⚠️ No se pudo registrar</b>\n\n${escape(error instanceof Error ? error.message : String(error))}`); }
  });
  bot.callbackQuery(/^recovery:/, async ctx => {
    await answerCallbackSafely(() => ctx.answerCallbackQuery());
    const [, action, id = ""] = ctx.callbackQuery.data.split(":");
    try {
      if (action === "list") { drafts.delete(ctx.chat!.id); return await list(ctx, Math.max(0, Number(id) || 0)); }
      if (action === "view") return await view(ctx, id);
      if (action === "check") { const result = await recovery.check(id); return await view(ctx, id, result.message); }
      if (action === "ack") { recovery.acknowledge(id); return await view(ctx, id, "Aviso reconocido; la conciliación continúa."); }
      if (action === "evidence" || action === "resolve") {
        const item = recovery.list().items.find(entry => entry.intentId === id);
        if (!item) return await list(ctx);
        if (action === "resolve" && !item.manualEligible) throw new Error(item.manualBlockedReason);
        drafts.set(ctx.chat!.id, { token: randomUUID().slice(0, 8), intentId: id, expectedUpdatedAt: item.updatedAt, expiresAt: Date.now() + 600_000,
          stage: action === "evidence" ? "evidence" : "outcome", evidenceOnly: action === "evidence" });
        if (action === "evidence") return void await prompt(ctx, "<b>📝 Registrar evidencia</b>\n\nDescribe lo que comprobaste en QvaPay. Se guardará sin declarar resuelta la operación.");
        const keyboard = new InlineKeyboard();
        item.manualOutcomes.forEach((outcome, index) => keyboard.text(labels[outcome], `recovery:outcome:${index}`).row());
        return await render(ctx, "<b>🔎 Resultado de tu revisión</b>\n\nSelecciona lo que verificaste en QvaPay.", keyboard);
      }
      const draft = drafts.get(ctx.chat!.id);
      if (!draft || draft.expiresAt <= Date.now()) throw new Error("La edición caducó. Abre /recovery para empezar de nuevo.");
      if (action === "outcome" && draft.stage === "outcome") {
        const outcome = recovery.list().items.find(item => item.intentId === draft.intentId)?.manualOutcomes[Number(id)];
        if (!outcome) throw new Error("El resultado ya no está disponible.");
        draft.outcome = outcome; draft.stage = "reason";
        return void await prompt(ctx, "<b>📝 Motivo de la resolución</b>\n\nExplica por qué corresponde ese resultado.");
      }
      if (action === "confirm" && draft.stage === "confirm" && id === draft.token) {
        recovery.resolveManual({ intentId: draft.intentId, expectedUpdatedAt: draft.expectedUpdatedAt, outcome: draft.outcome!, reason: draft.reason!, evidence: draft.evidence!, confirmed: true });
        drafts.delete(ctx.chat!.id);
        return await view(ctx, draft.intentId);
      }
    } catch (error) { await render(ctx, `<b>⚠️ Acción no completada</b>\n\n${escape(error instanceof Error ? error.message : String(error))}`); }
  });
}
