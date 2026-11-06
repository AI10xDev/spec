#!/usr/bin/env bash
set -euo pipefail

root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
if ! command -v python3 >/dev/null 2>&1; then
  printf 'The setup wizard needs Python 3.9+. Install it with your OS package manager, then retry.\nAlternatively, see docs/INSTALLATION.md for ./run.sh --local.\n' >&2
  exit 1
fi
exec python3 -B "$root/scripts/setup.py" "$@"
