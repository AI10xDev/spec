# Fixed SSH supervisor. Arguments: remote workspace, snapshot byte count, fixed alias script.
# stdin is a byte-counted snapshot followed by a connection-lifetime lease.
set -eu
umask 077
cd -- "$1"
directory=$(mktemp -d /tmp/spec-build-XXXXXXXXXX)
pid=
cleanup() {
    trap - EXIT HUP INT TERM
    if [[ -n "$pid" ]]; then
        kill -KILL -- "-$pid" 2>/dev/null || true
        wait "$pid" 2>/dev/null || true
    fi
    rm -rf -- "$directory"
}
trap cleanup EXIT
trap 'exit 125' HUP INT TERM
head -c "$2" > "$directory/snapshot.md"
[[ $(wc -c < "$directory/snapshot.md") -eq "$2" ]] || { echo '[remote] incomplete snapshot' >&2; exit 125; }
# A separate process group lets cleanup stop the build and its ordinary children.
setsid bash --noprofile --norc -c "$3" -- "$directory/snapshot.md" "$directory/ready" </dev/null &
pid=$!
SECONDS=0
# Do not process lease EOF before setsid has established the group we must kill.
while [[ ! -f "$directory/ready" ]] && kill -0 "$pid" 2>/dev/null; do
    if (( SECONDS >= 10 )); then
        kill -KILL "$pid" 2>/dev/null || true
        echo '[remote] build shell did not start' >&2
        exit 125
    fi
    sleep 0.01
done
while kill -0 "$pid" 2>/dev/null; do
    if (( SECONDS >= 900 )); then
        echo '[remote] build timed out' >&2
        exit 124
    fi
    # EOF (local cancellation/disconnect) revokes the lease. A timed read returns
    # >128, so a healthy idle connection keeps the foreground build alive.
    if IFS= read -r -t 0.2 -n 1; then
        echo '[remote] unexpected control data' >&2
        exit 125
    else
        result=$?
        if (( result <= 128 )); then
            echo '[remote] connection closed; stopping build' >&2
            exit 125
        fi
    fi
done
set +e
wait "$pid"
result=$?
exit "$result"
