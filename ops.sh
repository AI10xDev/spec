#!/usr/bin/env bash
set -euo pipefail

root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

export SPEC_WORKSPACE="${SPEC_WORKSPACE:-$HOME/specs}"

exec "$root/run.sh" "$@"
