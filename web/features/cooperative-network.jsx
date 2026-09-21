import React, { useState } from "react";
import { RadioTower, ShieldAlert, UsersRound, Wifi, WifiOff } from "lucide-react";
import { Panel, ViewHead } from "../components/common.jsx";
import { Button } from "../components/ui.jsx";
import { requestJson } from "../lib/http.js";
import { money } from "../lib/format.js";

export function CooperativeNetwork({ data, label, unit, onChanged }) {
  const network = data.cooperativeNetwork || disabledState;
  const [drafts, setDrafts] = useState({});
  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState("");
  const aggregates = Object.values(network.snapshot || {}).sort((a, b) =>
    a.coin.localeCompare(b.coin),
  );

  const draftFor = (market) => {
    const current = network.contributions?.[market.code];
    return drafts[market.code] || {
      fiat: current?.fiat ?? "",
      minimal: current?.minimal ?? "",
      price: current?.price ?? "",
    };
  };
  const updateDraft = (coin, field, value) =>
    setDrafts((current) => {
      const base = current[coin] || network.contributions?.[coin] || {
        fiat: "",
        minimal: "",
        price: "",
      };
      return { ...current, [coin]: { ...base, [field]: value } };
    });
  const publish = async (market) => {
    const draft = draftFor(market);
    setBusy(market.code);
    setNotice("");
    try {
      await requestJson("/api/cooperative-network/contributions", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          coin: market.code,
          fiat: Number(draft.fiat),
          minimal: Number(draft.minimal),
          price: Number(draft.price),
        }),
      });
      setNotice(`Aportación de ${label(market.code)} enviada a la red.`);
      await onChanged();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "No se pudo publicar la aportación.");
    } finally {
      setBusy("");
    }
  };
  const withdraw = async (market) => {
    setBusy(market.code);
    setNotice("");
    try {
      await requestJson(
        `/api/cooperative-network/contributions/${encodeURIComponent(market.code)}`,
        {
          method: "DELETE",
          headers: { "content-type": "application/json" },
          body: "{}",
        },
      );
      setNotice(`Aportación de ${label(market.code)} retirada.`);
      await onChanged();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "No se pudo retirar la aportación.");
    } finally {
      setBusy("");
    }
  };

  return (
    <div className="view-stack cooperative-network-view">
      <ViewHead
        kicker="Coordinación entre bots"
        title="Red cooperativa"
        description="Capacidad fiat compartida en tiempo real mediante NATS. La ejecución conjunta permanece bloqueada hasta que el servidor garantice idempotencia y transacciones."
        meta={
          <div className="network-status-row" role="status" aria-live="polite">
            <ConnectionPill connected={network.httpConnected} label="HTTP" />
            <ConnectionPill connected={network.natsConnected} label="NATS" />
            <span className="freshness">
              {network.lastNatsAt || network.lastHttpAt
                ? `Último snapshot · ${new Date(network.lastNatsAt || network.lastHttpAt).toLocaleString("es-CU")}`
                : "Sin snapshot recibido"}
            </span>
          </div>
        }
      />

      {!network.enabled ? (
        <Panel title="Integración desactivada" kicker="Configuración">
          <div className="network-callout">
            <WifiOff aria-hidden="true" />
            <p>Configura las variables <code>SYNC_*</code> y activa <code>SYNC_ENABLED=true</code> para conectar esta VPS.</p>
          </div>
        </Panel>
      ) : null}

      {network.lastError ? (
        <div className="network-error" role="alert">
          <ShieldAlert aria-hidden="true" />
          <span>{network.lastError}</span>
        </div>
      ) : null}

      <Panel
        title="Liquidez global"
        kicker="Snapshot sincronizado"
        description="Suma aportada por todos los bots para cada moneda."
        wide
      >
        <div className="network-aggregate-grid">
          {aggregates.length ? aggregates.map((item) => (
            <article className="network-aggregate" key={item.coin}>
              <div className="network-aggregate-head">
                <span>{label(item.coin)}</span>
                <UsersRound aria-hidden="true" />
              </div>
              <strong>{money(item.fiat)} {unit(item.coin)}</strong>
              <dl>
                <div><dt>Bots</dt><dd>{item.offersCount}</dd></div>
                <div><dt>Precio medio</dt><dd>{money(item.price)}</dd></div>
                <div><dt>Mínimo medio</dt><dd>{money(item.minimal)}</dd></div>
              </dl>
            </article>
          )) : (
            <div className="network-callout">
              <RadioTower aria-hidden="true" />
              <p>Todavía no hay capacidad global guardada.</p>
            </div>
          )}
        </div>
      </Panel>

      <Panel
        title="Nuestra aportación"
        kicker="Capital disponible"
        description="Publica cuánto fiat puede aportar este bot a una cacería compartida."
        wide
      >
        {notice ? <p className="network-notice" role="status">{notice}</p> : null}
        <div className="network-contribution-grid">
          {data.markets.map((market) => {
            const draft = draftFor(market);
            const current = network.contributions?.[market.code];
            return (
              <form
                className="network-contribution"
                key={market.code}
                onSubmit={(event) => {
                  event.preventDefault();
                  void publish(market);
                }}
              >
                <header>
                  <div>
                    <strong>{market.label}</strong>
                    <span>{current ? (current.state === "confirmed" ? "Confirmada" : "Pendiente") : "Sin publicar"}</span>
                  </div>
                </header>
                <label>
                  Fiat aportado ({market.currency})
                  <input type="number" min="0.01" step="0.01" required value={draft.fiat} onChange={(event) => updateDraft(market.code, "fiat", event.target.value)} />
                </label>
                <label>
                  Mínimo por operación
                  <input type="number" min="0.01" step="0.01" required value={draft.minimal} onChange={(event) => updateDraft(market.code, "minimal", event.target.value)} />
                </label>
                <label>
                  Precio objetivo
                  <input type="number" min="0.0001" step="any" required value={draft.price} onChange={(event) => updateDraft(market.code, "price", event.target.value)} />
                </label>
                <div className="network-actions">
                  <Button type="submit" variant="primary" disabled={!network.enabled || busy === market.code}>
                    {current ? "Actualizar" : "Publicar"}
                  </Button>
                  {current ? (
                    <Button type="button" variant="ghost" disabled={busy === market.code} onClick={() => void withdraw(market)}>
                      Retirar
                    </Button>
                  ) : null}
                </div>
              </form>
            );
          })}
        </div>
      </Panel>
    </div>
  );
}

function ConnectionPill({ connected, label }) {
  return (
    <span className={`network-pill ${connected ? "connected" : "offline"}`}>
      {connected ? <Wifi aria-hidden="true" /> : <WifiOff aria-hidden="true" />}
      {label} · {connected ? "conectado" : "sin conexión"}
    </span>
  );
}

const disabledState = {
  enabled: false,
  httpConnected: false,
  natsConnected: false,
  snapshot: {},
  contributions: {},
  lastHttpAt: null,
  lastNatsAt: null,
  lastError: null,
};
