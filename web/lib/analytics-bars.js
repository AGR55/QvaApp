// Group the whole selected period: density changes never hide earlier days.
export function analyticsBars(daily, maximum) {
  const size = Math.max(1, Math.ceil(daily.length / maximum));
  return Array.from({ length: Math.ceil(daily.length / size) }, (_, index) => {
    const rows = daily.slice(index * size, (index + 1) * size);
    return rows.reduce((sum, row) => ({ ...sum,
      incoming: sum.incoming + row.incoming, outgoing: sum.outgoing + row.outgoing,
      unknown: sum.unknown + row.unknown, count: sum.count + row.count,
      bought: sum.bought + row.bought, sold: sum.sold + row.sold,
    }), { date: rows[0].date, end: rows.at(-1).date, incoming: 0, outgoing: 0, unknown: 0, count: 0, bought: 0, sold: 0 });
  });
}
