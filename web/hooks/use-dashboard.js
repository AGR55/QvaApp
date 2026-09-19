import { useCallback, useEffect, useRef, useState } from "react";
import { requestJson } from "../lib/http.js";

const EMPTY_RESOURCES = Object.freeze({});

export function useDashboard(view, market, setMarket) {
  const [data, setData] = useState();
  const [status, setStatus] = useState("Leyendo datos preparados por la VPS…");
  const [online, setOnline] = useState(() => navigator.onLine);
  const generation = useRef(0);

  const loadLocal = useCallback(
    async (activeGeneration = generation.current) => {
      const payload = await requestJson("/api/dashboard", { timeoutMs: 5_000 });
      if (activeGeneration !== generation.current || !payload.data) return;
      setData(payload.data);
      setMarket((current) =>
        payload.data.markets.some((item) => item.code === current)
          ? current
          : payload.data.markets.find((item) => item.active)?.code ||
            payload.data.markets[0]?.code ||
            "",
      );
      setStatus("Vista actualizada desde la VPS");
    },
    [setMarket],
  );

  const refresh = useCallback(async () => {
    const activeGeneration = ++generation.current;
    setStatus("Leyendo datos preparados por la VPS…");
    try {
      await loadLocal(activeGeneration);
    } catch (error) {
      if (activeGeneration !== generation.current || error?.status === 401)
        return;
      setStatus(
        navigator.onLine
          ? error instanceof Error
            ? error.message
            : "No se pudo leer el panel"
          : "Sin conexión · conservando la última vista",
      );
    }
  }, [loadLocal]);

  useEffect(() => {
    void refresh();
    return () => {
      generation.current += 1;
    };
  }, [refresh]);

  useEffect(() => {
    if (!data) return;
    void refresh();
    // Cambiar de vista o mercado solo relee el snapshot local de la VPS.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, market]);

  useEffect(() => {
    const updateConnection = () => {
      setOnline(navigator.onLine);
      if (navigator.onLine) void refresh();
      else setStatus("Sin conexión · conservando la última vista");
    };
    const onVisibility = () => {
      if (!document.hidden) void refresh();
    };
    window.addEventListener("online", updateConnection);
    window.addEventListener("offline", updateConnection);
    document.addEventListener("visibilitychange", onVisibility);
    const timer = window.setInterval(() => {
      if (!document.hidden) void refresh();
    }, 10_000);
    return () => {
      window.removeEventListener("online", updateConnection);
      window.removeEventListener("offline", updateConnection);
      document.removeEventListener("visibilitychange", onVisibility);
      window.clearInterval(timer);
    };
  }, [refresh]);

  return {
    data,
    status,
    resources: EMPTY_RESOURCES,
    online,
    refresh,
  };
}
