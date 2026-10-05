set -eo pipefail
umask 077
cd -- "$1"
snapshot=$(mktemp "${TMPDIR:-/tmp}/spec-build.XXXXXXXX.md")
trap 'rm -f -- "$snapshot"' EXIT
# The SSH stdin contains only the immutable spec, never shell source.
cat > "$snapshot"
# Bound remote work even if the local SSH client is killed or disconnected.
timeout --kill-after=5s 900s bash -c '
    set -e
    . "$HOME/.bash_aliases"
    unset SPEC_SESSION_DIR KIBI_SPEC_SESSION
    SPEC_BUILD_FOREGROUND=1 spec build "$1"
' spec "$snapshot" </dev/null
