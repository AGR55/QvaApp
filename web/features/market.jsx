import React from "react";
import { Freshness, Panel, Skeleton, ViewHead } from "../components/common.jsx";
import { Offers } from "../components/offers.jsx";
import { MarketIdentity } from "../components/market-identity.jsx";
import { ToggleGroup, ToggleGroupItem } from "../components/ui/toggle-group.tsx";

export function Market({ data, market, setMarket, selected, label, unit, resource }) {
  return (
    <div className="page-stack">
      <ViewHead
        title="Mercados"
      />
      <Panel title={`Libro · ${selected.total} abiertas`} wide>
        <ToggleGroup
          type="single"
          value={market}
          onValueChange={(nextMarket) => nextMarket && setMarket(nextMarket)}
          className="ui-tabs"
          aria-label="Seleccionar mercado"
        >
          {data.markets.map((item) => (
            <ToggleGroupItem
              key={item.code}
              value={item.code}
              className={market === item.code ? "selected" : ""}
            >
              <MarketIdentity market={item} size="sm" />
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
        <Freshness state={resource} cachedAt={data.freshness?.markets?.[market]} />
        {resource?.loading && !data.freshness?.markets?.[market]
          ? <Skeleton rows={6} label={`Cargando ofertas de ${label(market)}`} />
          : <Offers offers={selected.offers} markets={data.markets} label={label} unit={unit} />}
        {resource?.error ? <p className="inline-error" role="alert">{resource.error}</p> : null}
      </Panel>
    </div>
  );
}
