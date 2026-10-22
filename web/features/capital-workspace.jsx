import React, { useCallback, useEffect, useMemo, useState } from "react";
import { FiatHistory } from "./operational-insights.jsx";
import { ArrowDownToLine, ArrowUpFromLine, Pencil, Plus, Scale, X } from "lucide-react";
import { Offers } from "../components/offers.jsx";
import { Freshness, Panel, Skeleton, ViewHead } from "../components/common.jsx";
import { money } from "../lib/format.js";
import { requestJson } from "../lib/http.js";
import { indexDecimalPlaces, median, ownOfferFiatTotal, roundRateForIndex } from "../../src/market-math.js";
import { Button, IconButton, Input, Select } from "../components/ui.jsx";
import { Field, FieldGroup, FieldLabel } from "../components/ui/field.tsx";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../components/ui/dialog.tsx";
import { MarketIdentity } from "../components/market-identity.jsx";

export function CapitalWorkspace({ data, label, unit, onChanged, resources }) {
  const [editor, setEditor] = useState();
  const [pendingCancel, setPendingCancel] = useState();
  const [cancelError, setCancelError] = useState("");
  const [cancelling, setCancelling] = useState(false);
  const [rebalance, setRebalance] = useState();
  const [loadingRebalance, setLoadingRebalance] = useState(false);
  const closeCancel = useCallback(() => {
    if (!cancelling) setPendingCancel(undefined);
  }, [cancelling]);
  const hasDeficit = Object.values(data.budget || {}).some((plan) => Number(plan.deficit) > 0.000001);

  const openRebalance = async () => {
    setLoadingRebalance(true);
    try {
      const payload = await requestJson("/api/offers/rebalance/preview", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
        timeoutMs: 25_000,
      });
      setRebalance({ ...payload.data, error: "" });
    } catch (error) {
      setRebalance({ plans: [], error: error instanceof Error ? error.message : "No se pudo preparar el reajuste." });
    } finally {
      setLoadingRebalance(false);
    }
  };

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
      <ViewHead
        title="Capital"
      />
      <Panel title="Capital disponible" wide>
        <Freshness state={resources.balance} cachedAt={data.freshness?.balance} />
        {resources.balance?.loading && !data.freshness?.balance ? <Skeleton label="Consultando saldo QUSD" /> : null}
        <div className="market-grid capital-grid">
          {data.markets.map((market) => {
            const availability = data.availability.fiat[market.code] || {};
            return (
              <article className="market-card capital-card" key={market.code}>
                <MarketIdentity market={market} size="sm" />
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
          <Button variant={hasDeficit ? "destructive" : "secondary"} onClick={openRebalance} disabled={!hasDeficit || loadingRebalance}>
            <Scale aria-hidden="true" /> {loadingRebalance ? "Calculando…" : "Reajustar capital"}
          </Button>
          <Button variant="primary" onClick={openCreate}><Plus aria-hidden="true" /> Nueva oferta</Button>
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
            markets={data.markets}
            label={label}
            unit={unit}
            editable
            onEdit={openEdit}
            onCancel={(offer) => { setCancelError(""); setPendingCancel(offer); }}
          />
        )}
        {resources.ownOffers?.error ? <p className="inline-error" role="alert">{resources.ownOffers.error}</p> : null}
      </Panel>

      <FiatHistory markets={data.markets} />

      <Dialog open={Boolean(pendingCancel)} onOpenChange={(open) => !open && closeCancel()}>
        {pendingCancel ? (
          <DialogContent className="review-dialog cancel-offer-dialog">
            <DialogHeader>
              <DialogTitle>Eliminar esta oferta</DialogTitle>
              <DialogDescription>La oferta dejará de estar disponible en QvaPay. Las operaciones iniciadas no cambian.</DialogDescription>
            </DialogHeader>
            <dl className="offer-summary">
              <div><dt>Mercado</dt><dd>{label(pendingCancel.coin)}</dd></div>
              <div><dt>Lado</dt><dd>{pendingCancel.type === "buy" ? "Compra" : "Venta"}</dd></div>
              <div><dt>Importe</dt><dd>{money(pendingCancel.amount)} QUSD</dd></div>
              <div><dt>Tasa</dt><dd>{money(pendingCancel.rate, unit(pendingCancel.coin) === "USD" ? 4 : 2)} {unit(pendingCancel.coin)}</dd></div>
            </dl>
            {cancelError ? <p className="form-error" role="alert">{cancelError}</p> : null}
            <DialogFooter>
              <Button variant="ghost" type="button" onClick={closeCancel} disabled={cancelling}>Conservar oferta</Button>
              <Button variant="destructive" type="button" onClick={cancelOffer} disabled={cancelling}>{cancelling ? "Eliminando…" : "Sí, eliminar oferta"}</Button>
            </DialogFooter>
          </DialogContent>
        ) : null}
      </Dialog>
      {rebalance ? (
        <RebalanceDialog
          initial={rebalance}
          data={data}
          label={label}
          unit={unit}
          onClose={() => setRebalance(undefined)}
          onChanged={onChanged}
        />
      ) : null}
    </div>
  );
}

function RebalanceDialog({ initial, data, label, unit, onClose, onChanged }) {
  const [preview, setPreview] = useState(initial);
  const [values, setValues] = useState(() => Object.fromEntries(
    initial.plans.flatMap((plan) => plan.adjustments.map((item) => [item.uuid, String(item.proposedQusd)])),
  ));
  const [error, setError] = useState(initial.error || "");
  const [applying, setApplying] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [job, setJob] = useState();
  const close = useCallback(() => onClose(), [onClose]);
  const refreshPreview = useCallback(async () => {
    setRefreshing(true);
    try {
      const payload = await requestJson("/api/offers/rebalance/preview", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ refresh: true }),
        timeoutMs: 25_000,
      });
      const next = payload.data;
      setPreview(next);
      setValues((current) => Object.fromEntries(
        next.plans.flatMap((plan) => plan.adjustments.map((item) => [
          item.uuid,
          current[item.uuid] ?? String(item.proposedQusd),
        ])),
      ));
      setError("");
      return next;
    } catch (cause) {
      setError(
        `Se conserva el cálculo local. ${cause instanceof Error ? cause.message : "No se pudieron actualizar las ofertas."}`,
      );
      return undefined;
    } finally {
      setRefreshing(false);
    }
  }, []);
  useEffect(() => {
    if (!job) void refreshPreview();
  }, [job, refreshPreview]);
  useEffect(() => {
    if (!job?.id || ["completed", "partial", "failed"].includes(job.state)) return undefined;
    let active = true;
    const poll = async () => {
      try {
        const payload = await requestJson(`/api/offers/rebalance/${encodeURIComponent(job.id)}`, { timeoutMs: 5_000 });
        if (!active) return;
        setJob(payload.data);
        if (payload.data.state !== job.state && ["completed", "partial", "failed", "reconciliation_required"].includes(payload.data.state))
          await onChanged?.();
      } catch (reason) {
        if (active) setError(reason instanceof Error ? reason.message : "No se pudo consultar el progreso.");
      }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), 2_000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [job?.id, job?.state, onChanged]);
  const plans = preview.plans || [];
  const previewIsStale = !preview.updatedAt || Date.now() - preview.updatedAt > 60_000;
  const summaries = plans.map((plan) => {
    const market = data.markets.find((item) => item.code === plan.coin);
    const proposed = plan.committed - plan.adjustments.reduce((sum, item) => sum + item.currentFiat, 0)
      + plan.adjustments.reduce((sum, item) => {
        const amount = Number(values[item.uuid]);
        if (!Number.isFinite(amount) || amount <= 0) return sum;
        return sum + ownOfferFiatTotal(amount, item.rate, "buy", market?.currency || "") + (market?.outgoingTransferFee || 0);
      }, 0);
    return { plan, market, proposed, valid: proposed <= plan.available + 0.000001 };
  });
  const invalidAmount = plans.some((plan) => plan.adjustments.some((item) => {
    const amount = Number(values[item.uuid]);
    return !Number.isFinite(amount) || amount < 0 || amount > item.currentQusd + 0.000001;
  }));
  const valid = plans.length > 0 && !invalidAmount && summaries.every((item) => item.valid);
  const apply = async () => {
    if (!valid || applying) return;
    setApplying(true);
    setError("");
    try {
      let activePlans = plans;
      if (previewIsStale) {
        const refreshed = await refreshPreview();
        if (!refreshed) return;
        activePlans = refreshed.plans;
      }
      const payload = await requestJson("/api/offers/rebalance/apply", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          adjustments: activePlans.flatMap((plan) => plan.adjustments.map((item) => ({
            uuid: item.uuid,
            amount: Number(values[item.uuid] ?? item.proposedQusd),
          }))),
        }),
        timeoutMs: 10_000,
      });
      setJob(payload.data);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "No se pudo aplicar el reajuste.");
    } finally {
      setApplying(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && close()}>
      <DialogContent className="offer-modal rebalance-dialog" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>Reajustar ofertas de compra</DialogTitle>
          <DialogDescription>Reduce cantidades hasta quedar dentro del fiat disponible; las tasas se conservan.</DialogDescription>
        </DialogHeader>
        <DialogClose asChild>
          <IconButton variant="ghost" className="absolute top-2 right-2" aria-label="Cerrar reajuste" title="Cerrar reajuste"><X aria-hidden="true" /></IconButton>
        </DialogClose>
        <p className={`rebalance-freshness ${previewIsStale ? "stale" : ""}`}>
          {refreshing
            ? "Actualizando ofertas con QvaPay…"
            : preview.updatedAt
              ? `Ofertas verificadas ${new Date(preview.updatedAt).toLocaleString("es-CU")}.`
              : "Todavía no hay una lista de ofertas verificada."}
        </p>
        {summaries.map(({ plan, market, proposed, valid: marketValid }) => (
          <section className="rebalance-market" key={plan.coin}>
            <div className="rebalance-market-summary">
              <MarketIdentity market={market || { code: plan.coin, label: label(plan.coin) }} size="sm" />
              <span className={marketValid ? "positive-value" : "negative-value"}>{money(proposed, market?.currency === "USD" ? 2 : 0)} / {money(plan.available, market?.currency === "USD" ? 2 : 0)} {unit(plan.coin)}</span>
            </div>
            <div className="rebalance-adjustments">
              {plan.adjustments.map((item) => {
                const amount = Number(values[item.uuid]);
                const effective = amount > 0
                  ? (ownOfferFiatTotal(amount, item.rate, "buy", market?.currency || "") + (market?.outgoingTransferFee || 0)) / amount
                  : 0;
                const index = market?.buyMaxRate || item.rate;
                const shownRate = amount > 0 ? roundRateForIndex(effective, "buy", index) : 0;
                const amountId = `rebalance-amount-${item.uuid}`;
                return (
                  <Field className="rebalance-row" key={item.uuid}>
                    <div className="rebalance-offer">
                      <strong>{money(item.currentQusd)} QUSD</strong>
                      <small>Tasa {money(shownRate, indexDecimalPlaces(index))} {unit(plan.coin)} · se conserva {item.rate}</small>
                    </div>
                    <div className="rebalance-amount">
                      <FieldLabel htmlFor={amountId}>Nuevo importe</FieldLabel>
                      <span className="input-unit"><Input id={amountId} type="number" min="0" max={item.currentQusd} step="0.01" inputMode="decimal" value={values[item.uuid]} onChange={(event) => setValues((current) => ({ ...current, [item.uuid]: event.target.value }))} /><small>QUSD</small></span>
                    </div>
                    <em>{amount === 0 ? "Se cancelará" : "Se mantiene"}</em>
                  </Field>
                );
              })}
            </div>
          </section>
        ))}
        {invalidAmount ? <p className="form-error" role="alert">Cada cantidad debe estar entre cero y su importe actual.</p> : null}
        {!invalidAmount && summaries.some((item) => !item.valid) ? <p className="form-error" role="alert">Todavía hay más fiat comprometido que declarado. Reduce un poco más las cantidades.</p> : null}
        {error ? <p className="form-error" role="alert">{error}</p> : null}
        {job ? <RebalanceProgress job={job} /> : null}
        <DialogFooter>
          <Button variant="ghost" onClick={close}>{job ? "Cerrar" : "Cancelar"}</Button>
          {!job ? <Button variant="primary" onClick={apply} disabled={!valid || applying || (refreshing && previewIsStale)}>{applying ? "Validando…" : previewIsStale ? "Validar y aplicar" : "Aceptar reajuste"}</Button> : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RebalanceProgress({ job }) {
  const completed = job.adjustments.filter((item) => item.state === "completed").length;
  const labels = {
    pending: "Reajuste en cola",
    applying: "Aplicando reajuste",
    completed: "Reajuste completado",
    partial: "Reajuste completado parcialmente",
    reconciliation_required: "Esperando confirmación de QvaPay",
    failed: "No se pudo completar el reajuste",
  };
  return (
    <div className={`rebalance-progress state-${job.state}`} role="status" aria-live="polite">
      <strong>{labels[job.state] || "Procesando reajuste"}</strong>
      <span>{completed} de {job.adjustments.length} ofertas procesadas</span>
      <div aria-hidden="true"><span style={{ width: `${job.adjustments.length ? completed / job.adjustments.length * 100 : 0}%` }} /></div>
      {job.error ? <small>{job.error}</small> : null}
      {["pending", "applying", "reconciliation_required"].includes(job.state) ? <small>Puedes cerrar esta ventana; QvaApply continuará en segundo plano.</small> : null}
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
  const roundedReceive = validNumbers
    ? ownOfferFiatTotal(amount, rate, paysFiat ? "buy" : "sell", market?.currency || "")
    : 0;
  const transfer = {
    nominal: roundedReceive,
    fee: paysFiat ? market?.outgoingTransferFee || 0 : 0,
    total: roundedReceive + (paysFiat ? market?.outgoingTransferFee || 0 : 0),
    effectiveRate: amount > 0 ? (roundedReceive + (paysFiat ? market?.outgoingTransferFee || 0 : 0)) / amount : 0,
  };
  const configuredIndex = values.type === "buy" ? market?.buyMaxRate : market?.sellMinRate;
  const indexedEffectiveRate = configuredIndex && validNumbers
    ? roundRateForIndex(transfer.effectiveRate, values.type, configuredIndex)
    : transfer.effectiveRate;
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
          <p className="eyebrow">{initial.mode === "create" ? "Nueva posición" : "Ajustar posición"}</p>
          <h3 id="offer-editor-title">{initial.mode === "create" ? "Crear oferta" : `Editar ${label(initial.coin)}`}</h3>
        </div>
              <IconButton variant="ghost" type="button" onClick={onClose} aria-label="Cerrar editor"><X aria-hidden="true" /></IconButton>
      </header>
      <form onSubmit={submit}>
        <FieldGroup className="offer-fields">
          <Field className="offer-field"><FieldLabel htmlFor="offer-coin">Mercado</FieldLabel><Select id="offer-coin" value={values.coin} disabled={initial.mode === "edit"} onValueChange={(value) => setField("coin", value)} options={data.markets.map((item) => ({ value: item.code, label: label(item.code) }))} /></Field>
          <Field className="offer-field"><FieldLabel htmlFor="offer-type">Movimiento</FieldLabel><Select id="offer-type" value={values.type} disabled={initial.mode === "edit"} onValueChange={(value) => setField("type", value)} options={[{ value: "buy", label: "Comprar QUSD" }, { value: "sell", label: "Vender QUSD" }]} /></Field>
          <Field className="offer-field"><FieldLabel htmlFor="offer-amount">Importe</FieldLabel><span className="input-unit"><Input id="offer-amount" type="number" min="0.01" step="0.01" inputMode="decimal" value={values.amount} onChange={(event) => setField("amount", event.target.value)} autoFocus /><small>QUSD</small></span></Field>
          <Field className="offer-field"><FieldLabel htmlFor="offer-rate">Tasa</FieldLabel><span className="input-unit"><Input id="offer-rate" type="number" min="0.0001" step="0.0001" inputMode="decimal" value={values.rate} onChange={(event) => setField("rate", event.target.value)} /><small>{unit(values.coin)}/QUSD</small></span></Field>
        </FieldGroup>
        <div className="offer-calculation">
          <div className="calculation-lead">
            {paysFiat ? <ArrowUpFromLine aria-hidden="true" /> : <ArrowDownToLine aria-hidden="true" />}
            <span>{paysFiat ? "Salida total estimada" : "Ingreso bruto estimado"}</span>
            <strong>{money(transfer.total, unit(values.coin) === "USD" ? 4 : 2)} {unit(values.coin)}</strong>
          </div>
          <dl>
            <div><dt>Importe fiat</dt><dd>{money(transfer.nominal, unit(values.coin) === "USD" ? 4 : 2)}</dd></div>
            <div><dt>Comisión de salida</dt><dd>{paysFiat ? money(transfer.fee, 2) : "No aplica"}</dd></div>
            <div><dt>Tasa efectiva</dt><dd>{money(indexedEffectiveRate, configuredIndex ? indexDecimalPlaces(configuredIndex) : 4)}</dd></div>
            <div><dt>Mediana del mercado</dt><dd>{marketReference ? money(marketReference, 4) : "Sin muestra"}</dd></div>
            <div><dt>Diferencia</dt><dd className={favorableDeviation === undefined ? "" : favorableDeviation ? "positive-value" : "negative-value"}>{deviation === undefined ? "—" : `${deviation > 0 ? "+" : ""}${money(deviation, 2)}%`}</dd></div>
            <div><dt>Fiat disponible</dt><dd>{money(spendable, unit(values.coin) === "USD" ? 2 : 0)}</dd></div>
          </dl>
        </div>
        {exceedsBalance ? <p className="form-error" role="alert">La salida total supera el fiat disponible en {label(values.coin)}.</p> : null}
        {status ? <p className="form-error" role="alert">{status}</p> : null}
        <footer><Button variant="ghost" type="button" onClick={onClose}>Descartar</Button><Button variant="primary" type="submit" disabled={invalid || saving}>{saving ? "Guardando…" : initial.mode === "create" ? "Crear oferta" : "Guardar cambios"}</Button></footer>
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
