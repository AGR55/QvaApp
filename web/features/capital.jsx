import React, { useState } from "react";
import { Offers } from "../components/offers.jsx";
import { Freshness, Panel, Skeleton } from "../components/common.jsx";
import { money } from "../lib/format.js";
import { requestJson } from "../lib/http.js";

export function Capital({ data, label, unit, onChanged, resources }) {
  const [form, setForm] = useState(),
    [message, setMessage] = useState("");
  const submit = async () => {
    if (!confirm("¿Crear esta oferta?")) return;
    try {
      await requestJson("/api/offers", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          coin: form.coin,
          type: form.type,
          amount: Number(form.amount),
          rate: Number(form.rate),
        }),
      });
      setForm(undefined);
      setMessage("");
      await onChanged?.();
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : "No se pudo crear la oferta.",
      );
    }
  };
  return (
    <>
      <Panel title="Capital disponible" wide>
        <Freshness state={resources.balance} cachedAt={data.freshness?.balance} />
        {resources.balance?.loading && !data.freshness?.balance ? <Skeleton label="Consultando saldo QUSD" /> : null}
        <div className="market-grid">
          {data.markets.map((market) => {
            const availability = data.availability.fiat[market.code] || {};
            return (
              <article className="market-card" key={market.code}>
                <span>{label(market.code)}</span>
                <strong>
                  {money(availability.available)} {unit(market.code)}
                </strong>
                <small>
                  {money(availability.committed)} comprometidos ·{" "}
                  {money(availability.declared)} declarados
                </small>
              </article>
            );
          })}
        </div>
      </Panel>
      <Panel title="Mis ofertas" wide>
        <Freshness state={resources.ownOffers} cachedAt={data.freshness?.ownOffers} />
        <button
          className="refresh"
          onClick={() =>
            setForm({
              coin: data.markets[0]?.code,
              type: "buy",
              amount: "",
              rate: "",
            })
          }
        >
          Nueva oferta
        </button>
        {form ? (
          <div className="settings-form offer-form">
            <label>
              Mercado
              <select
                value={form.coin}
                onChange={(event) =>
                  setForm((current) => ({
                    ...current,
                    coin: event.target.value,
                  }))
                }
              >
                {data.markets.map((market) => (
                  <option key={market.code} value={market.code}>
                    {label(market.code)}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Tipo
              <select
                value={form.type}
                onChange={(event) =>
                  setForm((current) => ({
                    ...current,
                    type: event.target.value,
                  }))
                }
              >
                <option value="buy">Compra</option>
                <option value="sell">Venta</option>
              </select>
            </label>
            <label>
              QUSD
              <input
                type="number"
                value={form.amount}
                onChange={(event) =>
                  setForm((current) => ({
                    ...current,
                    amount: event.target.value,
                  }))
                }
              />
            </label>
            <label>
              Tasa
              <input
                type="number"
                value={form.rate}
                onChange={(event) =>
                  setForm((current) => ({
                    ...current,
                    rate: event.target.value,
                  }))
                }
              />
            </label>
            <button className="refresh" onClick={submit}>
              Guardar
            </button>
            <span>{message}</span>
          </div>
        ) : null}
        {resources.ownOffers?.loading && !data.freshness?.ownOffers ? <Skeleton rows={5} label="Consultando ofertas propias" /> : <Offers
          offers={data.ownOffers}
          label={label}
          unit={unit}
          editable
          onChanged={onChanged}
        />}
        {resources.ownOffers?.error ? <p className="inline-error">{resources.ownOffers.error}</p> : null}
      </Panel>
    </>
  );
}
