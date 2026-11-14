#!/usr/bin/env bash
# Ejecuta el auditor de invariantes sobre la SQLite real en modo read-only y
# persiste el resultado en shadow.invariant_runs.
#
# Uso (como root, en la VPS):
#   f3-shadow-invariants.sh [run-id]
set -Eeuo pipefail

readonly app_root="/opt/qvaapply-f3-shadow"
readonly prod_root="/opt/qvaapply"
readonly prod_db="$prod_root/data/qvaapply.sqlite"
readonly env_file="$app_root/.env"
readonly compose_file="$app_root/current/deploy/compose.f3-shadow.yaml"
readonly sql_file="$app_root/current/services/db/audit-invariants.sqlite.sql"

if (( EUID != 0 )); then
  echo "El auditor debe ejecutarse como root." >&2
  exit 2
fi
if [[ $app_root == "$prod_root" || $app_root == "$prod_root/"* ]]; then
  echo "Ruta de instalación insegura: $app_root" >&2
  exit 2
fi

run_id=${1:-invariants-$(date -u +%Y%m%dT%H%M%SZ)}
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
if [[ ! -f $env_file || ! -f $compose_file || ! -f $sql_file ]]; then
  echo "Falta el despliegue shadow, su .env o el SQL de invariantes." >&2
  exit 2
fi

install -d -m 700 "$app_root/data"
violations_file=$(mktemp "$app_root/data/invariants.XXXXXX.json")
cleanup() {
  rm -f "$violations_file"
}
trap cleanup EXIT

echo "Ejecutando invariantes SQLite en modo read-only..."
sqlite3 -readonly -json "file:${prod_db}?mode=ro" < "$sql_file" > "$violations_file"
violations=$( { grep -o '"check_id"' "$violations_file" || true; } | wc -l | tr -d '[:space:]')
if [[ ! $violations =~ ^[0-9]+$ ]]; then
  echo "No se pudo contar las violaciones." >&2
  exit 1
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

compose_for "$compose_file" exec -T postgres \
  psql -U qvaapply -d qvaapply -v ON_ERROR_STOP=1 \
  -c "INSERT INTO shadow.invariant_runs (run_id, source, violations, created_at) VALUES ('$run_id', 'sqlite-invariants', $violations, extract(epoch from now())::bigint) ON CONFLICT (run_id) DO UPDATE SET violations = excluded.violations, created_at = excluded.created_at;"

if (( violations > 0 )); then
  echo "Invariantes con $violations violaciones (run $run_id):" >&2
  cat "$violations_file" >&2
  exit 1
fi

echo "Invariantes limpios: 0 violaciones (run $run_id)."
