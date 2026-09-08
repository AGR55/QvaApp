import { useCallback, useEffect, useRef, useState } from "react";
import { requestJson } from "../lib/http.js";

const RETRY_DELAYS = [0, 1_200, 3_000];

export function useDashboard(view, market, setMarket) {
  const [data, setData] = useState();
  const [status, setStatus] = useState("Leyendo datos locales…");
  const [resources, setResources] = useState({});
  const [online, setOnline] = useState(() => navigator.onLine);
  const generation = useRef(0);

  const loadLocal = useCallback(async (activeGeneration = generation.current) => {
    const payload = await requestJson("/api/dashboard", { timeoutMs: 5_000 });
    if (activeGeneration !== generation.current || !payload.data) return;
    setData(payload.data);
    setMarket((current) => current || payload.data.markets[0]?.code || "");
    setStatus("Datos locales disponibles");
  }, [setMarket]);

  const setResource = useCallback((key, patch) => {
    setResources((current) => ({
      ...current,
      [key]: { ...(current[key] || {}), ...patch },
    }));
  }, []);

  const syncOne = useCallback(async (key, url, activeGeneration) => {
    setResource(key, { loading: true, error: "" });
    let lastError;
    for (const delay of RETRY_DELAYS) {
      if (activeGeneration !== generation.current) return;
      if (delay) await wait(delay);
      try {
        const payload = await requestJson(url, { timeoutMs: 12_000 });
        if (activeGeneration !== generation.current) return;
        setResource(key, {
          loading: false,
          stale: Boolean(payload.stale),
          updatedAt: payload.updatedAt ?? null,
          error: payload.error || "",
        });
        await loadLocal(activeGeneration);
        return !payload.stale;
      } catch (error) {
        if (error?.status === 401) throw error;
        lastError = error;
        if (!navigator.onLine) break;
      }
    }
    if (activeGeneration !== generation.current) return;
    const detail = lastError instanceof Error
      ? lastError.message
      : "QvaPay no respondió.";
    setResource(key, { loading: false, stale: true, error: detail });
    setStatus(`Mostrando datos guardados · ${detail}`);
    return false;
  }, [loadLocal, setResource]);

  const resourcesForView = useCallback((snapshot) => {
    if (!snapshot) return [];
    if (view === "resumen") {
      return [
        ["balance", "/api/live/balance"],
        ["ownOffers", "/api/live/own-offers"],
        ...snapshot.markets
          .filter((item) => item.active)
          .map((item) => [
            `market:${item.code}`,
            `/api/live/markets/${encodeURIComponent(item.code)}`,
          ]),
      ];
    }
    if (view === "mercado" && market)
      return [[`market:${market}`, `/api/live/markets/${encodeURIComponent(market)}`]];
    if (view === "ofertas")
      return [
        ["balance", "/api/live/balance"],
        ["ownOffers", "/api/live/own-offers"],
      ];
    if (view === "caceria")
      return snapshot.markets
        .filter((item) => item.active && (item.huntBuyEnabled || item.huntSellEnabled))
        .map((item) => [
          `market:${item.code}`,
          `/api/live/markets/${encodeURIComponent(item.code)}`,
        ]);
    return [];
  }, [market, view]);

  const refresh = useCallback(async () => {
    const activeGeneration = ++generation.current;
    setStatus("Actualizando esta vista…");
    try {
      await loadLocal(activeGeneration);
      if (!navigator.onLine) {
        setStatus("Sin conexión · usando SQLite");
        return;
      }
      // Secuencial a propósito: evita saturar conexiones lentas con ráfagas.
      let allFresh = true;
      for (const [key, url] of resourcesForView(data))
        allFresh = (await syncOne(key, url, activeGeneration)) !== false && allFresh;
      if (activeGeneration === generation.current)
        setStatus(allFresh ? "Vista actualizada" : "Vista disponible con datos guardados");
    } catch (error) {
      if (activeGeneration !== generation.current || error?.status === 401) return;
      setStatus(error instanceof Error ? error.message : "Sin conexión local");
    }
  }, [data, loadLocal, resourcesForView, syncOne]);

  useEffect(() => {
    const activeGeneration = ++generation.current;
    void loadLocal(activeGeneration).catch((error) => {
      if (activeGeneration === generation.current)
        setStatus(error instanceof Error ? error.message : "No se pudo leer SQLite");
    });
    return () => { generation.current += 1; };
  }, [loadLocal]);

  useEffect(() => {
    if (!data) return;
    void refresh();
    // `data` no se incluye: cada fusión local no debe reiniciar la cola remota.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, market, Boolean(data)]);

  useEffect(() => {
    const updateConnection = () => {
      setOnline(navigator.onLine);
      setStatus(navigator.onLine
        ? "Conexión recuperada · listo para actualizar"
        : "Sin conexión · usando SQLite");
    };
    const onVisibility = () => {
      if (!document.hidden && navigator.onLine) void refresh();
    };
    window.addEventListener("online", updateConnection);
    window.addEventListener("offline", updateConnection);
    document.addEventListener("visibilitychange", onVisibility);
    const timer = window.setInterval(() => {
      if (!document.hidden && navigator.onLine) void refresh();
    }, 60_000);
    return () => {
      window.removeEventListener("online", updateConnection);
      window.removeEventListener("offline", updateConnection);
      document.removeEventListener("visibilitychange", onVisibility);
      window.clearInterval(timer);
    };
  }, [refresh]);

  return { data, status, resources, online, refresh };
}

function wait(milliseconds) {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}
