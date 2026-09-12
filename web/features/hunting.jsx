import React, { useCallback, useMemo, useState } from "react";
import {
  AlertTriangle,
  Crosshair,
  Pause,
  Play,
  Save,
  ShoppingCart,
  Tags,
} from "lucide-react";
import { Empty, Panel } from "../components/common.jsx";
import { useDialog } from "../hooks/use-dialog.js";
import { money } from "../lib/format.js";
import { requestJson } from "../lib/http.js";
import { Badge, Button, Input } from "../components/ui.jsx";
import { MarketIdentity } from "../components/market-identity.jsx";

const cancellableStates = new Set(["applied", "acknowledged"]);

export function Hunting({ data, label, unit, onChanged }) {
  const [busy, setBusy] = useState("");
  const [status, setStatus] = useState("");
  const [pendingCancel, setPendingCancel] = useState();
  const [rates, setRates] = useState(() => rateDraft(data.markets));
  const closeCancel = useCallback(() => {
    if (!busy) setPendingCancel(undefined);
  }, [busy]);
  const dialogRef = useDialog(Boolean(pendingCancel), closeCancel);
  const captured = useMemo(
    () => (data.operations || []).filter((operation) => operation.autoApplied),
    [data.operations],
  );

  const update = async (key, payload, success) => {
    setBusy(key);
    setStatus("");
    try {
      await requestJson("/api/hunting", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      await onChanged?.();
      setStatus(success);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "No se pudo actualizar la cacería.");
    } finally {
      setBusy("");
    }
  };
  const cancel = async () => {
    if (!pendingCancel) return;
    const key = `cancel:${pendingCancel.uuid}`;
    setBusy(key);
    setStatus("");
    try {
      await requestJson(`/api/operations/${encodeURIComponent(pendingCancel.uuid)}/cancel`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      setPendingCancel(undefined);
      await onChanged?.();
      setStatus("Aplicación cancelada y registrada.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "No se pudo cancelar la aplicación.");
    } finally {
      setBusy("");
    }
  };

  return (
    <div className="hunting-stack">
      <section className="hunting-command" aria-label="Controles de cacería">
        <div className="hunt-scan-status">
          <span className={`live ${data.state.paused ? "offline" : ""}`} />
          <strong>{data.state.paused ? "Motor general pausado" : `Escaneo cada ${data.automation?.scanIntervalSeconds || "—"} s`}</strong>
          <small>{data.state.lastScan ? `Último: ${new Date(data.state.lastScan.at).toLocaleTimeString("es-CU")} · ${data.state.lastScan.result}` : "Aún no hay escaneos registrados"}</small>
        </div>
        <div className="hunt-master-grid">
          <MasterControl
            side="buy"
            running={data.hunting.buyRunning}
            paused={data.state.paused}
            mode={data.state.mode}
            busy={busy === "master:buy"}
            disabled={Boolean(busy)}
            onToggle={() => update("master:buy", { buyRunning: !data.hunting.buyRunning }, data.hunting.buyRunning ? "Cacería de compra detenida." : "Cacería de compra iniciada.")}
          />
          <MasterControl
            side="sell"
            running={data.hunting.sellRunning}
            paused={data.state.paused}
            mode={data.state.mode}
            busy={busy === "master:sell"}
            disabled={Boolean(busy)}
            onToggle={() => update("master:sell", { sellRunning: !data.hunting.sellRunning }, data.hunting.sellRunning ? "Cacería de venta detenida." : "Cacería de venta iniciada.")}
          />
        </div>
      </section>

      <Panel title="Mercados de cacería" wide>
        <div className="hunt-market-list">
          {data.markets.map((market) => {
            const draft = rates[market.code] || { buyMaxRate: market.buyMaxRate, sellMinRate: market.sellMinRate };
            const stats = data.averages?.[market.code] || {};
            const savingRates = busy === `rates:${market.code}`;
            return (
              <article className={`hunt-market ${market.active ? "" : "disabled"}`} key={market.code}>
                <header>
                  <MarketIdentity code={market.code} label={label(market.code)} size="lg" />
                  <strong>{market.active ? "Disponible" : "Mercado inactivo"}</strong>
                </header>
                <div className="hunt-side-grid">
                  <HuntSide
                    icon={ShoppingCart}
                    title="Comprar QUSD"
                    enabled={market.huntBuyEnabled}
                    running={data.hunting.buyRunning}
                    paused={data.state.paused}
                    mode={data.state.mode}
                    disabled={!market.active || Boolean(busy)}
                    median={stats.median_sell}
                    rate={draft.buyMaxRate}
                    unit={unit(market.code)}
                    limitLabel="Máximo para cazar"
                    onToggle={() => update(`market:${market.code}:buy`, { market: { code: market.code, huntBuyEnabled: !market.huntBuyEnabled } }, `Compra ${market.huntBuyEnabled ? "desactivada" : "activada"} en ${label(market.code)}.`)}
                    onRate={(value) => setRates((current) => ({ ...current, [market.code]: { ...current[market.code], buyMaxRate: value } }))}
                  />
                  <HuntSide
                    icon={Tags}
                    title="Vender QUSD"
                    enabled={market.huntSellEnabled}
                    running={data.hunting.sellRunning}
                    paused={data.state.paused}
                    mode={data.state.mode}
                    disabled={!market.active || Boolean(busy)}
                    median={stats.median_buy}
                    rate={draft.sellMinRate}
                    unit={unit(market.code)}
                    limitLabel="Mínimo para cazar"
                    onToggle={() => update(`market:${market.code}:sell`, { market: { code: market.code, huntSellEnabled: !market.huntSellEnabled } }, `Venta ${market.huntSellEnabled ? "desactivada" : "activada"} en ${label(market.code)}.`)}
                    onRate={(value) => setRates((current) => ({ ...current, [market.code]: { ...current[market.code], sellMinRate: value } }))}
                  />
                </div>
                <footer>
                  <Button
                    type="button"
                    variant="primary"
                    size="sm"
                    disabled={!market.active || Boolean(busy) || !validRates(draft) || ratesEqual(draft, market)}
                    onClick={() => update(`rates:${market.code}`, { market: { code: market.code, buyMaxRate: Number(draft.buyMaxRate), sellMinRate: Number(draft.sellMinRate) } }, `Precios de ${label(market.code)} actualizados.`)}
                  >
                    <Save aria-hidden="true" /> {savingRates ? "Guardando…" : "Guardar precios"}
                  </Button>
                </footer>
              </article>
            );
          })}
        </div>
      </Panel>

      <Panel title="Ofertas cazadas" wide>
        <div className="capture-heading">
          <strong>{captured.length} captura{captured.length === 1 ? "" : "s"}</strong>
        </div>
        {captured.length ? (
          <div className="capture-list">
            {captured.map((operation) => (
              <article className="capture-row" key={operation.uuid}>
                <div className={`capture-side ${operation.offerType === "sell" ? "buy" : "sell"}`}>
                  <Crosshair aria-hidden="true" />
                  <span>{operation.offerType === "sell" ? "Compra cazada" : "Venta cazada"}</span>
                </div>
                <div><span>Mercado</span><strong>{label(operation.coin)}</strong><small>{new Date(operation.createdAt).toLocaleString("es-CU")}</small></div>
                <div><span>Importe</span><strong>{money(operation.amount)} QUSD</strong><small>{money(operation.receive, unit(operation.coin) === "USD" ? 4 : 2)} {unit(operation.coin)}</small></div>
                <div><span>Tasa capturada</span><strong>{money(operation.rate, unit(operation.coin) === "USD" ? 4 : 2)}</strong><small>Mediana {operation.referenceRate ? money(operation.referenceRate, unit(operation.coin) === "USD" ? 4 : 2) : "no registrada"}</small></div>
                <div className="capture-action">
                  <OperationState value={operation.state} />
                  {cancellableStates.has(operation.state) ? <Button type="button" variant="destructive" size="sm" disabled={Boolean(busy)} onClick={() => setPendingCancel(operation)}>Cancelar aplicación</Button> : null}
                </div>
              </article>
            ))}
          </div>
        ) : <Empty>Cuando el bot aplique una oferta con precio de caza, aparecerá aquí.</Empty>}
      </Panel>

      {status ? <p className="detail hunt-feedback" role="status" aria-live="polite">{status}</p> : null}
      {pendingCancel ? (
        <section ref={dialogRef} className="offer-modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="cancel-capture-title">
          <div className="offer-modal cancel-offer-dialog">
            <div className="dialog-icon danger-icon"><AlertTriangle aria-hidden="true" /></div>
            <p className="eyebrow">OPERACIÓN CAZADA</p>
            <h2 id="cancel-capture-title">Cancelar esta aplicación</h2>
            <p>QvaApply pedirá a QvaPay cancelar la operación. Detener la cacería no es necesario y no se modificarán otras capturas.</p>
            <dl className="offer-summary">
              <div><dt>Flujo</dt><dd>{pendingCancel.offerType === "sell" ? "Comprar QUSD" : "Vender QUSD"}</dd></div>
              <div><dt>Mercado</dt><dd>{label(pendingCancel.coin)}</dd></div>
              <div><dt>Importe</dt><dd>{money(pendingCancel.amount)} QUSD</dd></div>
              <div><dt>Tasa</dt><dd>{money(pendingCancel.rate, unit(pendingCancel.coin) === "USD" ? 4 : 2)} {unit(pendingCancel.coin)}</dd></div>
            </dl>
            <div className="offer-modal-actions">
              <Button variant="ghost" type="button" onClick={closeCancel} disabled={Boolean(busy)}>Mantener aplicación</Button>
              <Button variant="destructive" type="button" onClick={cancel} disabled={Boolean(busy)}>{busy ? "Cancelando…" : "Sí, cancelar aplicación"}</Button>
            </div>
          </div>
        </section>
      ) : null}
    </div>
  );
}

function MasterControl({ side, running, paused, mode, busy, disabled, onToggle }) {
  const buying = side === "buy";
  const state = !running ? "Detenida" : paused ? "Preparada" : mode === "simulation" ? "Simulando" : "Cazando";
  return (
    <article className={`hunt-master ${running && !paused ? "running" : "stopped"}`}>
      <div><span>{buying ? "COMPRA" : "VENTA"}</span><strong>{state}</strong></div>
      <Button variant={running ? "secondary" : "primary"} type="button" onClick={onToggle} disabled={disabled}>{running ? <Pause aria-hidden="true" /> : <Play aria-hidden="true" />}{busy ? "Actualizando…" : running ? "Detener" : "Iniciar"}</Button>
    </article>
  );
}

function HuntSide({ icon: Icon, title, enabled, running, paused, mode, disabled, median, rate, unit, limitLabel, onToggle, onRate }) {
  const active = enabled && running && !paused;
  const state = !enabled
    ? "Fuera de cacería"
    : !running
      ? "Espera inicio"
      : paused
        ? "Pausa general"
        : mode === "simulation"
          ? "Solo simulación"
          : "Buscando";
  return (
    <section className={`hunt-side ${active ? "active" : ""}`}>
      <div className="hunt-side-title"><Icon aria-hidden="true" /><div><h4>{title}</h4></div></div>
      <Button variant={enabled ? "secondary" : "ghost"} type="button" role="switch" aria-checked={enabled} className="hunt-switch" onClick={onToggle} disabled={disabled}><span />{enabled ? "Seleccionado" : "No cazar"}</Button>
      <dl><div><dt>Mediana actual</dt><dd>{Number.isFinite(Number(median)) ? money(median, unit === "USD" ? 4 : 2) : "Sin muestra"}</dd></div><div><dt>Estado efectivo</dt><dd>{state}</dd></div></dl>
      <label>{limitLabel}<span className="input-unit"><Input type="number" min="0.0001" step="0.0001" value={rate} disabled={disabled} onChange={(event) => onRate(event.target.value)} /><small>{unit}/QUSD</small></span></label>
    </section>
  );
}

function OperationState({ value }) {
  const labels = { applied: "Aplicada", acknowledged: "Pago anunciado", paid: "Pagada", cancelled: "Cancelada", completed: "Completada", failed: "Fallida" };
  return <Badge className={`state state-${value}`}>{labels[value] || value}</Badge>;
}

function rateDraft(markets) {
  return Object.fromEntries(markets.map((market) => [market.code, { buyMaxRate: String(market.buyMaxRate), sellMinRate: String(market.sellMinRate) }]));
}
function validRates(value) {
  return Number(value.buyMaxRate) > 0 && Number(value.sellMinRate) > Number(value.buyMaxRate);
}
function ratesEqual(value, market) {
  return Number(value.buyMaxRate) === market.buyMaxRate && Number(value.sellMinRate) === market.sellMinRate;
}
