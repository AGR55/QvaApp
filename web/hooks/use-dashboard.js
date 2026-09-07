import { useCallback, useEffect, useRef, useState } from "react";
import { requestJson } from "../lib/http.js";

export function useDashboard(setMarket) {
  const [data, setData] = useState();
  const [status, setStatus] = useState("Preparando la mesa…");
  const requestId = useRef(0);
  const refresh = useCallback(async () => {
    const currentRequest = ++requestId.current;
    setStatus("Actualizando…");
    try {
      const payload = await requestJson("/api/dashboard");
      if (currentRequest !== requestId.current) return;
      if (!payload.data) throw new Error(payload.error || "Sin datos");
      setData(payload.data);
      setMarket((current) => current || payload.data.markets[0]?.code || "");
      setStatus(
        `${payload.stale ? "Lectura anterior" : "Actualizado"} ${new Date(payload.data.generatedAt).toLocaleTimeString("es-CU")}${payload.error ? ` · ${payload.error}` : ""}`,
      );
    } catch (error) {
      if (currentRequest === requestId.current && error?.status !== 401)
        setStatus(
          error instanceof Error ? error.message : "Sin conexión local",
        );
    }
  }, [setMarket]);
  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 30_000);
    return () => {
      requestId.current += 1;
      clearInterval(timer);
    };
  }, [refresh]);
  return { data, status, refresh };
}
