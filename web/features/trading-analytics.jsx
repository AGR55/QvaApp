import React, { useEffect, useMemo, useState } from "react";
import { Activity, ArrowDownLeft, ArrowUpRight, ChartNoAxesCombined, RefreshCw } from "lucide-react";
import { Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, Label, Pie, PieChart, ReferenceLine, XAxis, YAxis } from "recharts";
import { Empty, Skeleton } from "../components/common.jsx";
import { Button, Field, Select, Tabs } from "../components/ui.jsx";
import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter, CardAction } from "../components/ui/card.tsx";
import { ChartContainer, ChartTooltip, ChartTooltipContent, ChartLegend, ChartLegendContent } from "../components/ui/chart.tsx";
import { Badge } from "../components/ui/badge.tsx";
import { FieldGroup } from "../components/ui/field.tsx";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table.tsx";
import { money } from "../lib/format.js";
import { requestJson } from "../lib/http.js";
import { analyticsBars } from "../lib/analytics-bars.js";

const COLORS = ["var(--chart-1)", "var(--chart-2)", "var(--chart-3)", "var(--chart-4)", "var(--chart-5)"];
const FLOW_CONFIG = {
  incoming: { label: "Entradas", color: "var(--chart-2)" }, outgoing: { label: "Salidas", color: "var(--chart-1)" },
  unknown: { label: "Sin clasificar", color: "var(--chart-5)" }, count: { label: "Transacciones", color: "var(--chart-1)" },
  bought: { label: "Comprado", color: "var(--chart-2)" }, sold: { label: "Vendido", color: "var(--chart-1)" },
  profit: { label: "Ganancia estimada", color: "var(--chart-2)" }, balance: { label: "Saldo QUSD", color: "var(--chart-1)" },
};
const dateLabel = (date) => new Date(`${date}T12:00:00Z`).toLocaleDateString("es-CU", { day: "numeric", month: "short", timeZone: "UTC" });
const compact = (value) => new Intl.NumberFormat("es-CU", { notation: "compact", maximumFractionDigits: 1 }).format(value);
const reportCache = new Map();

export function TradingAnalytics({ markets, initialBalanceHistory = [] }) {
  const [days, setDays] = useState("30"), [reports, setReports] = useState(() => Object.fromEntries(reportCache)), [loading, setLoading] = useState(true), [error, setError] = useState(""), [retry, setRetry] = useState(0);
  const [density, setDensity] = useState("20"), [activityMetric, setActivityMetric] = useState("amount"), [shareMetric, setShareMetric] = useState("volume"), [currency, setCurrency] = useState("");
  useEffect(() => {
    let active = true, pending = false;
    const read = async () => {
      if (pending || document.hidden) return;
      pending = true; setLoading(true);
      try {
        const payload = await requestJson(`/api/trading-analytics?days=${days}`, { timeoutMs: 8_000 });
        if (active) { reportCache.set(days, payload.data); setReports((current) => ({ ...current, [days]: payload.data })); setError(""); }
      } catch (reason) { if (active) setError(reason instanceof Error ? reason.message : "No se pudo actualizar el análisis."); }
      finally { pending = false; if (active) setLoading(false); }
    };
    void read();
    const timer = window.setInterval(() => void read(), 30_000);
    const visible = () => { if (!document.hidden) void read(); };
    document.addEventListener("visibilitychange", visible);
    return () => { active = false; window.clearInterval(timer); document.removeEventListener("visibilitychange", visible); };
  }, [days, retry]);
  const report = reports[days];
  const bars = useMemo(() => analyticsBars(report?.daily ?? [], Number(density)), [report, density]);
  const rows = useMemo(() => (report?.markets ?? []).map((row, index) => ({ ...row, key: `market${index}`, fill: COLORS[index % COLORS.length] })), [report]);
  const config = useMemo(() => ({ ...FLOW_CONFIG, ...Object.fromEntries(rows.map((row) => [row.key, { label: row.label, color: row.fill }])) }), [rows]);
  const selectedCurrency = report?.currencies.some((item) => item.currency === currency) ? currency : report?.currencies[0]?.currency ?? markets[0]?.currency ?? "CUP";
  const profitRows = rows.filter((row) => row.currency === selectedCurrency);
  const balanceRows = useMemo(() => (report?.balanceHistory ?? initialBalanceHistory).map((point) => ({ at: point.createdAt, balance: point.qusdBalance })), [report, initialBalanceHistory]);
  const totalShare = rows.reduce((sum, row) => sum + row[shareMetric], 0);
  const profitTimeline = useMemo(() => {
    let cumulative = 0;
    return (report?.daily ?? []).map((point) => {
      cumulative += report.profits.find((item) => item.date === point.date && item.currency === selectedCurrency)?.profit ?? 0;
      return { date: point.date, profit: cumulative };
    });
  }, [report, selectedCurrency]);
  const unknown = report?.totals.unknown ?? 0;
  return <section className="analytics-workspace" aria-label="Análisis de tu actividad">
    <div className="analytics-toolbar">
      <div><p className="eyebrow">TU ACTIVIDAD</p><p className="analytics-period">{report ? `${dateLabel(report.start)} — ${dateLabel(report.end)}` : "Actividad de tu cuenta y mercados"}</p></div>
      <div className="analytics-toolbar-actions">
        <Tabs value={days} onChange={setDays} items={[{ value: "7", label: "7 días" }, { value: "30", label: "30 días" }, { value: "90", label: "90 días" }]} />
        <Button variant="outline" size="icon" aria-label="Actualizar análisis" disabled={loading} onClick={() => setRetry((value) => value + 1)}><RefreshCw aria-hidden="true" /></Button>
      </div>
    </div>
    {error ? <div className="resource-error" role="alert"><p>{error}</p><Button size="sm" onClick={() => setRetry((value) => value + 1)}>Reintentar</Button></div> : null}
    <div className="analytics-kpis">
      <Metric label="Volumen P2P completado" value={report ? `${money(report.volume)} QUSD` : null} detail={report ? `${report.completed} operaciones completadas` : "Operaciones finalizadas"} icon={ChartNoAxesCombined} />
      <Metric label="Entradas en la cuenta" value={report ? `${money(report.totals.incoming)} QUSD` : null} detail="Transacciones recibidas" icon={ArrowDownLeft} />
      <Metric label="Salidas de la cuenta" value={report ? `${money(report.totals.outgoing)} QUSD` : null} detail="Transacciones enviadas" icon={ArrowUpRight} />
      <Metric label="Ganancia estimada" value={report ? report.currencies.filter((item) => item.matchedQusd > 0).map((item) => `${money(item.profit)} ${item.currency}`).join(" · ") || "Sin coste emparejado" : null} detail="Ventas con compras previas del mismo mercado" icon={Activity} />
    </div>
    <AnalyticsCard title="Actividad de transacciones" description="Entradas y salidas en QUSD; incluye movimientos fuera del P2P." wide
      action={<Tabs value={activityMetric} onChange={setActivityMetric} items={[{ value: "amount", label: "Importe" }, { value: "count", label: "Cantidad" }]} />}
      footer={<><span>{report?.totals.count ?? 0} transacciones en el periodo{unknown > 0 ? ` · ${money(unknown)} QUSD sin dirección identificada` : ""}</span><Field label="Barras visibles" htmlFor="analytics-density"><Select id="analytics-density" value={density} onValueChange={setDensity} options={[10, 20, 40, 90].map((value) => ({ value: String(value), label: `Hasta ${value} barras` }))} /></Field></>}>
      <ChartOrEmpty ready={Boolean(report)} hasData={Boolean(report?.totals.count)}>
        <ChartContainer config={FLOW_CONFIG} className="analytics-chart analytics-activity">
          <BarChart accessibilityLayer data={bars} margin={{ left: 0, right: 8, top: 12 }}>
            <CartesianGrid vertical={false} />
            <XAxis dataKey="date" axisLine={false} tickLine={false} minTickGap={32} tickFormatter={dateLabel} />
            <YAxis axisLine={false} tickLine={false} width={52} tickFormatter={compact} allowDecimals={activityMetric !== "count"} />
            <ChartTooltip content={<ChartTooltipContent labelFormatter={(_, payload) => payload[0] ? `${dateLabel(payload[0].payload.date)} — ${dateLabel(payload[0].payload.end)}` : ""} />} />
            <ChartLegend content={<ChartLegendContent />} />
            {activityMetric === "count" ? <Bar dataKey="count" fill="var(--color-count)" radius={3} animationDuration={350} /> : <>
              <Bar dataKey="incoming" stackId="flow" fill="var(--color-incoming)" animationDuration={350} />
              <Bar dataKey="outgoing" stackId="flow" fill="var(--color-outgoing)" animationDuration={350} />
              {unknown > 0 ? <Bar dataKey="unknown" stackId="flow" fill="var(--color-unknown)" radius={[3, 3, 0, 0]} animationDuration={350} /> : null}
            </>}
          </BarChart>
        </ChartContainer>
      </ChartOrEmpty>
    </AnalyticsCard>
    <div className="analytics-grid">
      <AnalyticsCard title="Distribución por mercado" description="Participación de cada mercado en operaciones completadas."
        action={<Tabs value={shareMetric} onChange={setShareMetric} items={[{ value: "volume", label: "QUSD" }, { value: "count", label: "Operaciones" }]} />}>
        <ChartOrEmpty ready={Boolean(report)} hasData={totalShare > 0}>
          <ChartContainer config={config} className="analytics-chart analytics-donut">
            <PieChart accessibilityLayer>
              <ChartTooltip content={<ChartTooltipContent nameKey="key" hideLabel />} />
              <Pie data={rows} dataKey={shareMetric} nameKey="key" innerRadius={64} outerRadius={94} paddingAngle={2} stroke="var(--card)" animationDuration={350}>
                <Label content={({ viewBox }) => viewBox && "cx" in viewBox ? <text x={viewBox.cx} y={viewBox.cy} textAnchor="middle" dominantBaseline="middle"><tspan x={viewBox.cx} dy="-3" className="fill-foreground font-mono text-xl font-semibold">{compact(totalShare)}</tspan><tspan x={viewBox.cx} dy="24" className="fill-muted-foreground text-xs">{shareMetric === "volume" ? "QUSD operados" : "operaciones"}</tspan></text> : null} />
              </Pie>
            </PieChart>
          </ChartContainer>
          <ul className="analytics-market-legend">{rows.map((row) => <li key={row.code}><span className="analytics-dot" style={{ backgroundColor: row.fill }} /><span>{row.label}</span><strong>{money(row[shareMetric], shareMetric === "count" ? 0 : 2)}{shareMetric === "volume" ? " QUSD" : ""}</strong><span>{money(row[shareMetric] / totalShare * 100, 1)}%</span></li>)}</ul>
        </ChartOrEmpty>
      </AnalyticsCard>
      <AnalyticsCard title="Compras y ventas por mercado" description="Volumen QUSD completado; compras y ventas desde tu perspectiva.">
        <ChartOrEmpty ready={Boolean(report)} hasData={rows.length > 0}>
          <ChartContainer config={FLOW_CONFIG} className="analytics-chart analytics-market-volume" style={{ height: Math.max(270, Math.min(900, rows.length * 54)) }}>
            <BarChart accessibilityLayer data={rows} layout="vertical" margin={{ left: 0, right: 8 }}>
              <CartesianGrid horizontal={false} />
              <XAxis type="number" axisLine={false} tickLine={false} tickFormatter={compact} />
              <YAxis type="category" dataKey="label" width={112} axisLine={false} tickLine={false} tick={{ fontSize: 11 }} />
              <ChartTooltip content={<ChartTooltipContent />} />
              <ChartLegend content={<ChartLegendContent />} />
              <Bar dataKey="bought" stackId="trade" fill="var(--color-bought)" animationDuration={350} />
              <Bar dataKey="sold" stackId="trade" fill="var(--color-sold)" animationDuration={350} />
              {rows.some((row) => row.unknown > 0) ? <Bar dataKey="unknown" stackId="trade" fill="var(--color-unknown)" animationDuration={350} /> : null}
            </BarChart>
          </ChartContainer>
        </ChartOrEmpty>
      </AnalyticsCard>
      <AnalyticsCard title="Ganancia estimada por mercado" description="Diferencia entre venta y coste de compra conocido, usando primero las compras más antiguas."
        action={report?.currencies.length ? <Field label="Moneda" htmlFor="analytics-profit-currency"><Select id="analytics-profit-currency" value={selectedCurrency} onValueChange={setCurrency} options={report.currencies.map((item) => ({ value: item.currency, label: item.currency }))} /></Field> : null}
        footer={<span>Costes y ventas en {selectedCurrency}. Las comisiones que no constan en el histórico están excluidas.</span>}>
        <ChartOrEmpty ready={Boolean(report)} hasData={profitRows.some((row) => row.matchedQusd > 0)} title="Falta emparejar compras y ventas" description="La ganancia aparecerá cuando una venta tenga compras anteriores del mismo mercado con coste conocido.">
          <ChartContainer config={FLOW_CONFIG} className="analytics-chart">
            <BarChart accessibilityLayer data={profitRows.map((row) => ({ ...row, profit: row.estimatedProfit }))} margin={{ left: 0, right: 8, top: 12 }}>
              <CartesianGrid vertical={false} /><ReferenceLine y={0} stroke="var(--border)" />
              <XAxis dataKey="label" axisLine={false} tickLine={false} tick={{ fontSize: 11 }} />
              <YAxis axisLine={false} tickLine={false} width={55} tickFormatter={compact} />
              <ChartTooltip content={<ChartTooltipContent />} />
              <Bar dataKey="profit" radius={3} animationDuration={350}>{profitRows.map((row) => <Cell key={row.code} fill={row.estimatedProfit >= 0 ? "var(--chart-2)" : "var(--destructive)"} />)}</Bar>
            </BarChart>
          </ChartContainer>
        </ChartOrEmpty>
      </AnalyticsCard>
      <AnalyticsCard title="Evolución de tu saldo" description="Saldo QUSD registrado por QvaApply a lo largo del periodo." footer={<span>El saldo incluye transferencias, depósitos y retiradas; no representa solo ganancias.</span>}>
        <ChartOrEmpty ready={Boolean(report) || balanceRows.length > 0} hasData={balanceRows.length > 0} title="Esperando registros de saldo" description="Las lecturas de saldo irán construyendo esta evolución.">
          <ChartContainer config={FLOW_CONFIG} className="analytics-chart">
            <AreaChart accessibilityLayer data={balanceRows} margin={{ left: 0, right: 8, top: 12 }}>
              <CartesianGrid vertical={false} />
              <XAxis dataKey="at" axisLine={false} tickLine={false} minTickGap={40} tickFormatter={(time) => new Date(time).toLocaleDateString("es-CU", { day: "numeric", month: "short" })} />
              <YAxis axisLine={false} tickLine={false} width={55} tickFormatter={compact} />
              <ChartTooltip content={<ChartTooltipContent labelFormatter={(_, payload) => payload[0] ? new Date(payload[0].payload.at).toLocaleString("es-CU") : ""} />} />
              <Area dataKey="balance" type="monotone" fill="var(--color-balance)" fillOpacity={0.12} stroke="var(--color-balance)" strokeWidth={2} animationDuration={350} />
            </AreaChart>
          </ChartContainer>
        </ChartOrEmpty>
      </AnalyticsCard>
    </div>
    <div className="analytics-grid">
      <AnalyticsCard title="Ritmo de operaciones P2P" description="QUSD comprados y vendidos por día, solo con operaciones completadas.">
        <ChartOrEmpty ready={Boolean(report)} hasData={Boolean(report?.volume)}>
          <ChartContainer config={FLOW_CONFIG} className="analytics-chart">
            <BarChart accessibilityLayer data={bars} margin={{ left: 0, right: 8, top: 12 }}>
              <CartesianGrid vertical={false} />
              <XAxis dataKey="date" axisLine={false} tickLine={false} minTickGap={32} tickFormatter={dateLabel} />
              <YAxis axisLine={false} tickLine={false} width={52} tickFormatter={compact} />
              <ChartTooltip content={<ChartTooltipContent labelFormatter={(_, payload) => payload[0] ? `${dateLabel(payload[0].payload.date)} — ${dateLabel(payload[0].payload.end)}` : ""} />} />
              <ChartLegend content={<ChartLegendContent />} />
              <Bar dataKey="bought" fill="var(--color-bought)" radius={3} animationDuration={350} />
              <Bar dataKey="sold" fill="var(--color-sold)" radius={3} animationDuration={350} />
            </BarChart>
          </ChartContainer>
        </ChartOrEmpty>
      </AnalyticsCard>
      <AnalyticsCard title="Ganancia estimada acumulada" description={`Resultado de ventas con coste conocido durante el periodo, en ${selectedCurrency}.`}>
        <ChartOrEmpty ready={Boolean(report)} hasData={profitRows.some((row) => row.matchedQusd > 0)} title="Esperando ventas con coste conocido" description="Al completar compras y ventas del mismo mercado verás cómo evoluciona la estimación.">
          <ChartContainer config={FLOW_CONFIG} className="analytics-chart">
            <AreaChart accessibilityLayer data={profitTimeline} margin={{ left: 0, right: 8, top: 12 }}>
              <CartesianGrid vertical={false} /><ReferenceLine y={0} stroke="var(--border)" />
              <XAxis dataKey="date" axisLine={false} tickLine={false} minTickGap={32} tickFormatter={dateLabel} />
              <YAxis axisLine={false} tickLine={false} width={55} tickFormatter={compact} />
              <ChartTooltip content={<ChartTooltipContent labelFormatter={(label) => dateLabel(label)} />} />
              <Area dataKey="profit" type="stepAfter" fill="var(--color-profit)" fillOpacity={0.12} stroke="var(--color-profit)" strokeWidth={2} animationDuration={350} />
            </AreaChart>
          </ChartContainer>
        </ChartOrEmpty>
      </AnalyticsCard>
    </div>
    <AnalyticsCard title="Resultados por mercado" description="Importes reales por moneda y cobertura de la estimación de ganancia."
      footer={<div className="analytics-coverage"><Badge variant="outline">{report?.sync.limited ? "Histórico parcial" : report?.sync.complete ? "Histórico importado" : "Histórico en actualización"}</Badge><span>{report?.coverage.transactions ?? 0} transacciones guardadas{report?.coverage.oldestAt ? ` · Desde ${new Date(report.coverage.oldestAt).toLocaleDateString("es-CU")}` : ""}. {money(report?.coverage.unmatchedSoldQusd ?? 0)} QUSD vendidos sin coste conocido.</span></div>}>
      {!report ? <Skeleton rows={3} label="Cargando resultados por mercado" /> : rows.length ? <Table><TableHeader><TableRow><TableHead>Mercado</TableHead><TableHead>Operaciones</TableHead><TableHead>Volumen QUSD</TableHead><TableHead>Fiat pagado</TableHead><TableHead>Fiat recibido</TableHead><TableHead>Ganancia estimada</TableHead><TableHead>Ventas con coste</TableHead></TableRow></TableHeader><TableBody>{rows.map((row) => <TableRow key={row.code}><TableCell>{row.label}</TableCell><TableCell>{row.count}</TableCell><TableCell>{money(row.volume)}</TableCell><TableCell>{money(row.fiatSpent)} {row.currency}</TableCell><TableCell>{money(row.fiatReceived)} {row.currency}</TableCell><TableCell>{row.matchedQusd > 0 ? `${money(row.estimatedProfit)} ${row.currency}` : "—"}</TableCell><TableCell>{row.sold ? `${money(row.matchedQusd / row.sold * 100, 1)}%` : "—"}</TableCell></TableRow>)}</TableBody></Table> : <Empty title="Sin operaciones completadas" icon={Activity}>El historial se completará en segundo plano. Las operaciones en revisión no cuentan como ganancias.</Empty>}
    </AnalyticsCard>
    <span className="sr-only" role="status">{loading ? "Actualizando análisis en segundo plano" : "Análisis actualizado"}</span>
  </section>;
}

function Metric({ label, value, detail, icon: Icon }) {
  return <Card size="sm" className="analytics-metric"><CardHeader><CardDescription>{label}</CardDescription><CardAction><Icon aria-hidden="true" /></CardAction></CardHeader><CardContent>{value === null ? <Skeleton rows={1} label={`Cargando ${label}`} /> : <p className="analytics-metric-value">{value}</p>}<p className="analytics-metric-detail">{detail}</p></CardContent></Card>;
}
function AnalyticsCard({ title, description, action, children, footer, wide }) {
  return <Card className={wide ? "analytics-card analytics-wide" : "analytics-card"} role="region" aria-label={title}><CardHeader><CardTitle>{title}</CardTitle><CardDescription>{description}</CardDescription>{action ? <CardAction>{action}</CardAction> : null}</CardHeader><CardContent>{children}</CardContent>{footer ? <CardFooter><FieldGroup className="analytics-card-footer">{footer}</FieldGroup></CardFooter> : null}</Card>;
}
function ChartOrEmpty({ ready, hasData, children, title = "Sin actividad en este periodo", description = "Prueba otro periodo. Los datos nuevos se incorporan automáticamente." }) {
  if (!ready) return <div className="analytics-placeholder"><Skeleton rows={4} label="Cargando análisis local" /></div>;
  return hasData ? children : <div className="analytics-placeholder"><Empty title={title} icon={ChartNoAxesCombined}>{description}</Empty></div>;
}
