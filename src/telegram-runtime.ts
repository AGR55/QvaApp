/** Responde el callback antes de efectuar I/O lento. Un callback ya expirado no es un error de negocio. */
export async function answerCallbackSafely(
  answer: () => Promise<unknown>,
): Promise<boolean> {
  try {
    await answer();
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (
      message.includes("answerCallbackQuery") ||
      message.includes("query is too old") ||
      message.includes("query ID is invalid")
    )
      return false;
    console.warn("No se pudo responder callback de Telegram:", message);
    return false;
  }
}

export function splitCallbackData(
  data: string,
): [action: string, value: string] {
  const separator = data.indexOf(":");
  return separator < 0
    ? [data, ""]
    : [data.slice(0, separator), data.slice(separator + 1)];
}

/** Invalidates background Telegram edits when a newer interaction arrives. */
export class TelegramRenderGuard {
  private readonly revisions = new Map<string, number>();

  begin(key: string): number {
    const revision = (this.revisions.get(key) ?? 0) + 1;
    this.revisions.set(key, revision);
    return revision;
  }

  isCurrent(key: string, revision: number): boolean {
    return this.revisions.get(key) === revision;
  }
}

export function isMessageNotModified(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /message is not modified/i.test(message);
}
