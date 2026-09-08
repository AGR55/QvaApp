import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Check, History, Plus, Save, ShieldAlert, Trash2 } from "lucide-react";
import { Empty, Panel, Skeleton } from "../components/common.jsx";
import { requestJson } from "../lib/http.js";
import { useDialog } from "../hooks/use-dialog.js";

const riskFields = [
  ["maxQusdPerOperation", "Máximo por operación", "QUSD"],
  ["maxConcurrentQusdExposure", "Exposición simultánea", "QUSD"],
  ["maxDailyAppliedQusd", "Volumen diario", "QUSD"],
  ["maxConcurrentOperations", "Operaciones simultáneas", "operaciones"],
  ["minQusdReserve", "Reserva mínima", "QUSD"],
  ["maxQuoteAgeSeconds", "Antigüedad máxima", "segundos"],
  ["minExpectedMarginPercent", "Margen mínimo", "%"],
  ["maxSlippagePercent", "Deslizamiento máximo", "%"],
  ["maxConsecutiveErrors", "Errores antes de pausar", "errores"],
  ["marketCooldownSeconds", "Enfriamiento por mercado", "segundos"],
  ["counterpartyCooldownSeconds", "Enfriamiento por contraparte", "segundos"],
];
const automationFields = [
  ["scanIntervalSeconds", "Intervalo de escaneo", "segundos", 5],
  ["autoCancelMinutes", "Cancelación automática", "minutos", 1],
  ["offerRefreshIntervalMinutes", "Refresco de ofertas propias", "minutos", 1],
  ["priceGuardPercent", "Cortafuegos frente a la mediana", "%", 1],
];

export function Settings({ onChanged }) {
  const [saved, setSaved] = useState();
  const [draft, setDraft] = useState();
  const [revisions, setRevisions] = useState([]);
  const [reviewing, setReviewing] = useState(false);
  const [reason, setReason] = useState("Revisión de límites y mercados desde la mesa de operaciones");
  const [status, setStatus] = useState("Cargando configuración…");
  const closeReview = useCallback(() => setReviewing(false), []);
  const dialogRef = useDialog(reviewing, closeReview);

  const load = async () => {
    try {
      const configPayload = await requestJson("/api/config");
      setSaved(configPayload.data);
      setDraft(structuredClone(configPayload.data));
      setStatus("");
      try {
        const revisionPayload = await requestJson("/api/config-revisions");
        setRevisions(revisionPayload.data || []);
      } catch {
        setStatus("Configuración disponible; el historial se reintentará después.");
      }
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "No se pudo cargar.");
    }
  };
  useEffect(() => void load(), []);

  const changes = useMemo(() => diffConfig(saved, draft), [saved, draft]);
  const requiresInitialReview = draft?.risk.reviewedAt === null;
  if (!draft)
    return (
      <Panel title="Estrategia y riesgo" wide>
        <Skeleton rows={7} label={status || "Leyendo configuración SQLite"} />
      </Panel>
    );

  const updateRisk = (key, value) =>
    setDraft((current) => ({
      ...current,
      risk: { ...current.risk, [key]: Number(value) },
    }));
  const updateMarket = (index, key, value) =>
    setDraft((current) => ({
      ...current,
      markets: current.markets.map((market, position) =>
        position === index
          ? {
              ...market,
              [key]: ["active", "label", "currency", "code"].includes(key)
                ? value
                : Number(value),
            }
          : market,
      ),
    }));
  const updateDetail = (marketIndex, detailIndex, key, value) =>
    setDraft((current) => ({
      ...current,
      markets: current.markets.map((market, index) => index !== marketIndex ? market : {
        ...market,
        paymentDetails: market.paymentDetails.map((detail, position) => position === detailIndex ? { ...detail, [key]: value } : detail),
      }),
    }));
  const addDetail = (marketIndex) => setDraft((current) => ({
    ...current,
    markets: current.markets.map((market, index) => index === marketIndex ? { ...market, paymentDetails: [...market.paymentDetails, { name: "", value: "" }] } : market),
  }));
  const removeDetail = (marketIndex, detailIndex) => setDraft((current) => ({
    ...current,
    markets: current.markets.map((market, index) => index === marketIndex ? { ...market, paymentDetails: market.paymentDetails.filter((_, position) => position !== detailIndex) } : market),
  }));
  const addMarket = () => setDraft((current) => ({ ...current, markets: [...current.markets, { code: "NUEVO", label: "Nuevo mercado", currency: "", active: false, fiatBalance: 0, buyMaxRate: 1, sellMinRate: 1, purchaseMaxQusd: 0, sellFeePercent: 0, outgoingTransferFee: 0, paymentDetails: [] }] }));
  const removeMarket = (index) => setDraft((current) => ({ ...current, markets: current.markets.filter((_, position) => position !== index) }));
  const save = async () => {
    setStatus("Guardando revisión…");
    try {
      await requestJson("/api/config", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          config: draft,
          reason,
        }),
      });
      setReviewing(false);
      await load();
      await onChanged?.();
      setStatus("Configuración activa y auditada.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "No se pudo guardar.");
    }
  };

  return (
    <div className="settings-stack">
      <section className="decision-strip settings-hero">
        <div>
          <span>POLÍTICA GLOBAL</span>
          <strong>
            {draft.risk.reviewedAt ? "Límites revisados" : "Revisión obligatoria"}
          </strong>
          <p>El bot no moverá capital con límites conservadores sin confirmar.</p>
        </div>
        <ShieldAlert aria-hidden="true" />
      </section>

      <Panel title="Límites de riesgo" wide>
        <form className="settings-form" onSubmit={(event) => event.preventDefault()}>
          <label>
            Máximo de ofertas propias
            <span className="input-unit"><input type="number" min="1" step="1" value={draft.maxOpenOffers} onChange={(event) => setDraft((current) => ({ ...current, maxOpenOffers: Number(event.target.value) }))} /><small>ofertas</small></span>
          </label>
          {riskFields.map(([key, label, unit]) => (
            <label key={key}>
              {label}
              <span className="input-unit">
                <input
                  type="number"
                  min="0"
                  step={key.includes("Operations") || key.includes("Errors") ? "1" : "0.01"}
                  value={draft.risk[key]}
                  onChange={(event) => updateRisk(key, event.target.value)}
                />
                <small>{unit}</small>
              </span>
            </label>
          ))}
          <div className="form-actions" aria-live="polite">
            <button
              type="button"
              className="refresh"
              disabled={!changes.length && !requiresInitialReview}
              onClick={() => setReviewing(true)}
            >
              <Save aria-hidden="true" /> {requiresInitialReview && !changes.length
                ? "Revisar y aprobar límites"
                : `Revisar ${changes.length} cambio(s)`}
            </button>
            <span>{status}</span>
          </div>
        </form>
      </Panel>

      <Panel title="Comportamiento del bot" wide>
        <form className="settings-form" onSubmit={(event) => event.preventDefault()}>
          {automationFields.map(([key, label, unit, minimum]) => (
            <label key={key}>
              {label}
              <span className="input-unit">
                <input
                  type="number"
                  min={minimum}
                  step="1"
                  value={draft.automation[key]}
                  onChange={(event) => setDraft((current) => ({
                    ...current,
                    automation: {
                      ...current.automation,
                      [key]: Number(event.target.value),
                    },
                  }))}
                />
                <small>{unit}</small>
              </span>
            </label>
          ))}
          <label className="message-setting">
            Mensaje automático en el chat P2P
            <textarea
              maxLength="79"
              rows="3"
              value={draft.automation.welcomeMessage}
              onChange={(event) => setDraft((current) => ({
                ...current,
                automation: {
                  ...current.automation,
                  welcomeMessage: event.target.value,
                },
              }))}
            />
            <small>{draft.automation.welcomeMessage.length}/79 caracteres</small>
          </label>
          <p className="settings-note-inline">Estos valores están en SQLite y se aplican sin editar archivos. El interruptor de despliegue para permitir dinero real permanece protegido en el entorno.</p>
        </form>
      </Panel>

      <Panel title="Mercados y precios" wide>
        <div className="market-settings-grid">
          {draft.markets.map((market, index) => (
            <fieldset key={market.code} className="market-settings">
              <legend>{market.label}</legend>
              <label className="toggle-field">
                <input
                  type="checkbox"
                  checked={market.active}
                  onChange={(event) =>
                    updateMarket(index, "active", event.target.checked)
                  }
                />
                Mercado activo
              </label>
              <label>
                Código QvaPay
                <input value={market.code} onChange={(event) => updateMarket(index, "code", event.target.value.toUpperCase())} />
              </label>
              <label>
                Nombre visible
                <input value={market.label} onChange={(event) => updateMarket(index, "label", event.target.value)} />
              </label>
              <label>
                Moneda fiat
                <input value={market.currency} onChange={(event) => updateMarket(index, "currency", event.target.value.toUpperCase())} />
              </label>
              <label>
                Saldo fiat declarado
                <input type="number" min="0" step="0.01" value={market.fiatBalance} onChange={(event) => updateMarket(index, "fiatBalance", event.target.value)} />
              </label>
              <label>
                Máximo de compra
                <input
                  type="number"
                  min="0.0000001"
                  step="0.0001"
                  value={market.buyMaxRate}
                  onChange={(event) =>
                    updateMarket(index, "buyMaxRate", event.target.value)
                  }
                />
              </label>
              <label>
                Mínimo de venta
                <input
                  type="number"
                  min="0.0000001"
                  step="0.0001"
                  value={market.sellMinRate}
                  onChange={(event) =>
                    updateMarket(index, "sellMinRate", event.target.value)
                  }
                />
              </label>
              <label>
                Máximo QUSD por compra
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  value={market.purchaseMaxQusd}
                  onChange={(event) =>
                    updateMarket(index, "purchaseMaxQusd", event.target.value)
                  }
                />
              </label>
              <label>
                Comisión de venta (%)
                <input
                  type="number"
                  min="0"
                  max="99.99"
                  step="0.01"
                  value={market.sellFeePercent}
                  onChange={(event) =>
                    updateMarket(index, "sellFeePercent", event.target.value)
                  }
                />
              </label>
              <label>
                Comisión fija de salida
                <span className="input-unit">
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    value={market.outgoingTransferFee}
                    onChange={(event) =>
                      updateMarket(index, "outgoingTransferFee", event.target.value)
                    }
                  />
                  <small>{market.currency}</small>
                </span>
              </label>
              <div className="payment-details">
                <strong>Datos de cobro</strong>
                {market.paymentDetails.map((detail, detailIndex) => (
                  <div key={detailIndex}>
                    <input aria-label={`Nombre del dato ${detailIndex + 1}`} placeholder="Campo" value={detail.name} onChange={(event) => updateDetail(index, detailIndex, "name", event.target.value)} />
                    <input aria-label={`Valor del dato ${detailIndex + 1}`} placeholder="Valor" value={detail.value} onChange={(event) => updateDetail(index, detailIndex, "value", event.target.value)} />
                    <button type="button" aria-label="Eliminar dato" onClick={() => removeDetail(index, detailIndex)}><Trash2 aria-hidden="true" /></button>
                  </div>
                ))}
                <button type="button" onClick={() => addDetail(index)}><Plus aria-hidden="true" /> Añadir dato</button>
              </div>
              <button type="button" className="danger-button" onClick={() => removeMarket(index)}><Trash2 aria-hidden="true" /> Eliminar mercado</button>
            </fieldset>
          ))}
        </div>
        <button type="button" className="refresh add-market" onClick={addMarket}><Plus aria-hidden="true" /> Añadir mercado</button>
      </Panel>

      {reviewing ? (
        <section ref={dialogRef} className="review-panel" role="dialog" aria-modal="true" aria-labelledby="review-title">
          <div>
            <p className="eyebrow">CONFIRMACIÓN CRÍTICA</p>
            <h2 id="review-title">Revisa el impacto antes de activar</h2>
            <ul className="change-list">
              {requiresInitialReview && !changes.length ? (
                <li>
                  <span>Política de riesgo inicial</span>
                  <del>Sin revisar</del>
                  <strong>Aprobada</strong>
                </li>
              ) : null}
              {changes.map((change) => (
                <li key={change.key}>
                  <span>{change.label}</span>
                  <del>{change.before}</del>
                  <strong>{change.after}</strong>
                </li>
              ))}
            </ul>
            <label className="reason-field">Motivo de la revisión<input value={reason} minLength="5" required onChange={(event) => setReason(event.target.value)} /></label>
            <div className="review-actions">
              <button type="button" onClick={closeReview}>Volver</button>
              <button type="button" className="refresh" disabled={reason.trim().length < 5} onClick={save}>
                <Check aria-hidden="true" /> Confirmar y activar
              </button>
            </div>
          </div>
        </section>
      ) : null}

      <Panel title="Historial de revisiones" wide>
        {revisions.length ? (
          <ol className="revision-list">
            {revisions.slice(0, 10).map((revision) => (
              <li key={revision.id}>
                <History aria-hidden="true" />
                <span>
                  <strong>{revision.source}</strong>
                  <small>{new Date(revision.createdAt).toLocaleString("es-CU")}</small>
                </span>
                <code>{revision.hash.slice(0, 12)}</code>
              </li>
            ))}
          </ol>
        ) : (
          <Empty>Sin revisiones registradas.</Empty>
        )}
      </Panel>
    </div>
  );
}

function diffConfig(saved, draft) {
  if (!saved || !draft) return [];
  const rootChanges = [
    ["maxOpenOffers", "Máximo de ofertas propias"],
  ].flatMap(([key, label]) => saved[key] === draft[key] ? [] : [{ key, label, before: saved[key], after: draft[key] }]);
  const riskChanges = riskFields.flatMap(([key, label]) =>
    saved.risk[key] === draft.risk[key]
      ? []
      : [{ key, label, before: saved.risk[key], after: draft.risk[key] }],
  );
  const automationChanges = [
    ...automationFields.map(([key, label]) => [key, label]),
    ["welcomeMessage", "Mensaje automático P2P"],
  ].flatMap(([key, label]) =>
    saved.automation?.[key] === draft.automation?.[key]
      ? []
      : [{
          key: `automation:${key}`,
          label,
          before: saved.automation?.[key] ?? "",
          after: draft.automation?.[key] ?? "",
        }],
  );
  const marketChanges = draft.markets.flatMap((market, index) => {
    const before = saved.markets[index];
    if (!before) return [{ key: `market:${market.code}`, label: market.label, before: "Nuevo", after: "Activo" }];
    return ["code", "label", "currency", "active", "fiatBalance", "buyMaxRate", "sellMinRate", "purchaseMaxQusd", "sellFeePercent", "outgoingTransferFee", "paymentDetails"].flatMap(
      (key) =>
        JSON.stringify(before[key]) === JSON.stringify(market[key])
          ? []
          : [{
              key: `market:${market.code}:${key}`,
              label: `${market.label} · ${key}`,
              before: key === "paymentDetails" ? `${before[key].length} dato(s)` : String(before[key]),
              after: key === "paymentDetails" ? `${market[key].length} dato(s)` : String(market[key]),
            }],
    );
  });
  return [...rootChanges, ...automationChanges, ...riskChanges, ...marketChanges];
}
