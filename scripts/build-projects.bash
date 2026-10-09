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
mkdir -p -- .spec-runs
logs="$(mktemp -d "$directory/.spec-runs/batch-XXXXXXXX")"
printf 'Build logs: %s\n' "$logs"
failed=0
for file in "${specs[@]}"; do
  printf '\nBuilding %s\n' "${file##*/}"
  # Run serially, and keep the build from consuming the SSH script on stdin.
  # A subshell keeps each invocation in the same project directory.
  if (spec build "$file") </dev/null 2>&1 | tee -- "$logs/${file##*/}.out"; then
    printf 'OK: %s\n' "${file##*/}"
  else
    code=$?
    printf 'FAILED (%s): %s\n' "$code" "${file##*/}" >&2
    failed=$((failed + 1))
  fi
done
printf '\nBuilt %s spec(s); %s failed. Logs: %s\n' "${#specs[@]}" "$failed" "$logs"
(( failed == 0 ))
