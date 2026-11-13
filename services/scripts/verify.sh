#!/usr/bin/env bash
# Verificación del workspace Go de F1.
#
#   - gofmt sin deriva
#   - tests con -race en shared y trading-core
#   - go vet
#   - binario de conformidad
#   - paridad real contra los goldens del oráculo TS
#
# Uso:
#   bash services/scripts/verify.sh
#   bash services/scripts/verify.sh --filter market-math
set -euo pipefail

cd "$(dirname "$0")/.."

if [[ "${1:-}" == "--filter" ]]; then
  filters=("${2:-market-math}")
else
  filters=("market-math" "pure/budget/" "risk-policy" "liquidity-plan" "apply-budget" "hunting-requirements" "flexible-order")
fi

pending="$(gofmt -l shared trading-core)"
if [[ -n "$pending" ]]; then
  printf 'gofmt pendiente en:\n%s\n' "$pending"
  exit 1
fi

(
  cd shared
  go test -race ./...
)

(
  cd trading-core
  go test -race ./...
  go vet ./...
  mkdir -p bin
  go build -trimpath -o bin/parity-sut ./cmd/parity-sut
)

cd ..
for filter in "${filters[@]}"; do
  node --import tsx parity/runner/run.ts \
    --sut cli \
    --command "services/trading-core/bin/parity-sut" \
    --suite pure \
    --filter "$filter"
done

printf '\nservices: verificación Go + paridad (%s) en verde.\n' "${filters[*]}"
