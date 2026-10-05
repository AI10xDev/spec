#!/usr/bin/env bash
set -euo pipefail
if [[ "${1:-}" == --manual || "${1:-}" == --help || "${1:-}" == -h || "${1:-}" == /eval || "${1:-}" == /telle || "${1:-}" == telle ]]; then
  exec /home/opencode/.bun/bin/bun /home/opencode/opencode-source/script/spec-workflow.ts "$@"
fi
if [[ "${1:-}" == eval || "${1:-}" == --eval ]]; then
  shift
  exec "$(dirname "$(realpath "${BASH_SOURCE[0]}")")/spec-eval" "$@"
fi
# Unattended remediation must finish in the foreground and propagate failure.
if [[ "${1:-}" == build && "${SPEC_BUILD_AUTO:-0}" == 1 ]]; then
  if (( $# != 2 )); then
    printf 'Usage: SPEC_BUILD_AUTO=1 spec build <spec-file>\n' >&2
    exit 1
  fi
  if [[ ! -f "$2" || ! -r "$2" ]]; then
    printf 'Spec file is not readable: %s\n' "$2" >&2
    exit 1
  fi
  prompt=$(<"$2")
  exec opencode run --auto --dir "$PWD" --agent build -- "$prompt"
fi
# Retain the existing editor/build shell function on this VM.
source "$HOME/.bash_aliases"
spec "$@"
