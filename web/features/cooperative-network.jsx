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

const MIN_COOPERATIVE_QUSD = 5;

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
    return drafts[market.code] ?? {
      minimal: current?.minimal ?? "",
    };
  };
  const updateDraft = (coin, value) =>
    setDrafts((current) => ({ ...current, [coin]: { minimal: value } }));
  const publish = async (market) => {
    const draft = draftFor(market);
    const minimal = Number(draft.minimal);
    if (!Number.isFinite(minimal) || minimal <= 0) {
      setNotice("Escribe la cantidad mínima que quieres comprar en este mercado.");
      return;
    }
    setBusy(market.code);
    setNotice("");
    try {
      await requestJson("/api/cooperative-network/contributions", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ coin: market.code, minimal }),
      });
      setDrafts((current) => {
        const next = { ...current };
        delete next[market.code];
        return next;
      });
      setNotice(`Publicado en ${label(market.code)}: ${money(market.buyMaxRate, 4)} ${market.currency}/QUSD · mínimo ${money(minimal)} QUSD.`);
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
      setNotice(`Retirado de ${label(market.code)}.`);
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
      setNotice("Red sincronizada.");
      await onChanged();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "No se pudo reconciliar la red.");
    } finally {
      setBusy("");
    }
  };

  const markets = data.markets.filter((market) => market.active !== false);
  const published = Object.keys(network.contributions || {}).length;
  const connected = Boolean(network.enabled && network.httpConnected);

  return (
    <div className="view-stack cooperative-network-view">
      <ViewHead
        title="Cacerías conjuntas"
        description="Comparte liquidez con otros bots y publica tu capacidad por mercado."
        meta={(
          <Button type="button" variant="outline" disabled={!network.enabled || busy === "reconcile"} onClick={() => void reconcile()}>
            <RefreshCw aria-hidden="true" /> Reconectar
          </Button>
        )}
      />

      <section className={`network-hero ${connected ? "is-online" : "is-offline"}`} aria-label="Estado del sincronizador">
        <div className="network-hero-signal">
          {connected ? <Wifi aria-hidden="true" /> : <WifiOff aria-hidden="true" />}
          <div>
            <strong>{connected ? "Conectado al sincronizador" : network.enabled ? "Sin conexión con el sincronizador" : "Sincronizador sin configurar"}</strong>
            <p>
              {connected
                ? `${published} ${published === 1 ? "mercado publicado" : "mercados publicados"} en la red cooperativa.`
                : network.lastError || "Revisa SYNC_* o pulsa Reconectar para reintentar."}
            </p>
          </div>
        </div>
        <dl className="network-hero-stats">
          <div>
            <dt>HTTP</dt>
            <dd><ConnectionDot connected={network.httpConnected} /></dd>
          </div>
          <div>
            <dt>NATS</dt>
            <dd>{network.natsConnected ? <ConnectionDot connected /> : <span className="network-optional">Informativo</span>}</dd>
          </div>
          <div>
            <dt>Última respuesta</dt>
            <dd>{network.lastHttpAt ? new Date(network.lastHttpAt).toLocaleTimeString("es-CU", { hour: "2-digit", minute: "2-digit" }) : "—"}</dd>
          </div>
        </dl>
      </section>

      {notice ? <p className="network-notice" role="status">{notice}</p> : null}

      {!network.enabled ? (
        <Panel title="Conexión">
          <div className="network-callout">
            <WifiOff aria-hidden="true" />
            <p>Faltan las variables <code>SYNC_*</code> en el entorno del edge. El sincronizador está desplegado: solo necesita la URL, el correo y la contraseña para entrar.</p>
          </div>
        </Panel>
      ) : null}

      {network.lastError && connected ? (
        <div className="network-error" role="alert">
          <ShieldAlert aria-hidden="true" />
          <span>{network.lastError}</span>
        </div>
      ) : null}

      <Panel title="Publicar por mercado" wide>
        <p className="network-capacity-hint">
          El precio es el de tu compra configurada y el fiat sale del saldo del mercado. Solo eliges la cantidad mínima que estás dispuesto a que te asignen.
        </p>
        <div className="network-market-grid">
          {markets.map((market) => {
            const draft = draftFor(market);
            const current = network.contributions?.[market.code];
            const formId = `network-contribution-${market.code}`;
            const minQusd = market.buyMaxRate > 0 ? MIN_COOPERATIVE_QUSD * market.buyMaxRate : 0;
            const canPublish = connected && market.fiatBalance > minQusd && market.buyMaxRate > 0;
            const projected = Number(draft.minimal) > 0 && market.buyMaxRate > 0
              ? Number(draft.minimal) * market.buyMaxRate
              : 0;
            return (
              <Card className={`network-market-card ${current ? "is-published" : ""}`} key={market.code} size="sm">
                <CardHeader>
                  <CardTitle>{label(market.code)}</CardTitle>
                  <CardAction>
                    <Badge variant={current ? "success" : "neutral"}>
                      {current ? "Publicado" : "Sin publicar"}
                    </Badge>
                  </CardAction>
                </CardHeader>
                <CardContent className="network-market-card-body">
                  <dl className="network-market-terms">
                    <div>
                      <dt>Precio de compra</dt>
                      <dd>{market.buyMaxRate > 0 ? `${money(market.buyMaxRate, 4)} ${market.currency}` : "Sin configurar"}</dd>
                    </div>
                    <div>
                      <dt>Fiat disponible</dt>
                      <dd>{money(market.fiatBalance)} {market.currency}</dd>
                    </div>
                    <div>
                      <dt>Mínimo por cacería</dt>
                      <dd>{money(minQusd)} {market.currency}</dd>
                    </div>
                  </dl>
                  <form id={formId} className="network-market-form" onSubmit={(event) => { event.preventDefault(); void publish(market); }}>
                    <label htmlFor={`${market.code}-minimal`}>
                      <span className="network-minimal-title">Cantidad mínima</span>
                      <span className="network-minimal-hint">QUSD que aceptas como mínimo</span>
                    </label>
                    <Input
                      id={`${market.code}-minimal`}
                      name="minimal"
                      type="number"
                      min="0.01"
                      step="0.01"
                      inputMode="decimal"
                      autoComplete="off"
                      required
                      aria-label={`Cantidad mínima para ${market.label}`}
                      value={draft.minimal}
                      onChange={(event) => updateDraft(market.code, event.target.value)}
                    />
                    <p className="network-market-projection">
                      {projected > 0
                        ? `Reservaría hasta ${money(projected)} ${market.currency} de tu fiat.`
                        : "Se publica con tu saldo fiat actual."}
                    </p>
                  </form>
                </CardContent>
                <footer className="network-market-actions">
                  <Button form={formId} type="submit" variant="primary" disabled={!canPublish || busy === market.code}>
                    {current ? "Actualizar" : "Publicar"}
                  </Button>
                  {current ? (
                    <Button type="button" variant="outline" disabled={busy === market.code} onClick={() => void withdraw(market)}>
                      Retirar
                    </Button>
                  ) : null}
                  {!canPublish ? (
                    <small>{market.buyMaxRate <= 0 ? "Falta el precio de compra." : `Necesitas más de ${money(minQusd)} ${market.currency}.`}</small>
                  ) : null}
                </footer>
              </Card>
            );
          })}
        </div>
      </Panel>

      <Panel title="Liquidez de la red" wide>
        <div className="network-aggregate-grid">
          {aggregates.length ? aggregates.map((item) => (
            <div className="network-aggregate" key={item.coin}>
              <div className="network-aggregate-head">
                <strong>{label(item.coin)}</strong>
                <Badge variant="neutral">
                  <UsersRound aria-hidden="true" /> {item.offersCount} bots
                </Badge>
              </div>
              <p className="network-aggregate-amount">{money(item.fiat)} <span>{unit(item.coin)}</span></p>
              <p className="network-aggregate-price">
                {item.price > 0 ? `${money(item.price, 4)} ${unit(item.coin)}/QUSD` : "Sin precio"}
                {item.minimal > 0 ? ` · mínimo ${money(item.minimal)} QUSD` : ""}
              </p>
            </div>
          )) : (
            <div className="network-callout">
              <RadioTower aria-hidden="true" />
              <p>Todavía no hay capacidad global. Publica un mercado para abrir la red.</p>
            </div>
          )}
        </div>
      </Panel>

      <Panel title="Cacería conjunta · segunda prioridad" wide>
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
    </div>
  );
}

function ConnectionDot({ connected }) {
  return (
    <span className={`network-dot ${connected ? "is-on" : "is-off"}`}>
      <span aria-hidden="true" />
      {connected ? "Conectado" : "Sin conexión"}
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
