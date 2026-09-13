import React from "react";
import { Activity } from "lucide-react";
import { CardTitle } from "./ui.jsx";

export function Panel({ title, children, wide = false, kicker, description }) {
  return (
    <section
      className={`panel ui-section ${wide ? "wide" : ""}`}
      data-ui="panel"
    >
      <header className="panel-head ui-section-head">
        <div className="ui-section-titles">
          <CardTitle>{title}</CardTitle>
        </div>
      </header>
      <div className="ui-section-body">{children}</div>
    </section>
  );
}
export function ViewHead({ kicker, title, description, meta }) {
  return (
    <header className="view-head">
      <h1>{title}</h1>
      {meta ? <div className="view-meta">{meta}</div> : null}
    </header>
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
      {Array.from({ length: rows }, (_, index) => (
        <i key={index} />
      ))}
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
    <span
      className={`freshness ${state?.stale || state?.error ? "stale" : ""}`}
    >
      {state?.stale || state?.error ? "Dato guardado" : "Actualizado"} ·{" "}
      {new Date(updatedAt).toLocaleString("es-CU")}
    </span>
  );
}
export function List({ rows, render, empty = "Sin señales todavía." }) {
  return rows?.length ? (
    <ol className="decision-list">
      {rows.slice(0, 6).map((item, index) => (
        <li key={item.uuid || item.code || index}>{render(item)}</li>
      ))}
    </ol>
  ) : (
    <Empty>{empty}</Empty>
  );
}
