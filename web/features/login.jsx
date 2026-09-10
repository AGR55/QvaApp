import React, { useState } from "react";
import { LockKeyhole } from "lucide-react";
import { requestJson, setCsrfToken } from "../lib/http.js";
import { Button, Field, Input } from "../components/ui.jsx";

export function Login({ onAuthenticated }) {
  const [password, setPassword] = useState("");
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async (event) => {
    event.preventDefault();
    setBusy(true);
    setStatus("Verificando…");
    try {
      const payload = await requestJson("/api/session", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password }),
      });
      setCsrfToken(payload.data.csrfToken);
      setPassword("");
      onAuthenticated(payload.data);
    } catch (error) {
      setStatus(
        error instanceof Error ? error.message : "No se pudo iniciar sesión.",
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <main className="login-shell">
      <section className="login-card" aria-labelledby="login-title">
        <span className="mark">Q</span>
        <h1 id="login-title">Mesa de operaciones</h1>
        <p>
          Introduce la contraseña administrativa. La sesión expira
          automáticamente.
        </p>
        <form onSubmit={submit}>
          <Field label="Contraseña" htmlFor="dashboard-password">
            <div className="password-field">
              <LockKeyhole aria-hidden="true" />
              <Input
                id="dashboard-password"
                type="password"
                autoComplete="current-password"
                minLength="14"
                required
                autoFocus
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
            </div>
          </Field>
          <Button variant="primary" disabled={busy} type="submit">
            {busy ? "Verificando…" : "Entrar de forma segura"}
          </Button>
          <p className="detail" role="status" aria-live="polite">
            {status}
          </p>
        </form>
      </section>
    </main>
  );
}
