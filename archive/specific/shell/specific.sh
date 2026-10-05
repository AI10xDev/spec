# shellcheck shell=bash

_SPECIFIC_INSTALLED_HOME=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)

_specific_home() {
  printf '%s\n' "${SPECIFIC_HOME:-$_SPECIFIC_INSTALLED_HOME}"
}

_specific_command() {
  local name=$1
  local installed
  installed="$(_specific_home)/bin/$name"
  if [[ -x "$installed" ]]; then
    printf '%s\n' "$installed"
  elif command -v -- "$name" >/dev/null 2>&1; then
    command -v -- "$name"
  else
    printf 'specific command is not installed: %s\n' "$name" >&2
    return 1
  fi
}

run_goal() {
  local runner
  runner=$(_specific_command specific-run-build) || return
  "$runner" "$@"
}

plan_goal() {
  local runner
  runner=$(_specific_command specific-run-plan) || return
  "$runner" "$@"
}

spec() {
  local state_dir=${SPECIFIC_STATE_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/specific}
  local history_file="$state_dir/saved-files"
  local spec_file='' line='' directory='' base=''

  if [[ "${1:-}" == build ]]; then
    shift
    if (( $# > 1 )); then
      printf 'Usage: spec build [spec-file]\n' >&2
      return 1
    fi

    if (( $# == 1 )); then
      spec_file=$1
      if [[ ! -f "$spec_file" ]]; then
        printf 'Spec file is not a regular file: %s\n' "$spec_file" >&2
        return 1
      fi
      directory=$(dirname -- "$spec_file")
      base=$(basename -- "$spec_file")
      spec_file=$(cd -- "$directory" && printf '%s/%s\n' "$PWD" "$base") || return
    else
      if [[ ! -s "$history_file" ]]; then
        printf 'No saved spec is available. Save one with spec or pass a file.\n' >&2
        return 1
      fi
      while IFS= read -r line || [[ -n "$line" ]]; do
        spec_file=$line
      done < "$history_file"
      if [[ -z "$spec_file" ]]; then
        printf 'No saved spec is available. Save one with spec or pass a file.\n' >&2
        return 1
      fi
      if [[ ! -f "$spec_file" ]]; then
        printf 'Saved spec is no longer available: %s\n' "$spec_file" >&2
        return 1
      fi
    fi
    run_goal "$spec_file"
    return
  fi

  local editor runner
  editor="$(_specific_home)/editor/specific-editor"
  if [[ ! -x "$editor" ]]; then
    editor=$(command -v specific-editor 2>/dev/null) || {
      printf 'specific editor is not installed. Run install.sh.\n' >&2
      return 1
    }
  fi
  runner=${KIBI_RUN_COMMAND:-}
  if [[ -z "$runner" ]]; then
    runner=$(_specific_command specific-run-build) || return
  fi
  KIBI_RUN_COMMAND="$runner" \
    KIBI_SAVE_COPY_DIR="${SPECIFIC_SPECS_DIR:-$HOME/specs}" \
    KIBI_SAVE_HISTORY_FILE="$history_file" \
    XDG_DATA_DIRS="$(_specific_home)/editor/share:${XDG_DATA_DIRS:-/usr/local/share:/usr/share}" \
    "$editor" "$@"
}
