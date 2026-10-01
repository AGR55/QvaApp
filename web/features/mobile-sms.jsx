import React, { useCallback, useEffect, useState } from "react";
import { Empty, Panel } from "../components/common.jsx";
import { Badge, Button, Field, Input } from "../components/ui.jsx";
import { requestJson } from "../lib/http.js";
import { money } from "../lib/format.js";

const statusLabel = {
  pending: "Pendiente",
  processing: "Verificando",
  matched: "Pago marcado",
  review: "Revisión manual",
  failed: "Falló",
};

export function MobileSmsPanel() {
  const [devices, setDevices] = useState([]);
  const [receipts, setReceipts] = useState([]);
  const [operators, setOperators] = useState([]);
  const [label, setLabel] = useState("");
  const [newToken, setNewToken] = useState("");
  const [operatorLabel, setOperatorLabel] = useState("");
  const [newOperatorToken, setNewOperatorToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      const [deviceResult, receiptResult, operatorResult] = await Promise.all([
        requestJson("/api/mobile/devices", { timeoutMs: 5_000 }),
        requestJson("/api/mobile/payment-receipts", { timeoutMs: 5_000 }),
        requestJson("/api/mobile/operators", { timeoutMs: 5_000 }),
      ]);
      setDevices(deviceResult.data || []);
      setReceipts(receiptResult.data || []);
      setOperators(operatorResult.data || []);
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "No se pudo actualizar el estado del móvil.");
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, 15_000);
    return () => window.clearInterval(timer);
  }, [load]);

  const pair = async (event) => {
    event.preventDefault();
    if (!label.trim() || busy) return;
    setBusy(true);
    setNewToken("");
    try {
      const response = await requestJson("/api/mobile/devices", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ label: label.trim() }),
      });
      setNewToken(response.data.token);
      setLabel("");
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "No se pudo vincular el móvil.");
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (device) => {
    if (!window.confirm(`¿Revocar el acceso SMS de ${device.label}? La APK dejará de entregar comprobantes.`)) return;
    setBusy(true);
    try {
      await requestJson(`/api/mobile/devices/${encodeURIComponent(device.id)}`, {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "No se pudo revocar el dispositivo.");
    } finally {
      setBusy(false);
    }
  };

  const pairOperator = async (event) => {
    event.preventDefault();
    if (!operatorLabel.trim() || busy) return;
    setBusy(true);
    setNewOperatorToken("");
    try {
      const response = await requestJson("/api/mobile/operators", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ label: operatorLabel.trim() }),
      });
      setNewOperatorToken(response.data.token);
      setOperatorLabel("");
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "No se pudo vincular el operador móvil.");
    } finally {
      setBusy(false);
    }
  };

  const revokeOperator = async (operator) => {
    if (!window.confirm(`¿Revocar el acceso a operaciones de ${operator.label}? La app dejará de consultar y actuar.`)) return;
    setBusy(true);
    try {
      await requestJson(`/api/mobile/operators/${encodeURIComponent(operator.id)}`, {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "No se pudo revocar el operador móvil.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Panel title="Móvil Android · comprobantes SMS" wide description="Vincula la APK privada para registrar automáticamente pagos con coincidencia segura.">
      <div className="mobile-sms-layout">
        <div>
          <form className="mobile-sms-pair" onSubmit={pair}>
            <Field label="Nombre del móvil" htmlFor="sms-device-label">
              <Input id="sms-device-label" value={label} maxLength={80} onChange={(event) => setLabel(event.target.value)} placeholder="Mi Android" />
            </Field>
            <Button type="submit" variant="primary" disabled={!label.trim() || busy}>Vincular móvil</Button>
          </form>
          {newToken ? (
            <div className="mobile-sms-token" role="status">
              <strong>Token de vinculación · se muestra una sola vez</strong>
              <p>Cópialo en la APK junto con <code>{window.location.origin}</code>. No lo envíes por chat.</p>
              <Input aria-label="Token de vinculación" value={newToken} readOnly onFocus={(event) => event.target.select()} />
              <Button type="button" variant="outline" size="sm" onClick={() => void navigator.clipboard.writeText(newToken)}>Copiar token</Button>
              <Button type="button" variant="ghost" size="sm" onClick={() => setNewToken("")}>Ocultar</Button>
            </div>
          ) : null}
          {devices.length ? (
            <ul className="mobile-sms-devices">
              {devices.map((device) => (
                <li key={device.id}>
                  <span><strong>{device.label}</strong><small>Vinculado el {new Date(device.createdAt).toLocaleString("es-CU")}</small></span>
                  {device.revokedAt ? <Badge>Revocado</Badge> : <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => void revoke(device)}>Revocar</Button>}
                </li>
              ))}
            </ul>
          ) : <Empty>Aún no hay móviles vinculados.</Empty>}
          <h3>Operaciones y avisos</h3>
          <p className="detail">Este acceso es independiente del token SMS y permite ejecutar acciones financieras desde la app. Guárdalo solo en tu móvil.</p>
          <form className="mobile-sms-pair" onSubmit={pairOperator}>
            <Field label="Nombre del operador móvil" htmlFor="mobile-operator-label">
              <Input id="mobile-operator-label" value={operatorLabel} maxLength={80} onChange={(event) => setOperatorLabel(event.target.value)} placeholder="Mi Android" />
            </Field>
            <Button type="submit" variant="primary" disabled={!operatorLabel.trim() || busy}>Vincular operaciones</Button>
          </form>
          {newOperatorToken ? (
            <div className="mobile-sms-token" role="status">
              <strong>Token de operador · se muestra una sola vez</strong>
              <p>Cópialo en «Token de operador» de la APK. No lo compartas ni lo uses como token SMS.</p>
              <Input aria-label="Token de operador" value={newOperatorToken} readOnly onFocus={(event) => event.target.select()} />
              <Button type="button" variant="outline" size="sm" onClick={() => void navigator.clipboard.writeText(newOperatorToken)}>Copiar token</Button>
              <Button type="button" variant="ghost" size="sm" onClick={() => setNewOperatorToken("")}>Ocultar</Button>
            </div>
          ) : null}
          {operators.length ? (
            <ul className="mobile-sms-devices">
              {operators.map((operator) => (
                <li key={operator.id}>
                  <span><strong>{operator.label}</strong><small>Vinculado el {new Date(operator.createdAt).toLocaleString("es-CU")}</small></span>
                  {operator.revokedAt ? <Badge>Revocado</Badge> : <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => void revokeOperator(operator)}>Revocar</Button>}
                </li>
              ))}
            </ul>
          ) : <Empty>Aún no hay acceso a operaciones vinculado.</Empty>}
        </div>
        <div>
          <h3>Últimos comprobantes</h3>
          {receipts.length ? (
            <ul className="mobile-sms-receipts">
              {receipts.slice(0, 20).map((receipt) => (
                <li key={receipt.id}>
                  <div><strong>{money(receipt.amount)} {receipt.currency}</strong><Badge variant={receipt.state === "review" || receipt.state === "failed" ? "danger" : "neutral"}>{statusLabel[receipt.state] || receipt.state}</Badge></div>
                  <small>{receipt.bank}{receipt.beneficiaryMasked ? ` · ${receipt.beneficiaryMasked}` : ""} · {receipt.bank === "ETECSA" ? "Referencia interna: " : "ID: "}{receipt.transactionId}</small>
                  {receipt.reason ? <p>{receipt.reason}</p> : null}
                  {receipt.operationUuid ? <small>Operación {receipt.operationUuid}</small> : null}
                </li>
              ))}
            </ul>
          ) : <Empty>No hay comprobantes recibidos.</Empty>}
          <p className="detail">Si un comprobante requiere revisión, abre la operación correspondiente y usa «Registrar pago» tras comprobar la transferencia.</p>
        </div>
      </div>
      {error ? <p className="detail" role="alert">{error}</p> : null}
    </Panel>
  );
}
