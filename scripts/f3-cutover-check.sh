#!/usr/bin/env bash
# Comprobación pre-cutover TS -> Go. Solo lectura: no despliega, no reinicia,
# no escribe en bases de datos y no imprime secretos, tokens ni saldos.
#
# Uso (como root, en la VPS):
#   scripts/f3-cutover-check.sh
#   scripts/f3-cutover-check.sh --help
#
# También se puede ejecutar sin copiarlo a la VPS:
#   ssh -i ~/.ssh/qvaapply_codex root@2.25.247.171 'bash -s' \
#     < scripts/f3-cutover-check.sh
#
# Variables opcionales:
#   F3_ROOT                    raíz shadow (por defecto /opt/qvaapply-f3-shadow)
#   PROD_ROOT                  raíz de producción (por defecto /opt/qvaapply)
#   PROD_EXPECTED_REVISION     prefijo de release TS esperado (02bb5af)
#   INVARIANTS_MAX_AGE_SECONDS antigüedad máxima del último invariante (172800)
#   HTTP_TIMEOUT               timeout de curl en segundos (5)
#
# Salida: [ OK ], [FAIL], [WARN] e [info]. Exit 1 si falla alguna comprobación.
set -Eeuo pipefail

F3_ROOT=${F3_ROOT:-/opt/qvaapply-f3-shadow}
PROD_ROOT=${PROD_ROOT:-/opt/qvaapply}
PROD_EXPECTED_REVISION=${PROD_EXPECTED_REVISION:-02bb5af}
INVARIANTS_MAX_AGE_SECONDS=${INVARIANTS_MAX_AGE_SECONDS:-172800}
HTTP_TIMEOUT=${HTTP_TIMEOUT:-5}

# Normaliza barras finales sin tocar la raíz "/".
[[ $F3_ROOT == / ]] || F3_ROOT=${F3_ROOT%/}
[[ $PROD_ROOT == / ]] || PROD_ROOT=${PROD_ROOT%/}

readonly F3_ROOT PROD_ROOT PROD_EXPECTED_REVISION INVARIANTS_MAX_AGE_SECONDS
readonly HTTP_TIMEOUT
readonly POSTGRES_CONTAINER="qvaapply-f3-shadow-postgres"
readonly PG_USER="qvaapply"
readonly PG_DATABASE="qvaapply"
readonly GO_SERVICES=(trading-core hunter notifier edge)
readonly SHADOW_PORTS=(8090 8091 8092 8093)

checks=0
failures=0
warnings=0

usage() {
  cat <<'EOF'
Comprobación pre-cutover QvaApply TS -> Go (solo lectura).

Uso:
  f3-cutover-check.sh [--help]

Ejecuta comprobaciones de release shadow, contenedores, endpoints, métricas,
colas shadow, invariantes y producción. No muta nada: solo usa curl GET,
docker inspect y SELECT con psql.

Variables de entorno:
  F3_ROOT                    Raíz shadow (defecto: /opt/qvaapply-f3-shadow)
  PROD_ROOT                  Raíz de producción (defecto: /opt/qvaapply)
  PROD_EXPECTED_REVISION     Prefijo de release TS esperado (defecto: 02bb5af)
  INVARIANTS_MAX_AGE_SECONDS Edad máxima del último run de invariantes
                             (defecto: 172800 = 48 h)
  HTTP_TIMEOUT               Timeout de curl en segundos (defecto: 5)

Requiere root en la VPS (docker exec al Postgres shadow).

Códigos de salida:
  0  Todas las comprobaciones pasaron (puede haber avisos).
  1  Alguna comprobación falló.
  2  Error de uso o falta un requisito de ejecución.

Este script no ejecuta el cutover ni cambia la autoridad de producción.
EOF
}

while (($# > 0)); do
  case "$1" in
    -h | --help)
      usage
      exit 0
      ;;
    *)
      echo "Argumento no reconocido: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if ((EUID != 0)); then
  echo "Este script debe ejecutarse como root en la VPS." >&2
  exit 2
fi

if [[ -z $F3_ROOT || -z $PROD_ROOT ]]; then
  echo "F3_ROOT y PROD_ROOT no pueden estar vacíos." >&2
  exit 2
fi
if [[ $F3_ROOT == "$PROD_ROOT" || $F3_ROOT == "$PROD_ROOT/"* ]]; then
  echo "Ruta shadow insegura: $F3_ROOT (no puede estar dentro de $PROD_ROOT)." >&2
  exit 2
fi
if [[ ! $PROD_EXPECTED_REVISION =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$ ]]; then
  echo "PROD_EXPECTED_REVISION no es un prefijo seguro: $PROD_EXPECTED_REVISION" >&2
  exit 2
fi
if [[ ! $INVARIANTS_MAX_AGE_SECONDS =~ ^[0-9]+$ ]] || ((INVARIANTS_MAX_AGE_SECONDS < 1)); then
  echo "INVARIANTS_MAX_AGE_SECONDS debe ser un entero positivo." >&2
  exit 2
fi
if [[ ! $HTTP_TIMEOUT =~ ^[1-9][0-9]*$ ]]; then
  echo "HTTP_TIMEOUT debe ser un entero positivo." >&2
  exit 2
fi

for command_name in docker curl awk readlink; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "Falta el comando requerido: $command_name" >&2
    exit 2
  fi
done
if ! docker info >/dev/null 2>&1; then
  echo "No se puede hablar con el daemon de Docker." >&2
  exit 2
fi

section() {
  printf '\n== %s ==\n' "$*"
}

pass() {
  checks=$((checks + 1))
  printf '[ OK ] %s\n' "$*"
}

fail() {
  checks=$((checks + 1))
  failures=$((failures + 1))
  printf '[FAIL] %s\n' "$*"
}

warn() {
  warnings=$((warnings + 1))
  printf '[WARN] %s\n' "$*"
}

info() {
  printf '[info] %s\n' "$*"
}

http_status() {
  local code
  code=$(curl --silent --show-error --output /dev/null \
    --write-out '%{http_code}' --max-time "$HTTP_TIMEOUT" "$1" 2>/dev/null || true)
  printf '%s' "${code:-000}"
}

fetch_metrics() {
  curl --fail --silent --show-error --max-time "$HTTP_TIMEOUT" "$1" 2>/dev/null || true
}

metric_value() {
  local body=$1 name=$2
  awk -v name="$name" '$1 == name { print $2; exit }' <<<"$body"
}

check_metric_eq() {
  local body=$1 name=$2 expected=$3 label=$4 value
  value=$(metric_value "$body" "$name")
  if [[ -z $value ]]; then
    fail "$label: falta la métrica $name"
    return
  fi
  if [[ $value == "$expected" ]]; then
    pass "$label: $value ($name)"
  else
    fail "$label: $value, esperado $expected ($name)"
  fi
}

container_health() {
  docker inspect --format \
    '{{.State.Status}}|{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' \
    "$1" 2>/dev/null || true
}

container_image() {
  docker inspect --format '{{.Config.Image}}' "$1" 2>/dev/null || true
}

psql_query() {
  docker exec "$POSTGRES_CONTAINER" psql -U "$PG_USER" -d "$PG_DATABASE" \
    -At -F '|' -v ON_ERROR_STOP=1 -c "$1" 2>/dev/null
}

is_uint() {
  [[ ${1:-} =~ ^[0-9]+$ ]]
}

format_age() {
  local seconds=${1:-0}
  if ((seconds < 0)); then
    seconds=0
  fi
  if ((seconds < 3600)); then
    printf '%dm' "$((seconds / 60))"
  else
    printf '%dh%02dm' "$((seconds / 3600))" "$(((seconds % 3600) / 60))"
  fi
}

printf 'QvaApply — comprobación pre-cutover TS -> Go (solo lectura)\n'
printf 'Fecha UTC: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
printf 'Shadow:    %s\n' "$F3_ROOT"
printf 'Producción: %s\n' "$PROD_ROOT"
printf 'Modo:      curl GET, docker inspect y SELECT; sin mutaciones\n'
info "Git no aplica en la VPS: se validan release, contenedores y datos."

# ---------------------------------------------------------------------------
section "1. Release shadow y contenedores"
# ---------------------------------------------------------------------------

release_path=""
release_name=""
if [[ ! -e $F3_ROOT ]]; then
  fail "no existe la raíz shadow $F3_ROOT"
else
  release_path=$(readlink -f "$F3_ROOT/current" 2>/dev/null || true)
  if [[ -z $release_path || ! -d $release_path ]]; then
    fail "no hay release shadow activa en $F3_ROOT/current"
    release_path=""
  elif [[ $release_path != "$F3_ROOT/releases/"* ]]; then
    fail "la release activa no está bajo $F3_ROOT/releases: $release_path"
    release_path=""
  else
    release_name=$(basename "$release_path")
    if [[ $release_name =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$ ]]; then
      pass "release shadow activa: $release_name"
    else
      fail "nombre de release shadow no seguro: $release_name"
      release_name=""
    fi
  fi
fi

if [[ -n $release_path ]]; then
  if [[ -f $release_path/deploy/compose.f3-shadow.yaml ]]; then
    pass "Compose shadow presente en la release activa"
  else
    fail "falta deploy/compose.f3-shadow.yaml en la release activa"
  fi
fi

for service in "${GO_SERVICES[@]}"; do
  container="qvaapply-f3-shadow-$service"
  state=$(container_health "$container")
  if [[ -z $state ]]; then
    fail "contenedor $container: no existe"
  else
    IFS='|' read -r status health <<<"$state" || true
    if [[ ${status:-} == running && ${health:-} == healthy ]]; then
      pass "contenedor $container: running/healthy"
    else
      fail "contenedor $container: ${status:-?}/${health:-?} (esperado running/healthy)"
    fi
  fi

  if [[ -n $release_name ]]; then
    image=$(container_image "$container")
    expected_image="qvaapply-f3-shadow-trading-core:$release_name"
    if [[ $image == "$expected_image" ]]; then
      pass "imagen $service: coincide con la release activa"
    else
      fail "imagen $service: ${image:-ausente} (esperado $expected_image)"
    fi
  fi
done

pg_state=$(container_health "$POSTGRES_CONTAINER")
if [[ -z $pg_state ]]; then
  fail "contenedor $POSTGRES_CONTAINER: no existe"
else
  IFS='|' read -r pg_status pg_health <<<"$pg_state" || true
  if [[ ${pg_status:-} == running && ${pg_health:-} == healthy ]]; then
    pass "contenedor $POSTGRES_CONTAINER: running/healthy"
  else
    fail "contenedor $POSTGRES_CONTAINER: ${pg_status:-?}/${pg_health:-?} (esperado running/healthy)"
  fi
fi

# ---------------------------------------------------------------------------
section "2. Endpoints HTTP shadow"
# ---------------------------------------------------------------------------

for port in "${SHADOW_PORTS[@]}"; do
  for path in healthz readyz; do
    url="http://127.0.0.1:$port/$path"
    code=$(http_status "$url")
    if [[ $code == 200 ]]; then
      pass "$url: 200"
    else
      fail "$url: ${code:-000} (esperado 200)"
    fi
  done
done

# ---------------------------------------------------------------------------
section "3. Métricas de hunter y trading-core"
# ---------------------------------------------------------------------------

hunter_metrics=$(fetch_metrics "http://127.0.0.1:8091/metrics")
if [[ -z $hunter_metrics ]]; then
  fail "métricas hunter: /metrics no responde"
else
  check_metric_eq "$hunter_metrics" hunter_stream_connected 1 "SSE conectado"
  check_metric_eq "$hunter_metrics" hunter_polls_total 0 "polls /p2p"
  check_metric_eq "$hunter_metrics" hunter_stream_consecutive_errors 0 "errores SSE consecutivos"
  stream_errors=$(metric_value "$hunter_metrics" hunter_stream_errors_total)
  if [[ ${stream_errors:-0} != 0 ]]; then
    warn "hubo ${stream_errors} errores SSE acumulados; el feed está reconectado y sin errores consecutivos"
  fi
fi

core_metrics=$(fetch_metrics "http://127.0.0.1:8090/metrics")
if [[ -z $core_metrics ]]; then
  fail "métricas trading-core: /metrics no responde"
else
  check_metric_eq "$core_metrics" trading_core_hunter_events_pending 0 \
    "eventos hunter pendientes"
  check_metric_eq "$core_metrics" trading_core_shadow_stats_error 0 \
    "error de estadísticas shadow"
  check_metric_eq "$core_metrics" trading_core_shadow_mismatches_total 0 \
    "divergencias shadow"
fi

# ---------------------------------------------------------------------------
section "4. Estado de las tablas shadow"
# ---------------------------------------------------------------------------

if ! row=$(psql_query "SELECT count(*) FILTER (WHERE state = 'pending'), count(*) FILTER (WHERE state = 'failed'), count(*) FROM shadow.hunter_events;"); then
  fail "shadow.hunter_events: no se pudo consultar"
elif [[ -z $row ]]; then
  fail "shadow.hunter_events: consulta sin datos"
else
  IFS='|' read -r pending failed total_events <<<"$row" || true
  if ! is_uint "${pending:-}" || ! is_uint "${failed:-}" || ! is_uint "${total_events:-}"; then
    fail "shadow.hunter_events: resultado inesperado"
  elif [[ $pending == 0 && $failed == 0 ]]; then
    pass "shadow.hunter_events: pending=0 failed=0 (total=$total_events)"
    if [[ $total_events == 0 ]]; then
      warn "shadow.hunter_events está vacía: todavía no hay eventos de hunter"
    fi
  else
    fail "shadow.hunter_events: pending=$pending failed=$failed (total=$total_events)"
  fi
fi

if ! row=$(psql_query "SELECT count(*) FILTER (WHERE allowed), count(*) FILTER (WHERE NOT allowed), count(*) FROM shadow.core_decisions;"); then
  fail "shadow.core_decisions: no se pudo consultar"
elif [[ -z $row ]]; then
  fail "shadow.core_decisions: consulta sin datos"
else
  IFS='|' read -r allowed blocked total_decisions <<<"$row" || true
  if ! is_uint "${allowed:-}" || ! is_uint "${blocked:-}" || ! is_uint "${total_decisions:-}"; then
    fail "shadow.core_decisions: resultado inesperado"
  else
    pass "shadow.core_decisions: allowed=$allowed blocked=$blocked total=$total_decisions"
    if [[ $total_decisions == 0 ]]; then
      warn "shadow.core_decisions está vacía: todavía no hay decisiones de core"
    fi
  fi
fi

if ! row=$(psql_query "SELECT count(*), count(*) FILTER (WHERE remaining_qusd::numeric < 0), count(*) FILTER (WHERE qusd_amount::numeric <= 0) FROM shadow.core_executions;"); then
  fail "shadow.core_executions: no se pudo consultar"
elif [[ -z $row ]]; then
  fail "shadow.core_executions: consulta sin datos"
else
  IFS='|' read -r executions negative_remaining invalid_amount <<<"$row" || true
  if ! is_uint "${executions:-}" || ! is_uint "${negative_remaining:-}" || ! is_uint "${invalid_amount:-}"; then
    fail "shadow.core_executions: resultado inesperado"
  elif [[ $negative_remaining == 0 && $invalid_amount == 0 ]]; then
    pass "shadow.core_executions: $executions ejecuciones, sin importes negativos"
  else
    fail "shadow.core_executions: negative_remaining=$negative_remaining invalid_amount=$invalid_amount (total=$executions)"
  fi
fi

if ! row=$(psql_query "SELECT (SELECT count(*) FROM shadow.core_operations), count(*) FILTER (WHERE state NOT IN ('created','reserved','submitted','confirmed','rejected','uncertain','reconciled')), coalesce(string_agg(state || '=' || operation_count, ', ' ORDER BY state), '-') FROM (SELECT state, count(*) AS operation_count FROM shadow.core_operations GROUP BY state) grouped;"); then
  fail "shadow.core_operations: no se pudo consultar"
elif [[ -z $row ]]; then
  fail "shadow.core_operations: consulta sin datos"
else
  IFS='|' read -r total_operations invalid_states operation_states <<<"$row" || true
  if ! is_uint "${total_operations:-}" || ! is_uint "${invalid_states:-}"; then
    fail "shadow.core_operations: resultado inesperado"
  elif [[ $invalid_states == 0 ]]; then
    pass "shadow.core_operations: total=$total_operations estados=${operation_states:--}"
  else
    fail "shadow.core_operations: $invalid_states estados inválidos (total=$total_operations)"
  fi
fi

if ! row=$(psql_query "SELECT count(*), coalesce(sum(violations), 0), extract(epoch FROM now())::bigint - coalesce(max(created_at), 0), coalesce((SELECT run_id FROM shadow.invariant_runs ORDER BY created_at DESC LIMIT 1), '-') FROM shadow.invariant_runs;"); then
  fail "shadow.invariant_runs: no se pudo consultar"
elif [[ -z $row ]]; then
  fail "shadow.invariant_runs: consulta sin datos"
else
  IFS='|' read -r invariant_runs invariant_violations invariant_age_seconds latest_invariant_run <<<"$row" || true
  if ! is_uint "${invariant_runs:-}" || ! is_uint "${invariant_violations:-}" || ! is_uint "${invariant_age_seconds:-}"; then
    fail "shadow.invariant_runs: resultado inesperado"
  elif [[ $invariant_runs == 0 ]]; then
    fail "shadow.invariant_runs: no hay ejecuciones registradas"
  elif [[ $invariant_violations != 0 ]]; then
    fail "shadow.invariant_runs: $invariant_violations violaciones acumuladas"
  elif ((invariant_age_seconds > INVARIANTS_MAX_AGE_SECONDS)); then
    fail "shadow.invariant_runs: último run hace $(format_age "$invariant_age_seconds") (umbral $(format_age "$INVARIANTS_MAX_AGE_SECONDS"))"
  else
    pass "shadow.invariant_runs: 0 violaciones; último run $latest_invariant_run hace $(format_age "$invariant_age_seconds")"
  fi
fi

if ! row=$(psql_query "SELECT count(*), coalesce(sum(steps - matched), 0) FROM shadow.runs;"); then
  fail "shadow.runs: no se pudo consultar"
elif [[ -z $row ]]; then
  fail "shadow.runs: consulta sin datos"
else
  IFS='|' read -r shadow_runs shadow_mismatches <<<"$row" || true
  if ! is_uint "${shadow_runs:-}" || ! is_uint "${shadow_mismatches:-}"; then
    fail "shadow.runs: resultado inesperado"
  elif [[ $shadow_mismatches == 0 ]]; then
    pass "shadow.runs: $shadow_runs runs, 0 divergencias"
    if [[ $shadow_runs == 0 ]]; then
      warn "shadow.runs está vacía: no hay evidencia de paridad reciente"
    fi
  else
    fail "shadow.runs: $shadow_mismatches divergencias en $shadow_runs runs"
  fi
fi

# ---------------------------------------------------------------------------
section "5. Producción TypeScript"
# ---------------------------------------------------------------------------

prod_release_path=""
if [[ ! -e $PROD_ROOT ]]; then
  fail "no existe la raíz de producción $PROD_ROOT"
else
  prod_release_path=$(readlink -f "$PROD_ROOT/current" 2>/dev/null || true)
  if [[ -z $prod_release_path || ! -d $prod_release_path ]]; then
    fail "no hay release de producción activa en $PROD_ROOT/current"
    prod_release_path=""
  else
    prod_release_name=$(basename "$prod_release_path")
    if [[ $prod_release_name == "$PROD_EXPECTED_REVISION"* ]]; then
      pass "producción sigue en la release esperada: $prod_release_name"
    else
      fail "producción en $prod_release_name; se esperaba el prefijo $PROD_EXPECTED_REVISION"
    fi
  fi
fi

prod_state=$(container_health "qvaapply")
if [[ -z $prod_state ]]; then
  fail "contenedor qvaapply: no existe"
else
  IFS='|' read -r prod_status prod_health <<<"$prod_state" || true
  if [[ ${prod_status:-} == running && ${prod_health:-} == healthy ]]; then
    pass "contenedor qvaapply: running/healthy"
  else
    fail "contenedor qvaapply: ${prod_status:-?}/${prod_health:-?} (esperado running/healthy)"
  fi
fi

prod_port=""
if [[ ! -r $PROD_ROOT/config/host-port ]]; then
  fail "no se puede leer $PROD_ROOT/config/host-port"
else
  prod_port=$(tr -d '[:space:]' <"$PROD_ROOT/config/host-port")
  if [[ $prod_port =~ ^[0-9]+$ ]] && ((prod_port >= 1 && prod_port <= 65535)); then
    pass "puerto interno de producción: $prod_port"
  else
    fail "puerto interno de producción inválido: ${prod_port:-vacío}"
    prod_port=""
  fi
fi

if [[ -n $prod_port ]]; then
  url="http://127.0.0.1:$prod_port/api/session"
  code=$(http_status "$url")
  if [[ $code == 200 ]]; then
    pass "producción $url: 200"
  else
    fail "producción $url: ${code:-000} (esperado 200)"
  fi
fi

# ---------------------------------------------------------------------------
printf '\nResumen: %d comprobaciones, %d fallos, %d avisos\n' \
  "$checks" "$failures" "$warnings"

if ((failures > 0)); then
  printf 'Resultado: NO APTO — corrige los fallos antes de planificar el cutover.\n'
  exit 1
fi

printf 'Resultado: comprobaciones OK. Este script no ejecuta el cutover ni cambia la autoridad de producción.\n'
exit 0
