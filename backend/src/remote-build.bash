# SSH attachment: workspace, bytes, alias, supervisor, UUID, name, mode, repository probe,
# session ID, config bytes, profile bytes, provider setup script.
# Only an explicit C byte after all uploads cancels; EOF/signals detach after launch.
set -eu
umask 077
cd -- "$1"
[[ $5 =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]] || exit 125
# The original spec name is a basename, never a path or shell expression.
name=$6
[[ -n $name && $name != .* && $name != *[/\\:]* && ! $name =~ [[:cntrl:]] && ${#name} -le 180 ]] || exit 125
log="$name.out"
mode=${7:-build}
[[ $mode == build || $mode == repository-save || $mode == continue || $mode == optimize || $mode == performance ]] || exit 125
run_kind=$mode
repository_probe=${8:-}
session_id=${9:-}
config_bytes=${10:-0}
profile_bytes=${11:-0}
[[ $profile_bytes =~ ^(0|[1-9][0-9]{0,5})$ ]] && (( profile_bytes <= 65536 )) || exit 125
[[ $config_bytes =~ ^(0|[1-9][0-9]{0,6})$ ]] || exit 125
if [[ $mode == optimize || $mode == performance ]]; then
    (( config_bytes > 0 && config_bytes <= 1048576 )) || exit 125
else
    [[ $config_bytes == 0 ]] || exit 125
fi
if [[ $mode == continue ]]; then
    [[ $session_id =~ ^ses_[A-Za-z0-9]+$ && ${#session_id} -le 127 ]] || {
        printf '%s\n' '[remote] Invalid or missing continuation session ID.' >&2
        exit 125
    }
    # Continuations are builds for repository locking and supervisor lifecycle.
    mode=build
else
    [[ -z $session_id ]] || exit 125
fi
runs=.spec-runs
[[ $mode != performance ]] || runs=.performance-runs
mkdir -p -- "$runs"
[[ ! -L $runs && -O $runs && $(stat -c %a -- "$runs") == 700 ]] || {
    printf '[remote] %s must be an owned, private (0700) directory\n' "$runs" >&2
    exit 125
}
destination="$PWD/$runs/run-$5"
run_path="$(pwd -P)/$runs/run-$5"
directory="$PWD/$runs/.pending-$5"
# Reserve the ID exclusively, but do not expose an unadmitted run to legacy
# scanners. No workload can start before registry and final-directory publication.
[[ ! -e $destination && ! -L $destination ]] || exit 125
mkdir -- "$directory" || exit 125
[[ ! -e $destination && ! -L $destination ]] || { rmdir -- "$directory"; exit 125; }
launched=
reader=
registry_record=
config_file=
publish() {
    [[ $directory != "$destination" ]] || return 0
    mv -T --no-clobber -- "$directory" "$destination" || return 1
    [[ ! -e $directory ]] || return 1
    [[ $config_file != "$directory/"* ]] || config_file="$destination/${config_file##*/}"
    directory=$destination
}
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
        rm -f -- "$directory/execution-profile.json" "$directory/provider-setup.bash"
        rm -f -- "$directory/legacy.tmp"
        rm -f -- "$directory/performance-launch.json"
        [[ -z $config_file ]] || rm -f -- "$config_file"
        printf '125\n' > "$directory/status.tmp"
        mv -T -- "$directory/status.tmp" "$directory/status"
        publish || return
        [[ -z $registry_record ]] || rm -f -- "$registry_record"
    fi
}
trap cleanup EXIT
trap 'exit 125' HUP INT TERM
: > "$directory/$log"
# Separate report identity from initial-build invocation evidence used by discovery.
printf '%s\0%s\0%s\0%s\0' "$PWD" "$run_kind" "$name" "$destination/$log" > "$directory/provenance.tmp"
mv -T -- "$directory/provenance.tmp" "$directory/provenance"
[[ -z $session_id ]] || printf '%s\n' "$session_id" > "$directory/session-id"
reject() {
    printf '[remote] %s\n' "$1" >> "$directory/$log"
    printf '[remote] %s\n' "$1" >&2
    exit 125
}
for dependency in setsid stdbuf flock; do
    command -v "$dependency" >/dev/null || reject "Missing required dependency: $dependency"
done
completed() {
    local status
    [[ -d $1 && ! -L $1 && -O $1 && $(stat -c %a -- "$1") == 700 &&
        -f $1/status && ! -L $1/status && -O $1/status &&
        $(stat -c %a -- "$1/status") == 600 && $(stat -c %h -- "$1/status") == 1 &&
        $(stat -c %s -- "$1/status") -le 4 ]] &&
        status=$(head -c 4 -- "$1/status") &&
        [[ $status =~ ^(0|[1-9][0-9]{0,2})$ && $(stat -c %s -- "$1/status") -eq $((${#status}+1)) ]] &&
        (( 10#$status <= 255 ))
}
# Match the probe's worktree scope, ignoring inherited Git overrides. A linked
# worktree has its own Git directory/index; subdirectories and symlinks share it.
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_COMMON_DIR
unset SPEC_OPTIM_WORKSPACE_LOCK SPEC_OPTIM_CONFIG
unset SPEC_EXECUTION_PROFILE SPEC_EXECUTION_API_KEY
project=$(pwd -P)
if [[ $mode == performance ]]; then
    # Parse data, never execute the uploaded runner to discover its lock scope.
    head -c "$2" > "$directory/snapshot.md"
    [[ $(wc -c < "$directory/snapshot.md") -eq "$2" ]] || reject 'incomplete snapshot'
    config_file="$directory/performance-request.json"
    head -c "$config_bytes" > "$config_file"
    [[ $(wc -c < "$config_file") -eq "$config_bytes" ]] || reject 'incomplete Performance request'
    project=$(python3 -I -c '
import json, sys
from pathlib import Path
def unique(items):
    result = {}
    for key, value in items:
        if key in result:
            raise ValueError()
        result[key] = value
    return result
try:
    workspace = Path(sys.argv[1]).resolve(strict=True)
    request_file = Path(sys.argv[2])
    request = json.loads(request_file.read_bytes(), object_pairs_hook=unique)
    if not isinstance(request, dict) or set(request) != {"project", "spec"}:
        raise ValueError()
    value = request["project"]
    if not isinstance(value, str) or not value.strip() or not value.isprintable():
        raise ValueError()
    path = Path(value)
    if not path.is_absolute() and ".." in path.parts:
        raise ValueError()
    project = (workspace / path).resolve(strict=True)
    if (not project.is_dir() or not str(project).isprintable()
            or (not path.is_absolute() and not project.is_relative_to(workspace))):
        raise ValueError()
    spec = request["spec"]
    if spec is not None and (not isinstance(spec, dict) or set(spec) != {"name", "content"}
            or not isinstance(spec["name"], str) or not spec["name"].strip()
            or not spec["name"].isprintable() or not isinstance(spec["content"], str)):
        raise ValueError()
    # Pin the runner to the same canonical selection, not a later symlink lookup.
    request["project"] = str(project)
    data = json.dumps(request).encode()
    if len(data) > 1048576:
        raise ValueError()
    with request_file.with_name("performance-launch.json").open("xb") as output:
        output.write(data)
    print(project)
except (ValueError, OSError, RuntimeError, RecursionError):
    sys.exit(125)
' "$project" "$config_file") || reject 'Invalid Performance request or project; refusing to launch.'
fi
command -v git >/dev/null || reject 'Missing required dependency: git'
resolve_scope() {
    local project ancestor
    project=$(cd -P -- "$1" && pwd -P) || reject 'Cannot resolve project directory.'
    scope=$project
    git_directory=
    if [[ $(git -C "$project" rev-parse --is-inside-work-tree 2>/dev/null) == true ]]; then
        git_directory=$(git -C "$project" rev-parse --absolute-git-dir) || reject 'Cannot resolve worktree lock.'
        git_directory=$(cd -- "$git_directory" && pwd -P) || reject 'Cannot resolve worktree lock.'
        scope=$(git -C "$project" rev-parse --show-toplevel) || reject 'Cannot resolve worktree root.'
        registry="$git_directory/spec-harness"
        lock=$registry
    else
        # A broken/inaccessible Git worktree must not fall back to an unrelated lock.
        ancestor=$project
        while :; do
            [[ ! -e $ancestor/.git && ! -L $ancestor/.git ]] || reject 'Cannot resolve worktree lock.'
            [[ $ancestor != / ]] || break
            ancestor=${ancestor%/*}
            [[ -n $ancestor ]] || ancestor=/
        done
        [[ $(git -C "$project" rev-parse --is-bare-repository 2>/dev/null) != true ]] || reject 'Bare repositories are not supported.'
        lock="$project/.spec-runs"
        registry="$lock/spec-harness"
    fi
}
resolve_scope "$project"
mkdir -p -- "$lock"
[[ -d $lock && ! -L $lock && -O $lock && $(stat -c %a -- "$lock") == 700 ]] ||
    reject 'Unsafe project lock directory; refusing to launch.'
mkdir -p -- "$registry"
[[ -d $registry && ! -L $registry && -O $registry && $(stat -c %a -- "$registry") == 700 ]] ||
    reject 'Unsafe worktree harness registry; refusing to launch.'
# The supervisor inherits this lock. Nonrepository builds retain workspace-local
# locking, while all workspaces in a Git worktree use the same private registry.
exec 9< "$lock"
lock_mode=--shared
[[ $mode == build ]] || lock_mode=--exclusive
flock "$lock_mode" --nonblock 9 || reject 'Another harness is active for this repository; refusing to launch.'
if [[ $mode == optimize ]]; then
    # Children do not inherit fd 9; identify the supervisor's lock without reopening it.
    SPEC_OPTIM_WORKSPACE_LOCK=$(stat -Lc '%d:%i' /proc/self/fd/9)
    export SPEC_OPTIM_WORKSPACE_LOCK
fi
read_record() {
    [[ -e $1 || -L $1 ]] || return 1
    [[ -f $1 && ! -L $1 && -O $1 && $(stat -c %a -- "$1") == 600 &&
        $(stat -c %h -- "$1") == 1 && $(stat -c %s -- "$1") -le 16384 ]] && {
        IFS= read -r -d '' prior && [[ $prior == /* ]] && {
            if IFS= read -r -d '' prior_mode; then
                [[ $prior_mode == build || $prior_mode == repository-save || $prior_mode == optimize || $prior_mode == performance ]] &&
                    ! IFS= read -r -d '' trailing && [[ -z $trailing ]]
            else
                [[ -z $prior_mode ]] && prior_mode=legacy
            fi
        }
    } < "$1"
}
for registry_scan in "$registry" ${git_directory:+"$git_directory/performance-harness"}; do
    [[ ! -e $registry_scan && ! -L $registry_scan ]] && continue
    [[ -d $registry_scan && ! -L $registry_scan && -O $registry_scan && $(stat -c %a -- "$registry_scan") == 700 ]] ||
        reject 'Unsafe worktree harness registry; refusing to launch.'
    for record in "$registry_scan"/run-*; do
        [[ -e $record || -L $record ]] || continue
        if read_record "$record"; then
            [[ $mode != build || $prior_mode != build ]] || continue
            if completed "$prior"; then
                # Shared readers leave retirement to the owner or an exclusive save.
                [[ $mode == build ]] || rm -f -- "$record"
                continue
            fi
        fi
        # A completing supervisor may retire its record during this scan.
        [[ -e $record || -L $record ]] || continue
        reject 'Prior harness completion is unresolved; refusing to launch.'
    done
done
# Old sessions may have no registry pointer. Inspect both namespaces, including
# sibling workspaces in this worktree, but not a different nested Git repository.
if [[ -n $git_directory ]]; then
    find "$scope" -mindepth 1 \( -name .git -o \( -type d -exec test -e '{}/.git' -o -L '{}/.git' \; \) \) -prune \
        -o \( -name .spec-runs -o -name .performance-runs \) -print0 -prune > "$directory/legacy.tmp" ||
        reject 'Cannot inspect legacy harness sessions.'
else
    printf '%s\0' "$project/.spec-runs" "$project/.performance-runs" > "$directory/legacy.tmp"
fi
while IFS= read -r -d '' legacy; do
    [[ -e $legacy || -L $legacy ]] || continue
    if [[ -n $git_directory ]]; then
        legacy_git=$(git -C "${legacy%/*}" rev-parse --absolute-git-dir) || reject 'Cannot resolve legacy worktree.'
        legacy_git=$(cd -- "$legacy_git" && pwd -P) || reject 'Cannot resolve legacy worktree.'
        [[ $legacy_git == "$git_directory" ]] || continue
    fi
    [[ -d $legacy && ! -L $legacy && -O $legacy && $(stat -c %a -- "$legacy") == 700 ]] ||
        reject 'Unsafe legacy harness directory; refusing to launch.'
    for session in "$legacy"/run-*; do
        [[ -e $session || -L $session ]] || continue
        completed "$session" && continue
        [[ -d $session && ! -L $session && -O $session && $(stat -c %a -- "$session") == 700 ]] ||
            reject 'Unsafe legacy harness session; refusing to launch.'
        # Only positively identified builds can overlap; an unregistered legacy
        # spec session may have been an exclusive save or Performance run.
        if [[ $mode == build ]] && read_record "$registry/${session##*/}" &&
            [[ $prior -ef $session && $prior_mode == build ]]; then
            continue
        fi
        # A relocated Performance session is unrelated only with a private,
        # matching registry pointer. Missing/stale evidence never permits a skip.
        if read_record "$session/lock-registry" && [[ $prior != "$registry" && $prior_mode == performance ]]; then
            foreign=$prior
            if read_record "$session/lock-project" && [[ $prior_mode == performance ]] &&
                expected=$(resolve_scope "$prior"; printf '%s' "$registry") && [[ $expected == "$foreign" ]] &&
                [[ -d $foreign && ! -L $foreign && -O $foreign && $(stat -c %a -- "$foreign") == 700 ]] &&
                read_record "$foreign/${session##*/}" && [[ $prior -ef $session && $prior_mode == performance ]]; then
                continue
            fi
        fi
        # Completion publishes status before retiring its registry pointer.
        completed "$session" && continue
        reject 'Prior harness completion is unresolved; refusing to launch.'
    done
done < "$directory/legacy.tmp"
rm -f -- "$directory/legacy.tmp"
if [[ $mode == performance ]]; then
    printf '%s\0performance\0' "$registry" > "$directory/lock-registry"
    printf '%s\0performance\0' "$project" > "$directory/lock-project"
fi
if [[ -n $registry ]]; then
    # The pointer outlives a killed supervisor, so losing a lock is not mistaken
    # for completion. Only a validated terminal session can retire this record.
    # Publish complete records atomically: normal builds scan under shared locks.
    record_tmp=$(mktemp "$registry/.pending-XXXXXXXX")
    printf '%s\0%s\0' "$run_path" "$mode" > "$record_tmp"
    mv -T --no-clobber -- "$record_tmp" "$registry/run-$5"
    [[ ! -e $record_tmp ]] ||
        reject 'Duplicate worktree run ID; refusing to launch.'
    registry_record="$registry/run-$5"
fi
# Retain ordinary completed runs for seven days; keep full optimization reports.
# Never prune a running supervisor.
find "$runs" -mindepth 2 -maxdepth 2 -name status -type f -mmin +10080 -printf '%h\0' |
    while IFS= read -r -d '' expired; do
        [[ ! -e "$expired/report.jsonl" ]] || continue
        [[ -z $registry || ( ! -e "$registry/${expired##*/}" && ! -L "$registry/${expired##*/}" ) ]] || continue
        rm -rf -- "$expired"
    done
if [[ $mode != performance ]]; then
    head -c "$2" > "$directory/snapshot.md"
    [[ $(wc -c < "$directory/snapshot.md") -eq "$2" ]] || { echo '[remote] incomplete snapshot' >&2; exit 125; }
fi
if [[ $mode == optimize ]]; then
    mkdir -p -- "$HOME/projects"
    config_parent=$(cd -- "$HOME/projects" && pwd -P)
    config_file=$(mktemp -- "$config_parent/spec-optimization.XXXXXXXX.optim")
    head -c "$config_bytes" > "$config_file"
    [[ $(wc -c < "$config_file") -eq "$config_bytes" ]] || reject 'incomplete optimization config'
    # Retain the unique upload after launch so reports reference the actual input.
    export SPEC_OPTIM_CONFIG="$config_file"
fi
if [[ $mode == repository-save ]]; then
    [[ -n $repository_probe ]] || exit 125
    timeout --kill-after=1s 10s bash --noprofile --norc -c "$repository_probe" -- "$PWD" require-dirty 9<&- >> "$directory/$log" 2>&1 || exit 125
fi
if (( profile_bytes > 0 )); then
    [[ -n ${12:-} ]] || reject 'Missing execution provider setup.'
    head -c "$profile_bytes" > "$directory/execution-profile.json"
    [[ $(wc -c < "$directory/execution-profile.json") -eq "$profile_bytes" ]] || reject 'Incomplete execution profile.'
    printf '%s' "${12}" > "$directory/provider-setup.bash"
    export SPEC_EXECUTION_PROFILE="$destination/execution-profile.json"
fi
publish || reject 'Cannot publish admitted run directory.'
# Ignore HUP before fork, and redirect every SSH descriptor before detaching.
# Ownership transfers before launch so an attachment signal cannot delete live input.
if [[ $mode == build && -z $session_id ]]; then
    # Record the actual launch identity, not a growing log's modification time.
    printf '%s\0%s\0%s\0%s\0' "$PWD" build "$name" "$directory/$log" > "$directory/invocation"
fi
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
