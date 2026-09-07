import React from "react";
import { Activity } from "lucide-react";

export function Panel({ title, children, wide = false }) {
  return (
    <section className={`panel ${wide ? "wide" : ""}`}>
      <header className="panel-head">
        <h2>{title}</h2>
      </header>
      {children}
    </section>
  );
}
export function Empty({ children }) {
  return (
    <div className="empty">
      <Activity />
      <p>{children}</p>
    </div>
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
