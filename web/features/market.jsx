import React from "react";
import { Freshness, Panel, Skeleton } from "../components/common.jsx";
import { Offers } from "../components/offers.jsx";
import { Tabs } from "../components/ui.jsx";

export function Market({ data, market, setMarket, selected, label, unit, resource }) {
  return (
    <div className="page-stack">
      <Panel title={`Libro · ${selected.total} abiertas`} wide>
        <Tabs value={market} onChange={setMarket} items={data.markets.map((item) => ({ value: item.code, label: item.label }))} />
        <Freshness state={resource} cachedAt={data.freshness?.markets?.[market]} />
        {resource?.loading && !data.freshness?.markets?.[market]
          ? <Skeleton rows={6} label={`Cargando ofertas de ${label(market)}`} />
          : <Offers offers={selected.offers} label={label} unit={unit} />}
        {resource?.error ? <p className="inline-error">{resource.error}</p> : null}
      </Panel>
    </div>
  );
}
