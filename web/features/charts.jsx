import React, { useEffect, useMemo, useState } from "react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Panel, Skeleton } from "../components/common.jsx";
import { money } from "../lib/format.js";
import { requestJson } from "../lib/http.js";

export function Charts({ markets }) {
  const [coin, setCoin] = useState(markets[0]?.code || ""),
    [data, setData] = useState();
  useEffect(() => {
    let active = true;
    setData(undefined);
    if (coin)
      void requestJson(`/api/market-analytics?coin=${encodeURIComponent(coin)}`)
        .then((payload) => {
          if (active) setData(payload.data);
        })
        .catch(() => {
          if (active) setData({ history: [] });
        });
    return () => {
      active = false;
    };
  }, [coin]);
  const rows = useMemo(
    () =>
      data?.history.map((item) => ({
        t: new Date(item.createdAt).toLocaleTimeString("es-CU"),
        compra: item.averageBuy ?? null,
        venta: item.averageSell ?? null,
        medianaCompra: item.medianBuy ?? null,
        medianaVenta: item.medianSell ?? null,
      })) || [],
    [data],
  );
  const values = rows
      .flatMap((item) => [
        item.compra,
        item.venta,
        item.medianaCompra,
        item.medianaVenta,
      ])
      .filter(Number.isFinite),
    minimum = values.length ? Math.min(...values) : 0,
    maximum = values.length ? Math.max(...values) : 1,
    padding = Math.max(
      (maximum - minimum) * 0.16,
      Math.abs(maximum || 1) * 0.008,
      0.0001,
    );
  return (
    <Panel title="Fluctuación de precios" wide>
      <div className="tabs">
        {markets.map((market) => (
          <button
            key={market.code}
            className={coin === market.code ? "selected" : ""}
            onClick={() => setCoin(market.code)}
          >
            {market.label}
          </button>
        ))}
      </div>
      {data ? (
        <ResponsiveContainer width="100%" height={400}>
          <AreaChart data={rows} margin={{ left: 18, right: 18 }}>
            <CartesianGrid vertical={false} />
            <XAxis dataKey="t" />
            <YAxis
              width={96}
              domain={[minimum - padding, maximum + padding]}
              tickFormatter={(value) => money(value, 4)}
            />
            <Tooltip />
            <Legend />
            <Area
              connectNulls
              dataKey="compra"
              name="Media compra"
              stroke="#15745f"
              fill="#15745f18"
            />
            <Area
              connectNulls
              dataKey="medianaCompra"
              name="Mediana compra"
              stroke="#15745f"
              strokeDasharray="6 4"
              fill="none"
            />
            <Area
              connectNulls
              dataKey="venta"
              name="Media venta"
              stroke="#b15c2e"
              fill="#b15c2e12"
            />
            <Area
              connectNulls
              dataKey="medianaVenta"
              name="Mediana venta"
              stroke="#b15c2e"
              strokeDasharray="6 4"
              fill="none"
            />
          </AreaChart>
        </ResponsiveContainer>
      ) : (
        <Skeleton rows={4} label="Leyendo histórico local" />
      )}
    </Panel>
  );
}
