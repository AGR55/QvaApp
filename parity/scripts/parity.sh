#!/usr/bin/env bash
# Wrapper del arnés de paridad. Uso: parity/scripts/parity.sh --sut ts --suite pure
set -euo pipefail
cd "$(dirname "$0")/../.."
exec node --import tsx parity/runner/run.ts "$@"
