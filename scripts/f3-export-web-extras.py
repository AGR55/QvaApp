#!/usr/bin/env python3
"""Exporta logs operativos, notificaciones y conciliaciones para el panel web.

Es de solo lectura y no incluye tokens. El edge aplica filtros y paginación.
"""

from __future__ import annotations

import json
import sqlite3
import sys
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


def text(value: Any) -> str | None:
    return None if value is None else str(value)


def integer(value: Any, default: int = 0) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def export_logs(connection: sqlite3.Connection) -> list[dict[str, Any]]:
    return [
        {
            "id": integer(row["id"]),
            "createdAt": integer(row["created_at"]),
            "action": text(row["action"]) or "",
            "uuid": text(row["offer_uuid"]),
            "detail": text(row["detail"]) or "",
        }
        for row in rows(
            connection,
            "SELECT id, created_at, action, offer_uuid, detail FROM audit_log"
            " ORDER BY id DESC LIMIT 5000",
        )
    ]


def export_notifications(connection: sqlite3.Connection) -> list[dict[str, Any]]:
    kinds = (
        "operation-applied",
        "own-offer-applied",
        "reconciliation-required",
        "recovery-blocked",
        "rebalance-completed",
        "rebalance-attention",
        "system-health",
        "informational-summary",
    )
    placeholders = ",".join("?" for _ in kinds)
    result: list[dict[str, Any]] = []
    for row in rows(
        connection,
        "SELECT id, kind, message, operation_uuid, payload_json, created_at"
        " FROM notification_events WHERE acknowledged_at IS NULL"
        f" AND kind IN ({placeholders})"
        " AND (kind <> 'rebalance-completed' OR push_delivered_at IS NOT NULL)"
        " ORDER BY CASE WHEN kind IN ('operation-applied','own-offer-applied',"
        "'recovery-blocked','reconciliation-required','rebalance-attention') THEN 0"
        " WHEN kind='informational-summary' THEN 2 ELSE 1 END,"
        " created_at DESC LIMIT 20",
        kinds,
    ):
        try:
            payload = json.loads(row["payload_json"])
        except (TypeError, ValueError):
            payload = {}
        result.append(
            {
                "id": text(row["id"]),
                "kind": text(row["kind"]),
                "message": text(row["message"]) or "",
                "operationUuid": text(row["operation_uuid"]),
                "payload": payload if isinstance(payload, dict) else {},
                "createdAt": integer(row["created_at"]),
            }
        )
    return result


def export_recovery(connection: sqlite3.Connection) -> dict[str, Any]:
    acknowledgements = {
        (text(row["key"]) or "").removeprefix("recovery_ack:"): integer(row["value"])
        for row in rows(
            connection,
            "SELECT key, value FROM settings WHERE key LIKE 'recovery_ack:%' LIMIT 5000",
        )
    }
    evidence: dict[str, list[dict[str, Any]]] = {}
    for row in rows(
        connection,
        "SELECT key, value FROM settings WHERE key LIKE 'recovery_evidence:%' LIMIT 5000",
    ):
        key = (text(row["key"]) or "").removeprefix("recovery_evidence:")
        try:
            parsed = json.loads(row["value"])
        except (TypeError, ValueError):
            continue
        if isinstance(parsed, list):
            evidence[key] = parsed

    items: list[dict[str, Any]] = []
    for row in rows(
        connection,
        "SELECT intent_id, operation_uuid, workflow_id, kind, state, error,"
        " created_at, updated_at FROM mutation_intents"
        " WHERE state IN ('submitted','uncertain') ORDER BY created_at ASC LIMIT 200",
    ):
        intent_id = text(row["intent_id"]) or ""
        items.append(
            {
                "intentId": intent_id,
                "kind": text(row["kind"]) or "",
                "state": text(row["state"]) or "",
                "operationUuid": text(row["operation_uuid"]),
                "workflowId": text(row["workflow_id"]),
                "createdAt": integer(row["created_at"]),
                "updatedAt": integer(row["updated_at"]),
                "error": text(row["error"]),
                "acknowledged": intent_id in acknowledgements,
                "evidence": evidence.get(intent_id, []),
                "manualEligible": False,
                "manualOutcomes": [],
                "manualBlockedReason": "El edge shadow es de solo lectura; la conciliación financiera sigue en el monolito TS.",
            }
        )
    return {"items": items, "blocked": bool(items)}


def export_cooperative(connection: sqlite3.Connection) -> dict[str, Any]:
    resources: dict[str, Any] = {}
    for row in rows(
        connection,
        "SELECT resource_key, payload_json FROM remote_resource_cache"
        " WHERE resource_key IN ('cooperative-network','cooperative-executions')",
    ):
        try:
            resources[text(row["resource_key"]) or ""] = json.loads(row["payload_json"])
        except (TypeError, ValueError):
            continue
    owed = 0.0
    for row in rows(connection, "SELECT value FROM settings WHERE key = 'cooperative_qusd_owed'"):
        try:
            owed = float(row["value"] or 0)
        except (TypeError, ValueError):
            owed = 0.0
        break
    network = resources.get("cooperative-network")
    executions = resources.get("cooperative-executions")
    return {
        "network": network if isinstance(network, dict) else {},
        "executions": executions if isinstance(executions, list) else [],
        "qusdOwed": owed,
    }


def export_decision_events(connection: sqlite3.Connection) -> list[dict[str, Any]]:
    return [
        {
            "id": integer(row["id"]),
            "version": text(row["version"]) or "",
            "uuid": text(row["offer_uuid"]) or "",
            "coin": text(row["coin"]) or "",
            "offerType": text(row["offer_type"]) or "",
            "amount": float(row["amount"] or 0),
            "receive": float(row["receive"] or 0),
            "rate": float(row["rate"] or 0),
            "decision": text(row["decision"]) or "",
            "reason": text(row["reason"]) or "",
            "checks": json.loads(row["checks_json"] or "[]"),
            "referenceRate": None if row["reference_rate"] is None else float(row["reference_rate"]),
            "resolution": text(row["resolution"]),
            "createdAt": integer(row["created_at"]),
            "updatedAt": integer(row["updated_at"]),
            "resolvedAt": None if row["resolved_at"] is None else integer(row["resolved_at"]),
        }
        for row in rows(
            connection,
            "SELECT * FROM decision_events ORDER BY id DESC LIMIT 2000",
        )
    ]


def export_simulation(connection: sqlite3.Connection) -> dict[str, Any]:
    account = ""
    for row in rows(connection, "SELECT value FROM settings WHERE key = 'analytics_account_uuid'"):
        account = text(row["value"]) or ""
        break
    own_offers: list[str] = []
    for row in rows(
        connection,
        "SELECT payload_json FROM remote_resource_cache WHERE resource_key = 'own-offers'",
    ):
        try:
            payload = json.loads(row["payload_json"])
        except (TypeError, ValueError):
            continue
        data = payload.get("data") if isinstance(payload, dict) else payload
        if isinstance(data, list):
            own_offers = [str(item.get("uuid")) for item in data if isinstance(item, dict) and item.get("uuid")]
    observations = [
        {
            "key": text(row["event_key"]) or "",
            "at": integer(row["received_at"]),
            "payload": text(row["payload_json"]) or "",
        }
        for row in rows(
            connection,
            "SELECT event_key, received_at, payload_json FROM market_feed_events"
            " WHERE event IN ('p2p.created','p2p.reopened','p2p.range_created','p2p.range_updated')"
            " ORDER BY received_at DESC, event_key DESC LIMIT 5000",
        )
    ]
    return {
        "accountUuid": account,
        "ownOffers": own_offers,
        "observations": observations,
    }


def main() -> int:
    if len(sys.argv) != 2:
        print("Uso: f3-export-web-extras.py <sqlite>", file=sys.stderr)
        return 2
    connection = connect(sys.argv[1])
    try:
        payload = {
            "logs": export_logs(connection),
            "notifications": export_notifications(connection),
            "recovery": export_recovery(connection),
            "decisionEvents": export_decision_events(connection),
            "simulation": export_simulation(connection),
            "cooperative": export_cooperative(connection),
        }
    finally:
        connection.close()
    json.dump(payload, sys.stdout, ensure_ascii=False, separators=(",", ":"))
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
