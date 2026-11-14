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
trading_core_binary="$repo_root/services/trading-core/trading-core"
shadow_replay_binary="$repo_root/services/trading-core/shadow-replay"
shadow_audit_binary="$repo_root/services/trading-core/shadow-audit"
shadow_workflows_binary="$repo_root/services/trading-core/shadow-workflows"
shadow_qvapay_binary="$repo_root/services/trading-core/shadow-qvapay"

cleanup() {
  rm -f "$temporary_archive" "$trading_core_binary" "$shadow_replay_binary" "$shadow_audit_binary" "$shadow_workflows_binary" "$shadow_qvapay_binary"
}
trap cleanup EXIT

required_paths=(
  services/trading-core
  services/shared
  services/go.work
  services/db/migrations/0004_shadow.sql
  services/db/migrations/0005_invariants.sql
  services/db/migrations/0006_soak.sql
  services/db/migrations/0007_qvapay.sql
  services/db/migrations/0008_qvapay_offers.sql
  services/db/audit-invariants.sqlite.sql
  parity/fixtures/replay/2026-11-12
  deploy/compose.f3-shadow.yaml
  scripts/deploy-f3-shadow.sh
  scripts/f3-shadow-replay.sh
  scripts/f3-shadow-audit.sh
  scripts/f3-shadow-workflows.sh
  scripts/f3-shadow-qvapay.sh
  scripts/f3-shadow-tail.sh
  scripts/f3-shadow-invariants.sh
  scripts/f3-shadow-soak.sh
  scripts/f3-shadow-soak-report.sh
  scripts/install-f3-shadow-timer.sh
)

# Ambos binarios: servicio HTTP y ejecutor one-shot del corpus replay.
(
  cd "$repo_root/services/trading-core"
  CGO_ENABLED=0 GOOS=linux GOARCH="${GOARCH:-amd64}" GOWORK=off \
    go build -trimpath -ldflags="-s -w" -o trading-core ./cmd/trading-core
  CGO_ENABLED=0 GOOS=linux GOARCH="${GOARCH:-amd64}" GOWORK=off \
    go build -trimpath -ldflags="-s -w" -o shadow-replay ./cmd/shadow-replay
  CGO_ENABLED=0 GOOS=linux GOARCH="${GOARCH:-amd64}" GOWORK=off \
    go build -trimpath -ldflags="-s -w" -o shadow-audit ./cmd/shadow-audit
  CGO_ENABLED=0 GOOS=linux GOARCH="${GOARCH:-amd64}" GOWORK=off \
    go build -trimpath -ldflags="-s -w" -o shadow-workflows ./cmd/shadow-workflows
  CGO_ENABLED=0 GOOS=linux GOARCH="${GOARCH:-amd64}" GOWORK=off \
    go build -trimpath -ldflags="-s -w" -o shadow-qvapay ./cmd/shadow-qvapay
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
  services/trading-core/ca-certificates.crt \
  services/trading-core/trading-core \
  services/trading-core/shadow-replay \
  services/trading-core/shadow-audit

listing=$(tar -tzf "$temporary_archive")

for required_member in \
  services/trading-core/Dockerfile.binary \
  services/trading-core/ca-certificates.crt \
  services/trading-core/trading-core \
  services/trading-core/shadow-replay \
  services/trading-core/shadow-audit \
  services/trading-core/shadow-workflows \
  services/trading-core/shadow-qvapay \
  services/trading-core/cmd/trading-core/main.go \
  services/trading-core/cmd/shadow-replay/main.go \
  services/trading-core/cmd/shadow-audit/main.go \
  services/trading-core/cmd/shadow-workflows/main.go \
  services/trading-core/cmd/shadow-qvapay/main.go \
  services/db/migrations/0004_shadow.sql \
  services/db/migrations/0005_invariants.sql \
  services/db/migrations/0006_soak.sql \
  services/db/migrations/0007_qvapay.sql \
  services/db/migrations/0008_qvapay_offers.sql \
  services/db/audit-invariants.sqlite.sql \
  parity/fixtures/replay/2026-11-12/events.ndjson \
  parity/fixtures/replay/2026-11-12/scenarios.json \
  parity/fixtures/replay/2026-11-12/decisions.ndjson \
  parity/fixtures/replay/2026-11-12/manifest.json \
  services/shared/go.mod \
  services/go.work \
  deploy/compose.f3-shadow.yaml \
  scripts/deploy-f3-shadow.sh \
  scripts/f3-shadow-replay.sh \
  scripts/f3-shadow-audit.sh \
  scripts/f3-shadow-workflows.sh \
  scripts/f3-shadow-qvapay.sh \
  scripts/f3-shadow-tail.sh \
  scripts/f3-shadow-invariants.sh \
  scripts/f3-shadow-soak.sh \
  scripts/f3-shadow-soak-report.sh \
  scripts/install-f3-shadow-timer.sh; do
  if ! grep -Fqx -- "$required_member" <<<"$listing"; then
    echo "El paquete no contiene $required_member" >&2
    exit 1
  fi
done

if grep -Eq '(^|/)\.env$|(^|/)node_modules/|^data/|\.sqlite($|-shm$|-wal$)|^services/trading-core/bin/' <<<"$listing"; then
  echo "El paquete contiene archivos prohibidos; se descarta." >&2
  exit 1
fi

mv -f "$temporary_archive" "$archive"
rm -f "$trading_core_binary" "$shadow_replay_binary" "$shadow_audit_binary" "$shadow_workflows_binary" "$shadow_qvapay_binary"
trap - EXIT

echo "Paquete creado: $archive"
echo "SHA-256: $(sha256sum "$archive" | awk '{print $1}')"
