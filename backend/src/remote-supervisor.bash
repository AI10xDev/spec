# Detached owner of the snapshot, build group, bounded log, and final status.
set -eu
umask 077
directory=$1
pid=
logger=
result=125
cleanup() {
    trap - EXIT INT TERM
    if [[ -n "$pid" ]]; then
        kill -KILL -- "-$pid" 2>/dev/null || true
        kill -KILL "$pid" 2>/dev/null || true
        wait "$pid" 2>/dev/null || true
    fi
    if [[ -n "$logger" ]]; then
        # A child that escaped the build group must not hold status publication
        # hostage by retaining the output pipe. Ordinary buffered output drains first.
        for ((attempt=0; attempt<100; attempt++)); do
            kill -0 "$logger" 2>/dev/null || break
            sleep 0.01
        done
        kill -KILL -- "-$logger" 2>/dev/null || true
        kill -KILL "$logger" 2>/dev/null || true
        wait "$logger" 2>/dev/null || true
    fi
    rm -f -- "$directory/snapshot.md" "$directory/pipe" "$directory/ready" "$directory/cancel"
    printf '%s\n' "$result" > "$directory/status.tmp"
    mv -- "$directory/status.tmp" "$directory/status"
}
trap cleanup EXIT
trap '' HUP
trap 'exit 125' INT TERM
mkfifo "$directory/pipe"
# Keep the first 8 MiB, then drain without retaining more or breaking the build pipe.
setsid bash --noprofile --norc -c 'stdbuf -o0 head -c 8388608; cat >/dev/null' < "$directory/pipe" > "$directory/output.log" &
logger=$!
setsid bash --noprofile --norc -c "$2" -- "$directory/snapshot.md" "$directory/ready" </dev/null > "$directory/pipe" 2>&1 &
pid=$!
SECONDS=0
# setsid must establish the group before cancellation can kill it.
while [[ ! -f "$directory/ready" ]] && kill -0 "$pid" 2>/dev/null; do
    if (( SECONDS >= 10 )); then
        kill -KILL "$pid" 2>/dev/null || true
        exit 125
    fi
    sleep 0.01
done
while kill -0 "$pid" 2>/dev/null; do
    if [[ -f "$directory/cancel" ]]; then
        result=130
        exit "$result"
    fi
    if (( SECONDS >= 900 )); then
        result=124
        exit "$result"
    fi
    sleep 0.1
done
set +e
wait "$pid"
result=$?
exit "$result"
