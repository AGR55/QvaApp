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
  const [label, setLabel] = useState("");
  const [newToken, setNewToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      const [deviceResult, receiptResult] = await Promise.all([
        requestJson("/api/mobile/devices", { timeoutMs: 5_000 }),
        requestJson("/api/mobile/payment-receipts", { timeoutMs: 5_000 }),
      ]);
      setDevices(deviceResult.data || []);
      setReceipts(receiptResult.data || []);
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
        </div>
        <div>
          <h3>Últimos comprobantes</h3>
          {receipts.length ? (
            <ul className="mobile-sms-receipts">
              {receipts.slice(0, 20).map((receipt) => (
                <li key={receipt.id}>
                  <div><strong>{money(receipt.amount)} {receipt.currency}</strong><Badge variant={receipt.state === "review" || receipt.state === "failed" ? "danger" : "neutral"}>{statusLabel[receipt.state] || receipt.state}</Badge></div>
                  <small>{receipt.bank} · {receipt.beneficiaryMasked} · {receipt.transactionId}</small>
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
