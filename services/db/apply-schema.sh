#!/usr/bin/env bash
# Aplica el esquema core v1 a una base Postgres vacía.
# Usa las variables PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDATABASE de psql.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
: "${PGDATABASE:=qvaapply}"

psql -v ON_ERROR_STOP=1 -f "$here/schema/core-v1.sql" "$@"
