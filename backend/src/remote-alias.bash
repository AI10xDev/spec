# Source only the trusted remote alias file, not an interactive shell/terminal.
# Separate lines ensure aliases defined by the source are expanded at invocation.
: > "$2" # Signal that setsid established the build process group.
spec_build_mode=${3:-build}
[[ $spec_build_mode == build || $spec_build_mode == repository-save ]] || exit 125
spec_build_workspace=$PWD
shopt -s expand_aliases
# SSH/noninteractive shells often omit user-installed engines and Bun. Set up
# their conventional locations without loading interactive/login startup files.
# The trusted alias file can still override PATH for a custom installation.
export PATH="$HOME/.local/bin:$HOME/.bun/bin:${PATH:-/usr/local/bin:/usr/bin:/bin}"
if [[ -f "$HOME/.bash_aliases" ]]; then
    source "$HOME/.bash_aliases" || exit
fi
unset SPEC_SESSION_DIR KIBI_SPEC_SESSION
export SPEC_BUILD_FOREGROUND=1 SPEC_BUILD_AUTO=1
# Request the external engine's unattended approval and recommended answers.
export OPENCODE_PERMISSION_AUTO_ALLOW_ALWAYS=1 OPENCODE_QUESTION_AUTO_RECOMMEND=1
type spec >/dev/null 2>&1 || { echo '[remote] spec alias/function/launcher not found; configure ~/.bash_aliases' >&2; exit 127; }
# Merge only this invocation's supplemental system instructions. Bun or Node is
# required on the remote PATH after aliases are sourced; never replace config.
spec_build_runtime=$(type -P bun || type -P node) || {
    printf '%s\n' '[remote] Spec build instructions require Bun or Node.js on PATH; configure ~/.bash_aliases.' >&2
    exit 127
}
[[ "$1" = /* ]] || { printf '%s\n' '[remote] Snapshot path must be absolute.' >&2; exit 125; }
spec_build_instructions=$(mktemp "${1%/*}/spec-build-instructions.XXXXXX.md") || exit 125
trap 'rm -f -- "$spec_build_instructions"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
if ! spec_build_config=$(OPENCODE_CONFIG_CONTENT="${OPENCODE_CONFIG_CONTENT-"{}"}" "$spec_build_runtime" -e '
const fs = require("node:fs");
try {
    let config;
    try {
        config = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT);
    } catch {
        throw new Error("OPENCODE_CONFIG_CONTENT must contain valid JSON; refusing to discard existing config.");
    }
    if (config === null || typeof config !== "object" || Array.isArray(config)) {
        throw new Error("OPENCODE_CONFIG_CONTENT must be a JSON object.");
    }
    if (config.instructions !== undefined &&
        (!Array.isArray(config.instructions) || config.instructions.some(item => typeof item !== "string"))) {
        throw new Error("OPENCODE_CONFIG_CONTENT instructions must be a string array.");
    }
    const instructionPath = process.argv[1];
    const repositorySave = process.argv[2] === "repository-save";
    if (repositorySave) {
        const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
        for (const key of ["agent", "mode"]) {
            if (config[key] !== undefined && !object(config[key])) {
                throw new Error(key + " must be an object; refusing to discard existing config.");
            }
            if (config[key]?.build !== undefined && !object(config[key].build)) {
                throw new Error(key + ".build must be an object; refusing to discard existing config.");
            }
        }
        config.model = "azure/gpt-6-sol";
        config.agent = {...(config.agent ?? {}), build: {...(config.agent?.build ?? {}), model: config.model}};
        // Legacy file-based mode settings merge over agent settings upstream.
        config.mode = {...(config.mode ?? {}), build: {...(config.mode?.build ?? {}), model: config.model}};
    }
    fs.writeFileSync(instructionPath, repositorySave ? `Repository-save invocation, not a spec implementation run:

Read the saved spec snapshot unchanged as context only. Do not rebuild or implement
pending specs. Inspect the existing repository status and diffs, and follow existing
Agent.md / AGENTS.md instructions and the repository save/commit workflow.
Validate the edited changes appropriately. The repository-save button explicitly
authorizes saving the edited changes with focused commit(s). Inspect git status,
git diff (including staged changes), and git log before committing. Do not include
secrets, session artifacts (.spec-runs/, .spec-output/, .spec.lock), or unrelated
edits. Do not push, amend, reset, change git config, or bypass hooks. Preserve
unrelated edits. Report blockers and outcomes honestly, including validation or
commit failures; do not claim changes were saved unless commits succeeded.
` : `Spec completion marker convention for this build invocation:

Read the saved spec snapshot unchanged. Outside code blocks, a leading single hash
followed by a space ("# "), after optional indentation, marks that spec line as
completed, not pending. For example, "  # Add search" is already completed.
Preserve completed text as context. Do not implement completed requirements again
unless explicitly reopened by removing the completion marker. Completion applies
only to the marked line, not automatically to subsequent lines or an entire section.
A line containing only "#" after indentation may be a completed blank line; it
contains no task. A hash without the following space, such as "#tag", is not a
completion marker. Two or more leading hashes ("##", "###", etc.) remain Markdown
headings, not completion markers. Inline hashes ("Use C#" or "color #fff") do not
mark completion. Hashes in fenced code blocks (backtick or tilde fences), indented
code blocks, and inline code are code content, not completion markers. Distinguish
actual code blocks from ordinary indentation on spec lines.
Implement only pending requirements; retain completed requirements as context.
`);
    config.instructions = [...(config.instructions ?? []), instructionPath];
    process.stdout.write(JSON.stringify(config));
} catch (error) {
    console.error("[remote] Cannot prepare spec build instructions: " + error.message);
    process.exit(125);
}
' "$spec_build_instructions" "$spec_build_mode"); then
    exit 125
fi
export OPENCODE_CONFIG_CONTENT="$spec_build_config"
if [[ $spec_build_mode == repository-save ]]; then
    [[ -n ${4:-} ]] || exit 125
    cd -- "$spec_build_workspace" || exit 125
    timeout --kill-after=1s 10s bash --noprofile --norc -c "$4" -- "$spec_build_workspace" require-dirty || exit 125
fi
spec build "$1"
result=$?
if [[ "$result" -eq 127 ]]; then
    printf '%s\n' '[remote] Build command not found. Ensure the launcher engine (e.g. opencode-source) is installed on the remote host and export its directory in PATH in ~/.bash_aliases; login profiles are not loaded.' >&2
fi
exit "$result"
