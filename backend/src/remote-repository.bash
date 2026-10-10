# Internal read-only probe: configured workspace, optional require-dirty guard.
set -euo pipefail
export GIT_OPTIONAL_LOCKS=0
# A connection is determined by this directory, not inherited Git overrides.
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_COMMON_DIR
unset GIT_LITERAL_PATHSPECS GIT_GLOB_PATHSPECS GIT_NOGLOB_PATHSPECS GIT_ICASE_PATHSPECS
cd -- "$1"
command -v git >/dev/null || { echo '[remote] Git is required for repository status' >&2; exit 125; }
connected=0
dirty=0
root=
if [[ $(git rev-parse --is-inside-work-tree 2>/dev/null) == true ]]; then
    connected=1
    root=$(git rev-parse --show-toplevel)
    exclusions=()
    # Status spans the worktree, including artifacts from sibling workspaces.
    for artifact in .spec-runs .spec-output .spec.lock; do
        exclusions+=(":(top,glob,exclude)**/$artifact" ":(top,glob,exclude)**/$artifact/**")
    done
    # Drain porcelain without retaining filenames or emitting an unbounded list.
    dirty=$(git -C "$root" status --porcelain=v1 -z --untracked-files=all --ignore-submodules=none -- ':(top)' "${exclusions[@]}" | {
        if IFS= read -r -d '' entry; then printf 1; else printf 0; fi
        cat >/dev/null
    })
fi
if [[ ${2:-status} == require-dirty ]]; then
    [[ $connected == 1 && $dirty == 1 ]] || {
        echo '[remote] Repository save requires a connected Git worktree with unsaved changes; refusing to launch.' >&2
        exit 125
    }
else
    printf 'SPEC-REPOSITORY-1 %s %s\0%s\0' "$connected" "$dirty" "$root"
fi
