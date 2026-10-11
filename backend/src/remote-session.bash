# Non-launching continuation preflight: workspace, prior run UUID, original name.
set -eu
export LC_ALL=C
missing() {
    printf '%s\n' 'This build has no saved session ID. Start a new build to enable continuation.' >&2
    exit 125
}
[[ $2 =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]] || missing
name=$3
[[ -n $name && $name != .* && $name != *[/\\:]* && ! $name =~ [[:cntrl:]] && ${#name} -le 180 ]] || missing
cd -- "$1" || missing
private_directory() {
    [[ -d $1 && ! -L $1 && -O $1 && $(stat -c %a -- "$1") == 700 ]]
}
private_file() {
    [[ -f $1 && ! -L $1 && -O $1 && $(stat -c %a -- "$1") == 600 && $(stat -c %h -- "$1") == 1 ]]
}
private_directory .spec-runs && private_directory ".spec-runs/run-$2" || missing
cd -- ".spec-runs/run-$2" || missing
# Never accept a different filename or fall back to a legacy/global session.
private_file "./$name.out" || missing
private_file status && [[ $(stat -c %s -- status) -le 4 ]] || missing
IFS= read -r status < status || missing
[[ $status =~ ^(0|[1-9][0-9]{0,2})$ && $(stat -c %s -- status) -eq $((${#status}+1)) ]] &&
    (( 10#$status <= 255 )) || missing
private_file session-id && [[ $(stat -c %s -- session-id) -le 128 ]] || missing
IFS= read -r session_id < session-id || missing
[[ $session_id =~ ^ses_[A-Za-z0-9]+$ && $(stat -c %s -- session-id) -eq $((${#session_id}+1)) ]] || missing
printf '%s\n' "$session_id"
