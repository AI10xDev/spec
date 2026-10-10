# SSH attachment: workspace, bytes, alias, supervisor, UUID, name, mode, repository probe.
# Only an explicit C byte after the snapshot cancels; EOF/signals detach.
set -eu
umask 077
cd -- "$1"
command -v setsid stdbuf flock >/dev/null
[[ $5 =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]] || exit 125
# The original spec name is a basename, never a path or shell expression.
name=$6
[[ -n $name && $name != .* && $name != *[/\\:]* && ! $name =~ [[:cntrl:]] && ${#name} -le 180 ]] || exit 125
log="$name.out"
mode=${7:-build}
[[ $mode == build || $mode == repository-save ]] || exit 125
repository_probe=${8:-}
mkdir -p .spec-runs
[[ ! -L .spec-runs && -O .spec-runs && $(stat -c %a .spec-runs) == 700 ]] || {
    echo '[remote] .spec-runs must be an owned, private (0700) directory' >&2
    exit 125
}
directory="$PWD/.spec-runs/run-$5"
# Exclusive creation is intentional: retrying an ID must never launch twice.
mkdir -- "$directory" || exit 125
launched=
reader=
registry_record=
cleanup() {
    # EOF may race normal exit; do not let the reader's TERM interrupt cleanup.
    trap '' HUP INT TERM
    trap - EXIT
    if [[ -n "$reader" ]]; then
        kill -KILL "$reader" 2>/dev/null || true
        wait "$reader" 2>/dev/null || true
    fi
    if [[ -z "$launched" ]]; then
        # Only this pre-launch owner can prove rejection. SSH failure or a missing
        # session alone never proves that a supervisor did not start.
        printf '%s\n' '[remote] Launch rejected before supervisor start.' >> "$directory/$log"
        rm -f -- "$directory/snapshot.md"
        printf '125\n' > "$directory/status.tmp"
        mv -T -- "$directory/status.tmp" "$directory/status"
        [[ -z $registry_record ]] || rm -f -- "$registry_record"
    fi
}
trap cleanup EXIT
trap 'exit 125' HUP INT TERM
: > "$directory/$log"
reject() {
    printf '[remote] %s\n' "$1" >> "$directory/$log"
    printf '[remote] %s\n' "$1" >&2
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
# Match the probe's worktree scope, ignoring inherited Git overrides. A linked
# worktree has its own Git directory/index; subdirectories and symlinks share it.
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_COMMON_DIR
registry=
if [[ $(git rev-parse --is-inside-work-tree 2>/dev/null) == true ]]; then
    git_directory=$(git rev-parse --absolute-git-dir)
    git_directory=$(cd -- "$git_directory" && pwd -P)
    registry="$git_directory/spec-harness"
    mkdir -p -- "$registry"
    [[ -d $registry && ! -L $registry && -O $registry && $(stat -c %a -- "$registry") == 700 ]] ||
        reject 'Unsafe worktree harness registry; refusing to launch.'
fi
# The supervisor inherits this lock. Nonrepository builds retain workspace-local
# locking, while all workspaces in a Git worktree use the same private registry.
exec 9< "${registry:-.spec-runs}"
lock_mode=--shared
[[ $mode != repository-save ]] || lock_mode=--exclusive
flock "$lock_mode" --nonblock 9 || reject 'Another harness is active for this repository; refusing to launch.'
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
                    # Old path-only records may represent a save, not just a build.
                    [[ -z $prior_mode ]] && prior_mode=legacy
                fi
            }
        } < "$record"; then
            [[ $mode != build || $prior_mode != build ]] || continue
            if completed "$prior"; then
                # Shared readers leave retirement to the owner or an exclusive save.
                [[ $mode != repository-save ]] || rm -f -- "$record"
                continue
            fi
        fi
        # A completing supervisor may retire its record during this scan.
        [[ -e $record || -L $record ]] || continue
        reject 'Prior harness completion is unresolved; refusing to launch.'
    done
fi
if [[ $mode == repository-save ]]; then
    # Retain the guard for pre-registry sessions in this workspace.
    for prior in "$PWD"/.spec-runs/run-*; do
        [[ $prior != "$directory" && ( -e $prior || -L $prior ) ]] || continue
        completed "$prior" || reject 'Prior harness completion is unresolved; refusing repository save.'
    done
fi
if [[ -n $registry ]]; then
    # The pointer outlives a killed supervisor, so losing a lock is not mistaken
    # for completion. Only a validated terminal session can retire this record.
    # Publish complete records atomically: normal builds scan under shared locks.
    record_tmp=$(mktemp "$registry/.pending-XXXXXXXX")
    printf '%s\0%s\0' "$directory" "$mode" > "$record_tmp"
    mv -T --no-clobber -- "$record_tmp" "$registry/run-$5"
    [[ ! -e $record_tmp ]] ||
        reject 'Duplicate worktree run ID; refusing to launch.'
    registry_record="$registry/run-$5"
fi
# Retain completed runs for seven days; never prune a running supervisor.
find .spec-runs -mindepth 2 -maxdepth 2 -name status -type f -mmin +10080 -printf '%h\0' |
    while IFS= read -r -d '' expired; do
        [[ -z $registry || ( ! -e "$registry/${expired##*/}" && ! -L "$registry/${expired##*/}" ) ]] || continue
        rm -rf -- "$expired"
    done
head -c "$2" > "$directory/snapshot.md"
[[ $(wc -c < "$directory/snapshot.md") -eq "$2" ]] || { echo '[remote] incomplete snapshot' >&2; exit 125; }
if [[ $mode == repository-save ]]; then
    [[ -n $repository_probe ]] || exit 125
    timeout --kill-after=1s 10s bash --noprofile --norc -c "$repository_probe" -- "$PWD" require-dirty 9<&- >> "$directory/$log" 2>&1 || exit 125
fi
# Ignore HUP before fork, and redirect every SSH descriptor before detaching.
# Ownership transfers before launch so an attachment signal cannot delete live input.
trap '' HUP
launched=1
setsid flock --exclusive --nonblock --close "$directory/lease" bash --noprofile --norc -c "$4" -- "$directory" "$3" "$log" "$mode" "$repository_probe" "$registry_record" </dev/null >/dev/null 2>&1 &
# The detached supervisor owns the lock now; attachment backpressure must not retain it.
exec 9<&-
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
printf '[remote] session: %s (%s, status; no hangup, EOF detaches)\n' "$directory" "$log" >&2
offset=0
while :; do
    finished=
    [[ ! -f "$directory/status" ]] || finished=1
    size=$(stat -c %s "$directory/$log")
    if (( size > offset )); then
        dd if="$directory/$log" iflag=skip_bytes,count_bytes skip="$offset" count="$((size-offset))" status=none
        offset=$size
    fi
    if [[ -n "$finished" ]]; then
        exit "$(cat "$directory/status")"
    fi
    sleep 0.2
done
