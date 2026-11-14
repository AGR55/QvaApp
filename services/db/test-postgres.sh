#!/usr/bin/env bash
# Verifica migraciones + triggers en un Postgres desechable.
# Usa PGHOST/PGPORT/PGUSER/PGPASSWORD y crea una base única; no toca otras.
set -euo pipefail
started_ms="$(date +%s%3N)"

here="$(cd "$(dirname "$0")" && pwd)"
: "${PGHOST:=127.0.0.1}"
: "${PGPORT:=5432}"
: "${PGUSER:=postgres}"
: "${PGADMIN_DB:=postgres}"

name="qvaapply_ci_$$_$(date +%s)"
cleanup() {
  psql -d "$PGADMIN_DB" -v ON_ERROR_STOP=1 -c "DROP DATABASE IF EXISTS \"$name\"" >/dev/null 2>&1 || true
}
trap cleanup EXIT

psql -d "$PGADMIN_DB" -v ON_ERROR_STOP=1 -c "CREATE DATABASE \"$name\""
PGDATABASE="$name" bash "$here/migrate.sh"
psql -d "$name" -v ON_ERROR_STOP=1 -f "$here/fixtures/triggers.sql"
psql -d "$name" -v ON_ERROR_STOP=1 -f "$here/fixtures/outbox-inbox.sql"
PGDATABASE="$name" bash "$here/audit-invariants.sh"
printf 'postgres-f1: migraciones y triggers OK (%s, %d ms)\n' "$name" "$(( $(date +%s%3N) - started_ms ))"
