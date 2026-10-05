#!/usr/bin/env bash

set -euo pipefail

usage() {
  cat <<'EOF'
Usage: ./install.sh [options]

Options:
  --prefix <directory>  Installation prefix
  --bin-dir <directory> Command link directory
  --configure-shell     Add the shell integration to ~/.bashrc
  --help                Show this help
EOF
}

prefix=${SPECIFIC_HOME:-${XDG_DATA_HOME:-$HOME/.local/share}/specific}
bin_dir=${SPECIFIC_BIN_DIR:-$HOME/.local/bin}
configure_shell=false

while (( $# > 0 )); do
  case $1 in
    --prefix|--bin-dir)
      if (( $# < 2 )); then
        printf 'Missing value for %s\n' "$1" >&2
        usage >&2
        exit 1
      fi
      if [[ $1 == --prefix ]]; then prefix=$2; else bin_dir=$2; fi
      shift 2
      ;;
    --configure-shell) configure_shell=true; shift ;;
    --help) usage; exit 0 ;;
    *) printf 'Unknown option: %s\n' "$1" >&2; usage >&2; exit 1 ;;
  esac
done

for dependency in bash git cargo rustc python3 nohup; do
  if ! command -v -- "$dependency" >/dev/null 2>&1; then
    printf 'Required dependency is not available: %s\n' "$dependency" >&2
    exit 1
  fi
done

if [[ -n "${SPECIFIC_OPENCODE_BIN:-}" ]]; then
  if [[ "$SPECIFIC_OPENCODE_BIN" == */* ]]; then
    [[ -x "$SPECIFIC_OPENCODE_BIN" ]] || {
      printf 'OpenCode executable is not available: %s\n' "$SPECIFIC_OPENCODE_BIN" >&2
      exit 1
    }
  elif ! command -v -- "$SPECIFIC_OPENCODE_BIN" >/dev/null 2>&1; then
    printf 'OpenCode executable is not available: %s\n' "$SPECIFIC_OPENCODE_BIN" >&2
    exit 1
  fi
elif ! command -v opencode >/dev/null 2>&1 && ! command -v opencode-source >/dev/null 2>&1; then
  printf 'OpenCode is required. Install opencode or set SPECIFIC_OPENCODE_BIN.\n' >&2
  exit 1
fi

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
cargo build --release --manifest-path "$script_dir/editor/Cargo.toml"

mkdir -p "$prefix/bin" "$prefix/editor/share/kibi/syntax.d" "$prefix/shell" "$bin_dir"
install -m 0755 "$script_dir/editor/target/release/kibi" "$prefix/editor/specific-editor"
install -m 0755 "$script_dir/bin/specific-run-build" "$prefix/bin/specific-run-build"
install -m 0755 "$script_dir/bin/specific-run-plan" "$prefix/bin/specific-run-plan"
install -m 0644 "$script_dir/shell/specific.sh" "$prefix/shell/specific.sh"
cp -R "$script_dir/editor/syntax.d/." "$prefix/editor/share/kibi/syntax.d/"

ln -sfn "$prefix/editor/specific-editor" "$bin_dir/specific-editor"
ln -sfn "$prefix/bin/specific-run-build" "$bin_dir/specific-run-build"
ln -sfn "$prefix/bin/specific-run-plan" "$bin_dir/specific-run-plan"

printf -v quoted_shell_path '%q' "$prefix/shell/specific.sh"
shell_line="source $quoted_shell_path"
if [[ $configure_shell == true ]]; then
  touch "$HOME/.bashrc"
  if ! grep -Fqx -- "$shell_line" "$HOME/.bashrc"; then
    printf '\n%s\n' "$shell_line" >> "$HOME/.bashrc"
  fi
fi

printf 'Installation complete. Load the shell integration with:\n%s\n' "$shell_line"
