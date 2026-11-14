#!/usr/bin/env bash
# Audita decisiones reales de `decision_events` con el dominio Go y persiste la
# comparación en shadow.*. Solo lee la SQLite de producción en modo read-only.
#
# Uso (como root, en la VPS):
#   f3-shadow-audit.sh [run-id]
set -Eeuo pipefail

readonly app_root="/opt/qvaapply-f3-shadow"
readonly prod_root="/opt/qvaapply"
readonly prod_db="$prod_root/data/qvaapply.sqlite"
readonly env_file="$app_root/.env"
readonly compose_file="$app_root/current/deploy/compose.f3-shadow.yaml"
readonly data_dir="$app_root/data"

if (( EUID != 0 )); then
  echo "La auditoría debe ejecutarse como root." >&2
  exit 2
fi
if [[ $app_root == "$prod_root" || $app_root == "$prod_root/"* ]]; then
  echo "Ruta de instalación insegura: $app_root" >&2
  exit 2
fi

run_id=${1:-sqlite-decisions-$(date -u +%Y%m%dT%H%M%SZ)}
if [[ ! $run_id =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$ ]]; then
  echo "run-id no seguro: $run_id" >&2
  exit 2
fi

for command_name in docker readlink sed sqlite3; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "Falta el comando requerido: $command_name" >&2
    exit 2
  fi
done
if [[ ! -r $prod_db ]]; then
  echo "No se puede leer $prod_db" >&2
  exit 2
fi
if [[ ! -f $env_file || ! -f $compose_file ]]; then
  echo "Falta el despliegue shadow o su .env; ejecuta antes deploy-f3-shadow.sh." >&2
  exit 2
fi

install -d -m 700 "$data_dir"
events_file=$(mktemp "$data_dir/decision-events.XXXXXX.json")
cleanup() {
  rm -f "$events_file"
}
trap cleanup EXIT

shadow_password=$(sed -n 's/^[[:space:]]*F3_POSTGRES_PASSWORD=//p' "$env_file" | tail -n 1 | tr -d '\r')
shadow_password=${shadow_password#\"}
shadow_password=${shadow_password%\"}
if [[ -z $shadow_password ]]; then
  echo "Falta F3_POSTGRES_PASSWORD en $env_file" >&2
  exit 2
fi

revision=$(basename "$(readlink -f "$app_root/current")")
export F3_POSTGRES_PASSWORD="$shadow_password"
export F3_REVISION="$revision"

compose_for() {
  local file=$1
  shift
  docker compose --env-file "$env_file" -f "$file" "$@"
}

echo "Exportando decision_events en modo read-only..." >&2
sqlite3 -readonly "file:${prod_db}?mode=ro" -json \
  "SELECT version, coin, offer_type, amount, receive, rate, decision, reason, checks_json, reference_rate, created_at, updated_at FROM decision_events ORDER BY id" \
  > "$events_file"
chmod 600 "$events_file"

events=$(sqlite3 -readonly "file:${prod_db}?mode=ro" "SELECT count(*) FROM decision_events;")
if [[ -z ${events:-} || $events == 0 ]]; then
  echo "No se exportaron decision_events." >&2
  exit 1
fi
echo "Eventos exportados: $events" >&2

echo "Auditando run-id=$run_id (release $revision)..." >&2
if ! compose_for "$compose_file" run --rm -T \
    -v "$events_file:/events.json:ro" \
    shadow-audit -events /events.json -run-id "$run_id"; then
  echo "shadow-audit falló; no se consulta el resumen." >&2
  exit 1
fi

echo "Resumen persistido en shadow.*:" >&2
compose_for "$compose_file" exec -T postgres \
  psql -U qvaapply -d qvaapply -v ON_ERROR_STOP=1 \
  -c "SELECT run_id, source, cases, steps, matched, steps - matched AS mismatches, to_timestamp(created_at) AS created_at FROM shadow.runs WHERE run_id = '$run_id';" \
  -c "SELECT count(*) AS decisions, count(*) FILTER (WHERE matched) AS matched, count(*) FILTER (WHERE NOT matched) AS mismatches FROM shadow.decisions WHERE run_id = '$run_id';"

echo "Auditoría completada: $run_id"
