import React, { useState } from "react";
import { RadioTower, RefreshCw, ShieldAlert, UsersRound, Wifi, WifiOff } from "lucide-react";
import { Panel, ViewHead } from "../components/common.jsx";
import { Badge, Button, Input } from "../components/ui.jsx";
import {
  Card,
  CardAction,
  CardContent,
  CardHeader,
  CardTitle,
} from "../components/ui/card.tsx";
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
  const reconcile = async () => {
    setBusy("reconcile");
    setNotice("");
    try {
      await requestJson("/api/cooperative-network/reconcile", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      setNotice("Red reconciliada con Sync Core.");
      await onChanged();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "No se pudo reconciliar la red.");
    } finally {
      setBusy("");
    }
  };

  return (
    <div className="view-stack cooperative-network-view">
      <ViewHead
        title="Red cooperativa"
        meta={(
          <Button type="button" variant="outline" disabled={!network.enabled || busy === "reconcile"} onClick={() => void reconcile()}>
            <RefreshCw aria-hidden="true" /> Actualizar red
          </Button>
        )}
      />

      <div className="network-status-row" role="status" aria-live="polite">
        <ConnectionPill connected={network.httpConnected} label="HTTP" />
        <ConnectionPill connected={network.natsConnected} label="NATS" />
        <span className="freshness">
          {network.lastNatsAt || network.lastHttpAt
            ? `Snapshot · ${new Date(network.lastNatsAt || network.lastHttpAt).toLocaleString("es-CU")}`
            : "Sin snapshot"}
        </span>
      </div>

      {!network.enabled ? (
        <Panel title="Sincronización">
          <div className="network-callout">
            <WifiOff aria-hidden="true" />
            <p>Configura <code>SYNC_*</code> para conectar Sync Core.</p>
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
        wide
      >
        <div className="network-aggregate-grid">
          {aggregates.length ? aggregates.map((item) => (
            <Card className="network-aggregate" key={item.coin} size="sm">
              <CardHeader>
                <CardTitle>{label(item.coin)}</CardTitle>
                <CardAction>
                  <Badge variant="neutral">
                    <UsersRound aria-hidden="true" /> {item.offersCount} bots
                  </Badge>
                </CardAction>
              </CardHeader>
              <CardContent className="network-aggregate-content">
                <strong>{money(item.fiat)} {unit(item.coin)}</strong>
              </CardContent>
            </Card>
          )) : (
            <div className="network-callout">
              <RadioTower aria-hidden="true" />
              <p>Todavía no hay capacidad global guardada.</p>
            </div>
          )}
        </div>
      </Panel>

      <Panel
        title="Aportaciones"
        wide
      >
        {notice ? <p className="network-notice" role="status">{notice}</p> : null}
        <div className="network-contribution-table-wrap">
          <table className="network-contribution-table">
            <caption className="sr-only">Aportaciones por mercado a la red cooperativa</caption>
            <thead>
              <tr>
                <th scope="col">Mercado</th>
                <th scope="col">Estado</th>
                <th scope="col">Fiat disponible</th>
                <th scope="col">Mínimo</th>
                <th scope="col">Precio objetivo</th>
                <th scope="col">Acciones</th>
              </tr>
            </thead>
            <tbody>
              {data.markets.map((market) => {
                const draft = draftFor(market);
                const current = network.contributions?.[market.code];
                const formId = `network-contribution-${market.code}`;
                const state = current?.state === "confirmed" ? "confirmed" : current ? "pending" : "draft";
                const status = state === "confirmed" ? "Confirmada" : state === "pending" ? "Pendiente" : "Sin publicar";
                return (
                  <tr className={`network-contribution-row is-${state}`} key={market.code}>
                    <td data-label="Mercado" className="network-market-cell">
                      <form id={formId} onSubmit={(event) => { event.preventDefault(); void publish(market); }} />
                      <strong>{market.label}</strong>
                      <small>{market.currency}</small>
                    </td>
                    <td data-label="Estado">
                      <Badge variant="neutral">{status}</Badge>
                    </td>
                    <td data-label={`Fiat (${market.currency})`}>
                      <Input form={formId} id={`${market.code}-fiat`} name="fiat" type="number" min="0.01" step="0.01" inputMode="decimal" autoComplete="off" required aria-label={`Fiat disponible en ${market.currency} para ${market.label}`} value={draft.fiat} onChange={(event) => updateDraft(market.code, "fiat", event.target.value)} />
                    </td>
                    <td data-label="Mínimo">
                      <Input form={formId} id={`${market.code}-minimal`} name="minimal" type="number" min="0.01" step="0.01" inputMode="decimal" autoComplete="off" required aria-label={`Mínimo para ${market.label}`} value={draft.minimal} onChange={(event) => updateDraft(market.code, "minimal", event.target.value)} />
                    </td>
                    <td data-label="Precio objetivo">
                      <Input form={formId} id={`${market.code}-price`} name="price" type="number" min="0.0001" step="any" inputMode="decimal" autoComplete="off" required aria-label={`Precio objetivo para ${market.label}`} value={draft.price} onChange={(event) => updateDraft(market.code, "price", event.target.value)} />
                    </td>
                    <td data-label="Acciones" className="network-actions">
                      <Button form={formId} type="submit" variant="primary" disabled={!network.enabled || busy === market.code}>
                        {current ? "Actualizar" : "Publicar"}
                      </Button>
                      {current ? (
                        <Button type="button" variant="outline" disabled={busy === market.code} onClick={() => void withdraw(market)}>
                          Retirar
                        </Button>
                      ) : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
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
