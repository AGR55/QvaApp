import type { QvaTransaction } from "./types.js";
import type { P2pOffer } from "./types.js";

export interface AnalyticsOffer {
  uuid: string; coin: string; amount: number; receive: number; side: "incoming" | "outgoing";
  completedAt: number;
  parentUuid?: string;
}

export function analyticsOffer(offer: P2pOffer, account: string): AnalyticsOffer | undefined {
  const completedAt = Date.parse(offer.updated_at ?? "");
  const owner = offer.User?.uuid === account, peer = offer.Peer?.uuid === account;
  if (offer.offer_kind === "flexible" || offer.status !== "completed" || !Number.isFinite(completedAt) || !Number.isFinite(offer.amount) || offer.amount <= 0 ||
    !Number.isFinite(offer.receive) || offer.receive <= 0 || owner === peer) return undefined;
  return { uuid: offer.uuid, coin: offer.coin, amount: offer.amount, receive: offer.receive,
    side: (owner && offer.type === "buy") || (peer && offer.type === "sell") ? "incoming" : "outgoing", completedAt };
}

/** A flexible parent is inventory; each completed child is one trade. */
export function analyticsOffers(offer: P2pOffer, account: string): AnalyticsOffer[] {
  if (offer.offer_kind !== "flexible") {
    const row = analyticsOffer(offer, account);
    return row ? [row] : [];
  }
  const owner = offer.User?.uuid === account || offer.owner_uuid === account;
  return (offer.Orders ?? []).flatMap(order => {
    const taker = order.Taker?.uuid === account;
    const completedAt = Date.parse(order.released_at ?? order.updated_at ?? "");
    if (order.status !== "completed" || owner === taker || !Number.isFinite(completedAt) ||
      !Number.isFinite(order.amount) || order.amount <= 0 || !Number.isFinite(order.receive) || order.receive <= 0) return [];
    return [{ uuid: order.uuid, parentUuid: offer.uuid, coin: offer.coin, amount: order.amount, receive: order.receive,
      side: (owner && offer.type === "buy") || (taker && offer.type === "sell") ? "incoming" as const : "outgoing" as const,
      completedAt }];
  });
}

export interface AnalyticsTransaction {
  uuid: string;
  amount: number;
  createdAt: number;
  updatedAt: number;
  payerUuid?: string;
  recipientUuid?: string;
  p2p?: { uuid: string; coin: string; amount: number; receive: number; status: string };
}

export interface AnalyticsFiatMovement {
  uuid: string;
  direction: string;
  amount: number;
}

export function analyticsTransaction(tx: QvaTransaction): AnalyticsTransaction | undefined {
  const createdAt = Date.parse(tx.created_at ?? ""), updatedAt = Date.parse(tx.updated_at ?? tx.created_at ?? "");
  if (tx.status !== "paid" || !Number.isFinite(createdAt) || !Number.isFinite(updatedAt) || !Number.isFinite(tx.amount) || tx.amount < 0) return undefined;
  const p = tx.P2P;
  return {
    uuid: tx.uuid, amount: tx.amount, createdAt, updatedAt,
    ...(tx.PaidBy?.uuid ? { payerUuid: tx.PaidBy.uuid } : {}),
    ...(tx.User?.uuid ? { recipientUuid: tx.User.uuid } : {}),
    ...(p?.uuid && p.coin && Number.isFinite(p.amount) && Number(p.amount) > 0 && Number.isFinite(p.receive) && Number(p.receive) > 0
      ? { p2p: { uuid: p.uuid, coin: p.coin, amount: Number(p.amount), receive: Number(p.receive), status: p.status ?? "unknown" } } : {}),
  };
}

type Direction = "incoming" | "outgoing" | "unknown";
const dayFormat = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Havana", year: "numeric", month: "2-digit", day: "2-digit" });
export function analyticsDay(time: number): string {
  const parts = dayFormat.formatToParts(time);
  return ["year", "month", "day"].map((type) => parts.find((p) => p.type === type)!.value).join("-");
}
function direction(tx: AnalyticsTransaction, account: string): Direction {
  if (tx.payerUuid === account && tx.recipientUuid === account) return "unknown";
  if (tx.recipientUuid === account) return "incoming";
  if (tx.payerUuid === account) return "outgoing";
  return "unknown";
}

export function buildTradingAnalytics(input: {
  transactions: AnalyticsTransaction[];
  offers?: AnalyticsOffer[];
  accountUuid: string;
  fiat: AnalyticsFiatMovement[];
  markets: { code: string; label: string; currency: string }[];
  days: number;
  now: number;
}) {
  const end = analyticsDay(input.now);
  const start = new Date(Date.parse(`${end}T12:00:00Z`) - (input.days - 1) * 86_400_000).toISOString().slice(0, 10);
  const inPeriod = (at: number) => at <= input.now && analyticsDay(at) >= start && analyticsDay(at) <= end;
  const daily = new Map<string, { date: string; incoming: number; outgoing: number; unknown: number; count: number; bought: number; sold: number }>();
  for (let i = 0; i < input.days; i++) {
    const date = new Date(Date.parse(`${start}T12:00:00Z`) + i * 86_400_000).toISOString().slice(0, 10);
    daily.set(date, { date, incoming: 0, outgoing: 0, unknown: 0, count: 0, bought: 0, sold: 0 });
  }
  const transactions = [...new Map(input.transactions.map((tx) => [tx.uuid, tx])).values()].filter((tx) => tx.createdAt <= input.now && tx.updatedAt <= input.now);
  for (const tx of transactions) {
    if (!inPeriod(tx.createdAt)) continue;
    const row = daily.get(analyticsDay(tx.createdAt))!;
    row[direction(tx, input.accountUuid)] += tx.amount;
    row.count++;
  }
  const rangeParents = new Set((input.offers ?? []).flatMap(offer => offer.parentUuid ? [offer.parentUuid] : []));
  // A completed offer can have several escrow/accounting transactions. Count it once.
  const groups = new Map<string, AnalyticsTransaction[]>();
  for (const tx of transactions) if (tx.p2p?.status === "completed" && !rangeParents.has(tx.p2p.uuid)) {
    const rows = groups.get(tx.p2p.uuid) ?? [];
    rows.push(tx); groups.set(tx.p2p.uuid, rows);
  }
  const fiatByUuid = new Map(input.fiat.map((movement) => [movement.uuid, movement]));
  const transactionTrades = [...groups.values()].map((rows) => {
    const tx = rows.reduce((latest, row) => row.updatedAt > latest.updatedAt ? row : latest);
    const p = tx.p2p!;
    const fiat = fiatByUuid.get(p.uuid);
    const sides = new Set(rows.map((row) => direction(row, input.accountUuid)).filter((side) => side !== "unknown"));
    const side: Direction = fiat ? fiat.direction === "debit" ? "incoming" : "outgoing" : sides.size === 1 ? [...sides][0]! : "unknown";
    return { uuid: p.uuid, coin: p.coin, qusd: p.amount, fiat: fiat?.amount ?? p.receive, side, at: tx.updatedAt };
  });
  const offerTrades = (input.offers ?? []).filter(offer => !rangeParents.has(offer.uuid)).map((offer) => ({ uuid: offer.uuid, coin: offer.coin, qusd: offer.amount,
    fiat: fiatByUuid.get(offer.uuid)?.amount ?? offer.receive, side: offer.side, at: offer.completedAt }));
  const trades = [...new Map([...transactionTrades, ...offerTrades].map((trade) => [trade.uuid, trade])).values()]
    .sort((a, b) => a.at - b.at || a.uuid.localeCompare(b.uuid));
  const markets = new Map<string, {
    code: string; label: string; currency: string; volume: number; count: number; bought: number; sold: number; unknown: number;
    fiatSpent: number; fiatReceived: number; estimatedProfit: number; matchedQusd: number; unmatchedSoldQusd: number; matchedCost: number;
  }>();
  const marketRow = (coin: string) => {
    if (!markets.has(coin)) {
      const info = input.markets.find((market) => market.code === coin);
      markets.set(coin, { code: coin, label: info?.label ?? coin, currency: info?.currency ?? coin,
        volume: 0, count: 0, bought: 0, sold: 0, unknown: 0, fiatSpent: 0, fiatReceived: 0,
        estimatedProfit: 0, matchedQusd: 0, unmatchedSoldQusd: 0, matchedCost: 0 });
    }
    return markets.get(coin)!;
  };
  const inventory = new Map<string, { amount: number; unitCost: number }[]>();
  const profits = new Map<string, { date: string; currency: string; profit: number }>();
  for (const trade of trades) {
    const row = marketRow(trade.coin), selected = inPeriod(trade.at);
    const lots = inventory.get(trade.coin) ?? [];
    inventory.set(trade.coin, lots);
    if (selected) {
      row.volume += trade.qusd; row.count++;
      if (trade.side === "incoming") { row.bought += trade.qusd; row.fiatSpent += trade.fiat; daily.get(analyticsDay(trade.at))!.bought += trade.qusd; }
      else if (trade.side === "outgoing") { row.sold += trade.qusd; row.fiatReceived += trade.fiat; daily.get(analyticsDay(trade.at))!.sold += trade.qusd; }
      else row.unknown += trade.qusd;
    }
    if (trade.side === "incoming") lots.push({ amount: trade.qusd, unitCost: trade.fiat / trade.qusd });
    if (trade.side !== "outgoing") continue;
    let remaining = trade.qusd, cost = 0, matched = 0;
    while (remaining > 1e-8 && lots.length) {
      const lot = lots[0]!;
      const used = Math.min(remaining, lot.amount);
      cost += used * lot.unitCost; matched += used; remaining -= used; lot.amount -= used;
      if (lot.amount < 1e-8) lots.shift();
    }
    if (selected) {
      const profit = matched * trade.fiat / trade.qusd - cost;
      row.matchedQusd += matched; row.unmatchedSoldQusd += remaining; row.matchedCost += cost; row.estimatedProfit += profit;
      const date = analyticsDay(trade.at), key = `${date}:${row.currency}`;
      const point = profits.get(key) ?? { date, currency: row.currency, profit: 0 };
      point.profit += profit; profits.set(key, point);
    }
  }
  const selectedMarkets = [...markets.values()].filter((row) => row.count).sort((a, b) => b.volume - a.volume);
  const totals = [...daily.values()].reduce((sum, row) => ({ count: sum.count + row.count, incoming: sum.incoming + row.incoming, outgoing: sum.outgoing + row.outgoing, unknown: sum.unknown + row.unknown }), { count: 0, incoming: 0, outgoing: 0, unknown: 0 });
  const currencies = [...new Set(selectedMarkets.map((row) => row.currency))].map((currency) => {
    const rows = selectedMarkets.filter((row) => row.currency === currency);
    return { currency, profit: rows.reduce((sum, row) => sum + row.estimatedProfit, 0), matchedQusd: rows.reduce((sum, row) => sum + row.matchedQusd, 0) };
  });
  return { days: input.days, start, end, generatedAt: input.now, daily: [...daily.values()], markets: selectedMarkets,
    profits: [...profits.values()], currencies, totals,
    volume: selectedMarkets.reduce((sum, row) => sum + row.volume, 0),
    completed: selectedMarkets.reduce((sum, row) => sum + row.count, 0),
    coverage: { transactions: transactions.length, oldestAt: transactions.length ? Math.min(...transactions.map((tx) => tx.createdAt)) : null,
      unknownDirection: transactions.filter((tx) => inPeriod(tx.createdAt) && direction(tx, input.accountUuid) === "unknown").length,
      unmatchedSoldQusd: selectedMarkets.reduce((sum, row) => sum + row.unmatchedSoldQusd, 0) },
  };
}
