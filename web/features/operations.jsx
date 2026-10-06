import React, { useCallback, useState } from "react";
import { AlertTriangle, ArrowLeftRight, Bell, CheckCircle2, RefreshCcw, Workflow } from "lucide-react";
import { Empty, Panel, ViewHead } from "../components/common.jsx";
import { money } from "../lib/format.js";
import { requestJson } from "../lib/http.js";
import { operationActionBody } from "../lib/operation-actions.js";
import { MobileSmsPanel } from "./mobile-sms.jsx";
import { Badge, Button, Field, Input } from "../components/ui.jsx";
import { FieldGroup } from "../components/ui/field.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../components/ui/dialog.tsx";
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../components/ui/table.tsx";

const terminalWorkflow = new Set(["applied", "restored", "blocked"]);

export function Operations({ data, label, unit, onChanged, notifications = [], onAcknowledgeNotification }) {
  const [pending, setPending] = useState();
  const [reference, setReference] = useState("");
  const [status, setStatus] = useState("");
  const closePending = useCallback(() => setPending(undefined), []);
  const run = async (path, body = {}) => {
    setStatus("Enviando acción…");
    try {
      await requestJson(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      setPending(undefined);
      setReference("");
      setStatus("Acción confirmada y auditada.");
      await onChanged();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "La acción falló.");
    }
  };
  return (
    <div className="operations-stack">
      <ViewHead
        title="Operaciones"
      />
      <Panel title="Avisos de operación" wide>
        {notifications.length ? (
          <ol className="operation-notifications">
            {notifications.map((item) => (
              <li key={item.id}>
                <div><strong>{item.type === "own-offer-applied" ? "Tomaron tu oferta" : "Aplicación del bot"}</strong><p>{item.message}</p><small>{item.alert?.uuid} · {item.alert?.coin} · {money(item.alert?.amount || 0)} QUSD · {new Date(item.createdAt).toLocaleString("es-CU")}</small></div>
                <div className="operation-notification-actions"><a href={item.url || `/?view=operaciones&operation=${encodeURIComponent(item.alert?.uuid || "")}`}>Abrir operación</a><Button type="button" variant="outline" size="sm" onClick={() => onAcknowledgeNotification?.(item.id)}>Reconocer</Button></div>
              </li>
            ))}
          </ol>
        ) : <Empty title="Sin avisos pendientes" icon={Bell}>Los avisos de tus operaciones aparecerán aquí.</Empty>}
      </Panel>
      {data.risk.usage.unresolvedMutation ? (
        <div className="alert" role="alert">
          <AlertTriangle aria-hidden="true" />
          Hay una mutación remota sin confirmar. El motor no abrirá otra operación.
        </div>
      ) : null}
      <div className="dashboard-grid operations-layout">
        <Panel title="Operaciones con dinero" wide>
          {data.operations?.length ? (
            <div className="table-scroll">
              <Table className="w-full min-w-[900px]" aria-label="Operaciones con dinero">
                <TableCaption className="sr-only">Operaciones con dinero y sus acciones disponibles</TableCaption>
                <TableHeader><TableRow><TableHead>Estado</TableHead><TableHead>Flujo</TableHead><TableHead>Mercado</TableHead><TableHead>Importe</TableHead><TableHead>Acciones</TableHead></TableRow></TableHeader>
                <TableBody>
                  {data.operations.map((operation) => (
                    <TableRow key={operation.uuid}>
                      <TableCell className="whitespace-nowrap"><State value={operation.state} /></TableCell>
                      <TableCell className="whitespace-nowrap">{operation.offerType === "sell" ? "Comprar QUSD" : "Vender QUSD"}{operation.cooperativeOwnerFiat !== undefined ? <small>Cacería conjunta</small> : null}</TableCell>
                      <TableCell className="whitespace-nowrap">{label(operation.coin)}</TableCell>
                      <TableCell className="whitespace-nowrap">{money(operation.amount)} QUSD<small>{money(operation.receive)} {unit(operation.coin)}{operation.cooperativeOwnerFiat !== undefined ? ` · Tu parte: ${money(operation.cooperativeOwnerFiat)}` : ""}</small></TableCell>
                      <TableCell className="row-actions whitespace-nowrap">
                        {operation.state === "applied" && operation.offerType === "sell" ? <Button type="button" variant="outline" size="sm" onClick={() => setPending({ operation, action: "ack" })}>Voy a pagar</Button> : null}
                        {["applied", "acknowledged"].includes(operation.state) && operation.offerType === "sell" ? <Button type="button" variant="outline" size="sm" onClick={() => setPending({ operation, action: "paid" })}>Registrar pago</Button> : null}
                        {["applied", "acknowledged", "paid"].includes(operation.state) && operation.offerType === "buy" ? <Button type="button" variant="outline" size="sm" onClick={() => setPending({ operation, action: "received" })}>Confirmar recepción</Button> : null}
                        {["applied", "acknowledged"].includes(operation.state) ? <Button type="button" variant="destructive" size="sm" onClick={() => setPending({ operation, action: "cancel" })}>Cancelar</Button> : null}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          ) : <Empty title="Sin operaciones registradas" icon={ArrowLeftRight}>Cuando se inicie una operación, podrás gestionarla desde esta tabla.</Empty>}
        </Panel>
        <Panel title="Flujos automáticos" wide>
          {data.workflows?.length ? (
            <ol className="workflow-list">
              {data.workflows.map((workflow) => (
                <li key={workflow.id}>
                  <State value={workflow.state} />
                  <span><strong>{money(workflow.targetOffer.amount)} QUSD · {label(workflow.targetOffer.coin)}</strong><small>{workflow.error || workflow.riskDecision.reasons.join(" · ")}</small></span>
                  {!terminalWorkflow.has(workflow.state) ? <Button type="button" variant="outline" size="sm" onClick={() => run(`/api/workflows/${workflow.id}/reconcile`)}><RefreshCcw aria-hidden="true" data-icon="inline-start" /> Conciliar</Button> : <CheckCircle2 aria-hidden="true" />}
                </li>
              ))}
            </ol>
          ) : <Empty title="Sin flujos ejecutados" icon={Workflow}>Las aplicaciones automáticas aparecerán aquí.</Empty>}
        </Panel>
      </div>
      <MobileSmsPanel />
      {status ? <p className="detail" role="status" aria-live="polite">{status}</p> : null}
      <Dialog open={Boolean(pending)} onOpenChange={(open) => !open && closePending()}>
        {pending ? (
          <DialogContent className="review-dialog" showCloseButton={false}>
            <DialogHeader>
              <DialogTitle>{actionTitle(pending.action)}</DialogTitle>
              <DialogDescription>{money(pending.operation.amount)} QUSD en {label(pending.operation.coin)}.{pending.operation.cooperativeOwnerFiat !== undefined && pending.action === "paid" ? " Confirma únicamente cuando todos los participantes hayan pagado al vendedor. Tu SMS solo demuestra tu parte." : ""}</DialogDescription>
            </DialogHeader>
            {pending.action === "paid" ? (
              <FieldGroup>
                <Field label="Referencia del pago" htmlFor="payment-reference">
                  <Input id="payment-reference" autoFocus value={reference} onChange={(event) => setReference(event.target.value)} />
                </Field>
              </FieldGroup>
            ) : null}
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={closePending}>Volver</Button>
              <Button type="button" variant="primary" disabled={pending.action === "paid" && !reference.trim()} onClick={() => run(`/api/operations/${pending.operation.uuid}/${pending.action}`, operationActionBody(pending.action, reference))}>Confirmar acción</Button>
            </DialogFooter>
          </DialogContent>
        ) : null}
      </Dialog>
    </div>
  );
}

function State({ value }) {
  return <Badge className={`state state-${value}`}>{value.replaceAll("_", " ")}</Badge>;
}

function actionTitle(action) {
  return ({ ack: "Confirmar que harás el pago", paid: "Registrar pago ya realizado", received: "Confirmar fiat recibido", cancel: "Cancelar la operación" })[action];
}
