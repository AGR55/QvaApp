#!/usr/bin/env bash
set -Eeuo pipefail

app_root=${1:-/opt/qvaapply}
active_revision=${2:?Falta la revisión activa}
previous_revision=${3:-}

if [[ ! $active_revision =~ ^[0-9a-f]{40}$ ]] ||
   [[ -n $previous_revision && ! $previous_revision =~ ^[0-9a-f]{40}$ ]]; then
  echo "La revisión protegida no es un SHA Git válido." >&2
  exit 2
fi
app_root=$(realpath -e -- "$app_root")
if [[ ! -d $app_root/releases || -L $app_root/releases ||
      $(readlink -f "$app_root/current") != "$app_root/releases/$active_revision" ]]; then
  echo "El release activo no coincide con el directorio de QvaApply." >&2
  exit 2
fi

# Resolve the complete candidate list before deleting anything. Docker refuses
# to remove an image in use; explicit references also protect stopped containers.
images=$(docker image ls --filter 'label=qvaapply.release=true' --format '{{.Repository}}:{{.Tag}}')
container_images=$(docker ps -a --format '{{.Image}}')
while IFS= read -r image; do
  if [[ $image =~ ^qvaapply:([0-9a-f]{40})$ ]]; then
    image_revision=${BASH_REMATCH[1]}
    if [[ $image_revision != "$active_revision" && $image_revision != "$previous_revision" ]] &&
       ! grep -Fxq -- "$image" <<< "$container_images"; then
      docker image rm "$image"
    fi
  fi
done <<< "$images"

while IFS= read -r -d '' stale_release; do
  stale_revision=$(basename "$stale_release")
  if [[ $stale_revision =~ ^[0-9a-f]{40}$ &&
        $stale_revision != "$active_revision" && $stale_revision != "$previous_revision" ]] &&
     ! grep -Fxq -- "qvaapply:$stale_revision" <<< "$container_images"; then
    if [[ $(realpath -e -- "$stale_release") == "$app_root/releases/$stale_revision" ]]; then
      rm -rf -- "$stale_release"
      echo "Release antiguo retirado: $stale_revision"
    fi
  fi
done < <(find "$app_root/releases" -mindepth 1 -maxdepth 1 -type d -print0)

docker image prune -f --filter 'label=qvaapply.release=true'
# Named stages identify future caches. The legacy COPY stages were verified
# against this VPS; unrelated builders, sources and shared image layers stay intact.
docker buildx prune -f --filter 'inuse=false' --filter 'shared=false' \
  --filter 'description~=qvaapply-runtime|^\[[67]/7\].COPY.(dist|public).'
echo "Retención de QvaApply: versión activa y versión anterior."
