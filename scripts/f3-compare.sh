#!/usr/bin/env bash
# Compara métricas del feed TS con hunter/core Go. Solo lee, no muta nada.
set -Eeuo pipefail

readonly prod_db="/opt/qvaapply/data/qvaapply.sqlite"
readonly hunter_url="http://127.0.0.1:8091/metrics"
readonly core_url="http://127.0.0.1:8090/metrics"

setting() {
  sqlite3 -readonly -noheader "file:${prod_db}?mode=ro" \
    "SELECT coalesce(value,'') FROM settings WHERE key = '$1' LIMIT 1;"
}

metric() {
  local url=$1 name=$2
  curl -fsS --max-time 3 "$url" 2>/dev/null | awk -v name="$name" '$1 == name {print $2; exit}'
}

ts_decision=$(setting market_feed_last_decision_ms)
ts_lag=$(setting market_feed_last_delivery_lag_ms)
ts_latency=$(setting market_feed_last_latency_ms)
ts_mode=$(setting market_source_mode)
go_decision_us=$(metric "$hunter_url" hunter_stream_last_decision_us)
go_lag=$(metric "$hunter_url" hunter_stream_last_lag_ms)
go_events=$(metric "$hunter_url" hunter_stream_events_total)
go_errors=$(metric "$hunter_url" hunter_stream_errors_total)
go_polls=$(metric "$hunter_url" hunter_polls_total)
core_allowed=$(metric "$core_url" trading_core_core_decisions_allowed_total)
core_blocked=$(metric "$core_url" trading_core_core_decisions_blocked_total)
core_pending=$(metric "$core_url" trading_core_hunter_events_pending)

printf '%-28s %-18s %-18s\n' 'Métrica' 'TS' 'Go'
printf '%-28s %-18s %-18s\n' '----------------------------' '------------------' '------------------'
printf '%-28s %-18s %-18s\n' 'fuente' "${ts_mode:-?}" 'SSE-only'
printf '%-28s %-18s %-18s\n' 'decisión' "${ts_decision:-?} ms" "$(awk -v us="${go_decision_us:-0}" 'BEGIN {printf "%.2f ms", us/1000}')"
printf '%-28s %-18s %-18s\n' 'delivery lag' "${ts_lag:-?} ms" "${go_lag:-?} ms"
printf '%-28s %-18s %-18s\n' 'latencia lectura' "${ts_latency:-?} ms" 'n/a (SSE)'
printf '%-28s %-18s %-18s\n' 'eventos/errores' 'n/a' "${go_events:-0} / ${go_errors:-0}"
printf '%-28s %-18s %-18s\n' 'polls /p2p' 'TS: 2 cuentas' "${go_polls:-0}"
printf '%-28s %-18s %-18s\n' 'core allowed/blocked' 'n/a' "${core_allowed:-0} / ${core_blocked:-0}"
printf '%-28s %-18s %-18s\n' 'core eventos pendientes' 'n/a' "${core_pending:-0}"

printf '\nNota: TS y Go pueden haber medido ventanas distintas; los valores sirven para tendencia, no como benchmark estadístico formal.\n'
