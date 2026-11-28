#!/usr/bin/env bash
# Caos F3 local: fallos de entrada, runs duplicados/concurrentes, kill -9 y
# base de datos inaccesible. Usa una base Postgres temporal y una exportación
# read-only de la SQLite; nunca toca producción.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
: "${PGHOST:=127.0.0.1}"
: "${PGPORT:=5432}"
: "${PGUSER:=postgres}"
: "${PGADMIN_DB:=postgres}"

name="qvaapply_f3_chaos_$$_$(date +%s)"
work="$(mktemp -d -t qva-f3-chaos-XXXXXX)"
cleanup() {
  psql -d "$PGADMIN_DB" -v ON_ERROR_STOP=1 -c "DROP DATABASE IF EXISTS \"$name\"" >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT

psql -d "$PGADMIN_DB" -v ON_ERROR_STOP=1 -c "CREATE DATABASE \"$name\"" >/dev/null
PGDATABASE="$name" bash "$repo/services/db/migrate.sh" >/dev/null
dsn="postgres://${PGUSER}:${PGPASSWORD:-}@${PGHOST}:${PGPORT}/${name}"

(
  cd "$repo/services/trading-core"
  go build -o "$work/shadow-replay" ./cmd/shadow-replay
  go build -o "$work/shadow-audit" ./cmd/shadow-audit
)

sqlite3 -readonly "file:$repo/data/qvaapply.sqlite?mode=ro" -json \
  "SELECT version, coin, offer_type, amount, receive, rate, decision, reason, checks_json, reference_rate, created_at, updated_at FROM decision_events ORDER BY id" \
  > "$work/events.json"

run_count() {
  psql -d "$name" -Atc "SELECT count(*) FROM shadow.runs WHERE run_id = '$1'"
}
decision_count() {
  psql -d "$name" -Atc "SELECT count(*) FROM shadow.decisions WHERE run_id = '$1'"
}

# 1. JSON malformado: debe fallar antes de escribir.
printf 'no-es-json' > "$work/bad.json"
if "$work/shadow-audit" -events "$work/bad.json" -database-url "$dsn" -run-id chaos-bad-json >"$work/bad.log" 2>&1; then
  echo "chaos: se aceptó JSON malformado" >&2
  exit 1
fi
[[ "$(run_count chaos-bad-json)" == 0 ]]

# 2. Evento sin checks: se omite, pero el run queda vacío y consistente.
printf '%s\n' '[{"version":"sin-checks","coin":"BANK_CUP","offer_type":"sell","amount":1,"receive":1,"rate":1,"decision":"blocked","reason":"sin evidencia","checks_json":"[]","created_at":1,"updated_at":1}]' > "$work/sin-checks.json"
"$work/shadow-audit" -events "$work/sin-checks.json" -database-url "$dsn" -run-id chaos-sin-checks -fail-on-mismatch=false >"$work/sin-checks.log"
[[ "$(run_count chaos-sin-checks)" == 1 ]]
[[ "$(decision_count chaos-sin-checks)" == 0 ]]

# 3. Run duplicado: el segundo intento falla y no duplica decisiones.
"$work/shadow-replay" -corpus "$repo/parity/fixtures/replay/2026-11-12" -database-url "$dsn" -run-id chaos-duplicate >/dev/null
if "$work/shadow-replay" -corpus "$repo/parity/fixtures/replay/2026-11-12" -database-url "$dsn" -run-id chaos-duplicate >"$work/duplicate.log" 2>&1; then
  echo "chaos: se aceptó un run duplicado" >&2
  exit 1
fi
[[ "$(decision_count chaos-duplicate)" == 14 ]]

# 4. Dos audits concurrentes con el mismo run: exactamente uno gana.
set +e
"$work/shadow-audit" -events "$work/events.json" -database-url "$dsn" -run-id chaos-concurrent >"$work/concurrent-1.log" 2>&1 &
pid1=$!
"$work/shadow-audit" -events "$work/events.json" -database-url "$dsn" -run-id chaos-concurrent >"$work/concurrent-2.log" 2>&1 &
pid2=$!
wait "$pid1"; status1=$?
wait "$pid2"; status2=$?
set -e
if (( status1 + status2 != 1 )); then
  echo "chaos: concurrencia inesperada ($status1, $status2)" >&2
  exit 1
fi
[[ "$(run_count chaos-concurrent)" == 1 ]]

# 5. kill -9: si el run existe, debe estar completo; si no, no hay residuos.
set +e
timeout -s KILL 0.05 "$work/shadow-audit" -events "$work/events.json" -database-url "$dsn" -run-id chaos-kill >/dev/null 2>&1
set -e
runs=$(run_count chaos-kill)
decisions=$(decision_count chaos-kill)
if [[ $runs == 1 ]]; then
  steps=$(psql -d "$name" -Atc "SELECT steps FROM shadow.runs WHERE run_id = 'chaos-kill'")
  if [[ "$decisions" != "$steps" ]]; then
    echo "chaos: run matado quedó parcial ($decisions/$steps)" >&2
    exit 1
  fi
fi

# 6. Base inaccesible: falla sin dejar run.
if "$work/shadow-audit" -events "$work/events.json" -database-url "postgres://${PGUSER}:${PGPASSWORD:-}@127.0.0.1:1/${name}" -run-id chaos-db-down >"$work/db-down.log" 2>&1; then
  echo "chaos: se aceptó una base inaccesible" >&2
  exit 1
fi
[[ "$(run_count chaos-db-down)" == 0 ]]

printf 'f3-chaos: OK (6 escenarios, sin runs parciales)\n'
