#!/usr/bin/env bash
# Ejecuta el auditor de invariantes contra PGDATABASE.
# Sale con 1 si hay cualquier violación.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
: "${PGDATABASE:=qvaapply}"

violations="$(psql -At -F $'\t' -v ON_ERROR_STOP=1 -d "$PGDATABASE" -f "$here/audit-invariants.sql")"
if [[ -n "$violations" ]]; then
  printf 'audit-invariants: VIOLACIONES\n%s\n' "$violations"
  exit 1
fi
printf 'audit-invariants: OK (%s)\n' "$PGDATABASE"
