#!/usr/bin/env bash
# Audita el risk_decision_json de trade_workflows con el dominio Go.
# Uso (como root, en la VPS): f3-shadow-workflows.sh [run-id]
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

run_id=${1:-sqlite-workflows-$(date -u +%Y%m%dT%H%M%SZ)}
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
if [[ ! -r $prod_db || ! -f $env_file || ! -f $compose_file ]]; then
  echo "Falta el despliegue shadow, su .env o la SQLite." >&2
  exit 2
fi

install -d -m 700 "$data_dir"
events_file=$(mktemp "$data_dir/workflows.XXXXXX.json")
cleanup() {
  rm -f "$events_file"
}
trap cleanup EXIT

sqlite3 -readonly "file:${prod_db}?mode=ro" -json \
  "SELECT id, state, risk_decision_json, target_json, created_at, updated_at FROM trade_workflows ORDER BY created_at" \
  > "$events_file"
chmod 644 "$events_file"

workflows=$(sqlite3 -readonly "file:${prod_db}?mode=ro" "SELECT count(*) FROM trade_workflows;")
if [[ -z ${workflows:-} || $workflows == 0 ]]; then
  echo "No hay trade_workflows."
  exit 0
fi

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

echo "Auditando $workflows workflows con run-id=$run_id (release $revision)..."
compose_for "$compose_file" run --rm -T \
  -v "$events_file:/workflows.json:ro" \
  shadow-workflows -events /workflows.json -run-id "$run_id"
