#!/usr/bin/env bash
# Análisis estático y vulnerabilidades del workspace Go.
#
# staticcheck, golangci-lint y govulncheck se ejecutan con versiones fijadas.
set -euo pipefail

cd "$(dirname "$0")/.."
started_ms="$(date +%s%3N)"

staticcheck_version="v0.8.2"
golangci_version="v2.15.0"
govulncheck_version="v1.9.0"

run_linters() {
  go run "honnef.co/go/tools/cmd/staticcheck@${staticcheck_version}" ./...
  go run "github.com/golangci/golangci-lint/v2/cmd/golangci-lint@${golangci_version}" \
    run --no-config --default=none --enable=govet --enable=ineffassign --enable=unused --timeout=5m ./...
  go run "golang.org/x/vuln/cmd/govulncheck@${govulncheck_version}" ./...
}

(
  cd shared
  run_linters
)

(
  cd trading-core
  run_linters
)

elapsed_ms="$(( $(date +%s%3N) - started_ms ))"
printf '\nservices: staticcheck + golangci-lint + govulncheck en verde (%d ms).\n' "$elapsed_ms"
