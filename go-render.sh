#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

if [[ -z "${CHROME:-}" ]]; then
  case "$(uname -s)" in
    Darwin)
      for candidate in \
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
        "/Applications/Chromium.app/Contents/MacOS/Chromium"; do
        if [[ -x "$candidate" ]]; then
          CHROME="$candidate"
          break
        fi
      done
      ;;
    Linux)
      for candidate in google-chrome google-chrome-stable chromium chromium-browser; do
        if command -v "$candidate" >/dev/null 2>&1; then
          CHROME="$(command -v "$candidate")"
          break
        fi
      done
      ;;
  esac
fi

if [[ -z "${CHROME:-}" ]]; then
  echo "Chrome or Chromium was not found." >&2
  echo "macOS: brew install --cask google-chrome" >&2
  echo "Or set CHROME to the browser executable path." >&2
  exit 1
fi
export CHROME

./go.sh render \
  -symbol IREN \
  -date 2026-07-22 \
  -start 09:27 \
  -end 10:10 \
  -xtra
