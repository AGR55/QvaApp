import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  ArrowDownToLine,
  Clipboard,
  Download,
  Pause,
  Play,
  RefreshCw,
  Search,
  TerminalSquare,
} from "lucide-react";
import { Empty, ViewHead } from "../components/common.jsx";
import { Badge, Button, Field, Input, Select } from "../components/ui.jsx";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "../components/ui/card.tsx";
import { requestJson } from "../lib/http.js";

const LEVELS = [
  { value: "all", label: "Todos los niveles" },
  { value: "error", label: "Errores" },
  { value: "warning", label: "Avisos" },
  { value: "success", label: "Correctos" },
  { value: "info", label: "Informativos" },
];
const COMPONENTS = [
  { value: "all", label: "Todos los componentes" },
  { value: "trading", label: "Escáner y estrategia" },
  { value: "qvapay", label: "QvaPay y operaciones" },
  { value: "notifications", label: "Notificaciones" },
  { value: "network", label: "Red cooperativa" },
  { value: "system", label: "Sistema" },
];
const PERIODS = [
  { value: "3600000", label: "Última hora" },
  { value: "21600000", label: "Últimas 6 horas" },
  { value: "86400000", label: "Últimas 24 horas" },
  { value: "604800000", label: "Últimos 7 días" },
  { value: "all", label: "Todo el historial" },
];
const LEVEL_LABEL = {
  info: "Info",
  success: "Correcto",
  warning: "Aviso",
  error: "Error",
};
const LEVEL_VARIANT = {
  info: "info",
  success: "success",
  warning: "warning",
  error: "danger",
};
const COMPONENT_LABEL = Object.fromEntries(
  COMPONENTS.filter((item) => item.value !== "all").map((item) => [
    item.value,
    item.label,
  ]),
);

export function Logs() {
  const [entries, setEntries] = useState([]);
  const [level, setLevel] = useState("all");
  const [component, setComponent] = useState("all");
  const [period, setPeriod] = useState("21600000");
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [following, setFollowing] = useState(true);
  const [autoScroll, setAutoScroll] = useState(true);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [lastUpdated, setLastUpdated] = useState(null);
  const [feedback, setFeedback] = useState("");
  const cursorRef = useRef(0);
  const requestGenerationRef = useRef(0);
  const pollingRef = useRef(false);
  const listRef = useRef(null);

  useEffect(() => {
    const timer = window.setTimeout(() => setQuery(search.trim()), 300);
    return () => window.clearTimeout(timer);
  }, [search]);

  const filterParams = useCallback(() => {
    const params = new URLSearchParams({ limit: "120" });
    if (level !== "all") params.set("level", level);
    if (component !== "all") params.set("component", component);
    if (period !== "all") params.set("since", period);
    if (query) params.set("query", query);
    return params;
  }, [component, level, period, query]);

  const loadInitial = useCallback(async () => {
    const generation = requestGenerationRef.current + 1;
    requestGenerationRef.current = generation;
    setLoading(true);
    setError("");
    try {
      const payload = await requestJson(`/api/logs?${filterParams()}`, {
        timeoutMs: 8_000,
      });
      if (requestGenerationRef.current !== generation) return;
      const page = payload.data;
      setEntries(page.items.slice().reverse());
      cursorRef.current = page.newestId;
      setLastUpdated(Date.now());
    } catch (caught) {
      if (requestGenerationRef.current !== generation) return;
      setError(
        caught instanceof Error
          ? caught.message
          : "No se pudieron cargar los logs.",
      );
    } finally {
      if (requestGenerationRef.current === generation) setLoading(false);
    }
  }, [filterParams]);

  const loadNew = useCallback(async () => {
    if (pollingRef.current) return;
    pollingRef.current = true;
    const generation = requestGenerationRef.current;
    const params = filterParams();
    params.set("after", String(cursorRef.current));
    params.set("limit", "200");
    try {
      const payload = await requestJson(`/api/logs?${params}`, {
        timeoutMs: 6_000,
      });
      if (requestGenerationRef.current !== generation) return;
      const page = payload.data;
      cursorRef.current = page.newestId;
      if (page.items.length) {
        setEntries((current) => {
          const known = new Set(current.map((item) => item.id));
          return [
            ...current,
            ...page.items.filter((item) => !known.has(item.id)),
          ].slice(-500);
        });
      }
      setLastUpdated(Date.now());
      setError("");
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "Se interrumpió el seguimiento de logs.",
      );
    } finally {
      pollingRef.current = false;
    }
  }, [filterParams]);

  useEffect(() => {
    void loadInitial();
    return () => {
      requestGenerationRef.current += 1;
    };
  }, [loadInitial]);

  useEffect(() => {
    if (!following) return undefined;
    const timer = window.setInterval(() => void loadNew(), 2_000);
    return () => window.clearInterval(timer);
  }, [following, loadNew]);

  useEffect(() => {
    if (!autoScroll || !listRef.current) return;
    listRef.current.scrollTo({
      top: listRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [autoScroll, entries.length]);

  const counts = useMemo(() => {
    const result = { info: 0, success: 0, warning: 0, error: 0 };
    for (const entry of entries) result[entry.level] += 1;
    return result;
  }, [entries]);

  const visibleText = useMemo(
    () => entries.map(formatLogLine).join("\n"),
    [entries],
  );

  const copyVisible = async () => {
    try {
      await navigator.clipboard.writeText(visibleText);
      setFeedback(`${entries.length} eventos copiados.`);
    } catch {
      setFeedback("El navegador no permitió copiar los eventos.");
    }
  };

  const downloadVisible = () => {
    const blob = new Blob([visibleText], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `qvaapply-logs-${new Date().toISOString().replaceAll(":", "-")}.txt`;
    anchor.click();
    URL.revokeObjectURL(url);
    setFeedback(`${entries.length} eventos descargados.`);
  };

  return (
    <>
      <ViewHead
        kicker="Diagnóstico local"
        title="Logs operativos"
        description="Sigue el escáner, QvaPay y las tareas internas sin acceder por SSH. Los secretos se redactan antes de llegar al navegador."
        meta={
          <div className="log-view-status" role="status" aria-live="polite">
            <span className={`live-dot ${following && !error ? "is-live" : ""}`} />
            <span>
              {error
                ? "Conexión interrumpida"
                : following
                  ? "Seguimiento activo"
                  : "Seguimiento pausado"}
            </span>
            {lastUpdated ? (
              <time dateTime={new Date(lastUpdated).toISOString()}>
                Última lectura {new Date(lastUpdated).toLocaleTimeString("es-CU")}
              </time>
            ) : null}
          </div>
        }
      />

      <section className="log-metrics" aria-label="Resumen de eventos visibles">
        <LogMetric label="Eventos" value={entries.length} tone="total" />
        <LogMetric label="Errores" value={counts.error} tone="error" />
        <LogMetric label="Avisos" value={counts.warning} tone="warning" />
        <LogMetric label="Correctos" value={counts.success} tone="success" />
      </section>

      <Card className="log-console-card">
        <CardHeader className="log-console-head">
          <div>
            <CardTitle className="log-console-title">
              <TerminalSquare aria-hidden="true" />
              Flujo de eventos
            </CardTitle>
            <CardDescription>
              Hasta 500 eventos visibles; el historial completo permanece en SQLite.
            </CardDescription>
          </div>
          <CardAction className="log-console-actions">
            <Button
              variant={following ? "outline" : "primary"}
              size="sm"
              onClick={() => setFollowing((current) => !current)}
            >
              {following ? (
                <Pause data-icon="inline-start" aria-hidden="true" />
              ) : (
                <Play data-icon="inline-start" aria-hidden="true" />
              )}
              {following ? "Pausar" : "Reanudar"}
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={loading}
              onClick={() => void loadInitial()}
            >
              <RefreshCw
                data-icon="inline-start"
                className={loading ? "spinning" : ""}
                aria-hidden="true"
              />
              Actualizar
            </Button>
          </CardAction>
        </CardHeader>

        <CardContent className="log-console-content">
          <div className="log-filters" role="search" aria-label="Filtrar logs">
            <Field label="Buscar" htmlFor="log-search" className="log-search-field">
              <div className="log-search-control">
                <Search aria-hidden="true" />
                <Input
                  id="log-search"
                  type="search"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="Acción, detalle o UUID"
                />
              </div>
            </Field>
            <Field label="Nivel" htmlFor="log-level">
              <Select
                id="log-level"
                value={level}
                onValueChange={setLevel}
                options={LEVELS}
              />
            </Field>
            <Field label="Componente" htmlFor="log-component">
              <Select
                id="log-component"
                value={component}
                onValueChange={setComponent}
                options={COMPONENTS}
              />
            </Field>
            <Field label="Período" htmlFor="log-period">
              <Select
                id="log-period"
                value={period}
                onValueChange={setPeriod}
                options={PERIODS}
              />
            </Field>
          </div>

          {error ? (
            <div className="log-connection-error" role="alert">
              <strong>No se perdieron los eventos visibles.</strong>
              <span>{error}</span>
              <Button variant="outline" size="sm" onClick={() => void loadInitial()}>
                Reintentar
              </Button>
            </div>
          ) : null}

          <div
            className="log-stream"
            ref={listRef}
            tabIndex="0"
            aria-label="Eventos operativos"
            aria-busy={loading}
          >
            {loading && !entries.length ? (
              <div className="log-loading" role="status">
                <span />
                <span />
                <span />
                Leyendo auditoría…
              </div>
            ) : entries.length ? (
              <ol className="log-list">
                {entries.map((entry) => (
                  <LogRow key={entry.id} entry={entry} />
                ))}
              </ol>
            ) : (
              <Empty>No hay eventos que coincidan con estos filtros.</Empty>
            )}
          </div>
        </CardContent>

        <CardFooter className="log-console-footer">
          <Button
            variant="ghost"
            size="sm"
            className="log-autoscroll"
            aria-pressed={autoScroll}
            onClick={() => setAutoScroll((current) => !current)}
          >
            <ArrowDownToLine data-icon="inline-start" aria-hidden="true" />
            Seguir el final
          </Button>
          <div className="log-export-actions">
            <Button
              variant="ghost"
              size="sm"
              disabled={!entries.length}
              onClick={() => void copyVisible()}
            >
              <Clipboard data-icon="inline-start" aria-hidden="true" />
              Copiar
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={!entries.length}
              onClick={downloadVisible}
            >
              <Download data-icon="inline-start" aria-hidden="true" />
              Descargar
            </Button>
          </div>
          <span className="log-feedback" role="status" aria-live="polite">
            {feedback}
          </span>
        </CardFooter>
      </Card>
    </>
  );
}

function LogMetric({ label, value, tone }) {
  return (
    <article className={`log-metric tone-${tone}`}>
      <span>{label}</span>
      <strong>{value.toLocaleString("es-CU")}</strong>
    </article>
  );
}

function LogRow({ entry }) {
  const timestamp = new Date(entry.createdAt);
  return (
    <li className={`log-row level-${entry.level}`}>
      <time dateTime={timestamp.toISOString()} title={timestamp.toLocaleString("es-CU")}>
        {timestamp.toLocaleTimeString("es-CU", {
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
          hour12: false,
        })}
      </time>
      <Badge variant={LEVEL_VARIANT[entry.level]}>
        {LEVEL_LABEL[entry.level]}
      </Badge>
      <span className="log-component">{COMPONENT_LABEL[entry.component]}</span>
      <div className="log-message">
        <strong>{humanizeAction(entry.action)}</strong>
        <p>{entry.detail}</p>
        {entry.uuid ? <code>{entry.uuid}</code> : null}
      </div>
    </li>
  );
}

function humanizeAction(action) {
  return action
    .split("_")
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function formatLogLine(entry) {
  const timestamp = new Date(entry.createdAt).toISOString();
  const uuid = entry.uuid ? ` uuid=${entry.uuid}` : "";
  return `${timestamp} [${entry.level.toUpperCase()}] [${entry.component}] ${entry.action}${uuid} — ${entry.detail}`;
}
