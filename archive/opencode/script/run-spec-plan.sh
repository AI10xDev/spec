#!/usr/bin/env bash

set -euo pipefail

root_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
spec_dir=${1:-"$HOME/specing"}

if (( $# > 1 )); then
  printf 'Usage: %s [spec-directory]\n' "$0" >&2
  exit 1
fi

if [[ ! -d "$spec_dir" ]]; then
  printf 'Spec directory does not exist: %s\n' "$spec_dir" >&2
  exit 1
fi

spec_dir=$(cd -- "$spec_dir" && pwd)
mapfile -d '' specs < <(find "$spec_dir" -type f -print0 | sort -z)

if (( ${#specs[@]} == 0 )); then
  printf 'No specs found in: %s\n' "$spec_dir" >&2
  exit 1
fi

printf 'Choose a spec to run in plan mode:\n'
for index in "${!specs[@]}"; do
  printf '%3d) %s\n' "$((index + 1))" "${specs[$index]#"$spec_dir"/}"
done

read -r -p 'Spec number: ' choice

if [[ ! "$choice" =~ ^[0-9]+$ ]] || (( choice < 1 || choice > ${#specs[@]} )); then
  printf 'Invalid spec number: %s\n' "$choice" >&2
  exit 1
fi

selected=${specs[$((choice - 1))]}
printf 'Using spec: %s\n' "${selected#"$spec_dir"/}"

cd -- "$root_dir"
opencode-source --agent plan --prompt "$(<"$selected")"
