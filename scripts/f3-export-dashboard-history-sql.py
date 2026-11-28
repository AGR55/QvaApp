#!/usr/bin/env python3
"""Importa el histórico de dashboard de producción a shadow."""
from __future__ import annotations
import sqlite3, sys

def main():
    if len(sys.argv) != 2:
        print("Uso: f3-export-dashboard-history-sql.py <sqlite>", file=sys.stderr)
        return 2
    con = sqlite3.connect(f"file:{sys.argv[1]}?mode=ro", uri=True, timeout=10)
    con.row_factory = sqlite3.Row
    out = []
    try:
        for r in con.execute(
            "SELECT created_at,qusd_balance,open_offers,active_operations "
            "FROM dashboard_snapshots ORDER BY created_at ASC"
        ):
            out.append(
                "INSERT INTO shadow.live_dashboard_history(created_at,qusd_balance,open_offers,active_operations) "
                f"VALUES ({int(r['created_at'])},{float(r['qusd_balance'] or 0)},"
                f"{int(r['open_offers'] or 0)},{int(r['active_operations'] or 0)}) "
                "ON CONFLICT (created_at) DO NOTHING;"
            )
    finally:
        con.close()
    print("\n".join(out))
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
