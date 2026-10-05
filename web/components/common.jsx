import React from "react";
import { Activity, Inbox } from "lucide-react";
import { CardTitle } from "./ui.jsx";
import { Card, CardContent, CardDescription, CardHeader } from "./ui/card.tsx";
import {
  Empty as ShadcnEmpty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
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
export function Empty({
  children,
  title = "Sin resultados",
  icon: Icon = Inbox,
  action,
  className = "",
}) {
  return (
    <ShadcnEmpty className={`empty ${className}`.trim()} data-ui="empty">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <Icon aria-hidden="true" />
        </EmptyMedia>
        <EmptyTitle>{title}</EmptyTitle>
        <EmptyDescription>{children}</EmptyDescription>
      </EmptyHeader>
      {action ? <EmptyContent>{action}</EmptyContent> : null}
    </ShadcnEmpty>
  );
}
export function Skeleton({ rows = 3, label = "Cargando datos" }) {
  return (
    <div className="skeleton" role="status" aria-label={label}>
      {Array.from({ length: rows }, (_, index) => (
        <ShadcnSkeleton key={index} className="skeleton-row" aria-hidden="true" />
      ))}
      <span className="sr-only">{label}</span>
    </div>
  );
}
export function ViewLoading({ label = "Cargando vista" }) {
  return (
    <section className="view-loading" role="status" aria-busy="true" aria-label={label}>
      <span className="sr-only">{label}</span>
      <div className="view-loading-heading" aria-hidden="true">
        <ShadcnSkeleton className="view-loading-title" />
        <ShadcnSkeleton className="view-loading-subtitle" />
      </div>
      <div className="view-loading-panel" aria-hidden="true">
        <div className="view-loading-summary">
          <ShadcnSkeleton />
          <ShadcnSkeleton />
          <ShadcnSkeleton />
        </div>
        <div className="view-loading-lines">
          <ShadcnSkeleton />
          <ShadcnSkeleton />
          <ShadcnSkeleton />
        </div>
      </div>
    </section>
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
    <Empty title="Sin actividad" icon={Activity}>{empty}</Empty>
  );
}
