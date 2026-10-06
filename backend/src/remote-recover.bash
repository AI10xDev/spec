# Fixed non-launching protocol. Never source aliases or accept a caller-supplied path.
set -eu
umask 077
[[ $2 =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]] || exit 125
[[ $3 == snapshot || $3 == cancel ]] || exit 125
name=$4
[[ -n $name && $name != .* && $name != *[/\\:]* && ! $name =~ [[:cntrl:]] && ${#name} -le 180 ]] || exit 125
cd -- "$1"
private_directory() {
    [[ -d $1 && ! -L $1 && -O $1 && $(stat -c %a -- "$1") == 700 ]]
}
private_file() {
    [[ -f $1 && ! -L $1 && -O $1 && $(stat -c %a -- "$1") == 600 && $(stat -c %h -- "$1") == 1 ]]
}
private_directory .spec-runs || { echo 'unsafe or missing remote run storage' >&2; exit 125; }
private_directory ".spec-runs/run-$2" || { echo 'unsafe or missing remote run' >&2; exit 125; }
cd -- ".spec-runs/run-$2"
# Runs launched before spec-named logs still write output.log after an upgrade.
log="./$name.out"
[[ -e $log || -L $log ]] || log=./output.log
status=unknown
if [[ -e status || -L status ]]; then
    private_file status && [[ $(stat -c %s status) -le 4 ]] || exit 125
    status=$(head -c 4 status)
    [[ $status =~ ^(0|[1-9][0-9]{0,2})$ ]] && (( 10#$status <= 255 )) || exit 125
elif [[ -e lease || -L lease ]]; then
    private_file lease || exit 125
    exec 9<lease
    # --close on the launch-side flock keeps descendants from inheriting the lease.
    if flock --exclusive --nonblock --conflict-exit-code 75 9; then
        flock --unlock 9
    else
        [[ $? == 75 ]] || exit 125
        status=running
    fi
fi
if [[ $3 == cancel && $status == running ]]; then
    # noclobber prevents following a pre-existing symlink or truncating any file.
    if [[ -e cancel || -L cancel ]]; then
        private_file cancel || exit 125
    else
        (set -o noclobber; : > cancel) || exit 125
    fi
elif [[ $3 == cancel && $status == unknown ]]; then
    echo 'cannot cancel a run with unknown supervisor status' >&2
    exit 125
fi
private_file "$log" || exit 125
size=$(stat -c %s -- "$log")
(( size <= 8388608 )) || exit 125
count=$size
offset=0
truncated=0
if (( size > 262144 )); then
    count=262144
    offset=$((size-count))
    truncated=1
fi
printf 'SPEC-RUN-1 %s %s\n' "$status" "$truncated"
dd if="$log" iflag=skip_bytes,count_bytes skip="$offset" count="$count" status=none
