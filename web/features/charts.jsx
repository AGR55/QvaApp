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
import { Empty, Panel, Skeleton } from "../components/common.jsx";
import { money } from "../lib/format.js";
import { requestJson } from "../lib/http.js";
import { chartDomain } from "../lib/chart-domain.js";

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
        medianaCompra: item.medianBuy ?? null,
        medianaVenta: item.medianSell ?? null,
      })) || [],
    [data],
  );
  const values = rows
      .flatMap((item) => [
        item.medianaCompra,
        item.medianaVenta,
      ])
      .filter(Number.isFinite),
    domain = chartDomain(values),
    digits = markets.find((market) => market.code === coin)?.currency === "USD" ? 4 : 2;
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
      {data && values.length ? (
        <ResponsiveContainer width="100%" height={400}>
          <AreaChart data={rows} margin={{ left: 18, right: 18 }}>
            <CartesianGrid vertical={false} />
            <XAxis dataKey="t" />
            <YAxis
              width={96}
              domain={domain}
              tickFormatter={(value) => money(value, digits)}
            />
            <Tooltip formatter={(value) => money(value, digits)} />
            <Legend />
            <Area
              connectNulls
              dataKey="medianaCompra"
              name="Mediana compra"
              stroke="#15745f"
              fill="#15745f18"
              isAnimationActive={false}
            />
            <Area
              connectNulls
              dataKey="medianaVenta"
              name="Mediana venta"
              stroke="#b15c2e"
              fill="#b15c2e12"
              isAnimationActive={false}
            />
          </AreaChart>
        </ResponsiveContainer>
      ) : data ? (
        <Empty>La próxima lectura del mercado añadirá las medianas necesarias para esta gráfica.</Empty>
      ) : (
        <Skeleton rows={4} label="Leyendo histórico local" />
      )}
    </Panel>
  );
}
