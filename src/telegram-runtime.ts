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
