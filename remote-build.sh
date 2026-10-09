#!/usr/bin/env bash
set -euo pipefail

root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
if (( $# > 1 )) || [[ "${1:-}" != '' && "${1:-}" != --check ]]; then
  printf 'Usage: %s [--check]\nBuild all specs in remote ~/project; --check only lists inputs.\n' "$0" >&2
  exit 2
fi
source "$root/scripts/ssh-config.bash"
spec_configure_remote
spec_prepare_remote
printf 'Remote workspace: %s:%s\n' "$SPEC_SSH_TARGET" "$SPEC_SSH_WORKSPACE"
exec "${spec_ssh[@]}" "bash -s -- $(spec_shell_quote "$SPEC_SSH_WORKSPACE") $(spec_shell_quote "${1:-}")" < "$root/scripts/build-projects.bash"
