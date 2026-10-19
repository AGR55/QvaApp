import React, { useState } from "react";
import { Brand } from "../components/brand.jsx";
import { LockKeyhole } from "lucide-react";
import { requestJson, setCsrfToken } from "../lib/http.js";
import { Button, Field, Input } from "../components/ui.jsx";
import { FieldGroup } from "../components/ui/field.tsx";

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
      <section className="login-panel" aria-labelledby="login-title">
        <div className="login-panel-inner">
          <div className="login-brand-lockup">
            <Brand />
          </div>
          <div className="login-heading">
            <h1 id="login-title">Mesa de operaciones</h1>
            <p>Todo el control de tus mercados, en un solo lugar.</p>
          </div>
          <form onSubmit={submit}>
            <FieldGroup className="login-form-fields">
            <Field
              label="Contraseña administrativa"
              htmlFor="dashboard-password"
            >
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
                  placeholder="Introduce tu contraseña"
                />
              </div>
            </Field>
            <Button variant="primary" disabled={busy} type="submit">
              {busy ? "Verificando…" : "Entrar de forma segura"}
            </Button>
            <p className="detail" role="status" aria-live="polite">
              {status}
            </p>
            </FieldGroup>
          </form>
        </div>
      </section>
    </main>
  );
}
