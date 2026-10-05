# SSH attachment. Arguments: workspace, snapshot bytes, alias script, supervisor.
# Only an explicit C byte after the snapshot cancels; EOF/signals detach.
set -eu
umask 077
cd -- "$1"
command -v setsid stdbuf >/dev/null
mkdir -p .spec-runs
[[ ! -L .spec-runs && -O .spec-runs && $(stat -c %a .spec-runs) == 700 ]] || {
    echo '[remote] .spec-runs must be an owned, private (0700) directory' >&2
    exit 125
}
# Retain completed runs for seven days; never prune a running supervisor.
find .spec-runs -mindepth 2 -maxdepth 2 -name status -type f -mmin +10080 -printf '%h\0' |
    xargs -0 -r rm -rf --
directory=$(mktemp -d "$PWD/.spec-runs/run-XXXXXXXXXX")
launched=
reader=
cleanup() {
    # EOF may race normal exit; do not let the reader's TERM interrupt cleanup.
    trap '' HUP INT TERM
    trap - EXIT
    if [[ -n "$reader" ]]; then
        kill -KILL "$reader" 2>/dev/null || true
        wait "$reader" 2>/dev/null || true
    fi
    [[ -n "$launched" ]] || rm -rf -- "$directory"
}
trap cleanup EXIT
trap 'exit 125' HUP INT TERM
head -c "$2" > "$directory/snapshot.md"
[[ $(wc -c < "$directory/snapshot.md") -eq "$2" ]] || { echo '[remote] incomplete snapshot' >&2; exit 125; }
: > "$directory/output.log"
# Ignore HUP before fork, and redirect every SSH descriptor before detaching.
# Ownership transfers before launch so an attachment signal cannot delete live input.
trap '' HUP
launched=1
setsid bash --noprofile --norc -c "$4" -- "$directory" "$3" </dev/null >/dev/null 2>&1 &
trap 'exit 125' HUP
# Control must not wait for log writes (or the session notice) to reach SSH.
attachment=$$
(
    trap - EXIT HUP INT TERM
    # Timed reads also retire this reader if the attachment is killed outright.
    while kill -0 "$attachment" 2>/dev/null && [[ ! -f "$directory/status" ]]; do
        if IFS= read -r -t 0.2 -n 1 control; then
            [[ "$control" == C ]] || break
            : > "$directory/cancel"
        else
            result=$?
            (( result > 128 )) || break
        fi
    done
    [[ -f "$directory/status" ]] || kill -TERM "$attachment" 2>/dev/null || true
) <&0 >/dev/null 2>&1 &
reader=$!
printf '[remote] session: %s (output.log, status; EOF detaches)\n' "$directory" >&2
offset=0
while :; do
    finished=
    [[ ! -f "$directory/status" ]] || finished=1
    size=$(stat -c %s "$directory/output.log")
    if (( size > offset )); then
        dd if="$directory/output.log" iflag=skip_bytes,count_bytes skip="$offset" count="$((size-offset))" status=none
        offset=$size
    fi
    if [[ -n "$finished" ]]; then
        exit "$(cat "$directory/status")"
    fi
    sleep 0.2
done
