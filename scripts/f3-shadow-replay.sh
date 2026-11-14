#!/usr/bin/env bash
# Ejecuta el replay shadow F3 en la VPS y muestra el resumen persistido.
#
# Uso (como root, en la VPS):
#   f3-shadow-replay.sh [run-id]
#
# Solo opera sobre /opt/qvaapply-f3-shadow. No toca /opt/qvaapply ni el
# contenedor de producción. La migración se aplica en el despliegue; este
# script nunca migra ni reinicia trading-core.
set -Eeuo pipefail

readonly app_root="/opt/qvaapply-f3-shadow"
readonly prod_root="/opt/qvaapply"
readonly env_file="$app_root/.env"
readonly compose_file="$app_root/current/deploy/compose.f3-shadow.yaml"

if (( EUID != 0 )); then
  echo "El replay debe ejecutarse como root." >&2
  exit 2
fi

# Salvaguarda explícita: este script jamás debe operar sobre producción.
if [[ $app_root == "$prod_root" || $app_root == "$prod_root/"* ]]; then
  echo "Ruta de instalación insegura: $app_root" >&2
  exit 2
fi

run_id=${1:-replay-$(date -u +%Y%m%dT%H%M%SZ)}
if [[ ! $run_id =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$ ]]; then
  echo "run-id no seguro: $run_id" >&2
  echo "Uso: $0 [run-id]" >&2
  exit 2
fi

for command_name in docker readlink sed; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "Falta el comando requerido: $command_name" >&2
    exit 2
  fi
done

if [[ ! -f $env_file ]]; then
  echo "Falta $env_file; ejecuta antes scripts/deploy-f3-shadow.sh." >&2
  exit 2
fi
if [[ ! -f $compose_file ]]; then
  echo "No hay una release activa en $app_root/current." >&2
  exit 2
fi

shadow_password=$(sed -n 's/^[[:space:]]*F3_POSTGRES_PASSWORD=//p' "$env_file" | tail -n 1 | tr -d '\r')
shadow_password=${shadow_password#\"}
shadow_password=${shadow_password%\"}
if [[ -z $shadow_password ]]; then
  echo "Falta F3_POSTGRES_PASSWORD en $env_file" >&2
  exit 2
fi

# La imagen se etiquetó con la revisión de la release activa.
revision=$(basename "$(readlink -f "$app_root/current")")
export F3_POSTGRES_PASSWORD="$shadow_password"
export F3_REVISION="$revision"

compose_for() {
  local file=$1
  shift
  docker compose --env-file "$env_file" -f "$file" "$@"
}

echo "Ejecutando shadow-replay con run-id=$run_id (release $revision)..." >&2
if ! compose_for "$compose_file" run --rm -T shadow-replay \
    -corpus /corpus -run-id "$run_id"; then
  echo "shadow-replay falló; no se consulta el resumen." >&2
  exit 1
fi

echo "Resumen persistido en shadow.*:" >&2
# `run_id` ya está restringido a [A-Za-z0-9._-], por lo que incrustarlo entre
# comillas simples es seguro (psql no interpola variables en -c).
compose_for "$compose_file" exec -T postgres \
  psql -U qvaapply -d qvaapply -v ON_ERROR_STOP=1 \
  -c "SELECT run_id, source, cases, steps, matched, steps - matched AS mismatches, to_timestamp(created_at) AS created_at FROM shadow.runs WHERE run_id = '$run_id';" \
  -c "SELECT count(*) AS decisions, count(*) FILTER (WHERE matched) AS matched, count(*) FILTER (WHERE NOT matched) AS mismatches FROM shadow.decisions WHERE run_id = '$run_id';"

echo "Replay completado: $run_id"
