#!/usr/bin/env bash
# Lee QvaPay en modo read-only usando el token cifrado de producción.
# El token y la clave solo existen en memoria del proceso; no se imprimen.
#
# Uso (como root, en la VPS): f3-shadow-qvapay.sh [run-id]
set -Eeuo pipefail

readonly app_root="/opt/qvaapply-f3-shadow"
readonly prod_root="/opt/qvaapply"
readonly prod_db="$prod_root/data/qvaapply.sqlite"
readonly prod_env="$prod_root/config/env"
readonly env_file="$app_root/.env"
readonly compose_file="$app_root/current/deploy/compose.f3-shadow.yaml"

if (( EUID != 0 )); then
  echo "La lectura QvaPay debe ejecutarse como root." >&2
  exit 2
fi
if [[ $app_root == "$prod_root" || $app_root == "$prod_root/"* ]]; then
  echo "Ruta de instalación insegura: $app_root" >&2
  exit 2
fi

run_id=${1:-qvapay-$(date -u +%Y%m%dT%H%M%SZ)}
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
if [[ ! -r $prod_db || ! -r $prod_env || ! -f $env_file || ! -f $compose_file ]]; then
  echo "Falta la SQLite/entorno de producción o el despliegue shadow." >&2
  exit 2
fi

local_key=$(sed -n 's/^[[:space:]]*LOCAL_ENCRYPTION_KEY=//p' "$prod_env" | tail -n 1 | tr -d '\r')
local_key=${local_key#\"}
local_key=${local_key%\"}
encrypted_token=$(sqlite3 -readonly -noheader "file:${prod_db}?mode=ro" \
  "SELECT value FROM settings WHERE key = 'qvapay_token';" | tr -d '\r')
if [[ ! $local_key =~ ^[a-fA-F0-9]{64}$ ]]; then
  echo "LOCAL_ENCRYPTION_KEY ausente o inválida." >&2
  exit 2
fi
if [[ -z $encrypted_token ]]; then
  echo "No hay token QvaPay cifrado en settings." >&2
  exit 2
fi

cleanup() {
  unset local_key encrypted_token
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
export LOCAL_ENCRYPTION_KEY="$local_key"
export QVA_TOKEN_CIPHERTEXT="$encrypted_token"

compose_for() {
  local file=$1
  shift
  docker compose --env-file "$env_file" -f "$file" "$@"
}

echo "Consultando QvaPay read-only con run-id=$run_id (release $revision)..."
if ! compose_for "$compose_file" run --rm -T \
    -e LOCAL_ENCRYPTION_KEY -e QVA_TOKEN_CIPHERTEXT \
    shadow-qvapay -run-id "$run_id"; then
  echo "shadow-qvapay falló; no se consulta el snapshot." >&2
  exit 1
fi

compose_for "$compose_file" exec -T postgres \
  psql -U qvaapply -d qvaapply -v ON_ERROR_STOP=1 \
  -c "SELECT run_id, balance, offers, averages, to_timestamp(captured_at) AS captured_at FROM shadow.qvapay_snapshots WHERE run_id = '$run_id';" \
  -c "SELECT coin, type, count(*) AS offers FROM shadow.qvapay_offers WHERE run_id = '$run_id' GROUP BY coin, type ORDER BY coin, type;"
