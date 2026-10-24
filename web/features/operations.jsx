import React, { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, ArrowLeftRight, Bell, CheckCircle2, MessageSquareText, RefreshCcw, Workflow } from "lucide-react";
import { Empty, Panel, ViewHead } from "../components/common.jsx";
import { money } from "../lib/format.js";
import { requestJson } from "../lib/http.js";
import { operationActionBody } from "../lib/operation-actions.js";
import { MobileSmsPanel } from "./mobile-sms.jsx";
import { OperationChatSheet } from "./operation-chat.jsx";
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
  const [chatOperation, setChatOperation] = useState();
  const [chatUnread, setChatUnread] = useState({});
  const [conversations, setConversations] = useState([]);
  const openedDeepLink = useRef(false);
  const [chatSearch, setChatSearch] = useState("");
  const refreshChatUnread = useCallback(async () => {
    try {
      const result = await requestJson("/api/operations/chats/unread", { timeoutMs: 10_000 });
      setChatUnread(result.data || {});
      const catalog = await requestJson("/api/operations/chats", {timeoutMs:10000});
      setConversations(catalog.data || []);
    } catch { /* La tabla conserva el último contador conocido. */ }
  }, []);
  useEffect(() => {
    void refreshChatUnread();
    const timer = window.setInterval(() => {
      if (document.visibilityState !== "hidden") void refreshChatUnread();
    }, 15_000);
    return () => window.clearInterval(timer);
  }, [refreshChatUnread]);
  useEffect(() => {
    const query = new URLSearchParams(window.location.search);
    const uuid = query.get("chat"), order = query.get("order");
    if (!uuid || openedDeepLink.current) return;
    const target = conversations.find(item => item.uuid === uuid && (item.orderUuid || "") === (order || ""));
    if (target) { openedDeepLink.current=true; setChatOperation(target); }
  }, [conversations]);
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
      <Panel title="Conversaciones y órdenes" wide>
        <Field label="Buscar conversación"><Input value={chatSearch} onChange={event=>setChatSearch(event.target.value)} placeholder="Mercado, contraparte, oferta u orden…" /></Field>
        {conversations.length ? <ol className="operation-notifications">
          {conversations.filter(item=>`${item.uuid} ${item.orderUuid||""} ${item.coin} ${label(item.coin)} ${item.counterpartyLabel||""}`.toLowerCase().includes(chatSearch.toLowerCase())).map(item=>(
            <li key={item.id}>
              <div><strong>{item.counterpartyLabel || "Contraparte"} · {label(item.coin)}</strong>
                <p>{money(item.amount)} QUSD · {item.role === "creator" ? "Tu oferta" : "Oferta tomada"} · {item.state}</p>
                <small>Oferta {item.uuid.slice(0,8)}{item.orderUuid ? ` · Orden ${item.orderUuid.slice(0,8)}` : " · Operación normal"}</small>
              </div>
              <Button type="button" variant="outline" onClick={()=>setChatOperation(item)}><MessageSquareText aria-hidden="true" /> Abrir chat{item.unreadCount ? ` · ${item.unreadCount} sin leer` : ""}</Button>
            </li>
          ))}
        </ol> : <Empty title="Sin conversaciones todavía" icon={MessageSquareText}>Las operaciones normales y cada orden por rango aparecerán al sincronizar tu cuenta.</Empty>}
      </Panel>
      {(data.recoveryNoticeCount ?? Number(data.risk.usage.unresolvedMutation)) > 0 ? (
        <div className="alert" role="alert">
          <AlertTriangle aria-hidden="true" />
          Hay una mutación remota sin confirmar. Se verifica esa oferta mientras continúan las demás cacerías.
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
                      <TableCell className="whitespace-nowrap"><State value={operation.state} />{operation.orderUuid ? <small title={operation.orderUuid}>Orden {operation.orderUuid.slice(0, 8)}</small> : null}</TableCell>
                      <TableCell className="whitespace-nowrap">{operation.offerType === "sell" ? "Comprar QUSD" : "Vender QUSD"}{operation.cooperativeOwnerFiat !== undefined ? <small>Cacería conjunta</small> : null}</TableCell>
                      <TableCell className="whitespace-nowrap">{label(operation.coin)}</TableCell>
                      <TableCell className="whitespace-nowrap">{money(operation.amount)} QUSD<small>{money(operation.receive)} {unit(operation.coin)}{operation.cooperativeOwnerFiat !== undefined ? ` · Tu parte: ${money(operation.cooperativeOwnerFiat)}` : ""}</small></TableCell>
                      <TableCell className="row-actions whitespace-nowrap">
                        <Button type="button" variant="ghost" size="sm" onClick={() => setChatOperation(operation)} aria-label={`Abrir chat de la operación ${operation.uuid}`}>
                          <MessageSquareText aria-hidden="true" data-icon="inline-start" /> Chat
                          {chatUnread[operation.uuid] ? <span className="operation-chat-unread" aria-label={`${chatUnread[operation.uuid]} mensajes sin leer`}>{chatUnread[operation.uuid]}</span> : null}
                        </Button>
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
      <OperationChatSheet key={chatOperation?.id || `${chatOperation?.uuid}:${chatOperation?.orderUuid || "fixed"}`} operation={chatOperation} label={label} onUnreadChange={refreshChatUnread} onClose={() => setChatOperation(undefined)} />
      {status ? <p className="detail" role="status" aria-live="polite">{status}</p> : null}
      <Dialog open={Boolean(pending)} onOpenChange={(open) => !open && closePending()}>
        {pending ? (
          <DialogContent className="review-dialog" showCloseButton={false}>
            <DialogHeader>
              <DialogTitle>{actionTitle(pending.action)}</DialogTitle>
              <DialogDescription>{money(pending.operation.amount)} QUSD en {label(pending.operation.coin)}.{pending.action === "cancel" && pending.operation.orderUuid && pending.operation.offerType === "buy" ? " En esta orden flexible, cancelar abre una disputa en QvaPay. Los fondos siguen comprometidos hasta su resolución." : ""}{pending.operation.cooperativeOwnerFiat !== undefined && pending.action === "paid" ? " Confirma únicamente cuando todos los participantes hayan pagado al vendedor. Tu SMS solo demuestra tu parte." : ""}</DialogDescription>
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
