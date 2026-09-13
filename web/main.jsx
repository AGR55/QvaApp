import React, {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
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
  Menu,
  ChevronDown,
} from "lucide-react";
import { Empty, Skeleton } from "./components/common.jsx";
import { Button, IconButton } from "./components/ui.jsx";
import { money } from "./lib/format.js";
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
import "./settings.css";
import "./cockpit.css";
import "./offer-actions.css";
import "./offer-modal.css";
import "./capital.css";
import "./hunting.css";
import "./audit.css";
import "./components.css";
import "./ui-polish.css";
import "./identity.css";

const Charts = lazy(() =>
  import("./features/charts.jsx").then((module) => ({
    default: module.Charts,
  })),
);
const navigationGroups = [
  {
    label: "Operar",
    items: [
      ["resumen", "Cockpit", LayoutDashboard],
      ["mercado", "Mercados", CandlestickChart],
      ["caceria", "Cacería", Crosshair],
      ["operaciones", "Operaciones", Workflow],
    ],
  },
  {
    label: "Gestionar",
    items: [
      ["ofertas", "Capital", WalletCards],
      ["graficas", "Gráficas", BarChart3],
    ],
  },
  {
    label: "Sistema",
    items: [
      ["configuracion", "Estrategia", SlidersHorizontal],
      ["auditoria", "Auditoría", ShieldCheck],
    ],
  },
];
const navigation = navigationGroups.flatMap((group) => group.items);

function App() {
  const [session, setSession] = useState();
  const [view, setView] = useState(() => initialView());
  const [market, setMarket] = useState("");
  const [notice, setNotice] = useState(null);
  const noticeRef = useRef(null);
  const noticeQueueRef = useRef([]);
  const seenNoticeIdsRef = useRef(new Set());
  const [theme, setTheme] = useState(() => getInitialTheme());
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const { data, status, resources, online, refresh } = useDashboard(
    view,
    market,
    setMarket,
  );
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
    window.localStorage.setItem("qvaapply-theme", theme);
  }, [theme]);
  useEffect(() => {
    if (!mobileNavOpen) return undefined;
    const onKeyDown = (event) => {
      if (event.key === "Escape") setMobileNavOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [mobileNavOpen]);
  const showNotification = useCallback((incoming) => {
    if (!incoming) return;
    const id = incoming.id || incoming.version;
    if (id && seenNoticeIdsRef.current.has(id)) return;
    if (id) seenNoticeIdsRef.current.add(id);
    if (noticeRef.current) {
      noticeQueueRef.current.push(incoming);
      return;
    }
    noticeRef.current = incoming;
    setNotice(incoming);
    playNotificationTone();
  }, []);
  const dismissNotification = useCallback((current) => {
    noticeRef.current = null;
    setNotice(null);
    const id = current?.id || current?.version;
    if (id)
      void requestJson(`/api/notifications/${encodeURIComponent(id)}/ack`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      }).catch(() => undefined);
    const next = noticeQueueRef.current.shift();
    if (next) {
      noticeRef.current = next;
      setNotice(next);
      playNotificationTone();
    }
  }, []);
  useEffect(() => {
    if (!session?.authenticated) return undefined;
    let active = true;
    const loadNotifications = async () => {
      try {
        const payload = await requestJson("/api/notifications", {
          timeoutMs: 5_000,
        });
        if (active && payload.data?.[0]) showNotification(payload.data[0]);
      } catch {
        /* Web Push y Telegram continúan disponibles si el panel está desconectado. */
      }
    };
    void loadNotifications();
    const timer = window.setInterval(() => void loadNotifications(), 10_000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [session?.authenticated, showNotification]);
  const navigate = useCallback((next) => {
    setView(next);
    setMobileNavOpen(false);
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
        <img
          className="brand-logo boot-logo"
          src="/logo/isotipo.webp"
          alt="QvaApply"
          width="56"
          height="56"
        />
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
        <img
          className="brand-logo boot-logo"
          src="/logo/isotipo.webp"
          alt="QvaApply"
          width="56"
          height="56"
        />
        <p>{status}</p>
        <Skeleton label="Leyendo la base de datos local" />
        <Button variant="primary" onClick={refresh}>
          Reintentar lectura local
        </Button>
      </main>
    );
  const metadata = new Map(data.markets.map((item) => [item.code, item]));
  const label = (code) => metadata.get(code)?.label || code;
  const unit = (code) => metadata.get(code)?.currency || "";
  const selected = data.market[market] || { offers: [], total: 0 };
  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">
        Saltar al contenido principal
      </a>
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-lockup">
            <img
              src="/logo/logotipo.webp"
              alt="QvaApply"
              width="200"
              height="34"
            />
          </div>
        </div>
        <nav aria-label="Navegación principal">
          {navigationGroups.map((group) => (
            <div key={group.label}>
              <p className="nav-group-label" aria-hidden="true">
                {group.label}
              </p>
              {group.items.map(([key, text, Icon]) => (
                <Button
                  key={key}
                  variant="ghost"
                  className={view === key ? "active" : ""}
                  aria-current={view === key ? "page" : undefined}
                  onClick={() => navigate(key)}
                >
                  <Icon aria-hidden="true" />
                  {text}
                </Button>
              ))}
            </div>
          ))}
        </nav>
        <div className="sidebar-foot" aria-label="Estado operativo">
          <div className="foot-row">
            <span>{data.state.paused ? "Inactivo" : "Activo"}</span>
          </div>
          <span className="foot-separator">-</span>
          <div
            className={`connection-state ${online ? "" : "offline"}`}
            role="status"
            aria-live="polite"
            title={status}
          >
            <span>{online ? "Conectado" : "Sin conexión"}</span>
          </div>
        </div>
      </aside>
      <main className="main-area" id="main-content" tabIndex="-1">
        <header className="topbar">
          <div
            className="header-metrics"
            role="region"
            tabIndex="0"
            aria-label="Resumen de fondos disponibles"
          >
            <CurrencyBadge
              src="/icons/qusd.png"
              alt="QUSD"
              value={money(data.availability.qusd.available)}
              tone="qusd"
            />
            {data.markets.filter((item) => item.active).map((item) => {
              const availability = data.availability.fiat[item.code];
              return (
                <CurrencyBadge
                  key={item.code}
                  src={item.iconUrl}
                  alt={item.label}
                  fallback={item.label}
                  value={money(availability?.available || 0)}
                  color={item.color}
                  danger={isOvercommitted(availability)}
                  deficit={fiatDeficit(availability)}
                />
              );
            })}
          </div>
          <div className="top-actions">
            <Button
              variant="secondary"
              className="mobile-nav-trigger"
              onClick={() => setMobileNavOpen((open) => !open)}
              aria-expanded={mobileNavOpen}
              aria-controls="mobile-navigation"
            >
              <Menu aria-hidden="true" />
              <span>Secciones</span>
              <ChevronDown aria-hidden="true" />
            </Button>
            <PushControl onNotification={showNotification} />
            <IconButton
              className="theme-toggle"
              onClick={() =>
                setTheme((current) => (current === "dark" ? "light" : "dark"))
              }
              aria-label={
                theme === "dark"
                  ? "Cambiar a modo claro"
                  : "Cambiar a modo oscuro"
              }
              title={
                theme === "dark"
                  ? "Cambiar a modo claro"
                  : "Cambiar a modo oscuro"
              }
            >
              {theme === "dark" ? (
                <Sun aria-hidden="true" />
              ) : (
                <Moon aria-hidden="true" />
              )}
            </IconButton>
            <Button
              variant="primary"
              onClick={refresh}
              disabled={Object.values(resources).some((item) => item.loading)}
              aria-label="Actualizar datos"
              title="Actualizar datos"
            >
              <RefreshCw
                className={
                  Object.values(resources).some((item) => item.loading)
                    ? "spinning"
                    : ""
                }
                aria-hidden="true"
              />
            </Button>
            <IconButton
              onClick={logout}
              aria-label="Cerrar sesión"
              title="Cerrar sesión"
            >
              <LogOut aria-hidden="true" />
            </IconButton>
          </div>
          {mobileNavOpen ? (
            <div className="mobile-nav-layer">
              <button
                className="mobile-nav-backdrop"
                type="button"
                aria-label="Cerrar navegación"
                onClick={() => setMobileNavOpen(false)}
              />
              <nav
                id="mobile-navigation"
                className="mobile-nav-panel"
                aria-label="Navegación principal"
              >
                <div className="mobile-nav-heading">
                  <span>Ir a</span>
                  <IconButton
                    variant="ghost"
                    size="icon"
                    onClick={() => setMobileNavOpen(false)}
                    aria-label="Cerrar menú"
                  >
                    <X aria-hidden="true" />
                  </IconButton>
                </div>
                {navigation.map(([key, text, Icon]) => (
                  <Button
                    key={key}
                    variant="ghost"
                    className={view === key ? "active" : ""}
                    aria-current={view === key ? "page" : undefined}
                    onClick={() => navigate(key)}
                  >
                    <Icon aria-hidden="true" />
                    <span>{text}</span>
                  </Button>
                ))}
              </nav>
            </div>
          ) : null}
        </header>
        <div className="content">
          {notice ? (
            <aside className="push-toast" role="alert" aria-live="assertive">
              <Bell aria-hidden="true" />
              <div>
                <strong>
                  {notice.type === "blocked-offer"
                    ? "Oferta requiere revisión"
                    : notice.type === "operation-applied"
                      ? "Aplicación confirmada"
                      : notice.type === "rebalance-completed"
                        ? "Reajuste completado"
                        : notice.type === "rebalance-attention"
                          ? "Reajuste requiere atención"
                          : "Conciliación necesaria"}
                </strong>
                <p>
                  {notice.alert?.coin || "QvaApply"}
                  {notice.alert?.amount ? ` · ${notice.alert.amount} QUSD` : ""}
                  {notice.alert?.reason ? ` · ${notice.alert.reason}` : ""}
                </p>
                <Button
                  variant="primary"
                  size="sm"
                  onClick={() => {
                    const next =
                      new URL(
                        notice.url || "/?view=auditoria",
                        window.location.origin,
                      ).searchParams.get("view") || "auditoria";
                    navigate(next);
                    dismissNotification(notice);
                  }}
                >
                  Abrir detalle
                </Button>
              </div>
              <IconButton
                variant="ghost"
                size="icon"
                className="dialog-close"
                onClick={() => dismissNotification(notice)}
                aria-label="Cerrar aviso"
              >
                <X />
              </IconButton>
            </aside>
          ) : null}
          {view === "resumen" ? (
            <Cockpit
              data={data}
              label={label}
              unit={unit}
              onChanged={refresh}
              resources={resources}
            />
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
            <Capital
              data={data}
              label={label}
              unit={unit}
              onChanged={refresh}
              resources={resources}
            />
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
            <Hunting
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
          {view === "auditoria" ? (
            <Audit data={data} onChanged={refresh} />
          ) : null}
        </div>
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
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

function CurrencyBadge({ src, alt, fallback, value, tone = "market", color, danger = false, deficit = 0 }) {
  const title = danger
    ? `${value} ${alt} disponibles · faltan ${money(deficit)} ${alt} para cubrir ofertas`
    : `${value} ${alt} disponibles`;
  return (
    <span
      className={`currency-badge tone-${tone}${danger ? " is-danger" : ""}`}
      style={{ "--market-accent": color || "#6f8494" }}
      title={title}
      aria-label={title}
    >
      {src ? <img src={src} alt={alt} /> : <span className="currency-fallback" aria-hidden="true">{String(fallback || alt).trim().slice(0, 1).toUpperCase()}</span>}
      <strong>{value}</strong>
    </span>
  );
}

function isOvercommitted(availability) {
  return (
    Number(availability?.committed || 0) >
    Number(availability?.declared || 0) + 0.000001
  );
}

function fiatDeficit(availability) {
  return Math.max(
    0,
    Number(availability?.committed || 0) - Number(availability?.declared || 0),
  );
}

function PushControl({ onNotification }) {
  const supported =
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window;
  const [state, setState] = useState(supported ? "checking" : "unsupported");
  useEffect(() => {
    if (!supported) return;
    let active = true;
    const onMessage = (event) => {
      if (event.data?.type !== "qvaapply-notification") return;
      onNotification(event.data.payload || {});
    };
    navigator.serviceWorker.addEventListener("message", onMessage);
    void navigator.serviceWorker
      .register("/service-worker.js")
      .then(async (registration) => {
        const subscription = await registration.pushManager.getSubscription();
        if (active)
          setState(
            subscription
              ? "enabled"
              : Notification.permission === "denied"
                ? "denied"
                : "disabled",
          );
      })
      .catch(() => {
        if (active) setState("unsupported");
      });
    return () => {
      active = false;
      navigator.serviceWorker.removeEventListener("message", onMessage);
    };
  }, [supported, onNotification]);
  const toggle = async () => {
    try {
      setState("checking");
      const registration = await navigator.serviceWorker.ready;
      const current = await registration.pushManager.getSubscription();
      if (current) {
        await requestJson("/api/push/subscriptions", {
          method: "DELETE",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ endpoint: current.endpoint }),
        });
        await current.unsubscribe();
        setState("disabled");
        return;
      }
      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        setState("denied");
        return;
      }
      const payload = await requestJson("/api/push/public-key");
      const subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: decodeVapidKey(payload.data.publicKey),
      });
      await requestJson("/api/push/subscriptions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(subscription),
      });
      setState("enabled");
    } catch {
      setState("error");
    }
  };
  const labels = {
    checking: "Comprobando avisos",
    enabled: "Avisos activados",
    disabled: "Activar avisos",
    denied: "Avisos bloqueados",
    unsupported: "Avisos no compatibles",
    error: "Reintentar avisos",
  };
  return (
    <IconButton
      className={`push-control ${state}`}
      onClick={() => void toggle()}
      disabled={
        state === "checking" || state === "unsupported" || state === "denied"
      }
      aria-label={labels[state]}
      title={labels[state]}
    >
      <Bell aria-hidden="true" />
      <span className="push-dot" />
    </IconButton>
  );
}

function decodeVapidKey(value) {
  const padding = "=".repeat((4 - (value.length % 4)) % 4);
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
    oscillator.frequency.value = 660;
    gain.gain.value = 0.035;
    oscillator.connect(gain);
    gain.connect(context.destination);
    oscillator.start();
    gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + 0.18);
    oscillator.stop(context.currentTime + 0.18);
  } catch {
    /* el aviso visual y nativo siguen disponibles */
  }
}
