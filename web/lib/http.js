let csrfToken = "";

export function setCsrfToken(value) {
  csrfToken = value || "";
}

export async function requestJson(url, options = {}) {
  const method = (options.method || "GET").toUpperCase();
  const headers = new Headers(options.headers || {});
  if (!["GET", "HEAD"].includes(method) && csrfToken)
    headers.set("x-csrf-token", csrfToken);
  const response = await fetch(url, { ...options, headers });
  const payload = response.status === 204 ? undefined : await response.json();
  if (!response.ok) {
    const error = new Error(payload?.error || `Solicitud fallida (${response.status})`);
    error.status = response.status;
    throw error;
  }
  return payload;
}
