import React, { lazy, Suspense, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  BarChart3,
  CandlestickChart,
  LayoutDashboard,
  RefreshCw,
  SlidersHorizontal,
  WalletCards,
  LogOut,
  Workflow,
  ShieldCheck,
} from "lucide-react";
import { Empty, Skeleton } from "./components/common.jsx";
import { useDashboard } from "./hooks/use-dashboard.js";
import { Capital } from "./features/capital.jsx";
import { Cockpit } from "./features/cockpit.jsx";
import { Market } from "./features/market.jsx";
import { Settings } from "./features/settings.jsx";
import { Login } from "./features/login.jsx";
import { Operations } from "./features/operations.jsx";
import { Audit } from "./features/audit.jsx";
import { requestJson, setCsrfToken } from "./lib/http.js";
import "./styles.css";
import "./settings.css";
import "./layout.css";
import "./cockpit.css";
import "./offer-actions.css";
import "./offer-modal.css";
import "./capital.css";

const Charts = lazy(() =>
  import("./features/charts.jsx").then((module) => ({
    default: module.Charts,
  })),
);
const navigation = [
  ["resumen", "Cockpit", LayoutDashboard],
  ["mercado", "Mercados", CandlestickChart],
  ["ofertas", "Capital", WalletCards],
  ["operaciones", "Operaciones", Workflow],
  ["graficas", "Gráficas", BarChart3],
  ["configuracion", "Estrategia", SlidersHorizontal],
  ["auditoria", "Auditoría", ShieldCheck],
];

function App() {
  const [session, setSession] = useState();
  const [view, setView] = useState("resumen");
  const [market, setMarket] = useState("");
  const { data, status, resources, online, refresh } = useDashboard(view, market, setMarket);
  useEffect(() => {
    void requestJson("/api/session")
      .then((payload) => {
        if (payload.data.authenticated) setCsrfToken(payload.data.csrfToken);
        setSession(payload.data);
      })
      .catch(() => setSession({ authenticated: false }));
  }, []);
  if (!session)
    return (
      <main className="boot">
        <div className="mark">Q</div>
        <p>Verificando sesión…</p>
      </main>
    );
  if (!session.authenticated)
    return (
      <Login
        onAuthenticated={(value) => {
          setSession(value);
          void refresh();
        }}
      />
    );
  const logout = async () => {
    await requestJson("/api/session", {
      method: "DELETE",
      headers: { "content-type": "apAplication/json" },
    });
    setCsrfToken("");
    setSession({ authenticated: false });
  };
  if (!data)
    return (
      <main className="boot">
        <div className="mark">Q</div>
        <p>{status}</p>
        <Skeleton label="Leyendo la base de datos local" />
        <button className="refresh" onClick={refresh}>Reintentar lectura local</button>
      </main>
    );
  const metadata = new Map(data.markets.map((item) => [item.code, item]));
  const label = (code) => metadata.get(code)?.label || code;
  const unit = (code) => metadata.get(code)?.currency || "";
  const selected = data.market[market] || { offers: [], total: 0 };
  const title = navigation.find(([key]) => key === view)?.[1] || "QvaApply";
  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">
        Saltar al contenido principal
      </a>
      <aside className="sidebar">
        <div className="brand">
          <span className="mark">Q</span>
          <span>
            QvaApply<small>DESK</small>
          </span>
        </div>
        <nav>
          {navigation.map(([key, text, Icon]) => (
            <button
              key={key}
              className={view === key ? "active" : ""}
              aria-current={view === key ? "page" : undefined}
              onClick={() => setView(key)}
            >
              <Icon />
              {text}
            </button>
          ))}
        </nav>
      </aside>
      <main className="content" id="main-content" tabIndex="-1">
        <header className="topbar">
          <div>
            <p className="eyebrow">MESA DE DECISIÓN</p>
            <h1>{title}</h1>
          </div>
          <div className="top-actions">
            <button className="refresh" onClick={refresh} disabled={Object.values(resources).some((item) => item.loading)}>
              <RefreshCw className={Object.values(resources).some((item) => item.loading) ? "spinning" : ""} aria-hidden="true" />
              Actualizar
            </button>
            <button
              className="icon-action"
              onClick={logout}
              aria-label="Cerrar sesión"
              title="Cerrar sesión"
            >
              <LogOut aria-hidden="true" />
            </button>
          </div>
        </header>
        <div className={`connection-state ${online ? "" : "offline"}`} role="status" aria-live="polite">
          <span />
          <p>{status}</p>
        </div>
        {view === "resumen" ? (
          <Cockpit data={data} label={label} unit={unit} onChanged={refresh} resources={resources} />
        ) : null}
        {view === "mercado" ? (
          <Market
            data={data}
            market={market}
            setMarket={setMarket}
            selected={selected}
            label={label}
            unit={unit}
            resource={resources[`market:${market}`]}
          />
        ) : null}
        {view === "ofertas" ? (
          <Capital data={data} label={label} unit={unit} onChanged={refresh} resources={resources} />
        ) : null}
        {view === "operaciones" ? (
          <Operations
            data={data}
            label={label}
            unit={unit}
            onChanged={refresh}
          />
        ) : null}
        {view === "graficas" ? (
          <Suspense fallback={<Empty>Cargando gráficas…</Empty>}>
            <Charts markets={data.markets} />
          </Suspense>
        ) : null}
        {view === "configuracion" ? <Settings onChanged={refresh} /> : null}
        {view === "auditoria" ? <Audit data={data} /> : null}
      </main>
    </div>
  );
}

createRoot(document.getElementById("root")).render(<App />);
