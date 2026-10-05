# Source only the trusted remote alias file, not an interactive shell/terminal.
# Separate lines ensure aliases defined by the source are expanded at invocation.
: > "$2" # Signal that setsid established the build process group.
shopt -s expand_aliases
if [[ -f "$HOME/.bash_aliases" ]]; then
    source "$HOME/.bash_aliases" || exit
fi
unset SPEC_SESSION_DIR KIBI_SPEC_SESSION
export SPEC_BUILD_FOREGROUND=1 SPEC_BUILD_AUTO=1
type spec >/dev/null 2>&1 || { echo '[remote] spec alias/function/launcher not found; configure ~/.bash_aliases' >&2; exit 127; }
spec build "$1"
