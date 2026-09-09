import React, { useEffect, useMemo, useState } from "react";
import { Empty, Panel, Skeleton } from "../components/common.jsx";
import { money } from "../lib/format.js";
import { requestJson } from "../lib/http.js";
import { chartDomain } from "../lib/chart-domain.js";

export function Charts({ markets }) {
  const [coin, setCoin] = useState(markets[0]?.code || ""),
    [data, setData] = useState(),
    [loading, setLoading] = useState(true),
    [error, setError] = useState(""),
    [retry, setRetry] = useState(0);
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError("");
    if (coin)
      void requestJson(`/api/market-analytics?coin=${encodeURIComponent(coin)}`)
        .then((payload) => {
          if (active) setData(payload.data);
        })
        .catch((reason) => {
          if (active) setError(reason instanceof Error ? reason.message : "No se pudo leer el histórico local.");
        })
        .finally(() => {
          if (active) setLoading(false);
        });
    return () => {
      active = false;
    };
  }, [coin, retry]);
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
    digits = markets.find((market) => market.code === coin)?.currency === "USD" ? 4 : 2,
    latest = rows.at(-1);
  return (
    <div className="page-stack">
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
        {error ? <div className="resource-error" role="alert"><p>{error}</p><button className="button secondary" onClick={() => setRetry((value) => value + 1)}>Reintentar</button></div> : null}
        {data && values.length ? (
          <>
          <dl className="chart-summary"><div><dt>Última mediana de compra</dt><dd>{Number.isFinite(latest?.medianaCompra) ? money(latest.medianaCompra, digits) : "—"}</dd></div><div><dt>Última mediana de venta</dt><dd>{Number.isFinite(latest?.medianaVenta) ? money(latest.medianaVenta, digits) : "—"}</dd></div><div><dt>Ventana</dt><dd>Últimas 24 h</dd></div></dl>
          <div className="chart-stage" aria-busy={loading}>
            <MarketChart rows={rows} domain={domain} digits={digits} />
            {loading ? <div className="chart-updating" role="status">Actualizando medianas…</div> : null}
          </div>
          </>
        ) : data ? (
          <div className="chart-stage chart-empty">
            <Empty>La próxima lectura del mercado añadirá las medianas necesarias para esta gráfica.</Empty>
          </div>
        ) : (
          <div className="chart-stage chart-loading">
            <Skeleton rows={4} label="Leyendo histórico local" />
          </div>
        )}
      </Panel>
    </div>
  );
}

function MarketChart({ rows, domain, digits }) {
  const width = 1000, height = 340, left = 92, right = 24, top = 24, bottom = 46;
  const plotWidth = width - left - right, plotHeight = height - top - bottom;
  const [minimum, maximum] = domain;
  const x = (index) => left + (rows.length <= 1 ? plotWidth / 2 : index / (rows.length - 1) * plotWidth);
  const y = (value) => top + (maximum - value) / (maximum - minimum || 1) * plotHeight;
  const points = (key) => rows.flatMap((row, index) => Number.isFinite(row[key]) ? [`${x(index)},${y(row[key])}`] : []).join(" ");
  const ticks = Array.from({ length: 5 }, (_, index) => maximum - index * (maximum - minimum) / 4);
  const timeTicks = [0, Math.floor((rows.length - 1) / 2), rows.length - 1].filter((value, index, all) => value >= 0 && all.indexOf(value) === index);
  return <figure className="market-chart-wrap" aria-label="Evolución de las medianas de compra y venta durante las últimas 24 horas">
    <svg className="market-chart" viewBox={`0 0 ${width} ${height}`} role="img">
      <title>Evolución de las medianas de compra y venta durante las últimas 24 horas</title>
      {ticks.map((tick) => <g key={tick}><line className="chart-gridline" x1={left} x2={width - right} y1={y(tick)} y2={y(tick)} /><text className="chart-y-label" x={left - 12} y={y(tick) + 4} textAnchor="end">{money(tick, digits)}</text></g>)}
      {timeTicks.map((index) => <text key={index} className="chart-x-label" x={x(index)} y={height - 13} textAnchor={index === 0 ? "start" : index === rows.length - 1 ? "end" : "middle"}>{rows[index]?.t}</text>)}
      <polyline className="chart-line chart-line-buy" points={points("medianaCompra")} />
      <polyline className="chart-line chart-line-sell" points={points("medianaVenta")} />
    </svg>
    <figcaption><span className="legend-buy">Mediana compra</span><span className="legend-sell">Mediana venta</span></figcaption>
  </figure>;
}
