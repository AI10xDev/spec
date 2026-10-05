# Source only the trusted remote alias file, not an interactive shell/terminal.
# Separate lines ensure aliases defined by the source are expanded at invocation.
: > "$2" # Signal that setsid established the build process group.
shopt -s expand_aliases
# SSH/noninteractive shells often omit user-installed engines and Bun. Set up
# their conventional locations without loading interactive/login startup files.
# The trusted alias file can still override PATH for a custom installation.
export PATH="$HOME/.local/bin:$HOME/.bun/bin:${PATH:-/usr/local/bin:/usr/bin:/bin}"
if [[ -f "$HOME/.bash_aliases" ]]; then
    source "$HOME/.bash_aliases" || exit
fi
unset SPEC_SESSION_DIR KIBI_SPEC_SESSION
export SPEC_BUILD_FOREGROUND=1 SPEC_BUILD_AUTO=1
# Request the external engine's unattended approval and recommended answers.
export OPENCODE_PERMISSION_AUTO_ALLOW_ALWAYS=1 OPENCODE_QUESTION_AUTO_RECOMMEND=1
type spec >/dev/null 2>&1 || { echo '[remote] spec alias/function/launcher not found; configure ~/.bash_aliases' >&2; exit 127; }
spec build "$1"
result=$?
if [[ "$result" -eq 127 ]]; then
    printf '%s\n' '[remote] Build command not found. Ensure the launcher engine (e.g. opencode-source) is installed on the remote host and export its directory in PATH in ~/.bash_aliases; login profiles are not loaded.' >&2
fi
exit "$result"
