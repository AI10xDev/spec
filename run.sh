#!/usr/bin/env bash
set -euo pipefail

root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

if ! command -v cargo >/dev/null 2>&1; then
  printf 'Rust/Cargo is required to run spec.\n' >&2
  exit 1
fi
if ! command -v bun >/dev/null 2>&1; then
  if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
    printf 'Install Bun or Node.js (22.12+) with npm to build the frontend.\n' >&2
    exit 1
  fi
fi

cd -- "$root/backend"
export SPEC_WORKSPACE="${SPEC_WORKSPACE:-$root/workspace}"
export SPEC_UI_DIR="${SPEC_UI_DIR:-$root/frontend/dist}"

umask 077
mkdir -p -- "$SPEC_WORKSPACE"
mode="$(stat -Lc '%a' -- "$SPEC_WORKSPACE")"
if (( (8#$mode & 0022) != 0 )); then
  printf 'Workspace must not be writable by group/others: %s\n' "$SPEC_WORKSPACE" >&2
  printf 'Choose a private SPEC_WORKSPACE or explicitly make this directory private:\n  chmod go-w -- %q\n' "$SPEC_WORKSPACE" >&2
  exit 1
fi

(
  cd -- "$root/frontend"
  if command -v bun >/dev/null 2>&1; then
    bun install --frozen-lockfile
    bun run build
  else
    printf 'Bun is unavailable; building with Node/npm (bun.lock is not used).\n'
    npm install --no-save --package-lock=false --no-audit --no-fund
    npm run typecheck
    npm exec --no -- vite build
  fi
)

exec cargo run --release --locked
