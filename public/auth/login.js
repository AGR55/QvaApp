const form = document.querySelector("#login-form");
const status = document.querySelector("#login-status");
const button = form.querySelector("button");

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  button.disabled = true;
  button.textContent = "Verificando…";
  status.textContent = "";
  try {
    const response = await fetch("/api/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: form.elements.password.value }),
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "No se pudo iniciar sesión.");
    form.reset();
    window.location.reload();
  } catch (error) {
    status.textContent = error instanceof Error ? error.message : "No se pudo conectar.";
    button.disabled = false;
    button.textContent = "Entrar de forma segura";
  }
});
