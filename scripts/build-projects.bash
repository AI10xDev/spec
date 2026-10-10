# Sent to remote Bash over SSH stdin by remote-build.sh.
set -eo pipefail
umask 077
cd -- "$1"
directory="$PWD"
check="${2:-}"
shopt -s nullglob
specs=()
for file in "$directory"/*; do
  [[ -f "$file" && ! -L "$file" ]] || continue
  case "${file##*/}" in
    *.md|*.txt|*.spec) specs+=("$file") ;;
    *.*) ;;
    *) specs+=("$file") ;;
  esac
done
if (( ${#specs[@]} == 0 )); then
  printf 'No specs found in %s. Add .md, .txt, .spec, or extensionless files and rerun.\n' "$directory"
  exit 0
fi
printf 'Found %s spec(s):\n' "${#specs[@]}"
printf '  %s\n' "${specs[@]}"
[[ "$check" != --check ]] || exit 0

export PATH="$HOME/.local/bin:$HOME/.bun/bin:${PATH:-/usr/local/bin:/usr/bin:/bin}"
shopt -s expand_aliases
if [[ -f "$HOME/.bash_aliases" ]]; then
  source "$HOME/.bash_aliases"
fi
type spec >/dev/null 2>&1 || {
  printf 'Remote spec command not found; configure ~/.bash_aliases or PATH.\n' >&2
  exit 127
}
unset SPEC_SESSION_DIR KIBI_SPEC_SESSION
export SPEC_BUILD_FOREGROUND=1 SPEC_BUILD_AUTO=1
export OPENCODE_PERMISSION_AUTO_ALLOW_ALWAYS=1 OPENCODE_QUESTION_AUTO_RECOMMEND=1
cd -- "$directory"
umask 077
mkdir -p -- .spec-runs
[[ ! -L .spec-runs && -O .spec-runs && $(stat -c %a .spec-runs) == 700 ]] || {
  printf 'Unsafe remote run storage; refusing to launch.\n' >&2
  exit 125
}
# This script is sent alone over SSH, so it must implement the same registry
# protocol as the backend adapter without sourcing files on the remote host.
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_COMMON_DIR
registry=
if [[ $(git rev-parse --is-inside-work-tree 2>/dev/null) == true ]]; then
  git_directory=$(git rev-parse --absolute-git-dir)
  git_directory=$(cd -- "$git_directory" && pwd -P)
  registry="$git_directory/spec-harness"
  mkdir -p -- "$registry"
  [[ -d $registry && ! -L $registry && -O $registry && $(stat -c %a -- "$registry") == 700 ]] || {
    printf 'Unsafe worktree harness registry; refusing to launch.\n' >&2
    exit 125
  }
fi
exec 9< "${registry:-.spec-runs}"
flock --shared --nonblock 9 || {
  printf 'Another harness is active for this repository; refusing to launch.\n' >&2
  exit 125
}
completed() {
  local status
  [[ -d $1 && ! -L $1 && -O $1 && $(stat -c %a -- "$1") == 700 &&
    -f $1/status && ! -L $1/status && -O $1/status &&
    $(stat -c %a -- "$1/status") == 600 && $(stat -c %h -- "$1/status") == 1 &&
    $(stat -c %s -- "$1/status") -le 4 ]] &&
    status=$(head -c 4 -- "$1/status") &&
    [[ $status =~ ^(0|[1-9][0-9]{0,2})$ ]] && (( 10#$status <= 255 ))
}
if [[ -n $registry ]]; then
  for record in "$registry"/run-*; do
    [[ -e $record || -L $record ]] || continue
    if [[ -f $record && ! -L $record && -O $record && $(stat -c %a -- "$record") == 600 &&
      $(stat -c %h -- "$record") == 1 && $(stat -c %s -- "$record") -le 16384 ]] && {
      IFS= read -r -d '' prior && [[ $prior == /* ]] && {
        if IFS= read -r -d '' prior_mode; then
          [[ $prior_mode == build || $prior_mode == repository-save ]] &&
            ! IFS= read -r -d '' trailing && [[ -z $trailing ]]
        else
          [[ -z $prior_mode ]] && prior_mode=legacy
        fi
      }
    } < "$record"; then
      [[ $prior_mode != build ]] || continue
      completed "$prior" && continue
    fi
    [[ -e $record || -L $record ]] || continue
    printf 'Prior harness completion is unresolved; refusing to launch.\n' >&2
    exit 125
  done
fi
logs="$(mktemp -d "$directory/.spec-runs/run-batch-XXXXXXXX")"
registry_record=
if [[ -n $registry ]]; then
  record_tmp=$(mktemp "$registry/.pending-XXXXXXXX")
  printf '%s\0build\0' "$logs" > "$record_tmp"
  registry_record="$registry/${logs##*/}"
  mv -T --no-clobber -- "$record_tmp" "$registry_record"
  [[ ! -e $record_tmp ]] || exit 125
fi
# Interruption must leave the record unresolved: descendants may still be alive.
trap 'exit 125' HUP INT TERM
printf 'Build logs: %s\n' "$logs"
failed=0
for file in "${specs[@]}"; do
  printf '\nBuilding %s\n' "${file##*/}"
  # Run serially, and keep the build from consuming the SSH script on stdin.
  # A subshell keeps each invocation in the same project directory.
  if (spec build "$file") 9<&- </dev/null 2>&1 | tee -- "$logs/${file##*/}.out" 9<&-; then
    printf 'OK: %s\n' "${file##*/}"
  else
    code=$?
    printf 'FAILED (%s): %s\n' "$code" "${file##*/}" >&2
    failed=$((failed + 1))
  fi
done
printf '\nBuilt %s spec(s); %s failed. Logs: %s\n' "${#specs[@]}" "$failed" "$logs"
result=0
(( failed == 0 )) || result=1
printf '%s\n' "$result" > "$logs/status.tmp"
mv -T -- "$logs/status.tmp" "$logs/status"
[[ -z $registry_record ]] || rm -f -- "$registry_record"
exit "$result"
