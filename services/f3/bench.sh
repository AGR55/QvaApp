#!/usr/bin/env bash
# Benchmark F3 local: replay, auditoría y RSS del servicio shadow.
# Usa una base Postgres temporal; nunca toca producción.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
: "${PGHOST:=127.0.0.1}"
: "${PGPORT:=5432}"
: "${PGUSER:=postgres}"
: "${PGADMIN_DB:=postgres}"
: "${REPLAY_ITERATIONS:=20}"
: "${AUDIT_ITERATIONS:=10}"

name="qvaapply_f3_bench_$$_$(date +%s)"
work="$(mktemp -d -t qva-f3-bench-XXXXXX)"
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
  go build -o "$work/trading-core" ./cmd/trading-core
  go build -o "$work/shadow-replay" ./cmd/shadow-replay
  go build -o "$work/shadow-audit" ./cmd/shadow-audit
)
sqlite3 -readonly "file:$repo/data/qvaapply.sqlite?mode=ro" -json \
  "SELECT version, coin, offer_type, amount, receive, rate, decision, reason, checks_json, reference_rate, created_at, updated_at FROM decision_events ORDER BY id" \
  > "$work/events.json"

measure_ms() {
  local start end
  start=$(date +%s%3N)
  "$@" >/dev/null 2>&1
  end=$(date +%s%3N)
  printf '%s' "$((end - start))"
}

stats() {
  local label=$1
  shift
  local times=()
  local i value
  for ((i = 1; i <= $#; i++)); do
    value=${!i}
    times+=("$value")
  done
  printf '%s\n' "${times[@]}" | sort -n > "$work/$label.sorted"
  local n=${#times[@]}
  local min avg p95
  min=$(head -n 1 "$work/$label.sorted")
  avg=$(awk '{s+=$1} END {printf "%.1f", s/NR}' "$work/$label.sorted")
  p95=$(awk -v n="$n" 'NR == int((n * 95 + 99) / 100) {print; exit}' "$work/$label.sorted")
  printf '%s: n=%d min=%sms avg=%sms p95=%sms\n' "$label" "$n" "$min" "$avg" "$p95"
}

replay_times=()
for i in $(seq 1 "$REPLAY_ITERATIONS"); do
  id="bench-replay-$i-$(date +%s%N)"
  replay_times+=("$(measure_ms "$work/shadow-replay" -corpus "$repo/parity/fixtures/replay/2026-11-12" -database-url "$dsn" -run-id "$id")")
done
stats replay "${replay_times[@]}"

audit_times=()
for i in $(seq 1 "$AUDIT_ITERATIONS"); do
  id="bench-audit-$i-$(date +%s%N)"
  audit_times+=("$(measure_ms "$work/shadow-audit" -events "$work/events.json" -database-url "$dsn" -run-id "$id")")
done
stats audit "${audit_times[@]}"

audit_rss=0
"$work/shadow-audit" -events "$work/events.json" -database-url "$dsn" -run-id "bench-audit-rss-$(date +%s%N)" >/dev/null 2>&1 &
audit_pid=$!
while kill -0 "$audit_pid" 2>/dev/null; do
  rss=$(awk '/VmRSS:/ {print $2}' "/proc/$audit_pid/status" 2>/dev/null || true)
  if [[ ${rss:-} =~ ^[0-9]+$ ]] && (( rss > audit_rss )); then
    audit_rss=$rss
  fi
  sleep 0.005
done
wait "$audit_pid"
printf 'audit RSS: %s KB\n' "$audit_rss"

PORT=18090 DATABASE_URL="$dsn" SERVICE_NAME=trading-core-bench "$work/trading-core" >"$work/service.log" 2>&1 &
service_pid=$!
cleanup_service() {
  kill "$service_pid" 2>/dev/null || true
  wait "$service_pid" 2>/dev/null || true
}
trap 'cleanup_service; cleanup' EXIT
for _ in $(seq 1 50); do
  curl -fsS http://127.0.0.1:18090/healthz >/dev/null 2>&1 && break
  sleep 0.1
done
service_rss=$(ps -o rss= -p "$service_pid" | tr -d '[:space:]')
service_cpu=$(ps -o %cpu= -p "$service_pid" | tr -d '[:space:]')
printf 'service idle: rss=%s KB cpu=%s%%\n' "$service_rss" "$service_cpu"
cleanup_service
trap cleanup EXIT

printf 'f3-bench: OK (base temporal %s)\n' "$name"
