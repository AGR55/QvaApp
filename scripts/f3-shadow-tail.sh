#!/usr/bin/env bash
# Ingesta incremental F3: audita solo las decisiones nuevas de SQLite.
#
# Uso (como root, en la VPS):
#   f3-shadow-tail.sh
#
# La primera ejecución inicializa el cursor en el máximo id actual. Las
# siguientes exportan `decision_events.id > cursor`, auditan y avanzan el
# cursor únicamente si la persistencia termina bien. Solo lee la SQLite de
# producción en modo read-only.
set -Eeuo pipefail

readonly app_root="/opt/qvaapply-f3-shadow"
readonly prod_root="/opt/qvaapply"
readonly prod_db="$prod_root/data/qvaapply.sqlite"
readonly env_file="$app_root/.env"
readonly compose_file="$app_root/current/deploy/compose.f3-shadow.yaml"
readonly data_dir="$app_root/data"
readonly cursor_file="$data_dir/decision-events.cursor"

if (( EUID != 0 )); then
  echo "La ingesta debe ejecutarse como root." >&2
  exit 2
fi
if [[ $app_root == "$prod_root" || $app_root == "$prod_root/"* ]]; then
  echo "Ruta de instalación insegura: $app_root" >&2
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

read_cursor() {
  local value=0
  if [[ -f $cursor_file ]]; then
    value=$(tr -dc '0-9' < "$cursor_file")
  fi
  if [[ -z $value ]]; then
    value=0
  fi
  printf '%s' "$value"
}

write_cursor() {
  local value=$1
  local temporary
  temporary=$(mktemp "$cursor_file.XXXXXX")
  printf '%s\n' "$value" > "$temporary"
  chmod 600 "$temporary"
  mv -f "$temporary" "$cursor_file"
}

last_id=$(read_cursor)
if (( last_id == 0 )); then
  max_id=$(sqlite3 -readonly "file:${prod_db}?mode=ro" "SELECT coalesce(max(id), 0) FROM decision_events;")
  if [[ ! $max_id =~ ^[0-9]+$ ]]; then
    echo "No se pudo inicializar el cursor (max_id=$max_id)." >&2
    exit 1
  fi
  write_cursor "$max_id"
  echo "Cursor inicializado en id=$max_id; no hay decisiones nuevas todavía."
  exit 0
fi

events_file=$(mktemp "$data_dir/decision-events.XXXXXX.json")
cleanup() {
  rm -f "$events_file"
}
trap cleanup EXIT

# Se fija el límite antes de exportar para no saltarse filas insertadas entre
# la exportación y la consulta del cursor.
max_id=$(sqlite3 -readonly "file:${prod_db}?mode=ro" "SELECT coalesce(max(id), 0) FROM decision_events;")
if [[ ! $max_id =~ ^[0-9]+$ ]]; then
  echo "max_id inválido: $max_id" >&2
  exit 1
fi
if (( max_id <= last_id )); then
  echo "Sin decisiones nuevas."
  exit 0
fi

echo "Exportando decision_events con id en ($last_id, $max_id]..."
sqlite3 -readonly "file:${prod_db}?mode=ro" -json \
  "SELECT id, version, coin, offer_type, amount, receive, rate, decision, reason, checks_json, reference_rate, created_at, updated_at FROM decision_events WHERE id > $last_id AND id <= $max_id ORDER BY id" \
  > "$events_file"
# El contenedor corre como UID 65532; el archivo se borra al terminar.
chmod 644 "$events_file"

events=$(sqlite3 -readonly "file:${prod_db}?mode=ro" "SELECT count(*) FROM decision_events WHERE id > $last_id AND id <= $max_id;")
if [[ -z ${events:-} || $events == 0 ]]; then
  echo "Sin decisiones nuevas."
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

run_id="tail-$(date -u +%Y%m%dT%H%M%SZ)"
echo "Auditando $events eventos nuevos con run-id=$run_id (release $revision)..."
if ! compose_for "$compose_file" run --rm -T \
    -v "$events_file:/events.json:ro" \
    shadow-audit -events /events.json -run-id "$run_id" -fail-on-mismatch=false; then
  echo "shadow-audit falló; el cursor se mantiene en id=$last_id para reintentar." >&2
  exit 1
fi

write_cursor "$max_id"
echo "Cursor avanzado a id=$max_id; run=$run_id"
