#!/usr/bin/env python3
"""Exporta un snapshot público y de solo lectura desde el SQLite de producción.

El resultado alimenta únicamente rutas GET autenticadas del edge shadow. Nunca
incluye tokens, hashes de credenciales, teléfonos, remitentes ni contenido de
chat: solo los campos que el panel ya muestra.

Uso:
    python3 scripts/f3-export-dashboard-snapshot.py /ruta/qvaapply.sqlite

Escribe JSON en stdout. Cualquier tabla ausente se exporta como lista vacía para
que el snapshot siga siendo válido durante una migración parcial.
"""

from __future__ import annotations

import json
import sqlite3
import sys
import time
from typing import Any


def connect(path: str) -> sqlite3.Connection:
    connection = sqlite3.connect(f"file:{path}?mode=ro", uri=True, timeout=10)
    connection.row_factory = sqlite3.Row
    return connection


def rows(connection: sqlite3.Connection, query: str, parameters: tuple[Any, ...] = ()) -> list[sqlite3.Row]:
    try:
        return list(connection.execute(query, parameters))
    except sqlite3.Error:
        return []


def integer(value: Any) -> int | None:
    if value is None:
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def number(value: Any) -> float | None:
    if value is None:
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def text(value: Any) -> str | None:
    return None if value is None else str(value)


def export_devices(connection: sqlite3.Connection) -> list[dict[str, Any]]:
    return [
        {
            "id": text(row["id"]),
            "label": text(row["label"]),
            "createdAt": integer(row["created_at"]),
            "revokedAt": integer(row["revoked_at"]),
        }
        for row in rows(
            connection,
            "SELECT id, label, created_at, revoked_at FROM sms_devices"
            " ORDER BY created_at DESC LIMIT 500",
        )
    ]


def export_receipts(connection: sqlite3.Connection) -> list[dict[str, Any]]:
    return [
        {
            "id": text(row["id"]),
            "status": text(row["state"]),
            "receivedAt": integer(row["received_at"]),
            "operationUuid": text(row["operation_uuid"]),
            "reason": text(row["reason"]),
        }
        for row in rows(
            connection,
            "SELECT id, state, received_at, operation_uuid, reason FROM payment_receipts"
            " ORDER BY created_at DESC LIMIT 100",
        )
    ]


def export_fiat_history(connection: sqlite3.Connection) -> list[dict[str, Any]]:
    history = [
        {
            "id": f"history:{row['id']}",
            "coin": text(row["coin"]),
            "before": number(row["balance_before"]),
            "after": number(row["balance_after"]),
            "amount": number(row["amount"]),
            "uuid": text(row["operation_uuid"]),
            "source": text(row["source"]),
            "kind": text(row["kind"]),
            "createdAt": integer(row["created_at"]),
            "origin": 1,
            "sequence": integer(row["id"]),
        }
        for row in rows(
            connection,
            "SELECT id, coin, balance_before, balance_after, amount, operation_uuid,"
            " source, kind, created_at FROM fiat_balance_history"
            " ORDER BY created_at DESC, id DESC LIMIT 2000",
        )
    ]
    legacy = [
        {
            "id": f"ledger:{row['id']}",
            "coin": text(row["coin"]),
            "before": None,
            "after": None,
            "amount": number(row["amount"]) if row["direction"] == "credit" else -float(row["amount"] or 0),
            "uuid": text(row["operation_uuid"]),
            "source": text(row["source"]),
            "kind": "legacy",
            "createdAt": integer(row["created_at"]),
            "origin": 0,
            "sequence": integer(row["id"]),
        }
        for row in rows(
            connection,
            "SELECT id, coin, amount, direction, operation_uuid, source, created_at"
            " FROM fiat_ledger l WHERE NOT EXISTS"
            " (SELECT 1 FROM fiat_balance_history h WHERE h.ledger_id = l.id)"
            " ORDER BY created_at DESC, id DESC LIMIT 2000",
        )
    ]
    return history + legacy


def export_rebalance_jobs(connection: sqlite3.Connection) -> list[dict[str, Any]]:
    jobs: list[dict[str, Any]] = []
    for row in rows(
        connection,
        "SELECT id, state, adjustments_json, error, created_at, updated_at"
        " FROM capital_rebalance_jobs ORDER BY created_at DESC LIMIT 500",
    ):
        try:
            adjustments = json.loads(row["adjustments_json"] or "[]")
        except (TypeError, ValueError):
            adjustments = []
        job: dict[str, Any] = {
            "id": text(row["id"]),
            "state": text(row["state"]),
            "adjustments": adjustments if isinstance(adjustments, list) else [],
            "createdAt": integer(row["created_at"]),
            "updatedAt": integer(row["updated_at"]),
        }
        if row["error"] is not None:
            job["error"] = text(row["error"])
        jobs.append(job)
    return jobs


def export_market_observations(connection: sqlite3.Connection) -> list[dict[str, Any]]:
    since = int(time.time() * 1000) - 7 * 86_400_000
    observations: list[dict[str, Any]] = []
    for row in rows(
        connection,
        "SELECT created_at, coin, average_buy, average_sell, median_buy, median_sell,"
        " best_buy, best_sell, open_offers, eligible FROM market_observations"
        " WHERE created_at >= ? ORDER BY created_at ASC LIMIT 50000",
        (since,),
    ):
        point: dict[str, Any] = {
            "createdAt": integer(row["created_at"]),
            "coin": text(row["coin"]),
            "openOffers": integer(row["open_offers"]),
            "eligible": integer(row["eligible"]),
        }
        for source, target in (
            ("average_buy", "averageBuy"),
            ("average_sell", "averageSell"),
            ("median_buy", "medianBuy"),
            ("median_sell", "medianSell"),
            ("best_buy", "bestBuy"),
            ("best_sell", "bestSell"),
        ):
            value = number(row[source])
            if value is not None:
                point[target] = value
        observations.append(point)
    return observations


def export_analytics_fees(connection: sqlite3.Connection) -> list[dict[str, Any]]:
    items: list[dict[str, Any]] = []
    for row in rows(
        connection,
        "SELECT a.payload_json, f.fee_qusd, f.gross_qusd, f.evidence, f.version"
        " FROM analytics_offers a LEFT JOIN analytics_fee_evidence f"
        " ON f.account_uuid = a.account_uuid AND f.offer_uuid = a.uuid"
        " WHERE json_extract(a.payload_json, '$.side') = 'incoming'"
        " ORDER BY a.completed_at DESC, a.uuid DESC LIMIT 2000",
    ):
        try:
            offer = json.loads(row["payload_json"])
        except (TypeError, ValueError):
            continue
        if not isinstance(offer, dict):
            continue
        amount = number(offer.get("amount"))
        gross = number(row["gross_qusd"])
        items.append(
            {
                "uuid": text(offer.get("uuid")),
                "coin": text(offer.get("coin")),
                "amount": amount,
                "receive": number(offer.get("receive")),
                "completedAt": integer(offer.get("completedAt")),
                "feeQusd": number(row["fee_qusd"]),
                "evidence": text(row["evidence"]) or "",
                "version": integer(row["version"]) or 0,
                "stale": gross is not None and amount is not None and gross != amount,
            }
        )
    return items


def main() -> int:
    if len(sys.argv) != 2:
        print("Uso: f3-export-dashboard-snapshot.py <sqlite>", file=sys.stderr)
        return 2
    connection = connect(sys.argv[1])
    try:
        snapshot = {
            "generatedAt": int(time.time() * 1000),
            "devices": export_devices(connection),
            "receipts": export_receipts(connection),
            "fiatHistory": export_fiat_history(connection),
            "rebalanceJobs": export_rebalance_jobs(connection),
            "marketObservations": export_market_observations(connection),
            "analyticsFees": export_analytics_fees(connection),
        }
    finally:
        connection.close()
    json.dump(snapshot, sys.stdout, ensure_ascii=False, separators=(",", ":"))
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
