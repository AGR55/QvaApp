#!/usr/bin/env bash
set -Eeuo pipefail

archive=${1:?Falta el archivo de release}
revision=${2:?Falta la revisión Git}
app_root="/root/Adriano/QvaApply"
release_dir="$app_root/releases/$revision"
environment_file="$app_root/config/env"
host_port_file="$app_root/config/host-port"

if (( EUID != 0 )); then
  echo "El despliegue debe ejecutarse como root." >&2
  exit 2
fi
if [[ ! $revision =~ ^[0-9a-f]{40}$ ]]; then
  echo "La revisión no es un SHA Git válido." >&2
  exit 2
fi
if [[ ! -f $archive ]]; then
  echo "No existe el archivo de release: $archive" >&2
  exit 2
fi
if [[ ! -f $environment_file || ! -f $host_port_file ]]; then
  echo "Falta la configuración. Ejecuta primero scripts/bootstrap-vps.sh." >&2
  exit 2
fi

host_port=$(tr -d '[:space:]' < "$host_port_file")
if [[ ! $host_port =~ ^[0-9]+$ ]] || (( host_port < 1024 || host_port > 65535 )); then
  echo "El puerto interno no es válido en $host_port_file" >&2
  exit 2
fi

mkdir -p "$app_root/releases" "$release_dir"
tar -xzf "$archive" -C "$release_dir"

previous_release=""
if [[ -L $app_root/current ]]; then
  previous_release=$(readlink -f "$app_root/current")
fi

export QVAAPPLY_HOST_PORT="$host_port"
export QVAAPPLY_REVISION="$revision"
docker compose -f "$release_dir/deploy/compose.yaml" build

ln -sfn "$release_dir" "$app_root/current.next"
mv -Tf "$app_root/current.next" "$app_root/current"
docker compose -f "$app_root/current/deploy/compose.yaml" up -d --remove-orphans

healthy=false
for _ in {1..30}; do
  if curl --fail --silent --show-error "http://127.0.0.1:${host_port}/api/session" >/dev/null; then
    healthy=true
    break
  fi
  sleep 2
done

if [[ $healthy != true ]]; then
  echo "La nueva versión no superó la comprobación de salud." >&2
  docker compose -f "$app_root/current/deploy/compose.yaml" logs --no-color --tail=100 >&2 || true
  if [[ -n $previous_release && -d $previous_release ]]; then
    ln -sfn "$previous_release" "$app_root/current.next"
    mv -Tf "$app_root/current.next" "$app_root/current"
    QVAAPPLY_REVISION=$(basename "$previous_release")
    export QVAAPPLY_REVISION
    docker compose -f "$app_root/current/deploy/compose.yaml" up -d --build --remove-orphans
    echo "Se restauró la versión anterior: $previous_release" >&2
  else
    docker compose -f "$release_dir/deploy/compose.yaml" down
  fi
  exit 1
fi

rm -f "$archive"
echo "QvaApply desplegado en $release_dir"
