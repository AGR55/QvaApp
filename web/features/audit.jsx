import React, { useCallback, useEffect, useMemo, useState } from "react";
import { CheckCircle2, Clock3, ShieldAlert, TrendingDown, TrendingUp, XCircle } from "lucide-react";
import { Empty, Panel, ViewHead } from "../components/common.jsx";
import { Button } from "../components/ui.jsx";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "../components/ui/alert-dialog.tsx";
import {
  Card,
  CardContent,
  CardFooter,
  CardHeader,
} from "../components/ui/card.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../components/ui/dialog.tsx";
import { requestJson } from "../lib/http.js";
import { RecoveryPanel } from "./recovery-panel.jsx";

export function Audit({ data, onChanged }) {
  const integrity = data.integrity?.configRevisionChainValid;
  const fallbackBlocked = useMemo(() => (data.alerts || []).filter((item) => item.decision === "blocked" && item.resolvedAt === null), [data.alerts]);
  const [events, setEvents] = useState();
  const [eventsError, setEventsError] = useState("");
  const [eventsLoading, setEventsLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [dialog, setDialog] = useState(null);
  const [preview, setPreview] = useState(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [dismissAllOpen, setDismissAllOpen] = useState(false);
  const [dismissAllSnapshot, setDismissAllSnapshot] = useState(null);
  const [dismissAllBusy, setDismissAllBusy] = useState(false);
  const [dismissAllError, setDismissAllError] = useState("");
  const [dismissAllMessage, setDismissAllMessage] = useState("");
  const close = useCallback(() => { if (!busy) { setDialog(null); setPreview(null); setMessage(""); } }, [busy]);
  const loadEvents = useCallback(async (requestedPage = page) => {
    setEventsLoading(true); setEventsError("");
    try {
      const payload = await requestJson(`/api/decision-events?decision=blocked&status=pending&page=${requestedPage}&pageSize=20`);
      setEvents(payload.data);
      return payload.data;
    } catch (error) {
      setEventsError(error instanceof Error ? error.message : "No se pudo leer la cola de decisiones.");
      return undefined;
    } finally { setEventsLoading(false); }
  }, [page]);
  useEffect(() => { void loadEvents(); }, [loadEvents, data.generatedAt]);
  const blocked = events?.items ?? fallbackBlocked;

  const prepareDismissAll = async () => {
    setDismissAllBusy(true);
    setDismissAllError("");
    setDismissAllMessage("");
    try {
      const latest = await loadEvents(page);
      if (!latest) return;
      if (!latest.pending || latest.dismissThroughId === undefined || latest.dismissThroughId === null) {
        setDismissAllError("No hay decisiones pendientes que descartar.");
        return;
      }
      setDismissAllSnapshot({ throughId: latest.dismissThroughId, pending: latest.pending });
      setDismissAllOpen(true);
    } finally {
      setDismissAllBusy(false);
    }
  };

  const dismissAll = async () => {
    const throughId = dismissAllSnapshot?.throughId;
    if (throughId === undefined || throughId === null || dismissAllBusy) return;
    setDismissAllBusy(true);
    setDismissAllError("");
    try {
      const payload = await requestJson("/api/decision-events/dismiss-all", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ throughId }),
      });
      setDismissAllOpen(false);
      setDismissAllSnapshot(null);
      setDismissAllMessage(`${payload.data.dismissed} decisión(es) descartada(s).`);
      setPage(1);
      await loadEvents(1);
      await onChanged();
    } catch (error) {
      setDismissAllError(error instanceof Error ? error.message : "No se pudieron descartar las decisiones pendientes.");
    } finally {
      setDismissAllBusy(false);
    }
  };

  const review = async (offer) => {
    setDialog({ kind: "review", offer }); setBusy(true); setMessage("Comprobando la oferta y calculando la liquidez…");
    try {
      const payload = await requestJson(`/api/blocked-offers/${encodeURIComponent(offer.uuid)}/preview`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({}) });
      setPreview(payload.data); setMessage("");
    } catch (error) { setMessage(error instanceof Error ? error.message : "No se pudo revisar la oferta."); await onChanged(); }
    finally { setBusy(false); }
  };
  const apply = async () => {
    if (!dialog?.offer) return;
    setBusy(true); setMessage("Aplicando con todas las protecciones activas…");
    try {
      const payload = await requestJson(`/api/blocked-offers/${encodeURIComponent(dialog.offer.uuid)}/apply`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ overridePriceGuard: true }) });
      setMessage(payload.data.message); setPreview(null); await onChanged();
    } catch (error) { setMessage(error instanceof Error ? error.message : "La protección de riesgo rechazó la aplicación."); await onChanged(); }
    finally { setBusy(false); }
  };
  const dismiss = async () => {
    if (!dialog?.offer) return;
    const offer = dialog.offer;
    const previousEvents = events;
    setEvents((current) => current ? {
      ...current,
      items: current.items.filter((item) => item.id !== offer.id && item.uuid !== offer.uuid),
      total: Math.max(0, current.total - 1),
      pending: Math.max(0, current.pending - 1),
    } : current);
    setDialog(null);
    setPreview(null);
    setMessage("");
    setBusy(false);
    try {
      const path = offer.id
        ? `/api/decision-events/${offer.id}/dismiss`
        : `/api/blocked-offers/${encodeURIComponent(offer.uuid)}/dismiss`;
      await requestJson(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({}) });
      void onChanged();
      void loadEvents();
    } catch (error) {
      setEvents(previousEvents);
      setEventsError(error instanceof Error ? error.message : "No se pudo descartar la oferta.");
    }
  };

  return <>
    <ViewHead
      title="Auditoría"
    />
    <div className="audit-layout">
      <div className="audit-main">
        <div className="dashboard-grid audit-health-grid">
          <Panel title="Salud e integridad"><dl className="health-list">
            <Health label="Cadena de configuración" ok={integrity} value={integrity ? "Íntegra" : "Alterada"} />
            <Health label="Esquema de datos" ok value={`v${data.integrity?.schemaVersion}`} />
            <Health label="Mutaciones pendientes" ok={!data.risk.usage.unresolvedMutation} value={data.risk.usage.unresolvedMutation ? "Bloqueo activo" : "Ninguna"} />
            <Health label="Parada de emergencia" ok={!data.risk.usage.emergencyStop} value={data.risk.usage.emergencyStop ? "Activada" : "Desactivada"} />
          </dl></Panel>
          <Panel title="Reservas de capital">{data.capitalReservations?.length ? <ol className="audit-list">{data.capitalReservations.map((item) => <li key={item.workflowId}><span>{item.market}</span><strong>{item.amount} QUSD</strong><small>{item.state}</small></li>)}</ol> : <Empty>Sin reservas registradas.</Empty>}</Panel>
        </div>
        <Panel title="Intenciones remotas">{data.mutationIntents?.length ? <ol className="audit-list">{data.mutationIntents.map((item) => <li key={item.intentId}><span>{item.kind}</span><strong>{item.state}</strong><small>{item.operationUuid || "sin UUID"} · {new Date(item.createdAt).toLocaleString("es-CU")}</small></li>)}</ol> : <Empty>Sin mutaciones registradas.</Empty>}</Panel>
        <RecoveryPanel onChanged={onChanged} />
        <Panel title="Registro de auditoría">{data.activity?.length ? <ol className="audit-list timeline-list">{data.activity.map((item, index) => <li key={`${item.createdAt}-${index}`}><span>{item.action}</span><strong>{item.detail}</strong><small>{new Date(item.createdAt).toLocaleString("es-CU")}</small></li>)}</ol> : <Empty>Sin eventos.</Empty>}</Panel>
      </div>
      <aside className="blocked-rail" aria-label="Ofertas bloqueadas pendientes">
        <div className="blocked-rail-head"><div><h2>Ofertas bloqueadas</h2></div><span className="count-badge">{events?.pending ?? blocked.length}</span></div>
        <Button variant="outline" size="sm" disabled={dismissAllBusy || eventsLoading || !events?.pending} onClick={() => void prepareDismissAll()}>
          {dismissAllBusy ? "Preparando…" : "Descartar todas"}
        </Button>
        {dismissAllMessage ? <p className="recovery-message" role="status">{dismissAllMessage}</p> : null}
        {dismissAllError ? <div className="resource-error" role="alert"><p>{dismissAllError}</p></div> : null}
        {eventsError ? <div className="resource-error" role="alert"><p>{eventsError}</p><Button variant="secondary" size="sm" onClick={() => void loadEvents()}>Reintentar</Button></div> : null}
        {eventsLoading && !events ? <div className="blocked-loading" aria-label="Cargando ofertas bloqueadas"><span /><span /><span /></div> : null}
        {blocked.length ? blocked.map((offer) => <BlockedCard key={offer.id ?? offer.uuid} offer={offer} onReview={() => void review(offer)} onDismiss={() => setDialog({ kind: "dismiss", offer })} />) : !eventsLoading ? <Empty>No hay ofertas esperando tu decisión.</Empty> : null}
        {events && events.total > events.pageSize ? <nav className="pagination" aria-label="Páginas de ofertas bloqueadas"><Button variant="outline" size="sm" disabled={page === 1 || eventsLoading} onClick={() => setPage((value) => Math.max(1, value - 1))}>Anterior</Button><span>{page} / {Math.ceil(events.total / events.pageSize)}</span><Button variant="outline" size="sm" disabled={page * events.pageSize >= events.total || eventsLoading} onClick={() => setPage((value) => value + 1)}>Siguiente</Button></nav> : null}
      </aside>
    </div>
    <AlertDialog open={dialog?.kind === "dismiss"} onOpenChange={(open) => !open && close()}>
      <AlertDialogContent className="decision-dialog">
        <AlertDialogHeader>
          <AlertDialogTitle>¿Ocultar esta oferta?</AlertDialogTitle>
          <AlertDialogDescription>La revisión queda registrada y reaparecerá si cambia el precio o el motivo del bloqueo.</AlertDialogDescription>
          {message ? <p className="dialog-message danger" role="status">{message}</p> : null}
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>Conservar</AlertDialogCancel>
          <AlertDialogAction variant="destructive" disabled={busy} onClick={(event) => { event.preventDefault(); void dismiss(); }}>{busy ? "Descartando…" : "Descartar oferta"}</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
    <AlertDialog open={dismissAllOpen} onOpenChange={(open) => {
      if (dismissAllBusy) return;
      setDismissAllOpen(open);
      if (!open) setDismissAllSnapshot(null);
    }}>
      <AlertDialogContent className="decision-dialog">
        <AlertDialogHeader>
          <AlertDialogTitle>¿Descartar {dismissAllSnapshot?.pending ?? 0} ofertas bloqueadas?</AlertDialogTitle>
          <AlertDialogDescription>Se registrará el descarte de todas las decisiones pendientes incluidas hasta el último evento cargado, incluso las que no aparecen en esta página. No se cancela ni modifica ninguna oferta. Las decisiones creadas después de ese cursor se conservarán.</AlertDialogDescription>
          {dismissAllError ? <p className="dialog-message danger" role="alert">{dismissAllError}</p> : null}
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={dismissAllBusy}>Conservar</AlertDialogCancel>
          <AlertDialogAction variant="destructive" disabled={dismissAllBusy || dismissAllSnapshot?.throughId === undefined || dismissAllSnapshot?.throughId === null} onClick={(event) => { event.preventDefault(); void dismissAll(); }}>
            {dismissAllBusy ? "Descartando…" : `Descartar ${dismissAllSnapshot?.pending ?? 0} decisiones`}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
    <Dialog open={dialog?.kind === "review"} onOpenChange={(open) => !open && close()}>
      <DialogContent className="decision-dialog">
        <DialogHeader>
          <DialogTitle>Revisar antes de aplicar</DialogTitle>
          <DialogDescription>Se volverán a comprobar saldo, límites y estado remoto.</DialogDescription>
        </DialogHeader>
        {preview ? <PreviewDetails preview={preview} /> : null}{message ? <p className="dialog-message" role="status">{message}</p> : null}
        {preview ? <p className="safety-note"><ShieldAlert /> Solo se omitirá el bloqueo de precio/mediana. Saldo, reserva, exposición, límites y estado remoto se comprobarán nuevamente.</p> : null}
        <DialogFooter><Button variant="secondary" onClick={close} disabled={busy}>Cancelar</Button><Button variant="primary" onClick={() => void apply()} disabled={busy || !preview}>{busy ? "Comprobando…" : "Aplicar con protecciones"}</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  </>;
}

function BlockedCard({ offer, onReview, onDismiss }) {
  const reference = offer.referenceRate;
  const deviation = reference ? ((offer.rate - reference) / reference) * 100 : null;
  const buying = offer.offerType === "sell";
  const Trend = buying ? TrendingDown : TrendingUp;
  return <Card className="blocked-card" size="sm"><CardHeader><header><span className={`offer-side ${buying ? "buy" : "sell"}`}><Trend />{buying ? "Comprar QUSD" : "Vender QUSD"}</span><time><Clock3 />{relativeTime(offer.updatedAt)}</time></header></CardHeader>
    <CardContent><div className="blocked-value"><strong>{offer.amount.toFixed(2)} QUSD</strong><span>{offer.receive.toLocaleString("es-CU")} · {offer.coin}</span></div>
      <dl className="offer-comparison"><div><dt>Tasa</dt><dd>{offer.rate.toFixed(2)}</dd></div><div><dt>Mediana</dt><dd>{reference ? reference.toFixed(2) : "No disponible"}</dd></div><div><dt>Diferencia</dt><dd className={deviation === null ? "" : Math.abs(deviation) > 1 ? "warning-text" : ""}>{deviation === null ? "—" : `${deviation > 0 ? "+" : ""}${deviation.toFixed(2)}%`}</dd></div></dl>
      <p className="blocked-reason"><ShieldAlert />{offer.reason}</p>
      {offer.checks?.length ? <details className="risk-checks"><summary>Ver {offer.checks.length} comprobaciones</summary><ul>{offer.checks.map((check) => <li key={check.code} className={`check-${check.status}`}><span>{check.label}</span><strong>{check.status === "pass" ? "Correcta" : check.status === "warning" ? "Advertencia" : check.status === "fail" ? "Bloqueo" : "No aplica"}</strong><small>{check.reason}{check.actual !== undefined ? ` · observado: ${String(check.actual)}` : ""}{check.limit !== undefined ? ` · límite: ${String(check.limit)}` : ""}</small></li>)}</ul></details> : null}
    </CardContent><CardFooter className="blocked-actions"><Button variant="outline" size="sm" onClick={onDismiss}>Descartar</Button><Button variant="primary" size="sm" onClick={onReview}>Revisar y aplicar</Button></CardFooter></Card>;
}

function PreviewDetails({ preview }) {
  return <div className="preview-details"><dl><div><dt>Operación</dt><dd>{preview.offerType === "sell" ? "Comprar" : "Vender"} {preview.amount.toFixed(2)} QUSD</dd></div><div><dt>Fiat</dt><dd>{preview.receive.toLocaleString("es-CU")} · {preview.coin}</dd></div><div><dt>Tasa / mediana</dt><dd>{preview.rate.toFixed(2)} / {preview.referenceRate.toFixed(2)}</dd></div><div><dt>Desviación</dt><dd>{preview.deviationPercent > 0 ? "+" : ""}{preview.deviationPercent.toFixed(2)}%</dd></div></dl>
    <div className="liquidity-preview"><strong>Plan de liquidez</strong><p>{preview.liquidityReason}</p>{preview.plannedCancellations.length ? <ul>{preview.plannedCancellations.map((item) => <li key={item.uuid}>{item.amount.toFixed(2)} QUSD · {item.coin} · tasa {item.rate.toFixed(2)}<small>Usar {optionalMoney(item.consumeQusd)} · reponer {optionalMoney(item.restoreQusd)} QUSD</small></li>)}</ul> : null}</div></div>;
}

function optionalMoney(value) {
  return typeof value === "number" && Number.isFinite(value) ? value.toFixed(2) : "no disponible";
}

function Health({ label, ok, value }) { return <div><dt>{ok ? <CheckCircle2 aria-hidden="true" /> : <XCircle aria-hidden="true" />}{label}</dt><dd className={ok ? "" : "danger"}>{value}</dd></div>; }
function relativeTime(timestamp) { const minutes = Math.max(0, Math.round((Date.now() - timestamp) / 60_000)); return minutes < 1 ? "ahora" : minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h`; }
