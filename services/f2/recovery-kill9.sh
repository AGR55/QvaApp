#!/usr/bin/env bash
# Prueba F2 de recuperación tras kill -9 de un worker que ya reclamó el outbox.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
: "${PGHOST:=127.0.0.1}"
: "${PGPORT:=5432}"
: "${PGUSER:=postgres}"
: "${PGADMIN_DB:=postgres}"

name="qvaapply_f2_crash_$$_$(date +%s)"
work="$(mktemp -d -t qva-f2-crash-XXXXXX)"
cleanup() {
  psql -d "$PGADMIN_DB" -v ON_ERROR_STOP=1 -c "DROP DATABASE IF EXISTS \"$name\"" >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT

psql -d "$PGADMIN_DB" -v ON_ERROR_STOP=1 -c "CREATE DATABASE \"$name\""
PGDATABASE="$name" bash "$repo/services/db/migrate.sh" >/dev/null
psql -d "$name" -v ON_ERROR_STOP=1 <<'SQL'
INSERT INTO core.outbox (id, topic, payload_json, idempotency_key, state, available_at, created_at)
VALUES ('crash-1', 'core.events', '{}', 'crash-key-1', 'pending', 1000, 1000);
SQL

(
  cd "$repo/services/trading-core"
  go build -o "$work/outbox-crash" ./cmd/outbox-crash
)
dsn="postgres://${PGUSER}:${PGPASSWORD:-}@${PGHOST}:${PGPORT}/${name}"
"$work/outbox-crash" --dsn "$dsn" --mode claim --worker worker-a --now 1000 --lease-ms 1000 >"$work/claim.log" 2>&1 &
pid=$!
for attempt in $(seq 1 100); do
  grep -q '^claimed ' "$work/claim.log" 2>/dev/null && break
  sleep 0.05
done
grep -q '^claimed crash-1$' "$work/claim.log"
kill -9 "$pid"
wait "$pid" 2>/dev/null || true

locked="$(psql -d "$name" -Atc "SELECT state || ':' || coalesce(locked_by, '') FROM core.outbox WHERE id = 'crash-1'")"
if [[ "$locked" != "in_flight:worker-a" ]]; then
  printf 'estado inesperado tras kill -9: %s\n' "$locked" >&2
  exit 1
fi

"$work/outbox-crash" --dsn "$dsn" --mode recover --worker worker-b --now 2501 --lease-ms 1000 >"$work/recover.log"
grep -q '^published crash-1$' "$work/recover.log"
published="$(psql -d "$name" -Atc "SELECT count(*) FROM core.outbox WHERE id = 'crash-1' AND state = 'published'")"
if [[ "$published" != "1" ]]; then
  printf 'publicaciones inesperadas: %s\n' "$published" >&2
  exit 1
fi
printf 'f2-recovery: kill -9 recuperado, mensaje publicado una sola vez\n'
