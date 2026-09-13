import React, { useCallback, useState } from "react";
import { AlertTriangle, CheckCircle2, RefreshCcw } from "lucide-react";
import { Empty, Panel, ViewHead } from "../components/common.jsx";
import { money } from "../lib/format.js";
import { requestJson } from "../lib/http.js";
import { operationActionBody } from "../lib/operation-actions.js";
import { useDialog } from "../hooks/use-dialog.js";
import { Badge, Button, Input } from "../components/ui.jsx";

const terminalWorkflow = new Set(["applied", "restored", "blocked"]);

export function Operations({ data, label, unit, onChanged }) {
  const [pending, setPending] = useState();
  const [reference, setReference] = useState("");
  const [status, setStatus] = useState("");
  const closePending = useCallback(() => setPending(undefined), []);
  const dialogRef = useDialog(Boolean(pending), closePending);
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
        kicker="Dinero en movimiento"
        title="Operaciones"
        description="Cada aplicación con su estado y la acción manual que le toca: pagar, registrar o conciliar."
      />
      {data.risk.usage.unresolvedMutation ? (
        <div className="alert" role="alert">
          <AlertTriangle aria-hidden="true" />
          Hay una mutación remota sin confirmar. El motor no abrirá otra operación.
        </div>
      ) : null}
      <div className="dashboard-grid">
        <Panel title="Operaciones con dinero" kicker="Seguimiento" wide>
          {data.operations?.length ? (
            <div className="table-scroll" tabIndex="0" role="region" aria-label="Operaciones con dinero, tabla desplazable">
              <table>
                <thead><tr><th>Estado</th><th>Flujo</th><th>Mercado</th><th>Importe</th><th>Acciones</th></tr></thead>
                <tbody>
                  {data.operations.map((operation) => (
                    <tr key={operation.uuid}>
                      <td><State value={operation.state} /></td>
                      <td>{operation.offerType === "sell" ? "Comprar QUSD" : "Vender QUSD"}</td>
                      <td>{label(operation.coin)}</td>
                      <td>{money(operation.amount)} QUSD<small>{money(operation.receive)} {unit(operation.coin)}</small></td>
                      <td className="row-actions">
                        {operation.state === "applied" && operation.offerType === "sell" ? <Button variant="outline" size="sm" onClick={() => setPending({ operation, action: "ack" })}>Voy a pagar</Button> : null}
                        {["applied", "acknowledged"].includes(operation.state) && operation.offerType === "sell" ? <Button variant="outline" size="sm" onClick={() => setPending({ operation, action: "paid" })}>Registrar pago</Button> : null}
                        {["applied", "acknowledged", "paid"].includes(operation.state) && operation.offerType === "buy" ? <Button variant="outline" size="sm" onClick={() => setPending({ operation, action: "received" })}>Confirmar recepción</Button> : null}
                        {["applied", "acknowledged"].includes(operation.state) ? <Button variant="destructive" size="sm" onClick={() => setPending({ operation, action: "cancel" })}>Cancelar</Button> : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : <Empty>No hay operaciones registradas.</Empty>}
        </Panel>
        <Panel title="Flujos automáticos y compensación" kicker="Motor" description="Concilia cuando el resultado remoto quede ambiguo." wide>
          {data.workflows?.length ? (
            <ol className="workflow-list">
              {data.workflows.map((workflow) => (
                <li key={workflow.id}>
                  <State value={workflow.state} />
                  <span><strong>{money(workflow.targetOffer.amount)} QUSD · {label(workflow.targetOffer.coin)}</strong><small>{workflow.error || workflow.riskDecision.reasons.join(" · ")}</small></span>
                  {!terminalWorkflow.has(workflow.state) ? <Button variant="outline" size="sm" onClick={() => run(`/api/workflows/${workflow.id}/reconcile`)}><RefreshCcw aria-hidden="true" /> Conciliar</Button> : <CheckCircle2 aria-hidden="true" />}
                </li>
              ))}
            </ol>
          ) : <Empty>No se han ejecutado flujos automáticos.</Empty>}
        </Panel>
      </div>
      {status ? <p className="detail" role="status" aria-live="polite">{status}</p> : null}
      {pending ? (
        <section ref={dialogRef} className="review-panel" role="dialog" aria-modal="true" aria-labelledby="operation-review-title">
          <div>
            <p className="eyebrow">Acción financiera</p>
            <h2 id="operation-review-title">{actionTitle(pending.action)}</h2>
            <p>{money(pending.operation.amount)} QUSD · {label(pending.operation.coin)}.</p>
            {pending.action === "paid" ? <label>Referencia del pago<Input autoFocus value={reference} onChange={(event) => setReference(event.target.value)} /></label> : null}
            <div className="review-actions">
              <Button variant="ghost" onClick={closePending}>Volver</Button>
              <Button variant="primary" disabled={pending.action === "paid" && !reference.trim()} onClick={() => run(`/api/operations/${pending.operation.uuid}/${pending.action}`, operationActionBody(pending.action, reference))}>Confirmar acción</Button>
            </div>
          </div>
        </section>
      ) : null}
    </div>
  );
}

function State({ value }) {
  return <Badge className={`state state-${value}`}>{value.replaceAll("_", " ")}</Badge>;
}

function actionTitle(action) {
  return ({ ack: "Confirmar que harás el pago", paid: "Registrar pago ya realizado", received: "Confirmar fiat recibido", cancel: "Cancelar la operación" })[action];
}
