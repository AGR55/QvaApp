#!/usr/bin/env python3
"""Sincroniza los saldos fiat de producción con la configuración del panel Go.

Mientras TypeScript sigue siendo la autoridad, sus saldos fiat cambian con cada
operación. El panel del edge conserva una copia que puede quedar obsoleta y
hacer que el dimensionado de ofertas calcule fondos de más o de menos.

Este script lee `fiat_balance:<MERCADO>` de la SQLite de producción y actualiza
solo `fiatBalance` en la configuración del panel. No toca tasas, límites,
secretos ni ningún otro campo.

Uso:
    python3 scripts/f3-sync-fiat-balances.py --dry-run
    python3 scripts/f3-sync-fiat-balances.py

Variables de entorno:
    QVAAPPLY_EDGE_URL   por defecto http://127.0.0.1:8093
    QVAAPPLY_ORIGIN     por defecto https://qvapply.honux.tech
    QVAAPPLY_ENV_FILE   por defecto /opt/qvaapply/config/env
    QVAAPPLY_DB         por defecto /opt/qvaapply/data/qvaapply.sqlite
"""
from __future__ import annotations

import argparse
import http.cookiejar
import json
import os
import sqlite3
import sys
import urllib.error
import urllib.request


def env(name: str, default: str) -> str:
    return os.environ.get(name, default)


def admin_password(path: str) -> str:
    with open(path, encoding="utf-8") as handle:
        for line in handle:
            if line.startswith("DASHBOARD_ADMIN_PASSWORD="):
                return line.split("=", 1)[1].strip()
    raise SystemExit("no se encontró DASHBOARD_ADMIN_PASSWORD en el entorno")


def production_balances(path: str) -> dict[str, float]:
    connection = sqlite3.connect(f"file:{path}?mode=ro", uri=True, timeout=10)
    try:
        rows = connection.execute(
            "SELECT key, value FROM settings WHERE key LIKE 'fiat_balance:%'"
        )
        return {key.split(":", 1)[1]: float(value) for key, value in rows}
    finally:
        connection.close()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dry-run", action="store_true", help="solo muestra los cambios")
    args = parser.parse_args()

    base = env("QVAAPPLY_EDGE_URL", "http://127.0.0.1:8093")
    origin = env("QVAAPPLY_ORIGIN", "https://qvapply.honux.tech")

    jar = http.cookiejar.CookieJar()
    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
    login = urllib.request.Request(
        base + "/api/session",
        data=json.dumps({"password": admin_password(env("QVAAPPLY_ENV_FILE", "/opt/qvaapply/config/env"))}).encode(),
        method="POST",
    )
    login.add_header("Content-Type", "application/json")
    login.add_header("Origin", origin)
    csrf = json.loads(opener.open(login, timeout=20).read())["data"]["csrfToken"]

    config = json.loads(opener.open(base + "/api/config", timeout=20).read())["data"]
    balances = production_balances(env("QVAAPPLY_DB", "/opt/qvaapply/data/qvaapply.sqlite"))

    changed = []
    for market in config.get("markets", []):
        code = market.get("code")
        if code not in balances:
            continue
        current = market.get("fiatBalance")
        if current != balances[code]:
            changed.append((code, current, balances[code]))
            market["fiatBalance"] = balances[code]

    for code, before, after in changed:
        print(f"{code}: {before} -> {after}")
    if not changed:
        print("saldos ya sincronizados")
        return 0
    if args.dry_run:
        print("dry-run: no se escribió nada")
        return 0

    payload = json.dumps({
        "config": config,
        "reason": "Sincronización de saldos fiat desde producción",
    }).encode()
    request = urllib.request.Request(base + "/api/config", data=payload, method="PUT")
    request.add_header("Content-Type", "application/json")
    request.add_header("Origin", origin)
    request.add_header("X-CSRF-Token", csrf)
    try:
        response = opener.open(request, timeout=20)
        status = response.status
    except urllib.error.HTTPError as error:
        print("error", error.code, error.read()[:300].decode(errors="replace"), file=sys.stderr)
        return 1
    print("sincronizado, status", status)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
