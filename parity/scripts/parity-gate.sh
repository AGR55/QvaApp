#!/usr/bin/env bash
# Gate de paridad F0.
#
#   golden-guard: los artefactos versionados (goldens puros, contratos de
#                 adaptador, superficie HTTP, corpus de replay, manifest y
#                 matriz) coinciden exactamente con el oráculo TS.
#   parity-gate:  el oráculo TS reproduce sus propios casos al 100 %,
#                 incluyendo contratos, HTTP y replay stateful sin red.
#
# Uso local/CI:
#   bash parity/scripts/parity-gate.sh
#   PARITY_REPORT_DIR=/tmp/parity bash parity/scripts/parity-gate.sh
set -euo pipefail

cd "$(dirname "$0")/../.."

report_dir="${PARITY_REPORT_DIR:-$(mktemp -d -t qvaapply-parity-XXXXXX)}"
mkdir -p "$report_dir"

step() {
  printf '\n== %s ==\n' "$1"
}

step "golden-guard: generadores contra el oráculo congelado"
node --import tsx parity/tools/generate-domain-goldens.ts --check
node --import tsx parity/tools/generate-extra-goldens.ts --check
node --import tsx parity/tools/generate-pure-goldens.ts --check
node --import tsx parity/tools/generate-contract.ts --check
node --import tsx parity/tools/generate-http.ts --check
node --import tsx parity/tools/generate-replay.ts --check

step "golden-guard: cobertura L1 y manifiesto"
node --import tsx parity/tools/check-pure-coverage.ts
node --import tsx parity/tools/build-manifest.ts --check

step "parity-gate: suite pura TS→TS"
node --import tsx parity/runner/run.ts --sut ts --suite pure --report "$report_dir/pure.json"

step "parity-gate: contratos de adaptador TS→TS (74 casos)"
node --import tsx parity/runner/run.ts --sut ts --suite contract --report "$report_dir/contract.json"

step "parity-gate: superficie HTTP TS→TS (39 casos)"
node --import tsx parity/runner/run.ts --sut ts --suite http --report "$report_dir/http.json"

step "parity-gate: replay stateful TS→TS (sin red)"
node --import tsx parity/runner/run.ts --sut ts --suite replay --report "$report_dir/replay.json"

printf '\nparity-gate: OK — goldens, manifiesto, pura, contratos, HTTP y replay en verde.\n'
printf 'Reportes: %s\n' "$report_dir"
