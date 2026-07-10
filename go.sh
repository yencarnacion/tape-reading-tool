#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

mode="${1:-live}"
if [[ $# -gt 0 ]]; then
  shift
fi

exec go run -buildvcs=false ./cmd/tape-reading-tool "$mode" "$@"
