import React from "react";
import { CheckCircle2, ShieldAlert, XCircle } from "lucide-react";
import { Empty, Panel } from "../components/common.jsx";

export function Audit({ data }) {
  const integrity = data.integrity?.configRevisionChainValid;
  return (
    <div className="dashboard-grid audit-grid">
      <Panel title="Salud e integridad">
        <dl className="health-list">
          <Health label="Cadena de configuración" ok={integrity} value={integrity ? "Íntegra" : "Alterada"} />
          <Health label="Esquema de datos" ok value={`v${data.integrity?.schemaVersion}`} />
          <Health label="Mutaciones pendientes" ok={!data.risk.usage.unresolvedMutation} value={data.risk.usage.unresolvedMutation ? "Bloqueo activo" : "Ninguna"} />
          <Health label="Parada de emergencia" ok={!data.risk.usage.emergencyStop} value={data.risk.usage.emergencyStop ? "Activada" : "Desactivada"} />
        </dl>
      </Panel>
      <Panel title="Reservas de capital">
        {data.capitalReservations?.length ? <ol className="audit-list">{data.capitalReservations.map((item) => <li key={item.workflowId}><span>{item.market}</span><strong>{item.amount} QUSD</strong><small>{item.state}</small></li>)}</ol> : <Empty>Sin reservas registradas.</Empty>}
      </Panel>
      <Panel title="Intenciones remotas" wide>
        {data.mutationIntents?.length ? <ol className="audit-list">{data.mutationIntents.map((item) => <li key={item.intentId}><span>{item.kind}</span><strong>{item.state}</strong><small>{item.operationUuid || "sin UUID"} · {new Date(item.createdAt).toLocaleString("es-CU")}</small></li>)}</ol> : <Empty>Sin mutaciones registradas.</Empty>}
      </Panel>
      <Panel title="Registro de auditoría" wide>
        {data.activity?.length ? <ol className="audit-list">{data.activity.map((item, index) => <li key={`${item.createdAt}-${index}`}><span>{item.action}</span><strong>{item.detail}</strong><small>{new Date(item.createdAt).toLocaleString("es-CU")} {item.uuid ? `· ${item.uuid}` : ""}</small></li>)}</ol> : <Empty>Sin eventos.</Empty>}
      </Panel>
    </div>
  );
}

function Health({ label, ok, value }) {
  return <div><dt>{ok ? <CheckCircle2 aria-hidden="true" /> : <XCircle aria-hidden="true" />}{label}</dt><dd className={ok ? "" : "danger"}>{value}</dd></div>;
}
