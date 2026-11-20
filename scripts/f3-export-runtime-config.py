#!/usr/bin/env python3
"""Genera el TradingConfig inicial del edge desde el SQLite de producción.

La salida tiene el mismo contrato que `GET /api/config` del monolito TS. El
deploy la inserta una sola vez en `shadow.runtime_config`; a partir de ahí el
panel es la fuente de verdad y los redeploys no sobrescriben cambios.
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


def first(connection: sqlite3.Connection, query: str) -> sqlite3.Row | None:
    return connection.execute(query).fetchone()


def number(value: Any, default: float = 0.0) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def integer(value: Any, default: int = 0) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def boolean(value: Any, default: bool = False) -> bool:
    if value is None:
        return default
    return bool(int(value))


def payment_details(connection: sqlite3.Connection) -> dict[str, list[dict[str, str]]]:
    details: dict[str, list[dict[str, str]]] = {}
    try:
        rows = connection.execute(
            "SELECT market_code, name, value FROM payment_details"
            " ORDER BY market_code, position"
        )
    except sqlite3.Error:
        return details
    for row in rows:
        details.setdefault(str(row["market_code"]), []).append(
            {"name": str(row["name"]), "value": str(row["value"])}
        )
    return details


def main() -> int:
    if len(sys.argv) != 2:
        print("Uso: f3-export-runtime-config.py <sqlite>", file=sys.stderr)
        return 2
    connection = connect(sys.argv[1])
    try:
        trading = first(connection, "SELECT * FROM trading_config WHERE id = 1")
        bot = first(connection, "SELECT * FROM bot_config WHERE id = 1")
        risk = first(connection, "SELECT * FROM risk_config WHERE id = 1")
        details = payment_details(connection)
        markets = []
        for row in connection.execute(
            "SELECT code, label, currency, icon_url, color, active,"
            " hunt_buy_enabled, hunt_sell_enabled, fiat_balance, buy_max_rate,"
            " sell_min_rate, purchase_max_qusd, sell_fee_percent,"
            " outgoing_transfer_fee FROM market_config ORDER BY rowid"
        ):
            markets.append(
                {
                    "code": str(row["code"]),
                    "label": str(row["label"]),
                    "currency": str(row["currency"]),
                    "iconUrl": row["icon_url"] or "",
                    "color": row["color"] or "",
                    "active": boolean(row["active"]),
                    "huntBuyEnabled": boolean(row["hunt_buy_enabled"], True),
                    "huntSellEnabled": boolean(row["hunt_sell_enabled"], True),
                    "fiatBalance": number(row["fiat_balance"]),
                    "buyMaxRate": number(row["buy_max_rate"]),
                    "sellMinRate": number(row["sell_min_rate"]),
                    "purchaseMaxQusd": number(row["purchase_max_qusd"]),
                    "sellFeePercent": number(row["sell_fee_percent"]),
                    "outgoingTransferFee": number(row["outgoing_transfer_fee"]),
                    "paymentDetails": details.get(str(row["code"]), []),
                }
            )
        config = {
            "version": 3,
            "qusdReserve": number(trading["qusd_reserve"]) if trading else 0,
            "maxOpenOffers": integer(trading["max_open_offers"], 10) if trading else 10,
            "hunting": {
                "buyRunning": boolean(bot["hunt_buy_running"], True) if bot else True,
                "sellRunning": boolean(bot["hunt_sell_running"], True) if bot else True,
            },
            "automation": {
                "scanIntervalSeconds": number(bot["scan_interval_seconds"], 3) if bot else 3,
                "autoCancelMinutes": number(bot["auto_cancel_minutes"], 60) if bot else 60,
                "offerRefreshIntervalMinutes": number(bot["offer_refresh_interval_minutes"], 4) if bot else 4,
                "offerRefreshSpacingSeconds": number(bot["offer_refresh_spacing_seconds"], 10) if bot else 10,
                "priceGuardPercent": number(bot["price_guard_percent"], 25) if bot else 25,
                "welcomeMessage": str(bot["welcome_message"]) if bot else "",
            },
            "risk": {
                "maxQusdPerOperation": number(risk["max_qusd_per_operation"]) if risk else 0,
                "maxConcurrentQusdExposure": number(risk["max_concurrent_qusd_exposure"]) if risk else 0,
                "maxDailyAppliedQusd": number(risk["max_daily_applied_qusd"]) if risk else 0,
                "maxConcurrentOperations": integer(risk["max_concurrent_operations"]) if risk else 1,
                "minQusdReserve": number(risk["min_qusd_reserve"]) if risk else 0,
                "maxQuoteAgeSeconds": number(risk["max_quote_age_seconds"]) if risk else 90,
                "minExpectedMarginPercent": number(risk["min_expected_margin_percent"]) if risk else 0,
                "maxSlippagePercent": number(risk["max_slippage_percent"]) if risk else 0,
                "maxConsecutiveErrors": integer(risk["max_consecutive_errors"], 3) if risk else 3,
                "marketCooldownSeconds": number(risk["market_cooldown_seconds"]) if risk else 30,
                "counterpartyCooldownSeconds": number(risk["counterparty_cooldown_seconds"]) if risk else 300,
                "reviewedAt": integer(risk["reviewed_at"]) if risk and risk["reviewed_at"] is not None else None,
            },
            "markets": markets,
        }
    finally:
        connection.close()
    json.dump(config, sys.stdout, ensure_ascii=False, separators=(",", ":"))
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
