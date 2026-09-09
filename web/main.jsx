import React, { lazy, Suspense, useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  BarChart3,
  Crosshair,
  CandlestickChart,
  LayoutDashboard,
  RefreshCw,
  SlidersHorizontal,
  WalletCards,
  LogOut,
  Workflow,
  ShieldCheck,
  Bell,
  X,
  Moon,
  Sun,
} from "lucide-react";
import { Empty, Skeleton } from "./components/common.jsx";
import { useDashboard } from "./hooks/use-dashboard.js";
import { Capital } from "./features/capital.jsx";
import { Cockpit } from "./features/cockpit.jsx";
import { Market } from "./features/market.jsx";
import { Settings } from "./features/settings.jsx";
import { Login } from "./features/login.jsx";
import { Operations } from "./features/operations.jsx";
import { Hunting } from "./features/hunting.jsx";
import { Audit } from "./features/audit.jsx";
import { requestJson, setCsrfToken } from "./lib/http.js";
import "./styles.css";
import "./settings.css";
import "./layout.css";
import "./cockpit.css";
import "./offer-actions.css";
import "./offer-modal.css";
import "./capital.css";
import "./hunting.css";
import "./audit.css";
import "./theme-refresh.css";
import "./components.css";

const Charts = lazy(() =>
  import("./features/charts.jsx").then((module) => ({
    default: module.Charts,
  })),
);
const navigation = [
  ["resumen", "Cockpit", LayoutDashboard],
  ["mercado", "Mercados", CandlestickChart],
  ["ofertas", "Capital", WalletCards],
  ["caceria", "Cacería", Crosshair],
  ["operaciones", "Operaciones", Workflow],
  ["graficas", "Gráficas", BarChart3],
  ["configuracion", "Estrategia", SlidersHorizontal],
  ["auditoria", "Auditoría", ShieldCheck],
];

function App() {
  const [session, setSession] = useState();
  const [view, setView] = useState(() => initialView());
  const [market, setMarket] = useState("");
  const [notice, setNotice] = useState(null);
  const [theme, setTheme] = useState(() => getInitialTheme());
  const { data, status, resources, online, refresh } = useDashboard(view, market, setMarket);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
    window.localStorage.setItem("qvaapply-theme", theme);
  }, [theme]);
  const navigate = useCallback((next) => {
    setView(next);
    const url = new URL(window.location.href);
    url.searchParams.set("view", next);
    window.history.replaceState({}, "", url);
  }, []);
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
      headers: { "content-type": "application/json" },
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
              onClick={() => navigate(key)}
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
            <PushControl onNotification={setNotice} />
            <button
              className="icon-action theme-toggle"
              onClick={() => setTheme((current) => current === "dark" ? "light" : "dark")}
              aria-label={theme === "dark" ? "Cambiar a modo claro" : "Cambiar a modo oscuro"}
              title={theme === "dark" ? "Cambiar a modo claro" : "Cambiar a modo oscuro"}
            >
              {theme === "dark" ? <Sun aria-hidden="true" /> : <Moon aria-hidden="true" />}
            </button>
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
        {notice ? <aside className="push-toast" role="status" aria-live="polite"><Bell aria-hidden="true" /><div><strong>{notice.type === "blocked-offer" ? "Oferta requiere revisión" : notice.type === "operation-applied" ? "Aplicación confirmada" : "Conciliación necesaria"}</strong><p>{notice.alert?.coin || "QvaApply"}{notice.alert?.amount ? ` · ${notice.alert.amount} QUSD` : ""}{notice.alert?.reason ? ` · ${notice.alert.reason}` : ""}</p><button className="button primary" onClick={() => { const next = new URL(notice.url || "/?view=auditoria", window.location.origin).searchParams.get("view") || "auditoria"; navigate(next); setNotice(null); }}>Abrir detalle</button></div><button className="dialog-close" onClick={() => setNotice(null)} aria-label="Cerrar aviso"><X /></button></aside> : null}
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
        {view === "caceria" ? (
          <Hunting data={data} label={label} unit={unit} onChanged={refresh} />
        ) : null}
        {view === "graficas" ? (
          <Suspense fallback={<Empty>Cargando gráficas…</Empty>}>
            <Charts markets={data.markets} />
          </Suspense>
        ) : null}
        {view === "configuracion" ? <Settings onChanged={refresh} /> : null}
        {view === "auditoria" ? <Audit data={data} onChanged={refresh} /> : null}
      </main>
    </div>
  );
}

createRoot(document.getElementById("root")).render(<App />);

function initialView() {
  const requested = new URLSearchParams(window.location.search).get("view");
  return navigation.some(([key]) => key === requested) ? requested : "resumen";
}

function getInitialTheme() {
  const saved = window.localStorage.getItem("qvaapply-theme");
  if (saved === "dark" || saved === "light") return saved;
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function PushControl({ onNotification }) {
  const supported = "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
  const [state, setState] = useState(supported ? "checking" : "unsupported");
  useEffect(() => {
    if (!supported) return;
    let active = true;
    const onMessage = (event) => {
      if (event.data?.type !== "qvaapply-notification") return;
      onNotification(event.data.payload || {});
      playNotificationTone();
    };
    navigator.serviceWorker.addEventListener("message", onMessage);
    void navigator.serviceWorker.register("/service-worker.js").then(async (registration) => {
      const subscription = await registration.pushManager.getSubscription();
      if (active) setState(subscription ? "enabled" : Notification.permission === "denied" ? "denied" : "disabled");
    }).catch(() => { if (active) setState("unsupported"); });
    return () => { active = false; navigator.serviceWorker.removeEventListener("message", onMessage); };
  }, [supported, onNotification]);
  const toggle = async () => {
    try {
      setState("checking");
      const registration = await navigator.serviceWorker.ready;
      const current = await registration.pushManager.getSubscription();
      if (current) {
        await requestJson("/api/push/subscriptions", { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ endpoint: current.endpoint }) });
        await current.unsubscribe(); setState("disabled"); return;
      }
      const permission = await Notification.requestPermission();
      if (permission !== "granted") { setState("denied"); return; }
      const payload = await requestJson("/api/push/public-key");
      const subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: decodeVapidKey(payload.data.publicKey) });
      await requestJson("/api/push/subscriptions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(subscription) });
      setState("enabled");
    } catch { setState("error"); }
  };
  const labels = { checking: "Comprobando avisos", enabled: "Avisos activados", disabled: "Activar avisos", denied: "Avisos bloqueados", unsupported: "Avisos no compatibles", error: "Reintentar avisos" };
  return <button className={`icon-action push-control ${state}`} onClick={() => void toggle()} disabled={state === "checking" || state === "unsupported" || state === "denied"} aria-label={labels[state]} title={labels[state]}><Bell aria-hidden="true" /><span className="push-dot" /></button>;
}

function decodeVapidKey(value) {
  const padding = "=".repeat((4 - value.length % 4) % 4);
  const raw = atob((value + padding).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(raw, (character) => character.charCodeAt(0));
}

function playNotificationTone() {
  try {
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (!AudioContext) return;
    const context = new AudioContext();
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.frequency.value = 660; gain.gain.value = 0.035;
    oscillator.connect(gain); gain.connect(context.destination);
    oscillator.start(); gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + 0.18);
    oscillator.stop(context.currentTime + 0.18);
  } catch { /* el aviso visual y nativo siguen disponibles */ }
}
