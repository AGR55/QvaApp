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
import { AlertDialog, AlertDialogContent, AlertDialogHeader, AlertDialogTitle, AlertDialogDescription, AlertDialogFooter, AlertDialogCancel } from "../components/ui/alert-dialog.tsx";

export function CooperativeNetwork({ data, label, unit, onChanged }) {
  const network = data.cooperativeNetwork || disabledState;
  const [drafts, setDrafts] = useState({});
  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState("");
  const [distribution, setDistribution] = useState(null);
  const hunting = data.cooperativeHunting ?? { enabled: false, executions: [], qusdOwed: 0 };
  const cooperativeAction = async (path, body = {}, method = "POST") => {
    setBusy("hunting"); setNotice("");
    try {
      await requestJson(path, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      setDistribution(null); setNotice("Acción cooperativa guardada."); await onChanged();
    } catch (error) { setNotice(error instanceof Error ? error.message : "La acción falló."); }
    finally { setBusy(""); }
  };
  const aggregates = Object.values(network.snapshot || {}).sort((a, b) =>
    a.coin.localeCompare(b.coin),
  );

  const draftFor = (market) => {
    const current = network.contributions?.[market.code];
    return drafts[market.code] || {
      minimal: current?.minimal ?? "",
      price: current?.price ?? "",
    };
  };
  const updateDraft = (coin, field, value) =>
    setDrafts((current) => {
      const base = current[coin] || network.contributions?.[coin] || {
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
      {notice ? <p className="network-notice" role="status">{notice}</p> : null}

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

      <Panel title="Cacería cooperativa · segunda prioridad" wide>
        <div className="flex flex-wrap items-center gap-3">
          <Badge variant={hunting.enabled ? "success" : "neutral"}>{hunting.enabled ? "Activa" : "Detenida"}</Badge>
          <Button variant="outline" disabled={!network.enabled || Boolean(busy)} onClick={() => cooperativeAction("/api/cooperative-network/hunting", { enabled: !hunting.enabled }, "PUT")}>
            {hunting.enabled ? "Detener cacería conjunta" : "Activar cacería conjunta"}
          </Button>
          <Button variant="outline" disabled={Boolean(busy)} onClick={() => cooperativeAction("/api/cooperative-network/executions/check")}>Comprobar pendientes</Button>
        </div>
        <p className="network-capacity-hint">Tus operaciones tienen prioridad. La cacería conjunta usa el fiat elegible del grupo y conserva un intento disponible para la cacería propia.</p>
        <p className="network-capacity-hint">QUSD pendientes de repartir: {money(hunting.qusdOwed)}. El bot conserva esta cantidad hasta que declares terminado el reparto manual.</p>
        <div className="flex flex-col gap-3">{hunting.executions.filter(job => !["released", "settled"].includes(job.phase)).map(job => <Card key={job.offer.uuid} size="sm">
          <CardHeader><CardTitle>{label(job.offer.coin)} · {money(job.offer.amount)} QUSD</CardTitle><CardAction><Badge variant="neutral">{({ completed: "Por repartir", cancelled: "Cancelada · revisar", committed: "Esperando pagos", commit_pending: "Confirmación pendiente", uncertain: "Revisar", applying: "Aplicando", reserving: "Reservando", release_pending: "Liberación pendiente", reserved: "Reservada", applied: "Aplicada" })[job.phase] ?? job.phase}</Badge></CardAction></CardHeader>
          <CardContent className="flex flex-col gap-3"><p>Total: {money(job.offer.receive)} {unit(job.offer.coin)} · Tu parte: {money(job.reservation?.ownerFiat ?? 0)} {unit(job.offer.coin)}.</p>
            {job.error ? <p role="status">{job.error}</p> : null}
            <a href={`/?view=operaciones&operation=${encodeURIComponent(job.offer.uuid)}`}>Abrir operación</a>
            {job.phase === "completed" ? <Button variant="outline" disabled={Boolean(busy)} onClick={() => setDistribution(job)}>Ya repartí los QUSD</Button> : null}
          </CardContent>
        </Card>)}</div>
      </Panel>
      <AlertDialog open={Boolean(distribution)} onOpenChange={open => { if (!open) setDistribution(null); }}>
        <AlertDialogContent><AlertDialogHeader><AlertDialogTitle>Confirmar reparto manual</AlertDialogTitle><AlertDialogDescription>Confirma que transferiste todos los QUSD correspondientes a los participantes de esta cacería. La cantidad se liberará para tus operaciones propias.</AlertDialogDescription></AlertDialogHeader>
          <AlertDialogFooter><AlertDialogCancel>Volver</AlertDialogCancel><Button disabled={Boolean(busy)} onClick={() => cooperativeAction(`/api/cooperative-network/executions/${encodeURIComponent(distribution.offer.uuid)}/distributed`, { confirmed: true })}>Confirmo que repartí todo</Button></AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

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
        <p className="network-capacity-hint">El aporte usa el saldo fiat del mercado. Se actualiza automáticamente y se retira si queda por debajo de 5 QUSD al precio indicado.</p>
        <div className="network-contribution-table-wrap">
          <table className="network-contribution-table">
            <caption className="sr-only">Aportaciones por mercado a la red cooperativa</caption>
            <thead>
              <tr>
                <th scope="col">Mercado</th>
                <th scope="col">Estado</th>
                <th scope="col">Fiat aportado</th>
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
                    <td data-label={`Fiat aportado (${market.currency})`}>
                      <strong>{money(current?.fiat ?? market.fiatBalance)} {market.currency}</strong>
                      {current && Math.abs(current.fiat - market.fiatBalance) > 0.01 ? <small className="network-local-balance">Saldo local: {money(market.fiatBalance)} {market.currency}</small> : null}
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
