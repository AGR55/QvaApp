#!/usr/bin/env bash
# Empaqueta localmente el despliegue F3 shadow en /tmp.
#
# Uso:
#   scripts/package-f3-shadow.sh [revision]
#
# Si se omite la revisión se usa el commit actual (git rev-parse HEAD).
# El archivo resultante se sube a la VPS y se pasa a scripts/deploy-f3-shadow.sh.
set -Eeuo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
revision=${1:-$(git -C "$repo_root" rev-parse HEAD 2>/dev/null || true)}

if [[ -z $revision || ! $revision =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$ ]]; then
  echo "Revisión inválida. Uso: $0 [revision]" >&2
  exit 2
fi

archive="/tmp/qvaapply-f3-shadow-${revision}.tar.gz"
temporary_archive=$(mktemp "${archive}.XXXXXX")

cleanup() {
  rm -f "$temporary_archive"
}
trap cleanup EXIT

required_paths=(
  services/trading-core
  services/shared
  services/go.work
  deploy/compose.f3-shadow.yaml
  scripts/deploy-f3-shadow.sh
)

(
  cd "$repo_root/services/trading-core"
  CGO_ENABLED=0 GOOS=linux GOARCH="${GOARCH:-amd64}" GOWORK=off     go build -trimpath -ldflags="-s -w" -o trading-core ./cmd/trading-core
)

for required_path in "${required_paths[@]}"; do
  if [[ ! -e $repo_root/$required_path ]]; then
    echo "Falta en el repositorio: $required_path" >&2
    exit 2
  fi
done

cd "$repo_root"

# Solo se incluyen las rutas explícitas de arriba. Los excludes evitan además
# datos locales, secretos, dependencias y binarios aunque aparezcan dentro.
tar \
  --create \
  --gzip \
  --file "$temporary_archive" \
  --exclude='.env' \
  --exclude='*/.env' \
  --exclude='node_modules' \
  --exclude='*/node_modules' \
  --exclude='data' \
  --exclude='*/data' \
  --exclude='*.sqlite' \
  --exclude='*.sqlite-shm' \
  --exclude='*.sqlite-wal' \
  --exclude='*.log' \
  --exclude='services/trading-core/bin' \
  --exclude='services/trading-core/bin/*' \
  "${required_paths[@]}" \
  services/trading-core/Dockerfile.binary \
  services/trading-core/trading-core

listing=$(tar -tzf "$temporary_archive")

for required_member in \
  services/trading-core/Dockerfile.binary \
  services/trading-core/trading-core \
  services/trading-core/cmd/trading-core/main.go \
  services/shared/go.mod \
  services/go.work \
  deploy/compose.f3-shadow.yaml \
  scripts/deploy-f3-shadow.sh; do
  if ! grep -Fqx -- "$required_member" <<<"$listing"; then
    echo "El paquete no contiene $required_member" >&2
    exit 1
  fi
done

if grep -Eq '(^|/)\.env$|(^|/)node_modules/|^data/|\.sqlite|^services/trading-core/bin/' <<<"$listing"; then
  echo "El paquete contiene archivos prohibidos; se descarta." >&2
  exit 1
fi

mv -f "$temporary_archive" "$archive"
rm -f "$repo_root/services/trading-core/trading-core"
trap - EXIT

echo "Paquete creado: $archive"
echo "SHA-256: $(sha256sum "$archive" | awk '{print $1}')"
