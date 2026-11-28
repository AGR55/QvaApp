#!/usr/bin/env python3
"""Emite SQL idempotente para importar cuentas lectoras y ajustes del feed.

Lee el SQLite de producción en modo read-only. No imprime secretos: el SQL va a
stdout y el deploy lo pasa directamente a psql dentro del contenedor.
"""

from __future__ import annotations

import sqlite3
import sys
from typing import Any


def quote(value: Any) -> str:
    if value is None:
        return "NULL"
    return "'" + str(value).replace("'", "''") + "'"


def main() -> int:
    if len(sys.argv) != 2:
        print("Uso: f3-export-market-readers-sql.py <sqlite>", file=sys.stderr)
        return 2
    connection = sqlite3.connect(f"file:{sys.argv[1]}?mode=ro", uri=True, timeout=10)
    connection.row_factory = sqlite3.Row
    statements: list[str] = []
    try:
        for row in connection.execute(
            "SELECT id,label,encrypted_token,token_fingerprint,interval_seconds,"
            "enabled,created_at,updated_at,last_success_at,last_attempt_at,"
            "next_eligible_at,consecutive_errors,last_error FROM market_reader_accounts"
        ):
            statements.append(
                "INSERT INTO shadow.market_readers ("
                "id,label,encrypted_token,token_fingerprint,interval_seconds,enabled,"
                "created_at,updated_at,last_success_at,last_attempt_at,next_eligible_at,"
                "consecutive_errors,last_error) VALUES ("
                f"{quote(row['id'])},{quote(row['label'])},{quote(row['encrypted_token'])},"
                f"{quote(row['token_fingerprint'])},{int(row['interval_seconds'] or 3)},"
                f"{'true' if row['enabled'] else 'false'},{int(row['created_at'] or 0)},"
                f"{int(row['updated_at'] or 0)},{quote(row['last_success_at'])},"
                f"{quote(row['last_attempt_at'])},{int(row['next_eligible_at'] or 0)},"
                f"{int(row['consecutive_errors'] or 0)},{quote(row['last_error'])}) "
                "ON CONFLICT (id) DO NOTHING;"
            )
        feed_settings = {
            "market_feed_app_id": "market_source.stream_app_id",
            "market_feed_app_secret": "market_source.stream_app_secret",
            "market_feed_secret": "market_source.webhook_secret",
        }
        for source, target in feed_settings.items():
            row = connection.execute(
                "SELECT value FROM settings WHERE key = ?", (source,)
            ).fetchone()
            if row and row["value"]:
                statements.append(
                    "INSERT INTO shadow.runtime_settings (key,value,updated_at) VALUES ("
                    f"{quote(target)},to_jsonb({quote(row['value'])}::text),"
                    "(extract(epoch from now()) * 1000)::bigint) "
                    "ON CONFLICT (key) DO NOTHING;"
                )
        statements.append(
            "INSERT INTO shadow.runtime_settings (key,value,updated_at) VALUES ("
            "'market_source.mode',to_jsonb('hybrid'::text),"
            "(extract(epoch from now()) * 1000)::bigint) ON CONFLICT (key) DO NOTHING;"
        )
    finally:
        connection.close()
    print("\n".join(statements))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
