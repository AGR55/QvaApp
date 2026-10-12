import type { DurableNotification, Operation } from "./store.js";

const SESSION_MS = 10 * 60_000;

function telegramEscape(value: string): string {
  return value.replace(/[&<>\"]/g, character => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;",
  })[character]!);
}

function number(value: number): string {
  return new Intl.NumberFormat("es-CU", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value);
}

export function canMarkPaid(operation: Operation | undefined): boolean {
  return operation?.offerType === "sell" && ["applied", "acknowledged"].includes(operation.state);
}

export function canCancelOperation(operation: Operation | undefined): boolean {
  return Boolean(operation && ["applied", "acknowledged"].includes(operation.state));
}

export function operationNotificationText(
  notification: DurableNotification,
  operation: Operation | undefined,
  marketLabel: (coin: string) => string,
  marketCurrency: (coin: string) => string,
): string {
  if (notification.message.startsWith("<b>🤝 Cacería conjunta")) return notification.message;
  if (notification.kind === "own-offer-applied") {
    const coin = String(notification.payload.coin ?? "");
    const amount = Number(notification.payload.amount);
    return [
      "<b>🔔 Alguien tomó tu oferta P2P</b>",
      [
        `🪙 Mercado: <b>${telegramEscape(marketLabel(coin))}</b>`,
        Number.isFinite(amount) ? `💰 Importe: <b>${number(amount)} QUSD</b>` : "",
        notification.operationUuid ? `🆔 Oferta: <code>${telegramEscape(notification.operationUuid)}</code>` : "",
      ].filter(Boolean).join("\n"),
      "👉 Abre Operaciones para ver el estado y el siguiente paso.",
      operationLink(notification.operationUuid),
    ].filter(Boolean).join("\n\n");
  }
  if (!operation) return telegramEscape(notification.message);
  const paying = operation.offerType === "sell";
  const title = operation.state === "completed" ? "✅ Operación completada"
    : operation.state === "cancelled" ? "✖ Operación cancelada"
      : operation.state === "paid" ? "✅ Pago registrado"
        : paying ? "💸 Compra de QUSD aplicada" : "🪙 Venta de QUSD aplicada";
  const next = operation.state === "completed" || operation.state === "cancelled"
    ? "No hay acciones pendientes."
    : operation.state === "paid" ? "⏳ Espera la confirmación de la contraparte."
      : paying
        ? "<b>👉 Siguiente paso</b>\nEnvía el pago fiat a la contraparte. Después pulsa «Registrar pago» y envía el ID de la transacción."
        : "<b>👉 Siguiente paso</b>\nComprueba que recibiste el fiat antes de confirmar la recepción.";
  return [
    `<b>${title}</b>`,
    [
      `🪙 Mercado: <b>${telegramEscape(marketLabel(operation.coin))}</b>`,
      `💰 Importe: <b>${number(operation.amount)} QUSD</b>`,
      `💸 ${paying ? "Debes enviar" : "Debes recibir"}: <b>${number(operation.receive)} ${telegramEscape(marketCurrency(operation.coin))}</b>`,
      operation.counterpartyId ? `👤 Contraparte: <code>${telegramEscape(operation.counterpartyId)}</code>` : "",
      `🆔 Oferta: <code>${telegramEscape(operation.uuid)}</code>`,
      operation.orderUuid ? `🧩 Orden: <code>${telegramEscape(operation.orderUuid)}</code>` : "",
    ].filter(Boolean).join("\n"),
    next,
    operationLink(operation.uuid),
  ].join("\n\n");
}

function operationLink(uuid?: string): string {
  return uuid && /^[0-9a-f-]{36}$/i.test(uuid)
    ? `🔗 <a href="https://www.qvapay.com/p2p/${uuid}">Ver operación en QvaPay</a>`
    : "";
}

export function cooperativeNotificationText(input: {
  uuid: string; amount: number; receive: number; coin: string;
  ownerFiat: number; owedQusd: number;
}): string {
  return [
    "<b>🤝 Cacería conjunta aplicada</b>",
    `🪙 Mercado: <b>${telegramEscape(input.coin)}</b>\n💰 Operación: <b>${number(input.amount)} QUSD</b>\n💸 Pago total: <b>${number(input.receive)} ${telegramEscape(input.coin)}</b>\n👤 Tu aporte: <b>${number(input.ownerFiat)} ${telegramEscape(input.coin)}</b>\n🆔 <code>${telegramEscape(input.uuid)}</code>`,
    "<b>👉 Siguiente paso</b>\nCada participante paga al vendedor. Confirma el pago total cuando todos hayan pagado.",
    `Después reparte <b>${number(input.owedQusd)} QUSD</b> al grupo.`,
    operationLink(input.uuid),
  ].filter(Boolean).join("\n\n");
}

export class PaymentReferenceSessions {
  private readonly pending = new Map<string, { uuid: string; expiresAt: number; messageId?: number }>();

  constructor(private readonly now: () => number = Date.now) {}

  start(chatId: string, uuid: string, messageId?: number): void {
    this.pending.set(chatId, { uuid, expiresAt: this.now() + SESSION_MS, ...(messageId ? { messageId } : {}) });
  }

  current(chatId: string): { uuid: string; messageId?: number } | undefined {
    const session = this.pending.get(chatId);
    if (!session) return undefined;
    if (session.expiresAt <= this.now()) {
      this.pending.delete(chatId);
      return undefined;
    }
    return { uuid: session.uuid, ...(session.messageId ? { messageId: session.messageId } : {}) };
  }

  cancel(chatId: string): void { this.pending.delete(chatId); }
}

export function parseTransactionId(input: string): string {
  const value = input.trim();
  if (!value || value.length > 120 || /[\r\n\t\x00-\x1f]/.test(value))
    throw new Error("Escribe un ID de transacción de hasta 120 caracteres en una sola línea.");
  return value;
}
