import React, { useCallback, useEffect, useState } from "react";
import { AlertTriangle, CircleCheck, RotateCw, ShieldAlert } from "lucide-react";
import { Empty, Panel, Skeleton } from "../components/common.jsx";
import { Button, Field, Select, Textarea } from "../components/ui.jsx";
import { Badge } from "../components/ui/badge.tsx";
import { Checkbox } from "../components/ui/checkbox.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../components/ui/dialog.tsx";
import { requestJson } from "../lib/http.js";

const jsonPost = (body = {}) => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

export function RecoveryPanel({ onChanged }) {
  const [report, setReport] = useState();
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [busyId, setBusyId] = useState("");
  const [actionMessage, setActionMessage] = useState("");
  const [actionFailed, setActionFailed] = useState(false);
  const [selected, setSelected] = useState(null);
  const [outcome, setOutcome] = useState("not_applied");
  const [reason, setReason] = useState("");
  const [evidence, setEvidence] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [resolveError, setResolveError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError("");
    try {
      const payload = await requestJson("/api/recovery");
      setReport(payload.data);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "No se pudo cargar la recuperación.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const check = async (item) => {
    setBusyId(item.intentId);
    setActionMessage("");
    setActionFailed(false);
    setLoadError("");
    try {
      const payload = await requestJson(
        `/api/recovery/${encodeURIComponent(item.intentId)}/check`,
        jsonPost(),
      );
      if (Array.isArray(payload.data?.items)) setReport(payload.data);
      else await load();
      await onChanged?.();
      const outcomeLabel = ({ reconciled: "Conciliada", pending: "Sigue pendiente", workflow_review_required: "Requiere revisión del workflow", not_pending: "Ya no está pendiente" })[payload.data?.outcome];
      setActionMessage([outcomeLabel, payload.data?.message].filter(Boolean).join(". ") || "Comprobación completada. La mutación no se repitió.");
    } catch (error) {
      setActionFailed(true);
      setActionMessage(error instanceof Error ? error.message : "No se pudo comprobar esta intención.");
    } finally {
      setBusyId("");
    }
  };

  const beginResolve = (item) => {
    setSelected(item);
    setOutcome(item.manualOutcomes?.[0] ?? "not_applied");
    setReason("");
    setEvidence("");
    setConfirmed(false);
    setResolveError("");
  };

  const resolve = async () => {
    if (!selected || !confirmed || !reason.trim() || !evidence.trim()) return;
    setBusyId(selected.intentId);
    setResolveError("");
    try {
      await requestJson(
        `/api/recovery/${encodeURIComponent(selected.intentId)}/resolve`,
        jsonPost({
          expectedUpdatedAt: selected.updatedAt,
          outcome,
          reason: reason.trim(),
          evidence: evidence.trim(),
          confirmed: true,
        }),
      );
      setSelected(null);
      await load();
      await onChanged?.();
    } catch (error) {
      setResolveError(error instanceof Error ? error.message : "No se pudo registrar la comprobación.");
    } finally {
      setBusyId("");
    }
  };

  const items = report?.items ?? [];
  return <>
    <Panel
      title="Recuperación de intenciones"
      kicker="Control remoto"
      description="Inspecciona operaciones inciertas y reconcilia evidencia sin volver a enviar una mutación."
    >
      <div className="recovery-panel">
        <div className="recovery-summary">
          <span><ShieldAlert aria-hidden="true" /> {blockedCount(report)} bloqueo(s) pendiente(s)</span>
          <Button variant="outline" size="sm" disabled={loading || Boolean(busyId)} onClick={() => void load()}>
            <RotateCw data-icon="inline-start" /> Actualizar
          </Button>
        </div>
        {loadError ? <div className="resource-error" role="alert"><p><AlertTriangle aria-hidden="true" />{loadError}</p><Button variant="outline" size="sm" onClick={() => void load()}>Reintentar</Button></div> : null}
        {actionMessage ? <p className={actionFailed ? "recovery-message danger" : "recovery-message"} role={actionFailed ? "alert" : "status"}>{actionMessage}</p> : null}
        {loading && !report ? <Skeleton rows={2} label="Cargando intenciones remotas" /> : null}
        {!loading && !loadError && items.length === 0 ? <Empty title="Todo al día" icon={CircleCheck}>No hay intenciones remotas que requieran atención.</Empty> : null}
        {items.length ? <ol className="recovery-list">
          {items.map((item) => <RecoveryCard
            key={item.intentId}
            item={item}
            busy={Boolean(busyId)}
            currentBusy={busyId === item.intentId}
            onCheck={() => void check(item)}
            onResolve={() => beginResolve(item)}
          />)}
        </ol> : null}
      </div>
    </Panel>

    <Dialog open={Boolean(selected)} onOpenChange={(open) => !open && !busyId && setSelected(null)}>
      <DialogContent className="decision-dialog recovery-dialog" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>Registrar comprobación manual</DialogTitle>
          <DialogDescription>Esto registra tu declaración como operador; no es una confirmación de QvaPay ni vuelve a enviar la aplicación. Si era el último bloqueo, el bot podrá volver a tomar ofertas. Verifica antes que no quede dinero comprometido.</DialogDescription>
        </DialogHeader>
        {selected ? <div className="recovery-resolution">
          <p className="recovery-intent-id">Intención <code>{selected.intentId}</code></p>
          <Field label="Resultado de tu comprobación" htmlFor="recovery-outcome">
            <Select
              id="recovery-outcome"
              value={outcome}
              onValueChange={setOutcome}
              options={[
                { value: "not_applied", label: "La aplicación no se realizó" },
                { value: "cancelled", label: "La solicitud aparece cancelada" },
                { value: "terminal_reviewed", label: "Oferta completada; verifiqué que no tengo obligaciones pendientes" },
              ].filter((option) => !selected.manualOutcomes || selected.manualOutcomes.includes(option.value))}
            />
          </Field>
          <Field label="Motivo" htmlFor="recovery-reason" description="Resume qué comprobaste y por qué corresponde este resultado.">
            <Textarea id="recovery-reason" value={reason} onChange={(event) => setReason(event.target.value)} rows={3} maxLength={500} />
          </Field>
          <Field label="Evidencia revisada en QvaPay" htmlFor="recovery-evidence" description={outcome === "terminal_reviewed" ? "Indica qué comprobaste en Mis operaciones y pagos de tu cuenta, además del UUID de la oferta. Mínimo 12 caracteres." : "Anota el dato observable que verificaste, por ejemplo estado e identificador de la oferta. Mínimo 12 caracteres."}>
            <Textarea id="recovery-evidence" value={evidence} onChange={(event) => setEvidence(event.target.value)} rows={3} maxLength={1000} />
          </Field>
          <label className="recovery-confirmation">
            <Checkbox checked={confirmed} onCheckedChange={(value) => setConfirmed(value === true)} />
            <span>{outcome === "terminal_reviewed" ? "Confirmo que revisé en QvaPay mis operaciones y pagos de esta oferta, y que no tengo ninguna obligación o dinero pendiente." : "Confirmo que revisé QvaPay y que esta declaración describe lo que observé."}</span>
          </label>
          {resolveError ? <div className="resource-error" role="alert"><p><AlertTriangle aria-hidden="true" />{resolveError}</p></div> : null}
          <p className="recovery-warning">{outcome === "terminal_reviewed" ? "El evento p2p.completed solo indica que la oferta terminó; no demuestra quién la tomó. Si figura en tus operaciones, tienes un pago sin cerrar o no puedes comprobarlo, no desbloquees aquí." : "No uses esta acción para marcar pagos o recepciones. La resolución manual no prueba por sí sola el resultado remoto."}</p>
        </div> : null}
        <DialogFooter>
          <Button variant="secondary" disabled={Boolean(busyId)} onClick={() => setSelected(null)}>Cancelar</Button>
          <Button variant="primary" disabled={Boolean(busyId) || !confirmed || reason.trim().length < 12 || reason.trim().length > 500 || evidence.trim().length < 12 || evidence.trim().length > 1_000} onClick={() => void resolve()}>
            {busyId ? "Registrando…" : "Registrar declaración"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </>;
}

function RecoveryCard({ item, busy, currentBusy, onCheck, onResolve }) {
  return <li className="recovery-item">
    <header className="recovery-item-head">
      <div><strong>{labelKind(item.kind)}</strong><Badge variant={item.state === "uncertain" ? "destructive" : "secondary"}>{item.state}</Badge></div>
      <time>{formatDate(item.updatedAt)}</time>
    </header>
    <dl className="recovery-fields">
      <Fact label="Intención" value={item.intentId} code />
      <Fact label="Operación" value={item.operationUuid} code />
      <Fact label="Workflow" value={item.workflowId} code />
      <Fact label="Registrada" value={formatDate(item.createdAt)} />
      <Fact label="Última actualización" value={formatDate(item.updatedAt)} />
      <Fact label="Último error" value={item.error} />
      <Fact label="Motivo por el que no se permite la resolución manual" value={item.manualBlockedReason} />
      {item.operation ? <ObjectFacts title="Operación / exposición" value={item.operation} fields={[
        ["amount", "QUSD en operación"], ["receive", "Importe fiat"], ["offerType", "Tipo de oferta"], ["coin", "Moneda"], ["state", "Estado local"], ["uuid", "UUID remoto"],
      ]} /> : null}
      {item.feed ? <ObjectFacts title="Evidencia del feed" value={item.feed} fields={[
        ["event", "Evento"], ["status", "Estado"], ["sentAt", "Enviado"], ["receivedAt", "Recibido"],
      ]} /> : null}
      {item.retry ? <ObjectFacts title="Reintento programado" value={item.retry} fields={[
        ["attempts", "Intentos"], ["nextAttemptAt", "Próximo intento"], ["eligible", "Habilitado"],
      ]} /> : null}
    </dl>
    <footer className="recovery-actions">
      <Button variant="outline" size="sm" disabled={busy} onClick={onCheck}>
        <RotateCw data-icon="inline-start" />{currentBusy ? "Comprobando…" : "Comprobar ahora"}
      </Button>
      {item.manualEligible === true ? <Button variant="secondary" size="sm" disabled={busy} onClick={onResolve}>
        <CircleCheck data-icon="inline-start" />Registrar comprobación manual
      </Button> : null}
    </footer>
  </li>;
}

function ObjectFacts({ title, value, fields }) {
  const entries = fields.flatMap(([key, label]) => {
    const entry = value?.[key];
    if (entry === undefined || entry === null || entry === "") return [];
    const displayed = key.toLowerCase().endsWith("at") && (typeof entry === "string" || typeof entry === "number")
      ? formatDate(entry)
      : String(entry);
    return [[label, displayed]];
  });
  return entries.length ? <div className="recovery-subfacts"><dt>{title}</dt>{entries.map(([label, text]) => <dd key={label}><span>{label}</span><strong>{text}</strong></dd>)}</div> : null;
}

function Fact({ label, value, code = false }) {
  if (value === undefined || value === null || value === "") return null;
  return <div><dt>{label}</dt><dd>{code ? <code>{value}</code> : value}</dd></div>;
}

function labelKind(kind) {
  return ({ apply: "Aplicación", paid: "Pago", received: "Recepción", cancel: "Cancelación", edit: "Edición" })[kind] ?? kind;
}

function blockedCount(report) {
  if (typeof report?.blocked === "number") return report.blocked;
  if (Array.isArray(report?.blocked)) return report.blocked.length;
  if (typeof report?.blocked === "boolean") return Number(report.blocked);
  return report?.items?.length ?? 0;
}

function formatDate(value) {
  if (value === undefined || value === null || value === "") return "Sin fecha";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString("es-CU");
}
