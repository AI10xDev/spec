spec () 
{ 
    if [[ "${1:-}" == --manual || "${1:-}" == --help || "${1:-}" == -h || "${1:-}" == /eval || "${1:-}" == /telle || "${1:-}" == telle ]]; then
        /home/opencode/.bun/bin/bun /home/opencode/opencode-source/script/spec-workflow.ts "$@";
        return;
    fi;
    local history_file="$HOME/.local/state/spec/saved-files";
    if [[ "${1:-}" == eval || "${1:-}" == --eval ]]; then
        shift;
        /home/opencode/nextweb/tools/eval/spec-eval "$@";
        return;
    fi;
    if [[ "${1:-}" == build ]]; then
        shift;
        if (( $# > 1 )); then
            printf 'Usage: spec build [spec-file]\n' 1>&2;
            return 1;
        fi;
        local spec_file="${1:-}";
        if [[ -z "$spec_file" ]]; then
            if [[ ! -s "$history_file" ]]; then
                printf 'No saved spec is available. Save one with spec or pass a file.\n' 1>&2;
                return 1;
            fi;
            spec_file=$(tail -n 1 -- "$history_file");
        fi;
        if [[ "${SPEC_BUILD_FOREGROUND:-0}" == 1 ]]; then
            run_goal "$spec_file";
            return;
        fi;
        local spec_name="${spec_file##*/}";
        local output_file;
        if [[ "$spec_name" == *.* && "$spec_name" != .* ]]; then
            output_file="${spec_file%.*}.out";
        else
            output_file="${spec_file}.out";
        fi;
        nohup bash -c '. "$HOME/.bash_aliases"; SPEC_BUILD_FOREGROUND=1 spec build "$1"' _ "$spec_file" > "$output_file" 2>&1 & printf 'Started spec build (PID %s); output: %s\n' "$!" "$output_file";
        return;
    fi;
    local run_command="${KIBI_RUN_COMMAND:-/home/opencode/opencode-source/script/run-spec.sh}";
    if (( $# == 0 )) && [[ -s "$history_file" ]]; then
        local previous_file;
        previous_file=$(tail -n 1 -- "$history_file");
        if [[ ! -f "$previous_file" ]]; then
            printf 'Saved spec is no longer available: %s\n' "$previous_file" 1>&2;
            return 1;
        fi;
        set -- "$previous_file";
    fi;
    local persistent_session=0;
    if [[ "$run_command" == /home/opencode/opencode-source/script/run-spec.sh ]]; then
        persistent_session=1;
    fi;
    KIBI_SPEC_SESSION="$persistent_session" KIBI_SPEC_RESUME="${KIBI_SPEC_RESUME:-1}" KIBI_SAVE_COPY_DIR="$HOME/specs" KIBI_ENV_FILE="${KIBI_ENV_FILE:-$HOME/code.dev/.env}" KIBI_SAVE_HISTORY_FILE="$history_file" KIBI_RUN_COMMAND="$run_command" XDG_DATA_DIRS="$HOME/.local/share/specific/editor/share:${XDG_DATA_DIRS:-/usr/local/share:/usr/share}" "$HOME/.local/share/specific/editor/specific-editor" "$@"
}
