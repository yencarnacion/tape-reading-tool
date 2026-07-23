#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

./go.sh render \
  -symbol IREN \
  -date 2026-07-22 \
  -start 09:27 \
  -end 10:10 \
  -xtra
