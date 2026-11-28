#!/usr/bin/env python3
"""Importa las operaciones locales de producción a shadow.local_operations."""
from __future__ import annotations
import sqlite3, sys

def q(value):
    if value is None:
        return "NULL"
    return "'" + str(value).replace("'", "''") + "'"

def main():
    if len(sys.argv) != 2:
        print("Uso: f3-export-operations-sql.py <sqlite>", file=sys.stderr)
        return 2
    con = sqlite3.connect(f"file:{sys.argv[1]}?mode=ro", uri=True, timeout=10)
    con.row_factory = sqlite3.Row
    out = []
    try:
        for r in con.execute(
            "SELECT uuid,offer_type,coin,amount,receive,rate,state,auto_applied,"
            "cancel_at,created_at,updated_at,order_uuid,reference_rate,counterparty_id "
            "FROM operations"
        ):
            out.append(
                "INSERT INTO shadow.local_operations (uuid,offer_type,coin,amount,receive,rate,state,"
                "auto_applied,cancel_at,created_at,updated_at,order_uuid,reference_rate,counterparty_id) VALUES ("
                f"{q(r['uuid'])},{q(r['offer_type'])},{q(r['coin'])},{float(r['amount'] or 0)},"
                f"{float(r['receive'] or 0)},{float(r['rate'] or 0)},{q(r['state'])},"
                f"{'true' if r['auto_applied'] else 'false'},{q(r['cancel_at'])},"
                f"{int(r['created_at'] or 0)},{int(r['updated_at'] or 0)},{q(r['order_uuid'])},"
                f"{q(r['reference_rate'])},{q(r['counterparty_id'])}) "
                "ON CONFLICT (uuid) DO UPDATE SET state=excluded.state, updated_at=excluded.updated_at;"
            )
    finally:
        con.close()
    print("\n".join(out))
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
