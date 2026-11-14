#!/usr/bin/env bash
# Resume el soak F3 y falla si hubo divergencias o violaciones.
set -Eeuo pipefail

readonly app_root="/opt/qvaapply-f3-shadow"
readonly env_file="$app_root/.env"
readonly postgres="qvaapply-f3-shadow-postgres"

if (( EUID != 0 )); then
  echo "El informe debe ejecutarse como root." >&2
  exit 2
fi
if [[ ! -f $env_file ]]; then
  echo "Falta $env_file." >&2
  exit 2
fi

shadow_password=$(sed -n 's/^[[:space:]]*F3_POSTGRES_PASSWORD=//p' "$env_file" | tail -n 1 | tr -d '\r')
shadow_password=${shadow_password#\"}
shadow_password=${shadow_password%\"}
if [[ -z $shadow_password ]]; then
  echo "Falta F3_POSTGRES_PASSWORD en $env_file" >&2
  exit 2
fi

docker exec -T "$postgres" psql -U qvaapply -d qvaapply -v ON_ERROR_STOP=1 -c "
  SELECT count(*) AS samples,
    to_timestamp(min(sampled_at)) AS first_sample,
    to_timestamp(max(sampled_at)) AS last_sample,
    min(service_rss_kb) AS min_rss_kb,
    max(service_rss_kb) AS max_rss_kb,
    round(avg(service_rss_kb)) AS avg_rss_kb,
    max(service_cpu_percent) AS max_cpu_percent,
    max(mismatches) AS max_mismatches,
    max(invariant_violations) AS max_invariant_violations
  FROM shadow.soak_samples;"
docker exec -T "$postgres" psql -U qvaapply -d qvaapply -v ON_ERROR_STOP=1 -c "
  SELECT to_timestamp(sampled_at) AS sampled_at, service_rss_kb,
    service_cpu_percent, postgres_rss_kb, runs, decisions, mismatches,
    invariant_violations
  FROM shadow.soak_samples ORDER BY sampled_at DESC LIMIT 6;"

violations=$(docker exec "$postgres" psql -U qvaapply -d qvaapply -At -c \
  "SELECT coalesce(max(mismatches), 0) + coalesce(max(invariant_violations), 0) FROM shadow.soak_samples;")
if [[ ${violations:-0} != 0 ]]; then
  echo "Soak con divergencias/violaciones: $violations" >&2
  exit 1
fi
