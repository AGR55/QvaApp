import React from "react";
import { Panel } from "../components/common.jsx";
import { Offers } from "../components/offers.jsx";

export function Market({ data, market, setMarket, selected, label, unit }) {
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
      <Offers offers={selected.offers} label={label} unit={unit} />
    </Panel>
  );
}
