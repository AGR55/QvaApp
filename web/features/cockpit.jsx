import React, { useCallback, useState } from "react";
import { AlertOctagon, Pause, Play, Radio, ShieldCheck } from "lucide-react";
import { List, Panel } from "../components/common.jsx";
import { money } from "../lib/format.js";
import { requestJson } from "../lib/http.js";
import { useDialog } from "../hooks/use-dialog.js";

export function Cockpit({ data, label, unit, onChanged }) {
  const first = data.rankings.potential?.[0];
  const [confirmReal, setConfirmReal] = useState(false);
  const [status, setStatus] = useState("");
  const closeReal = useCallback(() => setConfirmReal(false), []);
  const dialogRef = useDialog(confirmReal, closeReal);
  const control = async (change) => {
    setStatus("Aplicando control…");
    try {
      await requestJson("/api/control", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(change) });
      setConfirmReal(false);
      setStatus("Control aplicado y auditado.");
      await onChanged();
    } catch (error) { setStatus(error instanceof Error ? error.message : "No se pudo aplicar."); }
  };
  return (
    <>
      <section className="control-deck" aria-label="Controles operativos">
        <div><span className={`live ${data.state.paused ? "offline" : ""}`} /> <strong>{data.state.paused ? "Automatización pausada" : "Automatización activa"}</strong><small>Modo {data.state.mode}</small></div>
        <button onClick={() => control({ paused: !data.state.paused })}>{data.state.paused ? <Play /> : <Pause />}{data.state.paused ? "Reanudar" : "Pausar"}</button>
        <button onClick={() => data.state.mode === "real" ? control({ mode: "simulation", paused: true }) : setConfirmReal(true)}><Radio />{data.state.mode === "real" ? "Pasar a simulación" : "Preparar modo real"}</button>
        <button className={data.risk.usage.emergencyStop ? "emergency active" : "emergency"} onClick={() => control({ emergencyStop: !data.risk.usage.emergencyStop })}><AlertOctagon />{data.risk.usage.emergencyStop ? "Desbloquear emergencia" : "Parada de emergencia"}</button>
      </section>
      <p className="detail" role="status" aria-live="polite">{status}</p>
      <section className="decision-strip">
        <div>
          <span>DECISIÓN AHORA</span>
          <strong>
            {first
              ? `${label(first.buy)} → ${label(first.sell)}`
              : "Sin ciclo positivo elegible"}
          </strong>
          <p>
            {first
              ? `Margen potencial ${money(first.marginPercent)}% · revisa antes de operar.`
              : "Esperando una tasa que cumpla límites y capital."}
          </p>
        </div>
        <b>
          {money(data.availability.qusd.available)}
          <small> QUSD libres</small>
        </b>
      </section>
      <div className="market-grid">
        {data.markets.map((market) => {
          const availability = data.availability.fiat[market.code] || {},
            rate = data.strategy.buyMax[market.code] || market.buyMaxRate;
          return (
            <article className="market-card" key={market.code}>
              <span>
                {market.label} · {market.currency}
              </span>
              <strong>
                {money(availability.available)} {market.currency}
              </strong>
              <p>
                Comprable ≈{" "}
                <b>{money(rate ? availability.available / rate : 0)} QUSD</b>
              </p>
              <small>
                {money(availability.committed)} comprometidos · límite{" "}
                {money(rate, unit(market.code) === "USD" ? 4 : 2)}
              </small>
            </article>
          );
        })}
      </div>
      <Panel title="Consumo de límites globales" wide>
        <div className="risk-meter-grid">
          <RiskMeter label="Exposición simultánea" value={data.risk.usage.exposureQusd} maximum={data.risk.limits.maxConcurrentQusdExposure} unit="QUSD" />
          <RiskMeter label="Volumen aplicado hoy" value={data.risk.usage.dailyAppliedQusd} maximum={data.risk.limits.maxDailyAppliedQusd} unit="QUSD" />
          <RiskMeter label="Operaciones activas" value={data.risk.usage.activeOperations} maximum={data.risk.limits.maxConcurrentOperations} unit="" />
          <RiskMeter label="Reserva mínima" value={data.availability.qusd.reported} maximum={data.risk.limits.minQusdReserve} unit="QUSD" inverse />
        </div>
      </Panel>
      <div className="dashboard-grid">
        <Panel title="Oportunidades priorizadas">
          <List
            rows={data.rankings.potential}
            render={(item) =>
              `${label(item.buy)} → ${label(item.sell)} · +${money(item.profit, 4)} ${unit(item.sell)}`
            }
          />
        </Panel>
        <Panel title="Rotación · 24 h">
          <List
            rows={data.rankings.rotation}
            render={(item) =>
              `${item.label} · ${item.eligible} candidatas · ${item.observed} observadas`
            }
          />
        </Panel>
        <Panel title="Alertas operativas" wide>
          <List
            rows={data.alerts?.length ? data.alerts : data.activity}
            render={(item) => item.reason || item.detail}
          />
        </Panel>
      </div>
      {confirmReal ? <section ref={dialogRef} className="review-panel" role="dialog" aria-modal="true" aria-labelledby="real-mode-title"><div><ShieldCheck aria-hidden="true" /><p className="eyebrow">CAMBIO CRÍTICO</p><h2 id="real-mode-title">Activar capacidad de operar con dinero real</h2><p>El modo real habilita aplicaciones automáticas dentro de todos los límites configurados. Los pagos fiat seguirán siendo manuales.</p><div className="review-actions"><button onClick={closeReal}>Volver</button><button className="refresh" onClick={() => control({ mode: "real", paused: true })}>Confirmar modo real, aún pausado</button></div></div></section> : null}
    </>
  );
}

function RiskMeter({ label, value, maximum, unit, inverse = false }) {
  const raw = maximum > 0 ? value / maximum : value > 0 ? 1 : 0;
  const percent = Math.max(0, Math.min(100, raw * 100));
  const danger = inverse ? value < maximum : value >= maximum;
  return <div className={`risk-meter ${danger ? "at-limit" : ""}`}><span>{label}</span><strong>{money(value)} {unit}</strong><small>de {money(maximum)} {unit}</small><div aria-label={`${label}: ${money(percent)} por ciento`} role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow={percent}><i style={{ width: `${percent}%` }} /></div></div>;
}
