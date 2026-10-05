import React, { useEffect, useMemo, useState } from "react";
import { Activity } from "lucide-react";
import { CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Empty, Panel, Skeleton, ViewHead } from "../components/common.jsx";
import { Button, Tabs } from "../components/ui.jsx";
import { money } from "../lib/format.js";
import { requestJson } from "../lib/http.js";
import { chartDomain } from "../lib/chart-domain.js";
import { MarketIdentity } from "../components/market-identity.jsx";
import { TradingAnalytics } from "./trading-analytics.jsx";

export function Charts({ markets, initialHistory = [], initialBalanceHistory = [] }) {
  const [coin, setCoin] = useState(markets[0]?.code || ""),
    [remote, setRemote] = useState({}),
    [loading, setLoading] = useState(true),
    [error, setError] = useState(""),
    [retry, setRetry] = useState(0);
  useEffect(() => {
    let active = true;
    let pending = false;
    const refreshHistory = () => {
      if (!coin || pending || document.hidden) return;
      pending = true;
      setLoading(true);
      setError("");
      void requestJson(`/api/market-analytics?coin=${encodeURIComponent(coin)}`)
        .then((payload) => {
          if (active) setRemote((current) => ({ ...current, [coin]: payload.data.history }));
        })
        .catch((reason) => {
          if (active) setError(reason instanceof Error ? reason.message : "No se pudo leer el histórico local.");
        })
        .finally(() => {
          pending = false;
          if (active) setLoading(false);
        });
    };
    refreshHistory();
    const timer = window.setInterval(refreshHistory, 20_000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [coin, retry]);
  useEffect(() => {
    if (!markets.some((market) => market.code === coin))
      setCoin(markets.find((market) => market.active)?.code || markets[0]?.code || "");
  }, [coin, markets]);
  const data = useMemo(() => {
    const saved = initialHistory.filter((item) => item.coin === coin);
    const fresh = remote[coin];
    if (!fresh) return { history: saved };
    const freshTime = fresh.at(-1)?.createdAt ?? 0;
    return { history: [...fresh, ...saved.filter((point) => point.createdAt > freshTime)] };
  }, [coin, initialHistory, remote]);
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
      <ViewHead
        title="Gráficas"
      />
      <TradingAnalytics markets={markets} initialBalanceHistory={initialBalanceHistory} />
      <Panel title="Fluctuación de precios" wide>
          <Tabs value={coin} onChange={setCoin} items={markets.map((market) => ({ value: market.code, label: <MarketIdentity market={market} size="sm" /> }))} />
        {error ? <div className="resource-error" role="alert"><p>{error}</p><Button variant="secondary" size="sm" onClick={() => setRetry((value) => value + 1)}>Reintentar</Button></div> : null}
        {data && values.length ? (
          <>
          <dl className="chart-summary" aria-label="Resumen de las últimas medianas">
            <div><dt>Última mediana de compra</dt><dd>{Number.isFinite(latest?.medianaCompra) ? money(latest.medianaCompra, digits) : "—"}</dd></div>
            <div><dt>Última mediana de venta</dt><dd>{Number.isFinite(latest?.medianaVenta) ? money(latest.medianaVenta, digits) : "—"}</dd></div>
          </dl>
          <div className="chart-stage" aria-busy={loading}>
            <MarketChart rows={rows} domain={domain} digits={digits} />
            {loading ? <div className="chart-updating" role="status">Actualizando medianas…</div> : null}
          </div>
          </>
        ) : data ? (
          <div className="chart-stage chart-empty">
            <Empty title="Esperando histórico" icon={Activity}>La próxima lectura del mercado añadirá las medianas necesarias para esta gráfica.</Empty>
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
  return <figure className="market-chart-wrap" aria-label="Evolución de las medianas de compra y venta durante las últimas 24 horas">
    <div className="market-chart">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={rows} margin={{ top: 12, right: 18, bottom: 4, left: 18 }}>
          <CartesianGrid vertical={false} stroke="var(--line-soft)" strokeDasharray="3 3" />
          <XAxis
            dataKey="t"
            axisLine={false}
            tickLine={false}
            minTickGap={54}
            tick={{ fill: "var(--faint)", fontFamily: "var(--font-mono)", fontSize: 12 }}
          />
          <YAxis
            axisLine={false}
            tickLine={false}
            domain={domain}
            tickFormatter={(value) => money(value, digits)}
            tick={{ fill: "var(--faint)", fontFamily: "var(--font-mono)", fontSize: 12 }}
            width={92}
          />
          <Tooltip content={<MarketTooltip digits={digits} />} cursor={{ stroke: "var(--line)", strokeWidth: 1 }} />
          <Legend
            iconType="plainline"
            wrapperStyle={{ paddingTop: 12, fontSize: 12, fontWeight: 650, color: "var(--muted)" }}
          />
          <Line
            type="monotone"
            dataKey="medianaCompra"
            name="Mediana compra"
            stroke="var(--accent)"
            strokeWidth={2.6}
            dot={false}
            activeDot={{ r: 4, strokeWidth: 2, fill: "var(--surface)" }}
            connectNulls
            isAnimationActive
            animationDuration={420}
          />
          <Line
            type="monotone"
            dataKey="medianaVenta"
            name="Mediana venta"
            stroke="var(--success)"
            strokeWidth={2.6}
            dot={false}
            activeDot={{ r: 4, strokeWidth: 2, fill: "var(--surface)" }}
            connectNulls
            isAnimationActive
            animationDuration={420}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
    <figcaption className="sr-only">Pasa el cursor o toca un punto de la gráfica para consultar cada mediana.</figcaption>
  </figure>;
}

function MarketTooltip({ active, payload, label, digits }) {
  if (!active || !payload?.length) return null;
  return <div className="rounded-lg border border-border bg-popover px-3 py-2 text-sm text-popover-foreground shadow-md">
    <p className="mb-1 font-mono text-xs text-muted-foreground">{label}</p>
    {payload.filter((entry) => Number.isFinite(entry.value)).map((entry) => (
      <p key={entry.dataKey} className="flex items-center justify-between gap-4 font-medium">
        <span style={{ color: entry.color }}>{entry.name}</span>
        <span>{money(entry.value, digits)}</span>
      </p>
    ))}
  </div>;
}
