#!/usr/bin/env bash
# Muestrea RSS/CPU y contadores shadow para el soak de 72 h.
# Uso (como root, en la VPS): f3-shadow-soak.sh
set -Eeuo pipefail

readonly app_root="/opt/qvaapply-f3-shadow"
readonly env_file="$app_root/.env"
readonly compose_file="$app_root/current/deploy/compose.f3-shadow.yaml"
readonly service="qvaapply-f3-shadow-trading-core"
readonly postgres="qvaapply-f3-shadow-postgres"

if (( EUID != 0 )); then
  echo "El muestreo debe ejecutarse como root." >&2
  exit 2
fi
for command_name in docker sed awk readlink; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "Falta el comando requerido: $command_name" >&2
    exit 2
  fi
done
if [[ ! -f $env_file || ! -f $compose_file ]]; then
  echo "Falta el despliegue shadow o su .env." >&2
  exit 2
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

to_kb() {
  local value=$1
  local number unit
  number=$(printf '%s' "$value" | sed -E 's/^([0-9.]+).*/\1/')
  unit=$(printf '%s' "$value" | sed -E 's/^[0-9.]+([A-Za-z]+).*/\1/')
  case "$unit" in
    B) awk -v n="$number" 'BEGIN { printf "%d", n / 1024 }' ;;
    KiB|K) awk -v n="$number" 'BEGIN { printf "%d", n }' ;;
    MiB|M) awk -v n="$number" 'BEGIN { printf "%d", n * 1024 }' ;;
    GiB|G) awk -v n="$number" 'BEGIN { printf "%d", n * 1024 * 1024 }' ;;
    *) echo "unidad de memoria desconocida: $value" >&2; return 1 ;;
  esac
}

service_usage=$(docker stats --no-stream --format '{{.MemUsage}}' "$service")
service_cpu=$(docker stats --no-stream --format '{{.CPUPerc}}' "$service" | tr -d '%')
postgres_usage=$(docker stats --no-stream --format '{{.MemUsage}}' "$postgres")
service_rss_kb=$(to_kb "${service_usage%% *}")
postgres_rss_kb=$(to_kb "${postgres_usage%% *}")

counts=$(docker exec "$postgres" psql -U qvaapply -d qvaapply -At -F '|' -c "
  SELECT
    (SELECT count(*) FROM shadow.runs),
    (SELECT coalesce(sum(steps), 0) FROM shadow.runs),
    (SELECT coalesce(sum(steps - matched), 0) FROM shadow.runs),
    (SELECT coalesce(sum(violations), 0) FROM shadow.invariant_runs);")
IFS='|' read -r runs decisions mismatches invariant_violations <<<"$counts"
if [[ ! $runs =~ ^[0-9]+$ || ! $decisions =~ ^[0-9]+$ || ! $mismatches =~ ^[0-9]+$ || ! $invariant_violations =~ ^[0-9]+$ ]]; then
  echo "Contadores shadow inválidos: $counts" >&2
  exit 1
fi

sampled_at=$(date +%s)
docker exec -T "$postgres" psql -U qvaapply -d qvaapply -v ON_ERROR_STOP=1 -c "
  INSERT INTO shadow.soak_samples
    (sampled_at, service_rss_kb, service_cpu_percent, postgres_rss_kb,
     runs, decisions, mismatches, invariant_violations)
  VALUES
    ($sampled_at, $service_rss_kb, $service_cpu, $postgres_rss_kb,
     $runs, $decisions, $mismatches, $invariant_violations)
  ON CONFLICT (sampled_at) DO UPDATE SET
    service_rss_kb = excluded.service_rss_kb,
    service_cpu_percent = excluded.service_cpu_percent,
    postgres_rss_kb = excluded.postgres_rss_kb,
    runs = excluded.runs,
    decisions = excluded.decisions,
    mismatches = excluded.mismatches,
    invariant_violations = excluded.invariant_violations;" >/dev/null

printf 'soak sample: rss=%s KB cpu=%s%% pg=%s KB runs=%s decisions=%s mismatches=%s invariants=%s\n' \
  "$service_rss_kb" "$service_cpu" "$postgres_rss_kb" "$runs" "$decisions" "$mismatches" "$invariant_violations"
