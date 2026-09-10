import React from "react";
import { Activity } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "./ui.jsx";

export function Panel({ title, children, wide = false }) {
  return (
    <Card className={`panel ${wide ? "wide" : ""}`} data-ui="panel">
      <CardHeader className="panel-head"><CardTitle>{title}</CardTitle></CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}
export function Empty({ children }) {
  return (
    <div className="empty" data-ui="empty">
      <Activity />
      <p>{children}</p>
    </div>
  );
}
export function Skeleton({ rows = 3, label = "Cargando datos" }) {
  return (
    <div className="skeleton" role="status" aria-label={label}>
      {Array.from({ length: rows }, (_, index) => <i key={index} />)}
      <span className="sr-only">{label}</span>
    </div>
  );
}
export function Freshness({ state, cachedAt }) {
  const updatedAt = state?.updatedAt ?? cachedAt;
  if (state?.loading && !updatedAt)
    return <span className="freshness loading">Actualizando…</span>;
  if (!updatedAt)
    return <span className="freshness stale">Sin datos guardados</span>;
  return (
    <span className={`freshness ${state?.stale || state?.error ? "stale" : ""}`}>
      {state?.stale || state?.error ? "Dato guardado" : "Actualizado"} · {new Date(updatedAt).toLocaleString("es-CU")}
    </span>
  );
}
export function List({ rows, render }) {
  return rows?.length ? (
    <ol className="decision-list">
      {rows.slice(0, 6).map((item, index) => (
        <li key={item.uuid || item.code || index}>{render(item)}</li>
      ))}
    </ol>
  ) : (
    <Empty>Sin señales todavía.</Empty>
  );
}
