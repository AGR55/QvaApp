const GLOBAL_RESOURCES = [
  ["balance", "/api/live/balance"],
  ["ownOffers", "/api/live/own-offers"],
];

export function dashboardResources(view, market, snapshot) {
  if (!snapshot) return [];
  const specific = [];
  if (view === "resumen") {
    specific.push(...snapshot.markets
      .filter((item) => item.active)
      .map((item) => [
        `market:${item.code}`,
        `/api/live/markets/${encodeURIComponent(item.code)}`,
      ]));
  } else if (view === "mercado" && market) {
    specific.push([
      `market:${market}`,
      `/api/live/markets/${encodeURIComponent(market)}`,
    ]);
  } else if (view === "caceria") {
    specific.push(...snapshot.markets
      .filter((item) => item.active && (item.huntBuyEnabled || item.huntSellEnabled))
      .map((item) => [
        `market:${item.code}`,
        `/api/live/markets/${encodeURIComponent(item.code)}`,
      ]));
  } else if (view === "operaciones") {
    specific.push(["operations", "/api/live/operations"]);
  }
  return [...new Map(
    [...GLOBAL_RESOURCES, ...specific].map((resource) => [resource[0], resource]),
  ).values()];
}
