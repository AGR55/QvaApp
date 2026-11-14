#!/usr/bin/env bash
# Benchmark F2 local: paridad del corpus y comparación Go vs TS.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
cd "$repo/services/trading-core"
mkdir -p bin
go build -o bin/replay-session ./cmd/replay-session
go build -o bin/replay-bench ./cmd/replay-bench
cd "$repo"

services/trading-core/bin/replay-session
services/trading-core/bin/replay-bench --iterations "${GO_ITERATIONS:-1000}"
node --import tsx parity/tools/bench-replay.ts --iterations "${TS_ITERATIONS:-100}"
