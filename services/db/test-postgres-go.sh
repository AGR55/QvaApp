#!/usr/bin/env bash
# Pruebas de integración Go de las primitivas Postgres.
set -euo pipefail
started_ms="$(date +%s%3N)"

here="$(cd "$(dirname "$0")" && pwd)"
: "${PGHOST:=127.0.0.1}"
: "${PGPORT:=5432}"
: "${PGUSER:=postgres}"
: "${PGADMIN_DB:=postgres}"

name="qvaapply_ci_go_$$_$(date +%s)"
cleanup() {
  psql -d "$PGADMIN_DB" -v ON_ERROR_STOP=1 -c "DROP DATABASE IF EXISTS \"$name\"" >/dev/null 2>&1 || true
}
trap cleanup EXIT

psql -d "$PGADMIN_DB" -v ON_ERROR_STOP=1 -c "CREATE DATABASE \"$name\""
PGDATABASE="$name" bash "$here/migrate.sh" >/dev/null
url="postgres://${PGUSER}:${PGPASSWORD:-}@${PGHOST}:${PGPORT}/${name}"
(
  cd "$here/../trading-core"
  TEST_POSTGRES_URL="$url" go test -race ./internal/platform/postgres/...
)
printf 'postgres-f1-go: integración OK (%s, %d ms)\n' "$name" "$(( $(date +%s%3N) - started_ms ))"
