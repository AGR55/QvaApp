let csrfToken = "";

export function setCsrfToken(value) {
  csrfToken = value || "";
}

export async function requestJson(url, options = {}) {
  const { timeoutMs = 15_000, ...fetchOptions } = options;
  const method = (options.method || "GET").toUpperCase();
  const headers = new Headers(options.headers || {});
  if (!["GET", "HEAD"].includes(method) && csrfToken)
    headers.set("x-csrf-token", csrfToken);
  const controller = new AbortController();
  const forwardAbort = () => controller.abort();
  fetchOptions.signal?.addEventListener("abort", forwardAbort, { once: true });
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      ...fetchOptions,
      headers,
      signal: controller.signal,
    });
    const payload = response.status === 204 ? undefined : await response.json();
    if (!response.ok) {
      const error = new Error(payload?.error || `Solicitud fallida (${response.status})`);
      error.status = response.status;
      throw error;
    }
    return payload;
  } catch (error) {
    if (error?.name === "AbortError")
      throw new Error("La conexión tardó demasiado; se conservan los datos guardados.");
    if (error instanceof TypeError)
      throw new Error("No se pudo conectar; se conservan los datos guardados.");
    throw error;
  } finally {
    window.clearTimeout(timer);
    fetchOptions.signal?.removeEventListener("abort", forwardAbort);
  }
}
