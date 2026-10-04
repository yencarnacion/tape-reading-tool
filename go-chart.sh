#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

if [[ "${1:-}" == "replay" ]]; then
  shift
  exec ./go.sh replay -chart -xtra "$@"
fi

exec ./go.sh live -chart -xtra "$@"
