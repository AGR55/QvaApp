import React from "react";
import { Freshness, Panel, Skeleton } from "../components/common.jsx";
import { Offers } from "../components/offers.jsx";

export function Market({ data, market, setMarket, selected, label, unit, resource }) {
  return (
    <Panel title={`Libro · ${selected.total} abiertas`} wide>
      <div className="tabs">
        {data.markets.map((item) => (
          <button
            key={item.code}
            className={market === item.code ? "selected" : ""}
            onClick={() => setMarket(item.code)}
          >
            {item.label}
          </button>
        ))}
      </div>
      <Freshness state={resource} cachedAt={data.freshness?.markets?.[market]} />
      {resource?.loading && !data.freshness?.markets?.[market]
        ? <Skeleton rows={6} label={`Cargando ofertas de ${label(market)}`} />
        : <Offers offers={selected.offers} label={label} unit={unit} />}
      {resource?.error ? <p className="inline-error">{resource.error}</p> : null}
    </Panel>
  );
}
