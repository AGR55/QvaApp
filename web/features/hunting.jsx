import React, { useMemo, useState } from "react";
import {
  AlertTriangle,
  Crosshair,
  Save,
  ShoppingCart,
  Tags,
} from "lucide-react";
import { Empty, Panel, ViewHead } from "../components/common.jsx";
import { money } from "../lib/format.js";
import { requestJson } from "../lib/http.js";
import { Badge, Button, Input } from "../components/ui.jsx";
import { Field, FieldContent, FieldLabel, FieldTitle } from "../components/ui/field.tsx";
import { MarketIdentity } from "../components/market-identity.jsx";
import { Switch } from "../components/ui/switch.tsx";
import { ToggleGroup, ToggleGroupItem } from "../components/ui/toggle-group.tsx";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogTitle,
} from "../components/ui/alert-dialog.tsx";

const cancellableStates = new Set(["applied", "acknowledged"]);

export function Hunting({ data, label, unit, onChanged }) {
  const [busy, setBusy] = useState("");
  const [status, setStatus] = useState("");
  const [pendingCancel, setPendingCancel] = useState();
  const [rates, setRates] = useState(() => rateDraft(data.markets));
  const [optimistic, setOptimistic] = useState({ hunting: {}, markets: {} });
  const hunting = { ...data.hunting, ...optimistic.hunting };
  const markets = data.markets.map((market) => ({
    ...market,
    ...(optimistic.markets[market.code] || {}),
  }));
  const closeCancel = () => {
    if (!busy) setPendingCancel(undefined);
  };
  const captured = useMemo(
    () => (data.operations || []).filter((operation) => operation.autoApplied),
    [data.operations],
  );

  const update = async (key, payload, success) => {
    const previous = optimistic;
    setOptimistic((current) => applyOptimisticHunting(current, payload));
    setBusy(key);
    setStatus("");
    try {
      await requestJson("/api/hunting", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      await onChanged?.();
      setOptimistic({ hunting: {}, markets: {} });
      setStatus(success);
    } catch (error) {
      setOptimistic(previous);
      setStatus(
        error instanceof Error
          ? error.message
          : "No se pudo actualizar la cacería.",
      );
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
      await requestJson(
        `/api/operations/${encodeURIComponent(pendingCancel.uuid)}/cancel`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        },
      );
      setPendingCancel(undefined);
      await onChanged?.();
      setStatus("Aplicación cancelada y registrada.");
    } catch (error) {
      setStatus(
        error instanceof Error
          ? error.message
          : "No se pudo cancelar la aplicación.",
      );
    } finally {
      setBusy("");
    }
  };
  const masterSides = [
    ...(hunting.buyRunning ? ["buy"] : []),
    ...(hunting.sellRunning ? ["sell"] : []),
  ];
  const updateMasterSides = (nextSides) => {
    if (busy) return;
    const buyRunning = nextSides.includes("buy");
    if (buyRunning !== hunting.buyRunning) {
      update(
        "master:buy",
        { buyRunning },
        buyRunning ? "Cacería de compra iniciada." : "Cacería de compra detenida.",
      );
      return;
    }
    const sellRunning = nextSides.includes("sell");
    if (sellRunning !== hunting.sellRunning) {
      update(
        "master:sell",
        { sellRunning },
        sellRunning ? "Cacería de venta iniciada." : "Cacería de venta detenida.",
      );
    }
  };

  return (
    <div className="hunting-stack">
      <ViewHead
        title="Cacería"
      />
      <section className="hunting-command" aria-label="Controles de cacería">
        <div className="hunt-scan-status">
          <strong>
            {data.state.paused
              ? "Motor general pausado"
              : `Escaneo cada ${data.automation?.scanIntervalSeconds || "—"} s`}
          </strong>
          <small>
            {data.state.lastScan
              ? `Último: ${new Date(data.state.lastScan.at).toLocaleTimeString("es-CU")} · ${data.state.lastScan.result}`
              : "Aún no hay escaneos registrados"}
          </small>
        </div>
        <ToggleGroup
          type="multiple"
          value={masterSides}
          onValueChange={updateMasterSides}
          className="hunt-master-grid"
          aria-label="Lados de cacería"
          disabled={Boolean(busy)}
        >
          <MasterToggle
            side="buy"
            running={hunting.buyRunning}
            paused={data.state.paused}
            busy={busy === "master:buy"}
            disabled={Boolean(busy)}
          />
          <MasterToggle
            side="sell"
            running={hunting.sellRunning}
            paused={data.state.paused}
            busy={busy === "master:sell"}
            disabled={Boolean(busy)}
          />
        </ToggleGroup>
      </section>

      <Panel
        title="Mercados de cacería"
        wide
      >
        <div className="hunt-market-list">
          {markets.map((market) => {
            const draft = rates[market.code] || {
              buyMaxRate: market.buyMaxRate,
              sellMinRate: market.sellMinRate,
            };
            const stats = data.averages?.[market.code] || {};
            const savingRates = busy === `rates:${market.code}`;
            return (
              <article
                className={`hunt-market ${market.active ? "" : "disabled"}`}
                key={market.code}
              >
                <header>
                  <MarketIdentity market={market} size="lg" />
                  <strong>
                    {market.active ? "Disponible" : "Mercado inactivo"}
                  </strong>
                </header>
                <div className="hunt-side-grid">
                  <HuntSide
                    icon={ShoppingCart}
                    title="Comprar QUSD"
                    enabled={market.huntBuyEnabled}
                    running={hunting.buyRunning}
                    paused={data.state.paused}
                    disabled={!market.active || Boolean(busy)}
                    median={stats.median_sell}
                    rate={draft.buyMaxRate}
                    unit={unit(market.code)}
                    limitLabel="Máximo para cazar"
                    onToggle={() =>
                      update(
                        `market:${market.code}:buy`,
                        {
                          market: {
                            code: market.code,
                            huntBuyEnabled: !market.huntBuyEnabled,
                          },
                        },
                        `Compra ${market.huntBuyEnabled ? "desactivada" : "activada"} en ${label(market.code)}.`,
                      )
                    }
                    onRate={(value) =>
                      setRates((current) => ({
                        ...current,
                        [market.code]: {
                          ...current[market.code],
                          buyMaxRate: value,
                        },
                      }))
                    }
                  />
                  <HuntSide
                    icon={Tags}
                    title="Vender QUSD"
                    enabled={market.huntSellEnabled}
                    running={hunting.sellRunning}
                    paused={data.state.paused}
                    disabled={!market.active || Boolean(busy)}
                    median={stats.median_buy}
                    rate={draft.sellMinRate}
                    unit={unit(market.code)}
                    limitLabel="Mínimo para cazar"
                    onToggle={() =>
                      update(
                        `market:${market.code}:sell`,
                        {
                          market: {
                            code: market.code,
                            huntSellEnabled: !market.huntSellEnabled,
                          },
                        },
                        `Venta ${market.huntSellEnabled ? "desactivada" : "activada"} en ${label(market.code)}.`,
                      )
                    }
                    onRate={(value) =>
                      setRates((current) => ({
                        ...current,
                        [market.code]: {
                          ...current[market.code],
                          sellMinRate: value,
                        },
                      }))
                    }
                  />
                </div>
                <footer>
                  <Button
                    type="button"
                    variant="primary"
                    size="sm"
                    disabled={
                      !market.active ||
                      Boolean(busy) ||
                      !validRates(draft) ||
                      ratesEqual(draft, market)
                    }
                    onClick={() =>
                      update(
                        `rates:${market.code}`,
                        {
                          market: {
                            code: market.code,
                            buyMaxRate: Number(draft.buyMaxRate),
                            sellMinRate: Number(draft.sellMinRate),
                          },
                        },
                        `Precios de ${label(market.code)} actualizados.`,
                      )
                    }
                  >
                    <Save aria-hidden="true" data-icon="inline-start" />{" "}
                    {savingRates ? "Guardando…" : "Guardar precios"}
                  </Button>
                </footer>
              </article>
            );
          })}
        </div>
      </Panel>

      <Panel
        title="Ofertas cazadas"
        wide
      >
        <div className="capture-heading">
          <strong>
            {captured.length} captura{captured.length === 1 ? "" : "s"}
          </strong>
        </div>
        {captured.length ? (
          <div className="capture-list">
            {captured.map((operation) => (
              <article className="capture-row" key={operation.uuid}>
                <div
                  className={`capture-side ${operation.offerType === "sell" ? "buy" : "sell"}`}
                >
                  <Crosshair aria-hidden="true" />
                  <span>
                    {operation.offerType === "sell"
                      ? "Compra cazada"
                      : "Venta cazada"}
                  </span>
                </div>
                <div>
                  <span>Mercado</span>
                  <strong>{label(operation.coin)}</strong>
                  <small>
                    {new Date(operation.createdAt).toLocaleString("es-CU")}
                  </small>
                </div>
                <div>
                  <span>Importe</span>
                  <strong>{money(operation.amount)} QUSD</strong>
                  <small>
                    {money(
                      operation.receive,
                      unit(operation.coin) === "USD" ? 4 : 2,
                    )}{" "}
                    {unit(operation.coin)}
                  </small>
                </div>
                <div>
                  <span>Tasa capturada</span>
                  <strong>
                    {money(
                      operation.rate,
                      unit(operation.coin) === "USD" ? 4 : 2,
                    )}
                  </strong>
                  <small>
                    Mediana{" "}
                    {operation.referenceRate
                      ? money(
                          operation.referenceRate,
                          unit(operation.coin) === "USD" ? 4 : 2,
                        )
                      : "no registrada"}
                  </small>
                </div>
                <div className="capture-action">
                  <OperationState value={operation.state} />
                  {cancellableStates.has(operation.state) ? (
                    <Button
                      type="button"
                      variant="destructive"
                      size="sm"
                      disabled={Boolean(busy)}
                      onClick={() => setPendingCancel(operation)}
                    >
                      Cancelar aplicación
                    </Button>
                  ) : null}
                </div>
              </article>
            ))}
          </div>
        ) : (
          <Empty>
            Cuando el bot aplique una oferta con precio de caza, aparecerá aquí.
          </Empty>
        )}
      </Panel>

      {status ? (
        <p className="detail hunt-feedback" role="status" aria-live="polite">
          {status}
        </p>
      ) : null}
      <AlertDialog
        open={Boolean(pendingCancel)}
        onOpenChange={(open) => !open && closeCancel()}
      >
        {pendingCancel ? (
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogMedia>
                <AlertTriangle aria-hidden="true" />
              </AlertDialogMedia>
              <AlertDialogTitle>Cancelar esta aplicación</AlertDialogTitle>
              <AlertDialogDescription>
              Solo se cancelará esta operación; la cacería continuará activa.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <dl className="offer-summary">
              <div>
                <dt>Flujo</dt>
                <dd>
                  {pendingCancel.offerType === "sell"
                    ? "Comprar QUSD"
                    : "Vender QUSD"}
                </dd>
              </div>
              <div>
                <dt>Mercado</dt>
                <dd>{label(pendingCancel.coin)}</dd>
              </div>
              <div>
                <dt>Importe</dt>
                <dd>{money(pendingCancel.amount)} QUSD</dd>
              </div>
              <div>
                <dt>Tasa</dt>
                <dd>
                  {money(
                    pendingCancel.rate,
                    unit(pendingCancel.coin) === "USD" ? 4 : 2,
                  )}{" "}
                  {unit(pendingCancel.coin)}
                </dd>
              </div>
            </dl>
            <AlertDialogFooter>
              <AlertDialogCancel
                disabled={Boolean(busy)}
                onClick={closeCancel}
              >
                Mantener aplicación
              </AlertDialogCancel>
              <AlertDialogAction
                variant="destructive"
                onClick={(event) => {
                  event.preventDefault();
                  cancel();
                }}
                disabled={Boolean(busy)}
              >
                {busy ? "Cancelando…" : "Sí, cancelar aplicación"}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        ) : null}
      </AlertDialog>
    </div>
  );
}

function MasterToggle({ side, running, paused, busy, disabled }) {
  const buying = side === "buy";
  const Icon = buying ? ShoppingCart : Tags;
  const label = buying ? "Compra" : "Venta";
  const active = running && !paused;
  return (
    <ToggleGroupItem
      value={side}
      variant={active ? "default" : "outline"}
      size="sm"
      className={`hunt-master ${active ? "running" : "stopped"}`}
      aria-label={`Alternar cacería de ${label.toLowerCase()}`}
      disabled={disabled}
    >
      <Icon aria-hidden="true" data-icon="inline-start" />
      <span>{busy ? "Actualizando…" : label}</span>
    </ToggleGroupItem>
  );
}

function HuntSide({
  icon: Icon,
  title,
  enabled,
  running,
  paused,
  disabled,
  median,
  rate,
  unit,
  limitLabel,
  onToggle,
  onRate,
}) {
  const active = enabled && running && !paused;
  const state = !enabled
    ? "Fuera de cacería"
    : !running
      ? "Espera inicio"
      : paused
        ? "Pausa general"
        : "Buscando";
  return (
    <section className={`hunt-side ${active ? "active" : ""}`}>
      <div className="hunt-side-title">
        <Icon aria-hidden="true" />
        <div>
          <h4>{title}</h4>
        </div>
      </div>
      <Field orientation="horizontal" className="hunt-switch">
        <Switch
        id={`hunt-${title.replaceAll(" ", "-").toLowerCase()}`}
        checked={enabled}
        aria-label={`Activar ${title}`}
        onCheckedChange={onToggle}
        disabled={disabled}
      />
        <FieldContent>
          <FieldTitle>{enabled ? "Seleccionado" : "No cazar"}</FieldTitle>
        </FieldContent>
      </Field>
      <dl>
        <div>
          <dt>Mediana actual</dt>
          <dd>
            {Number.isFinite(Number(median))
              ? money(median, unit === "USD" ? 4 : 2)
              : "Sin muestra"}
          </dd>
        </div>
        <div>
          <dt>Estado efectivo</dt>
          <dd>{state}</dd>
        </div>
      </dl>
      <Field
        className="hunt-rate-field"
      >
        <FieldLabel htmlFor={`rate-${title.replaceAll(" ", "-").toLowerCase()}`}>{limitLabel}</FieldLabel>
        <span className="input-unit">
          <Input
            id={`rate-${title.replaceAll(" ", "-").toLowerCase()}`}
            type="number"
            min="0.0001"
            step="0.0001"
            value={rate}
            disabled={disabled}
            onChange={(event) => onRate(event.target.value)}
          />
          <small>{unit}/QUSD</small>
        </span>
      </Field>
    </section>
  );
}

function OperationState({ value }) {
  const labels = {
    applied: "Aplicada",
    acknowledged: "Pago anunciado",
    paid: "Pagada",
    cancelled: "Cancelada",
    completed: "Completada",
    failed: "Fallida",
  };
  return (
    <Badge className={`state state-${value}`}>{labels[value] || value}</Badge>
  );
}

function rateDraft(markets) {
  return Object.fromEntries(
    markets.map((market) => [
      market.code,
      {
        buyMaxRate: String(market.buyMaxRate),
        sellMinRate: String(market.sellMinRate),
      },
    ]),
  );
}

function applyOptimisticHunting(current, payload) {
  const next = {
    hunting: { ...current.hunting },
    markets: { ...current.markets },
  };
  if (payload.buyRunning !== undefined)
    next.hunting.buyRunning = payload.buyRunning;
  if (payload.sellRunning !== undefined)
    next.hunting.sellRunning = payload.sellRunning;
  if (payload.market?.code) {
    const { code, ...changes } = payload.market;
    next.markets[code] = { ...(next.markets[code] || {}), ...changes };
  }
  return next;
}

function validRates(value) {
  return (
    Number(value.buyMaxRate) > 0 &&
    Number(value.sellMinRate) > Number(value.buyMaxRate)
  );
}
function ratesEqual(value, market) {
  return (
    Number(value.buyMaxRate) === market.buyMaxRate &&
    Number(value.sellMinRate) === market.sellMinRate
  );
}
