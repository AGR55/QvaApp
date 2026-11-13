#!/usr/bin/env bash
# Análisis estático y vulnerabilidades del workspace Go.
#
# staticcheck y govulncheck se ejecutan con versiones fijadas. golangci-lint
# queda pendiente hasta que su release soporte el export data de Go 1.27.
set -euo pipefail

cd "$(dirname "$0")/.."

staticcheck_version="v0.8.2"
govulncheck_version="v1.9.0"

(
  cd shared
  go run "honnef.co/go/tools/cmd/staticcheck@${staticcheck_version}" ./...
  go run "golang.org/x/vuln/cmd/govulncheck@${govulncheck_version}" ./...
)

(
  cd trading-core
  go run "honnef.co/go/tools/cmd/staticcheck@${staticcheck_version}" ./...
  go run "golang.org/x/vuln/cmd/govulncheck@${govulncheck_version}" ./...
)

printf '\nservices: staticcheck + govulncheck en verde.\n'
