import React from "react";
import { CardTitle } from "./ui.jsx";
import { Card, CardContent, CardDescription, CardHeader } from "./ui/card.tsx";
import {
  Empty as ShadcnEmpty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
} from "./ui/empty.tsx";
import { Skeleton as ShadcnSkeleton } from "./ui/skeleton.tsx";

export function Panel({ title, children, wide = false, kicker, description }) {
  return (
    <Card
      className={`panel ui-section ${wide ? "wide" : ""}`}
      data-ui="panel"
      role="region"
      aria-label={title}
    >
      <CardHeader className="panel-head ui-section-head">
        <div className="ui-section-titles">
          {kicker ? <p className="eyebrow">{kicker}</p> : null}
          <CardTitle>{title}</CardTitle>
          {description ? <CardDescription>{description}</CardDescription> : null}
        </div>
      </CardHeader>
      <CardContent className="ui-section-body">{children}</CardContent>
    </Card>
  );
}
export function ViewHead({ kicker, title, description, meta }) {
  return (
    <header className="view-head">
      {kicker ? <p className="view-kicker">{kicker}</p> : null}
      <h1>{title}</h1>
      {description ? <p className="view-description">{description}</p> : null}
      {meta ? <div className="view-meta">{meta}</div> : null}
    </header>
  );
}
export function Empty({ children }) {
  return (
    <ShadcnEmpty className="empty" data-ui="empty">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <svg className="empty-illustration" viewBox="0 0 72 52" fill="none" aria-hidden="true">
            <rect x="5" y="7" width="62" height="38" rx="7" stroke="currentColor" strokeWidth="1.5" />
            <path d="M15 35h42M15 28l11-8 10 5 9-10 12 6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            <circle cx="45" cy="15" r="2.5" fill="currentColor" />
          </svg>
        </EmptyMedia>
        <EmptyDescription>{children}</EmptyDescription>
      </EmptyHeader>
    </ShadcnEmpty>
  );
}
export function Skeleton({ rows = 3, label = "Cargando datos" }) {
  return (
    <div className="skeleton" role="status" aria-label={label}>
      <span className="skeleton-pulse" aria-hidden="true" />
      {Array.from({ length: rows }, (_, index) => (
        <ShadcnSkeleton key={index} />
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
