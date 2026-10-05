import { useCallback, useEffect, useRef, useState } from "react";
import { requestJson } from "../lib/http.js";

const EMPTY_RESOURCES = Object.freeze({});

export function useDashboard(
  setMarket,
  initialData,
  enabled = true,
) {
  const [data, setData] = useState(() => initialData);
  const [status, setStatus] = useState(() =>
    initialData
      ? "Datos preparados por la VPS"
      : "Leyendo datos preparados por la VPS…",
  );
  const [online, setOnline] = useState(() => navigator.onLine);
  const generation = useRef(0);
  const inFlight = useRef();
  const hasData = useRef(Boolean(initialData));

  const selectAvailableMarket = useCallback(
    (snapshot) => {
      setMarket((current) =>
        snapshot.markets.some((item) => item.code === current)
          ? current
          : snapshot.markets.find((item) => item.active)?.code ||
            snapshot.markets[0]?.code ||
            "",
      );
    },
    [setMarket],
  );

  const loadLocal = useCallback(
    async (activeGeneration = generation.current) => {
      const payload = await requestJson("/api/dashboard", {
        timeoutMs: 30_000,
      });
      if (activeGeneration !== generation.current || !payload.data) return;
      hasData.current = true;
      setData(payload.data);
      selectAvailableMarket(payload.data);
      setStatus("Vista actualizada desde la VPS");
    },
    [selectAvailableMarket],
  );

  const refresh = useCallback(async () => {
    if (!enabled) return;
    if (inFlight.current) return inFlight.current;
    const activeGeneration = ++generation.current;
    setStatus(
      hasData.current
        ? "Actualizando en segundo plano…"
        : "Leyendo datos preparados por la VPS…",
    );
    const operation = (async () => {
      try {
        await loadLocal(activeGeneration);
      } catch (error) {
        if (activeGeneration !== generation.current || error?.status === 401)
          return;
        setStatus(
          navigator.onLine
            ? error instanceof Error
              ? error.message
              : "No se pudo actualizar el panel"
            : "Sin conexión · la vista actual sigue disponible",
        );
      }
    })();
    inFlight.current = operation;
    try {
      await operation;
    } finally {
      if (inFlight.current === operation) inFlight.current = undefined;
    }
  }, [enabled, loadLocal]);

  useEffect(() => {
    if (data) selectAvailableMarket(data);
  }, [data, selectAvailableMarket]);

  useEffect(() => {
    if (!enabled) return undefined;
    // El HTML ya contiene un snapshot local: deja pintar la interfaz antes de
    // pedir la siguiente lectura. Sin snapshot, consulta de inmediato.
    const timer = window.setTimeout(() => void refresh(), initialData ? 1_500 : 0);
    return () => {
      window.clearTimeout(timer);
      generation.current += 1;
    };
  }, [enabled, initialData, refresh]);

  useEffect(() => {
    if (!enabled) return undefined;
    const updateConnection = () => {
      setOnline(navigator.onLine);
      if (navigator.onLine) void refresh();
      else setStatus("Sin conexión · la vista actual sigue disponible");
    };
    const onVisibility = () => {
      if (!document.hidden) void refresh();
    };
    window.addEventListener("online", updateConnection);
    window.addEventListener("offline", updateConnection);
    document.addEventListener("visibilitychange", onVisibility);
    const timer = window.setInterval(() => {
      if (!document.hidden) void refresh();
    }, 20_000);
    return () => {
      window.removeEventListener("online", updateConnection);
      window.removeEventListener("offline", updateConnection);
      document.removeEventListener("visibilitychange", onVisibility);
      window.clearInterval(timer);
    };
  }, [enabled, refresh]);

  return {
    data,
    status,
    resources: EMPTY_RESOURCES,
    online,
    refresh,
  };
}
