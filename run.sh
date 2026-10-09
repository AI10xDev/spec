#!/usr/bin/env bash
set -euo pipefail

root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

if (( $# > 1 )) || [[ "${1:-}" != '' && "${1:-}" != --local ]]; then
  printf 'Usage: %s [--local]\nStart with remote builds in ~/project; --local starts the editor only.\n' "$0" >&2
  exit 2
fi

# Configure SSH and resolve key paths before changing directories.
source "$root/scripts/ssh-config.bash"
if [[ "${1:-}" == --local ]]; then
  unset SPEC_SSH_TARGET SPEC_SSH_WORKSPACE SPEC_SSH_KEY SPEC_SSH_BINARY
else
  spec_configure_remote
  spec_prepare_remote
  printf 'Remote workspace: %s:%s\n' "$SPEC_SSH_TARGET" "$SPEC_SSH_WORKSPACE"
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

"$root/build.sh"

exec cargo run --release --locked
