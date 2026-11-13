#!/usr/bin/env bash
# Verifica importación SQLite→Postgres y triggers con un fixture mínimo.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
: "${PGHOST:=127.0.0.1}"
: "${PGPORT:=5432}"
: "${PGUSER:=postgres}"
: "${PGADMIN_DB:=postgres}"

tmp="$(mktemp -d -t qva-pg-import-XXXXXX)"
name="qvaapply_ci_import_$$_$(date +%s)"
cleanup() {
  psql -d "$PGADMIN_DB" -v ON_ERROR_STOP=1 -c "DROP DATABASE IF EXISTS \"$name\"" >/dev/null 2>&1 || true
  rm -rf "$tmp"
}
trap cleanup EXIT

node "$here/generate-fixture.mjs" --out "$tmp/minimal-v31.sqlite" >/dev/null
psql -d "$PGADMIN_DB" -v ON_ERROR_STOP=1 -c "CREATE DATABASE \"$name\""
PGDATABASE="$name" node "$here/import-sqlite-to-postgres.mjs" \
  --source "$tmp/minimal-v31.sqlite" \
  --database "$name" --schema core --replace
psql -d "$name" -v ON_ERROR_STOP=1 -f "$here/triggers/core-v1.sql"
psql -d "$name" -v ON_ERROR_STOP=1 -f "$here/fixtures/import-triggers.sql"
printf 'postgres-f1-import: importación y triggers OK (%s)\n' "$name"
