#!/usr/bin/env bash

set -euo pipefail

root_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
invocation_dir=$PWD

if (( $# != 1 )); then
  printf 'Usage: %s <spec-file>\n' "$0" >&2
  exit 1
fi

spec_file=$1

if [[ ! -f "$spec_file" ]]; then
  printf 'Spec file does not exist: %s\n' "$spec_file" >&2
  exit 1
fi

printf 'Using spec: %s\n' "$spec_file"

if [[ -n "${SPEC_SESSION_DIR:-}" ]]; then
  # The inbox already contains the initial prompt; never also submit the spec file.
  exec setsid --wait bun "$root_dir/script/spec-session.ts" "$invocation_dir" "$SPEC_SESSION_DIR" </dev/null
fi

spec=$(<"$spec_file")

cd -- "$root_dir"
opencode-source run --thinking --dir "$invocation_dir" --agent build "$spec"
