#!/usr/bin/env bash
# Runner de migraciones Postgres versionadas.
#
# - Usa PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDATABASE de psql.
# - Aplica en orden lexicográfico los *.sql de services/db/migrations.
# - Registra cada versión en public.qvaapply_schema_migrations.
# - Cada migración y su registro se ejecutan en una sola transacción.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
: "${PGDATABASE:=qvaapply}"

psql -v ON_ERROR_STOP=1 -d "$PGDATABASE" <<'SQL'
CREATE TABLE IF NOT EXISTS public.qvaapply_schema_migrations (
  version text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);
SQL

shopt -s nullglob
for file in "$here"/migrations/*.sql; do
  version="$(basename "$file" .sql)"
  applied="$(psql -At -d "$PGDATABASE" -c "SELECT 1 FROM public.qvaapply_schema_migrations WHERE version = '${version}'")"
  if [[ "$applied" == "1" ]]; then
    printf 'skip  %s\n' "$version"
    continue
  fi
  printf 'apply %s\n' "$version"
  psql -v ON_ERROR_STOP=1 -1 -d "$PGDATABASE" \
    -f "$file" \
    -c "INSERT INTO public.qvaapply_schema_migrations(version) VALUES ('${version}')"
done
printf 'migrations: OK (%s)\n' "$PGDATABASE"
