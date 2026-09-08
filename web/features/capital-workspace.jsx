import React, { useCallback, useMemo, useState } from "react";
import { AlertTriangle, ArrowDownToLine, ArrowUpFromLine, Pencil, Plus, X } from "lucide-react";
import { Offers } from "../components/offers.jsx";
import { Freshness, Panel, Skeleton } from "../components/common.jsx";
import { money } from "../lib/format.js";
import { requestJson } from "../lib/http.js";
import { useDialog } from "../hooks/use-dialog.js";
import { median, outgoingFiatCost } from "../../src/market-math.js";

export function CapitalWorkspace({ data, label, unit, onChanged, resources }) {
  const [editor, setEditor] = useState();
  const [pendingCancel, setPendingCancel] = useState();
  const [cancelError, setCancelError] = useState("");
  const [cancelling, setCancelling] = useState(false);
  const closeCancel = useCallback(() => {
    if (!cancelling) setPendingCancel(undefined);
  }, [cancelling]);
  const cancelDialogRef = useDialog(Boolean(pendingCancel), closeCancel);

  const openCreate = () => setEditor({ mode: "create", coin: data.markets[0]?.code || "", type: "buy", amount: "", rate: "" });
  const openEdit = (offer) => setEditor({ mode: "edit", offer, coin: offer.coin, type: offer.type, amount: String(offer.amount), rate: String(offer.rate) });
  const submitOffer = async (values) => {
    const payload = { amount: Number(values.amount), rate: Number(values.rate) };
    if (values.mode === "create") {
      await requestJson("/api/offers", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ coin: values.coin, type: values.type, ...payload }),
      });
    } else {
      await requestJson(`/api/offers/${encodeURIComponent(values.offer.uuid)}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
    }
    setEditor(undefined);
    await onChanged?.();
  };
  const cancelOffer = async () => {
    if (!pendingCancel) return;
    setCancelling(true);
    setCancelError("");
    try {
      await requestJson(`/api/offers/${encodeURIComponent(pendingCancel.uuid)}`, { method: "DELETE" });
      setPendingCancel(undefined);
      await onChanged?.();
    } catch (error) {
      setCancelError(error instanceof Error ? error.message : "No se pudo cancelar la oferta.");
    } finally {
      setCancelling(false);
    }
  };

  return (
    <div className="capital-stack">
      <Panel title="Capital disponible" wide>
        <Freshness state={resources.balance} cachedAt={data.freshness?.balance} />
        {resources.balance?.loading && !data.freshness?.balance ? <Skeleton label="Consultando saldo QUSD" /> : null}
        <div className="market-grid capital-grid">
          {data.markets.map((market) => {
            const availability = data.availability.fiat[market.code] || {};
            return (
              <article className="market-card capital-card" key={market.code}>
                <span>{label(market.code)}</span>
                <strong>{money(availability.available)} {unit(market.code)}</strong>
                <small>{money(availability.committed)} comprometidos · {money(availability.declared)} declarados</small>
                {market.outgoingTransferFee > 0 ? <em>{money(market.outgoingTransferFee)} {unit(market.code)} por cada salida</em> : null}
              </article>
            );
          })}
        </div>
      </Panel>

      <Panel title="Mis ofertas" wide>
        <div className="capital-toolbar">
          <Freshness state={resources.ownOffers} cachedAt={data.freshness?.ownOffers} />
          <button className="refresh" onClick={openCreate}><Plus aria-hidden="true" /> Nueva oferta</button>
        </div>
        {editor ? (
          <OfferEditor
            key={`${editor.mode}:${editor.offer?.uuid || "new"}`}
            initial={editor}
            data={data}
            label={label}
            unit={unit}
            onClose={() => setEditor(undefined)}
            onSubmit={submitOffer}
          />
        ) : null}
        {resources.ownOffers?.loading && !data.freshness?.ownOffers ? (
          <Skeleton rows={5} label="Consultando ofertas propias" />
        ) : (
          <Offers
            offers={data.ownOffers}
            label={label}
            unit={unit}
            editable
            onEdit={openEdit}
            onCancel={(offer) => { setCancelError(""); setPendingCancel(offer); }}
          />
        )}
        {resources.ownOffers?.error ? <p className="inline-error">{resources.ownOffers.error}</p> : null}
      </Panel>

      {pendingCancel ? (
        <section ref={cancelDialogRef} className="offer-modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="cancel-offer-title">
          <div className="offer-modal cancel-offer-dialog">
            <div className="dialog-icon danger-icon"><AlertTriangle aria-hidden="true" /></div>
            <p className="eyebrow">ACCIÓN DESTRUCTIVA</p>
            <h2 id="cancel-offer-title">Eliminar esta oferta</h2>
            <p>La oferta dejará de estar disponible en QvaPay. Esta acción no modifica las operaciones ya iniciadas.</p>
            <dl className="offer-summary">
              <div><dt>Mercado</dt><dd>{label(pendingCancel.coin)}</dd></div>
              <div><dt>Lado</dt><dd>{pendingCancel.type === "buy" ? "Compra" : "Venta"}</dd></div>
              <div><dt>Importe</dt><dd>{money(pendingCancel.amount)} QUSD</dd></div>
              <div><dt>Tasa</dt><dd>{money(pendingCancel.rate, unit(pendingCancel.coin) === "USD" ? 4 : 2)} {unit(pendingCancel.coin)}</dd></div>
            </dl>
            {cancelError ? <p className="form-error" role="alert">{cancelError}</p> : null}
            <div className="offer-modal-actions">
              <button type="button" onClick={closeCancel} disabled={cancelling}>Conservar oferta</button>
              <button type="button" className="danger-confirm" onClick={cancelOffer} disabled={cancelling}>{cancelling ? "Eliminando…" : "Sí, eliminar oferta"}</button>
            </div>
          </div>
        </section>
      ) : null}
    </div>
  );
}

function OfferEditor({ initial, data, label, unit, onClose, onSubmit }) {
  const [values, setValues] = useState(initial);
  const [status, setStatus] = useState("");
  const [saving, setSaving] = useState(false);
  const market = data.markets.find((item) => item.code === values.coin);
  const amount = Number(values.amount);
  const rate = Number(values.rate);
  const validNumbers = Number.isFinite(amount) && amount > 0 && Number.isFinite(rate) && rate > 0;
  const paysFiat = values.type === "buy";
  const transfer = outgoingFiatCost(validNumbers ? amount : 0, validNumbers ? rate : 0, paysFiat ? market?.outgoingTransferFee || 0 : 0);
  const marketReference = useMemo(() => referenceMedian(data, values.coin, values.type), [data, values.coin, values.type]);
  const deviation = marketReference && rate > 0 ? ((rate - marketReference) / marketReference) * 100 : undefined;
  const favorableDeviation = deviation === undefined
    ? undefined
    : values.type === "buy"
      ? deviation <= 0
      : deviation >= 0;
  const availability = data.availability.fiat[values.coin] || {};
  const currentCommitment = initial.mode === "edit" && initial.type === "buy" ? Number(initial.offer.receive) + (market?.outgoingTransferFee || 0) : 0;
  const spendable = Number(availability.available || 0) + currentCommitment;
  const exceedsBalance = paysFiat && validNumbers && transfer.total > spendable + 0.000001;
  const invalid = !market || !validNumbers || exceedsBalance;
  const setField = (key, value) => setValues((current) => ({ ...current, [key]: value }));
  const submit = async (event) => {
    event.preventDefault();
    if (invalid || saving) return;
    setSaving(true);
    setStatus("");
    try {
      await onSubmit(values);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "No se pudo guardar la oferta.");
      setSaving(false);
    }
  };

  return (
    <section className="offer-workbench" aria-labelledby="offer-editor-title">
      <header>
        <div className="dialog-icon">{initial.mode === "create" ? <Plus aria-hidden="true" /> : <Pencil aria-hidden="true" />}</div>
        <div>
          <p className="eyebrow">{initial.mode === "create" ? "NUEVA POSICIÓN" : "AJUSTAR POSICIÓN"}</p>
          <h3 id="offer-editor-title">{initial.mode === "create" ? "Crear oferta" : `Editar ${label(initial.coin)}`}</h3>
          <p>Los cálculos se actualizan antes de enviar cualquier cambio a QvaPay.</p>
        </div>
        <button type="button" className="icon-action" onClick={onClose} aria-label="Cerrar editor"><X aria-hidden="true" /></button>
      </header>
      <form onSubmit={submit}>
        <div className="offer-fields">
          <label><span>Mercado</span><select value={values.coin} disabled={initial.mode === "edit"} onChange={(event) => setField("coin", event.target.value)}>{data.markets.map((item) => <option key={item.code} value={item.code}>{label(item.code)}</option>)}</select></label>
          <label><span>Movimiento</span><select value={values.type} disabled={initial.mode === "edit"} onChange={(event) => setField("type", event.target.value)}><option value="buy">Comprar QUSD</option><option value="sell">Vender QUSD</option></select></label>
          <label><span>Importe</span><span className="input-unit"><input type="number" min="0.01" step="0.01" inputMode="decimal" value={values.amount} onChange={(event) => setField("amount", event.target.value)} autoFocus /><small>QUSD</small></span></label>
          <label><span>Tasa</span><span className="input-unit"><input type="number" min="0.0001" step="0.0001" inputMode="decimal" value={values.rate} onChange={(event) => setField("rate", event.target.value)} /><small>{unit(values.coin)}/QUSD</small></span></label>
        </div>
        <div className="offer-calculation">
          <div className="calculation-lead">
            {paysFiat ? <ArrowUpFromLine aria-hidden="true" /> : <ArrowDownToLine aria-hidden="true" />}
            <span>{paysFiat ? "Salida total estimada" : "Ingreso bruto estimado"}</span>
            <strong>{money(transfer.total, unit(values.coin) === "USD" ? 4 : 2)} {unit(values.coin)}</strong>
          </div>
          <dl>
            <div><dt>Importe fiat</dt><dd>{money(transfer.nominal, unit(values.coin) === "USD" ? 4 : 2)}</dd></div>
            <div><dt>Comisión de salida</dt><dd>{paysFiat ? money(transfer.fee, 2) : "No aplica"}</dd></div>
            <div><dt>Tasa efectiva</dt><dd>{money(transfer.effectiveRate, 4)}</dd></div>
            <div><dt>Mediana del mercado</dt><dd>{marketReference ? money(marketReference, 4) : "Sin muestra"}</dd></div>
            <div><dt>Diferencia</dt><dd className={favorableDeviation === undefined ? "" : favorableDeviation ? "positive-value" : "negative-value"}>{deviation === undefined ? "—" : `${deviation > 0 ? "+" : ""}${money(deviation, 2)}%`}</dd></div>
            <div><dt>Fiat disponible</dt><dd>{money(spendable, unit(values.coin) === "USD" ? 2 : 0)}</dd></div>
          </dl>
        </div>
        {exceedsBalance ? <p className="form-error" role="alert">La salida total supera el fiat disponible en {label(values.coin)}.</p> : null}
        {status ? <p className="form-error" role="alert">{status}</p> : null}
        <footer><button type="button" onClick={onClose}>Descartar</button><button type="submit" className="refresh" disabled={invalid || saving}>{saving ? "Guardando…" : initial.mode === "create" ? "Crear oferta" : "Guardar cambios"}</button></footer>
      </form>
    </section>
  );
}

function referenceMedian(data, coin, ownType) {
  const side = ownType === "buy" ? "sell" : "buy";
  const cached = data.averages?.[coin]?.[side === "sell" ? "median_sell" : "median_buy"];
  if (Number.isFinite(cached)) return cached;
  return median((data.market?.[coin]?.offers || []).filter((offer) => offer.type === side).map((offer) => Number(offer.rate)));
}
