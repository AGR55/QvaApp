#!/usr/bin/env bash
# Despliega trading-core F3 en modo shadow dentro de la VPS.
#
# Uso (como root, en la VPS):
#   deploy-f3-shadow.sh <release.tar.gz> <revision>
#
# Este script administra exclusivamente /opt/qvaapply-f3-shadow. No modifica
# /opt/qvaapply, no reemplaza el contenedor Node `qvaapply`, no publica puertos
# fuera de loopback y nunca elimina los volúmenes de Postgres.
set -Eeuo pipefail

archive=${1:?Falta el archivo de release}
revision=${2:?Falta la revisión Git}

readonly app_root="/opt/qvaapply-f3-shadow"
readonly prod_root="/opt/qvaapply"
readonly shadow_port=8090
release_dir="$app_root/releases/$revision"
env_file="$app_root/.env"
compose_rel="deploy/compose.f3-shadow.yaml"

if (( EUID != 0 )); then
  echo "El despliegue debe ejecutarse como root." >&2
  exit 2
fi

# Salvaguarda explícita: este script jamás debe operar sobre producción.
if [[ $app_root == "$prod_root" || $app_root == "$prod_root/"* ]]; then
  echo "Ruta de instalación insegura: $app_root" >&2
  exit 2
fi

for command_name in docker curl openssl flock tar; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "Falta el comando requerido: $command_name" >&2
    exit 2
  fi
done

if [[ ! $revision =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$ ]]; then
  echo "La revisión no es un nombre seguro: $revision" >&2
  exit 2
fi
if [[ ! -f $archive ]]; then
  echo "No existe el archivo de release: $archive" >&2
  exit 2
fi

install -d -m 755 "$app_root" "$app_root/releases"

exec 9>"$app_root/deploy.lock"
if ! flock -n 9; then
  echo "Ya hay otro despliegue de qvaapply-f3-shadow en curso." >&2
  exit 1
fi

# Contraseña propia del shadow. Solo se genera la primera vez; si el archivo
# ya existe se respeta para no perder acceso a una base ya inicializada.
umask 077
if [[ ! -f $env_file ]]; then
  temporary_env=$(mktemp "$app_root/.env.XXXXXX")
  printf 'F3_POSTGRES_PASSWORD=%s\n' "$(openssl rand -hex 32)" > "$temporary_env"
  chmod 600 "$temporary_env"
  mv -f "$temporary_env" "$env_file"
  echo "Creado $env_file con una contraseña aleatoria." >&2
fi
chmod 600 "$env_file"

shadow_password=$(sed -n 's/^[[:space:]]*F3_POSTGRES_PASSWORD=//p' "$env_file" | tail -n 1 | tr -d '\r')
shadow_password=${shadow_password#\"}
shadow_password=${shadow_password%\"}
if [[ -z $shadow_password ]]; then
  echo "Falta F3_POSTGRES_PASSWORD en $env_file" >&2
  exit 2
fi
export F3_POSTGRES_PASSWORD="$shadow_password"
export F3_REVISION="$revision"

compose_for() {
  local file=$1
  shift
  docker compose --env-file "$env_file" -f "$file" "$@"
}

install -d -m 755 "$release_dir"
tar -xzf "$archive" -C "$release_dir"

compose_file="$release_dir/$compose_rel"
migration_file="$release_dir/services/db/migrations/0004_shadow.sql"
invariants_migration_file="$release_dir/services/db/migrations/0005_invariants.sql"
soak_migration_file="$release_dir/services/db/migrations/0006_soak.sql"
if [[ ! -f $compose_file || ! -f $release_dir/services/trading-core/Dockerfile.binary ]]; then
  echo "El archivo de release no contiene el despliegue F3 esperado." >&2
  exit 2
fi
if [[ ! -f $migration_file || ! -f $invariants_migration_file || ! -f $soak_migration_file ]]; then
  echo "El release no contiene las migraciones shadow 0004/0005/0006." >&2
  exit 2
fi

# Valida la interpolación antes de construir.
compose_for "$compose_file" config -q

previous_release=""
if [[ -L $app_root/current ]]; then
  previous_release=$(readlink -f "$app_root/current" 2>/dev/null || true)
fi

if ! compose_for "$compose_file" build; then
  echo "Falló la construcción de la imagen shadow; se conserva la release activa." >&2
  exit 1
fi

# Aplica la migración (idempotente) antes de activar la release. Si falla,
# /opt/qvaapply-f3-shadow/current sigue apuntando a la release anterior y no
# se levanta ningún contenedor nuevo.
if ! compose_for "$compose_file" run --rm -T shadow-migrate; then
  echo "Falló la migración shadow; se conserva la release activa." >&2
  exit 1
fi

ln -sfn "$release_dir" "$app_root/current.next"
mv -Tf "$app_root/current.next" "$app_root/current"

started=true
if ! compose_for "$compose_file" up -d --remove-orphans; then
  started=false
fi

healthy=false
for _ in {1..60}; do
  [[ $started == true ]] || break
  if curl --fail --silent --show-error --max-time 3 \
      "http://127.0.0.1:${shadow_port}/healthz" >/dev/null \
    && curl --fail --silent --show-error --max-time 3 \
      "http://127.0.0.1:${shadow_port}/readyz" >/dev/null; then
    healthy=true
    break
  fi
  sleep 2
done

if [[ $healthy != true ]]; then
  echo "La nueva release shadow no superó /healthz y /readyz." >&2
  compose_for "$compose_file" logs --no-color --tail=100 >&2 || true

  if [[ -n $previous_release && -d $previous_release && $previous_release != "$release_dir" ]]; then
    ln -sfn "$previous_release" "$app_root/current.next"
    mv -Tf "$app_root/current.next" "$app_root/current"
    F3_REVISION=$(basename "$previous_release")
    export F3_REVISION
    if compose_for "$previous_release/$compose_rel" up -d --build --remove-orphans; then
      echo "Se restauró la release anterior: $previous_release" >&2
    else
      echo "No se pudo restaurar la release anterior: $previous_release" >&2
    fi
  else
    # `down` sin --volumes: el volumen de Postgres se conserva.
    compose_for "$compose_file" down || true
    rm -f "$app_root/current"
    echo "No había una release anterior; el shadow quedó detenido. Los volúmenes se conservan." >&2
  fi
  exit 1
fi

echo "trading-core shadow desplegado en $release_dir"
echo "  healthz: http://127.0.0.1:${shadow_port}/healthz"
echo "  readyz:  http://127.0.0.1:${shadow_port}/readyz"
echo "  metrics: http://127.0.0.1:${shadow_port}/metrics"
