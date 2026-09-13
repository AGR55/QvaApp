import React from "react";
import { Freshness, Panel, Skeleton, ViewHead } from "../components/common.jsx";
import { Offers } from "../components/offers.jsx";
import { Tabs } from "../components/ui.jsx";
import { MarketIdentity } from "../components/market-identity.jsx";

export function Market({ data, market, setMarket, selected, label, unit, resource }) {
  return (
    <div className="page-stack">
      <ViewHead
        kicker="Libro P2P"
        title="Mercados"
        description="Ofertas abiertas por mercado con su tasa. Cambia de pestaña para comparar sin perder el contexto."
      />
      <Panel title={`Libro · ${selected.total} abiertas`} kicker="Profundidad" wide>
        <Tabs value={market} onChange={setMarket} items={data.markets.map((item) => ({ value: item.code, label: <MarketIdentity code={item.code} label={item.label} size="sm" showCode={false} /> }))} />
        <Freshness state={resource} cachedAt={data.freshness?.markets?.[market]} />
        {resource?.loading && !data.freshness?.markets?.[market]
          ? <Skeleton rows={6} label={`Cargando ofertas de ${label(market)}`} />
          : <Offers offers={selected.offers} label={label} unit={unit} />}
        {resource?.error ? <p className="inline-error">{resource.error}</p> : null}
      </Panel>
    </div>
  );
}
